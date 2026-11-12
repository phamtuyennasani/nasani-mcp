'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createHttpServer, BODY_LIMIT } = require('../lib/http.cjs');
const { changeMember } = require('../lib/access.cjs');
const { createServer, processBundle } = require('../lib/tools.cjs');
const { install } = require('../lib/install.cjs');
const { replaceSources, readSources } = require('../lib/project.cjs');
const cli = path.resolve(__dirname, '../bin/nasani.cjs');
const html = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Test</title><link rel="stylesheet" href="style.css"></head><body><div class="hero-wrap"><div class="wrap-content"><div class="hero-layout"><h2 class="hero__title">NASANI</h2></div></div></div></body></html>';
const css = '.wrap-content{max-width:1200px;margin-inline:auto;padding-inline:15px;width:100%;box-sizing:border-box}.hero__title{color:#123456}';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z" fill="#123456"/></svg>';
function fixture(directory) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), html);
    fs.writeFileSync(path.join(directory, 'style.css'), css);
}
async function local(t, args, env) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], env, stderr: 'pipe' });
    const client = new Client({ name: 'nasani-self-check', version: '1' });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
}
async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    let data;
    try { data = JSON.parse(result.content[0].text); }
    catch { data = { ok: false, errors: [result.content[0].text] }; }
    return { ...result, data };
}
test('local, remote, bridge and installer remain independent of the web app', { timeout: 90000 }, async t => {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasani-check-')));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const project = path.join(temporary, 'project');
    const output = path.join(project, 'output');
    const outside = path.join(temporary, 'outside');
    fixture(output); fixture(outside);
    const client = await local(t, ['local', '--project', project]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 6);
    assert.equal(listed.tools.find(item => item.name === 'nasani_format').annotations.readOnlyHint, false);
    assert.equal((await call(client, 'nasani_environment')).data.project_root, project);
    const workflowArgs = { design_url: 'https://www.figma.com/design/example/File?node-id=1-2', target: 'src/pages/Home' };
    const workflow = await call(client, 'nasani_workflow', workflowArgs);
    assert.equal(workflow.data.ok, true);
    assert.equal(workflow.data.project_root, project);
    assert.equal(workflow.data.output_mode, 'application');
    assert.equal(workflow.data.figma_context_received, false);
    assert.equal(workflow.data.standalone_contract, undefined);
    assert.ok(workflow.data.instructions.includes('active Codex/Claude coding session'));
    assert.ok(workflow.data.delivery.includes('directly'));
    const withContext = await call(client, 'nasani_workflow', { ...workflowArgs, output_mode: 'standalone', figma_context: 'Figma MCP: frame width 1440, wrapper max-width 1200.' });
    assert.equal(withContext.data.figma_context_received, true);
    assert.ok(withContext.data.standalone_contract.includes('max-width: 1200px'));
    assert.equal((await call(client, 'nasani_workflow', { ...workflowArgs, design_url: 'https://figma.com.evil.invalid/design/123' })).isError, true);
    assert.equal((await call(client, 'nasani_workflow', { ...workflowArgs, figma_context: 'x'.repeat(16001) })).isError, true);
    const args = { directory: 'output', content_width: 1200 };
    const before = readSources(output);
    assert.equal((await call(client, 'nasani_validate', args)).data.ok, true);
    assert.equal((await call(client, 'nasani_swiper_scripts', { directory: 'output', swipers: [] })).data.ok, true);
    assert.deepEqual(readSources(output), before);
    assert.equal((await call(client, 'nasani_validate', { ...args, content_width: 1199 })).isError, true);
    assert.equal((await call(client, 'nasani_validate', { ...args, content_width: '1200' })).isError, true);
    for (const directory of ['../outside', outside, 'missing']) assert.equal((await call(client, 'nasani_validate', { ...args, directory })).isError, true);
    fs.symlinkSync(outside, path.join(project, 'linked'), 'dir');
    assert.equal((await call(client, 'nasani_format', { ...args, directory: 'linked' })).isError, true);
    const hard = path.join(project, 'hard'); fixture(hard);
    fs.unlinkSync(path.join(hard, 'style.css')); fs.linkSync(path.join(outside, 'style.css'), path.join(hard, 'style.css'));
    assert.equal((await call(client, 'nasani_format', { ...args, directory: 'hard' })).isError, true);
    assert.equal((await call(client, 'nasani_format', args)).data.ok, true);
    const formatted = readSources(output);
    assert.notDeepEqual(formatted, before);
    assert.equal((await call(client, 'nasani_format', args)).data.ok, true);
    assert.deepEqual(readSources(output), formatted);
    const changed = { ...formatted, css: `${formatted.css}\n/* user edit */` };
    fs.writeFileSync(path.join(output, 'style.css'), changed.css);
    assert.throws(() => replaceSources(output, formatted, before), /Source changed/);
    assert.deepEqual(readSources(output), changed);
    const originalWrite = fs.writeFileSync;
    let failed = false;
    fs.writeFileSync = function(filename, ...rest) {
        if (filename === path.join(output, 'style.css') && !failed) { failed = true; throw new Error('simulated second write failure'); }
        return originalWrite.call(this, filename, ...rest);
    };
    try { assert.throws(() => replaceSources(output, changed, before), /original sources restored/); }
    finally { fs.writeFileSync = originalWrite; }
    assert.deepEqual(readSources(output), changed);
    fixture(output);
    fs.mkdirSync(path.join(output, 'assets'));
    fs.writeFileSync(path.join(output, 'assets/icon.svg'), svg);
    fs.writeFileSync(path.join(output, 'index.html'), html.replace('</h2>', '</h2><img class="hero__icon" src="assets/icon.svg" alt="">'));
    fs.appendFileSync(path.join(output, 'style.css'), '.hero__icon{width:10px}');
    fs.writeFileSync(path.join(output, 'assets/unreferenced.txt'), 'must not upload');
    assert.deepEqual((await call(client, 'nasani_assets', { directory: 'output' })).data.assets, ['assets/icon.svg']);

    const accessFile = path.join(temporary, 'access.json');
    const token = changeMember(accessFile, 'alice');
    const bobToken = changeMember(accessFile, 'bob');
    assert.ok(!fs.readFileSync(accessFile, 'utf8').includes(token));
    assert.throws(() => changeMember(accessFile, 'alice'), /already exists/);
    const reservation = require('node:net').createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const url = `http://127.0.0.1:${port}/mcp`;
    const http = createHttpServer({ accessFile, url });
    http.listen(port, '127.0.0.1'); await once(http, 'listening');
    t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const badHost = await new Promise(resolve => {
        const request = require('node:http').request(url, { method: 'POST', headers: { Host: 'evil.invalid', Authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode); });
        request.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.invalid', Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const remote = new Client({ name: 'self-check', version: '1' });
    await remote.connect(transport); t.after(() => remote.close());
    const remoteTools = (await remote.listTools()).tools;
    assert.ok(remoteTools.every(item => item.annotations.readOnlyHint));
    const bundle = { html, css, assets: [] };
    assert.equal((await call(remote, 'nasani_validate', { bundle, content_width: 1200 })).data.ok, true);
    assert.equal((await call(remote, 'nasani_validate', { directory: '/etc', content_width: 1200 })).isError, true);
    const remoteFormat = await call(remote, 'nasani_format', { bundle, content_width: 1200 });
    assert.equal(remoteFormat.data.ok, true);
    assert.ok(remoteFormat.data.source.html.includes('\n'));
    for (const asset of [{ path: 'assets/../../outside.svg', base64: Buffer.from(svg).toString('base64') }, { path: 'assets/icon.svg', base64: 'not base64' }]) {
        assert.equal((await call(remote, 'nasani_assets', { bundle: { ...bundle, assets: [asset] } })).isError, true);
    }
    const missing = await call(remote, 'nasani_assets', { bundle: { ...bundle, html: html.replace('</h2>', '</h2><img src="assets/missing.svg" alt="">') } });
    assert.equal(missing.isError, true);
    assert.ok(!JSON.stringify(missing).includes('nasani-job-'));
    const tokenFile = path.join(temporary, 'token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const bridge = await local(t, ['bridge', '--project', project, '--url', url, '--token-file', tokenFile]);
    assert.equal((await call(bridge, 'nasani_environment')).data.mode, 'bridge');
    assert.equal((await call(bridge, 'nasani_validate', args)).data.ok, true);
    assert.equal((await call(bridge, 'nasani_format', args)).data.ok, true);
    assert.ok(fs.readFileSync(path.join(output, 'index.html'), 'utf8').includes('<svg'));
    assert.equal((await call(bridge, 'nasani_validate', args)).data.ok, true);
    assert.deepEqual(readSources(outside), { html, css });
    const bobTransport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bobToken}` } } });
    const bob = new Client({ name: 'bob', version: '1' });
    await bob.connect(bobTransport); t.after(() => bob.close());
    const isolated = await Promise.all([
        call(remote, 'nasani_format', { bundle: { ...bundle, html: html.replace('NASANI</h2>', 'ALICE</h2>') }, content_width: 1200 }),
        call(bob, 'nasani_format', { bundle: { ...bundle, html: html.replace('NASANI</h2>', 'BOB</h2>') }, content_width: 1200 })
    ]);
    assert.equal(isolated[0].data.ok, true); assert.equal(isolated[1].data.ok, true);
    assert.match(isolated[0].data.source.html, /ALICE/); assert.ok(!isolated[0].data.source.html.includes('BOB'));
    assert.match(isolated[1].data.source.html, /BOB/); assert.ok(!isolated[1].data.source.html.includes('ALICE'));
    changeMember(accessFile, 'alice', true);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 401);
    const bobResult = await call(bob, 'nasani_validate', { bundle: { ...bundle, html: html.replace('NASANI</h2>', 'BOB</h2>') }, content_width: 1200 });
    assert.equal(bobResult.data.ok, true);
    const net = require('node:net');
    const oversized = await new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${bobToken}\r\nContent-Type: application/json\r\nContent-Length: ${BODY_LIMIT + 1}\r\nConnection: close\r\n\r\n`));
        let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data));
    });
    assert.match(oversized, /413/);
    const jobsBefore = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('nasani-job-')).sort();
    await processBundle('nasani_assets', { bundle });
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('nasani-job-')).sort(), jobsBefore);

    fs.mkdirSync(path.join(project, '.codex'));
    fs.writeFileSync(path.join(project, '.codex/config.toml'), 'model = "custom-existing-model"\n');
    const installed = install({ project, client: 'codex' });
    assert.ok(installed.changed.length >= 4);
    assert.match(fs.readFileSync(path.join(project, '.codex/config.toml'), 'utf8'), /^model = "custom-existing-model"/);
    assert.deepEqual(install({ project, client: 'codex' }).changed, []);
    assert.throws(() => install({ project, client: 'codex', mode: 'bridge', url }), /config differs/);
    fs.writeFileSync(path.join(project, '.mcp.json'), '{"otherSetting":true,"mcpServers":{"other":{"command":"existing"}}}');
    install({ project, client: 'claude', mode: 'bridge', url, tokenFile });
    const config = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json')));
    assert.equal(config.otherSetting, true); assert.equal(config.mcpServers.other.command, 'existing');
    assert.ok(!JSON.stringify(config).includes(token));
    const onlyProject = path.join(temporary, 'mcp-only'); fs.mkdirSync(onlyProject);
    const onlyInstall = spawnSync(process.execPath, [cli, 'install', '--client', 'codex', '--project', onlyProject, '--mcp-only'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(onlyInstall.status, 0, onlyInstall.stderr);
    const onlyResult = JSON.parse(onlyInstall.stdout);
    assert.equal(onlyResult.mcp_only, true);
    assert.deepEqual(onlyResult.changed, [path.join(onlyProject, '.codex/config.toml')]);
    const onlyConfig = fs.readFileSync(path.join(onlyProject, '.codex/config.toml'), 'utf8');
    assert.ok(!/NASANI_TOKEN|env_vars|https?:/.test(onlyConfig));
    assert.ok(!fs.existsSync(path.join(onlyProject, '.agents')));
    assert.ok(!fs.existsSync(path.join(onlyProject, '.codex/agents')));
    const onlyClient = await local(t, ['local', '--project', onlyProject], { PATH: process.env.PATH });
    assert.equal((await call(onlyClient, 'nasani_workflow', workflowArgs)).data.ok, true);
    assert.equal((await call(onlyClient, 'nasani_environment')).data.ok, true);
    const customSkill = path.join(project, '.agents/skills/nasani-figma/SKILL.md');
    fs.appendFileSync(customSkill, '\nPersonal instructions retained.\n');
    assert.throws(() => install({ project, client: 'codex' }), /customized file retained/);
    assert.match(fs.readFileSync(customSkill, 'utf8'), /Personal instructions retained/);
    const invalid = spawnSync(process.execPath, [cli, 'serve'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /NASANI_ACCESS_FILE/);
    // Simulate an edit arriving while a hosted format is running, through the real tool callback.
    const raced = createServer({ mode: 'bridge', root: project, remoteCall: async (name, input) => {
        const result = await processBundle(name, input);
        fs.appendFileSync(path.join(output, 'style.css'), '\n/* concurrent edit */');
        return result;
    } });
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const racingClient = new Client({ name: 'race', version: '1' });
    await raced.connect(a); await racingClient.connect(b);
    const rejected = await call(racingClient, 'nasani_format', args);
    assert.equal(rejected.isError, true); assert.match(rejected.data.errors[0], /Source changed/);
    assert.match(fs.readFileSync(path.join(output, 'style.css'), 'utf8'), /concurrent edit/);
    await racingClient.close(); await raced.close();
});
