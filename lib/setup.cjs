'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { projectRoot } = require('./project.cjs');

async function setup({ project, client, mcpOnly = false }) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('NASANI requires Node.js >=22.');
    const root = projectRoot(project);
    if (client === undefined) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run setup in a Terminal, or pass --client codex|claude|both.');
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
            console.log(`\nNASANI MCP — cài vào ${root}\n\n  1) Codex\n  2) Claude Code\n  3) Cả hai\n`);
            while (!client) {
                const answer = (await prompt.question('Chọn [1/2/3] (Enter = Codex): ')).trim() || '1';
                client = { '1': 'codex', '2': 'claude', '3': 'both' }[answer];
                if (!client) console.log('Vui lòng nhập 1, 2 hoặc 3.');
            }
        } finally { prompt.close(); }
    }
    if (!['codex', 'claude', 'both'].includes(client)) throw new Error('--client must be codex, claude or both.');
    const home = path.resolve(__dirname, '..');
    const prefix = path.join(os.homedir(), '.local/share/nasani-mcp/runtime');
    const runtime = path.join(prefix, 'node_modules/@nasani/figma-mcp');
    // ponytail: one runtime per user; use versioned installs if parallel versions become necessary.
    if (!fs.existsSync(runtime) || home !== fs.realpathSync(runtime)) {
        console.log('Đang cài NASANI vào vị trí cố định…');
        const npm = process.env.npm_execpath || (process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined);
        const result = spawnSync(npm ? process.execPath : 'npm', [
            ...(npm ? [npm] : []), 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
            '--no-save', '--no-package-lock', '--install-links', '--', home
        ], { stdio: 'inherit' });
        if (result.error || result.status !== 0) throw new Error(`Runtime install failed: ${result.error?.message || result.signal || result.status}. Project configuration was not changed.`);
    }
    if (!fs.statSync(path.join(runtime, 'bin/nasani.cjs')).isFile()) throw new Error('Persistent NASANI runtime is missing.');
    const { install } = require(path.join(runtime, 'lib/install.cjs'));
    const clients = client === 'both' ? ['codex', 'claude'] : [client];
    for (const selected of clients) install({ project: root, client: selected, mcpOnly, dryRun: true });
    for (const selected of clients) {
        const result = install({ project: root, client: selected, mcpOnly });
        console.log(`✓ ${selected}: ${result.changed.length ? 'đã cài' : 'đã có đúng cấu hình'}`);
    }
    console.log(`\nDự án: ${root}\nNASANI: ${runtime}\nMở lại Codex/Claude, chấp thuận MCP/trust dự án, rồi yêu cầu: Gọi nasani_environment.\nKết nối Figma MCP riêng bằng tài khoản Figma của bạn nếu chưa có.`);
}

module.exports = { setup };
