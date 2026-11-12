#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

async function main() {
    const { values, positionals } = parseArgs({ options: { project: { type: 'string' }, client: { type: 'string' } }, allowPositionals: true });
    const tool = positionals[0];
    if (positionals.length !== 1 || !['nasani_environment', 'nasani_workflow', 'nasani_validate', 'nasani_format', 'nasani_assets', 'nasani_swiper_scripts'].includes(tool)) throw new Error('Pass one NASANI tool name.');
    if (!['codex', 'claude'].includes(values.client)) throw new Error('--client must be codex or claude.');
    if (!values.project || !path.isAbsolute(values.project)) throw new Error('--project requires an absolute directory.');
    const root = fs.realpathSync(values.project);
    if (!fs.statSync(root).isDirectory() || root === path.parse(root).root) throw new Error('Use a project directory, not the filesystem root.');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('NASANI requires Node.js >=22.');
    let input = '';
    if (!process.stdin.isTTY) {
        for await (const chunk of process.stdin) {
            input += chunk;
            if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Tool input exceeds 1 MiB.');
        }
    }
    const args = input.trim() ? JSON.parse(input) : {};
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Tool input must be a JSON object on stdin.');
    const runtime = path.join(os.homedir(), '.local/share/nasani-mcp/runtime/node_modules/@nasani/figma-mcp');
    const cli = path.join(runtime, 'bin/nasani.cjs');
    // Reuse installer safety checks in-process; bootstrap only when runtime/config is missing.
    const needsSetup = !fs.existsSync(cli) || require(path.join(runtime, 'lib/install.cjs')).install({ project: root, client: values.client, mcpOnly: true, dryRun: true }).changed.length > 0;
    if (needsSetup) {
        const setup = ['setup', '--client', values.client, '--project', root, '--mcp-only'];
        const npm = process.env.npm_execpath || (process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined);
        const command = fs.existsSync(cli) || npm ? process.execPath : 'npm';
        const commandArgs = fs.existsSync(cli) ? [cli, ...setup] : [
            ...(npm ? [npm] : []), 'exec', '--yes', '--package=git+https://github.com/phamtuyennasani/nasani-mcp.git', '--', 'nasani-mcp', ...setup
        ];
        // ponytail: bootstrap on first use; a native client plugin can replace this when all target clients support it.
        const installed = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        if (installed.stdout) process.stderr.write(installed.stdout);
        if (installed.stderr) process.stderr.write(installed.stderr);
        if (installed.error || installed.status !== 0) throw new Error(`MCP setup failed: ${installed.error?.message || installed.signal || installed.status}.`);
    }
    const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
    const { Client } = runtimeRequire('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = runtimeRequire('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'nasani-skill', version: '1' });
    try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'local', '--project', root], stderr: 'inherit' }));
        const result = await client.callTool({ name: tool, arguments: args });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.isError) process.exitCode = 1;
    } finally { await client.close(); }
}

main().catch(error => { process.stderr.write(`NASANI skill: ${error.message}\n`); process.exitCode = 1; });
