#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HELP = `NASANI MCP — standalone design-to-code tooling (Node >=22)

  nasani-mcp local   --project /absolute/project
  nasani-mcp bridge  --project /absolute/project --url https://domain/mcp [--token-file /private/token]
  nasani-mcp install --client codex|claude --project /absolute/project [--mcp-only] [--mode local|bridge] [--url URL] [--token-file FILE]
  nasani-mcp serve   [--access-file FILE] [--url URL] [--host ADDRESS] [--port PORT]
  nasani-mcp keygen  --access-file FILE --member MEMBER
  nasani-mcp revoke  --access-file FILE --member MEMBER
  nasani-mcp token   [--token-file FILE]  (read a NASANI token from stdin, store with mode 600)

Local mode: uses the active coding session model and host file tools. No NASANI URL, NASANI token or AI API key.
Install --mcp-only: register MCP only; nasani_workflow serves the bundled instructions without installing skills/agents.
Optional remote server env: NASANI_ACCESS_FILE, NASANI_PUBLIC_URL, NASANI_HOST (127.0.0.1), PORT (8787), NASANI_CONCURRENCY (2).
Bridge credential: NASANI_TOKEN, or NASANI_TOKEN_FILE, or ~/.config/nasani/token.
Figma is authenticated separately through the official Figma MCP in your AI host.
`;
function parse(argv) {
    const [command, ...flags] = argv;
    const options = {};
    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (!/^--[a-z-]+$/.test(flag) || flag in options) throw new Error('Expected unique --flag value pairs.');
        if (flag === '--mcp-only') { options[flag] = true; continue; }
        if (!flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}.`);
        options[flag] = flags[++i];
    }
    return { command, options };
}
async function main() {
    if (!process.argv[2] || ['--help', '-h', 'help'].includes(process.argv[2])) return process.stdout.write(HELP);
    const { command, options: o } = parse(process.argv.slice(2));
    const allowed = {
        local: ['project'], bridge: ['project', 'url', 'token-file'],
        serve: ['access-file', 'url', 'host', 'port'], keygen: ['access-file', 'member'], revoke: ['access-file', 'member'],
        install: ['client', 'project', 'mode', 'url', 'token-file', 'mcp-only'], token: ['token-file']
    };
    if (!allowed[command]) throw new Error('Unknown command; use --help.');
    for (const key of Object.keys(o)) if (!allowed[command].includes(key.slice(2))) throw new Error(`Unsupported ${key} for ${command}.`);
    if (['local', 'bridge'].includes(command)) {
        const { projectRoot } = require('../lib/project.cjs');
        const root = projectRoot(o['--project']);
        let remote;
        if (command === 'bridge') remote = await require('../lib/bridge.cjs').connectRemote(o['--url'] || process.env.NASANI_URL, o['--token-file']);
        const server = require('../lib/tools.cjs').createServer({ mode: command, root, remoteCall: remote?.call });
        const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
        const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 });
        await server.connect(transport);
        let stopping = false;
        async function stop() { if (stopping) return; stopping = true; await server.close(); await remote?.close(); }
        process.stdin.on('end', () => stop().catch(() => {}));
        process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
        process.once('SIGINT', () => stop().finally(() => process.exit(0)));
    } else if (command === 'serve') {
        const port = Number(o['--port'] || process.env.PORT || 8787);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
        const accessFile = o['--access-file'] || process.env.NASANI_ACCESS_FILE;
        const url = o['--url'] || process.env.NASANI_PUBLIC_URL;
        if (!accessFile || !url) throw new Error('Set NASANI_ACCESS_FILE and NASANI_PUBLIC_URL, or pass --access-file and --url.');
        const server = require('../lib/http.cjs').createHttpServer({ accessFile, url, concurrency: Number(process.env.NASANI_CONCURRENCY || 2) });
        server.listen(port, o['--host'] || process.env.NASANI_HOST || '127.0.0.1', () => process.stderr.write(`NASANI listening on port ${port}; endpoint ${url}\n`));
        server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
        function stop() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 35000).unref(); }
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
    } else if (command === 'install') {
        const result = require('../lib/install.cjs').install({ project: o['--project'], client: o['--client'], mode: o['--mode'], url: o['--url'], tokenFile: o['--token-file'], mcpOnly: Boolean(o['--mcp-only']) });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (command === 'token') {
        const filename = path.resolve(o['--token-file'] || process.env.NASANI_TOKEN_FILE || path.join(os.homedir(), '.config/nasani/token'));
        let value = '';
        for await (const chunk of process.stdin) { value += chunk; if (Buffer.byteLength(value) > 256) throw new Error('Token input too long.'); }
        value = value.trim();
        if (!/^ns_[a-zA-Z0-9_-]{43}$/.test(value)) throw new Error('Invalid NASANI token.');
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, `${value}\n`, { mode: 0o600, flag: 'wx' });
        process.stdout.write(`Token stored in ${filename}\n`);
    } else {
        if (!o['--access-file']) throw new Error('--access-file is required.');
        const token = require('../lib/access.cjs').changeMember(o['--access-file'], o['--member'], command === 'revoke');
        process.stdout.write(token ? `${token}\n` : `Revoked ${o['--member']}.\n`);
    }
}
main().catch(error => { process.stderr.write(`NASANI: ${error.message}\n`); process.exitCode = 1; });
