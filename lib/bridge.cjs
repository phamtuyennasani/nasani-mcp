'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { publicUrl } = require('./http.cjs');

function readToken(filename) {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 256 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Token file must be private (chmod 600) and at most 256 bytes.');
    return fs.readFileSync(filename, 'utf8').trim();
}
async function connectRemote(url, tokenFile) {
    const token = process.env.NASANI_TOKEN || readToken(tokenFile || process.env.NASANI_TOKEN_FILE || path.join(os.homedir(), '.config/nasani/token'));
    if (!/^ns_[a-zA-Z0-9_-]{43}$/.test(token)) throw new Error('Missing or invalid NASANI_TOKEN/token file.');
    const endpoint = publicUrl(url);
    const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
        fetch: async (input, init) => {
            const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(65000)]) });
            if (Number(response.headers.get('content-length')) > 112 * 1024 * 1024) { await response.body?.cancel(); throw new Error('Remote response exceeds budget.'); }
            if (!response.body) return response;
            const reader = response.body.getReader(); let size = 0;
            const body = new ReadableStream({
                async pull(controller) {
                    try {
                        const { value, done } = await reader.read();
                        if (done) return controller.close();
                        size += value.byteLength;
                        if (size > 112 * 1024 * 1024) { await reader.cancel(); return controller.error(new Error('Remote response exceeds budget.')); }
                        controller.enqueue(value);
                    } catch (error) { controller.error(error); }
                },
                cancel: reason => reader.cancel(reason)
            });
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
    });
    const client = new Client({ name: 'nasani-project-bridge', version: require('../package.json').version });
    try { await client.connect(transport); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    return {
        close: () => client.close(),
        async call(name, args) {
            const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 65000 });
            const text = result.content?.find(item => item.type === 'text')?.text;
            const data = JSON.parse(text || 'null');
            if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') throw new Error('Invalid NASANI server response.');
            return data;
        }
    };
}
module.exports = { connectRemote };
