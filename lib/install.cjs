'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('./project.cjs');

function install({ project, client, mode = 'local', url, tokenFile, mcpOnly = false }) {
    const root = projectRoot(project);
    if (!['codex', 'claude'].includes(client)) throw new Error('--client must be codex or claude.');
    if (!['local', 'bridge'].includes(mode)) throw new Error('--mode must be local or bridge.');
    if (mode === 'bridge') require('./http.cjs').publicUrl(url);
    const home = path.resolve(__dirname, '..');
    function checkTarget(filename) {
        let current = root;
        for (const part of path.relative(root, filename).split(path.sep)) {
            current = path.join(current, part);
            try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Install target contains a symlink: ${current}`); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    const args = [path.join(home, 'bin/nasani.cjs'), mode, '--project', root];
    if (mode === 'bridge') {
        args.push('--url', url);
        if (tokenFile) args.push('--token-file', path.resolve(tokenFile));
    }
    const targets = [];
    const stage = (filename, content) => targets.push({ filename, content });
    function copyTree(source, target) {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const from = path.join(source, entry.name), to = path.join(target, entry.name);
            if (entry.isDirectory()) copyTree(from, to);
            else if (entry.isFile()) stage(to, fs.readFileSync(from));
            else throw new Error('Packaged skills may not contain symlinks.');
        }
    }
    const config = path.join(root, client === 'codex' ? '.codex/config.toml' : '.mcp.json');
    checkTarget(config);
    const old = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
    let next;
    if (client === 'codex') {
        const block = `[mcp_servers.nasani]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n${mode === 'bridge' ? 'env_vars = ["NASANI_TOKEN", "NASANI_TOKEN_FILE"]\n' : ''}`;
        if (/^\s*\[\s*mcp_servers\s*\.\s*["']?nasani["']?\s*\]/m.test(old)) {
            if (!old.includes(block)) throw new Error('Existing nasani MCP config differs. Update/remove that entry explicitly before reinstalling.');
            next = old;
        } else next = `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${block}`;
    } else {
        const data = old ? JSON.parse(old) : {};
        if (!data || Array.isArray(data) || typeof data !== 'object' || (data.mcpServers && (Array.isArray(data.mcpServers) || typeof data.mcpServers !== 'object'))) throw new Error('Invalid .mcp.json.');
        data.mcpServers ||= {};
        const entry = { type: 'stdio', command: process.execPath, args };
        if (data.mcpServers.nasani && JSON.stringify(data.mcpServers.nasani) !== JSON.stringify(entry)) throw new Error('Existing nasani MCP config differs. Update/remove that entry explicitly before reinstalling.');
        data.mcpServers.nasani = entry;
        next = `${JSON.stringify(data, null, 2)}\n`;
    }
    if (!mcpOnly) {
        copyTree(path.join(home, 'skills/nasani-figma'), path.join(root, client === 'codex' ? '.agents/skills/nasani-figma' : '.claude/skills/nasani-figma'));
        const agent = client === 'codex' ? 'nasani-figma.toml' : 'nasani-figma.md';
        stage(path.join(root, client === 'codex' ? '.codex/agents' : '.claude/agents', agent), fs.readFileSync(path.join(home, 'agents', client, agent)));
    }
    for (const { filename, content } of targets) {
        checkTarget(filename);
        if (fs.existsSync(filename) && !fs.readFileSync(filename).equals(Buffer.from(content))) throw new Error(`Existing customized file retained: ${filename}`);
    }
    stage(config, next);
    const changed = [];
    for (const { filename, content } of targets) {
        if (fs.existsSync(filename) && fs.readFileSync(filename).equals(Buffer.from(content))) continue;
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
        changed.push(filename);
    }
    return { ok: true, client, mode, project: root, mcp_only: mcpOnly, changed };
}
module.exports = { install };
