'use strict';

const http = require('node:http');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createServer } = require('./tools.cjs');
const { readAccess, authenticate } = require('./access.cjs');
const BODY_LIMIT = 112 * 1024 * 1024;

function publicUrl(value) {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') throw new Error('URL must be https://your-domain/mcp (HTTP allowed only on loopback).');
    return url;
}
function createHttpServer({ accessFile, url, concurrency = 2, perMinute = 120 }) {
    const endpoint = publicUrl(url);
    readAccess(accessFile);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1–8.');
    let active = 0;
    const busy = new Set();
    const rates = new Map();
    const server = http.createServer(async (req, res) => {
        const reply = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' }); res.end(JSON.stringify({ error: message })); };
        if (req.headers.host !== endpoint.host || (req.headers.origin && req.headers.origin !== endpoint.origin)) return reply(403, 'Host or Origin rejected.');
        if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
        if (req.url !== '/mcp') return reply(404, 'Not found.');
        let member;
        try { member = authenticate(accessFile, req.headers.authorization); }
        catch { return reply(503, 'Access configuration unavailable.'); }
        if (!member) return reply(401, 'Invalid NASANI access token.');
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, 'Use stateless MCP POST.'); }
        const now = Date.now();
        for (const [key, item] of rates) if (now - item.start >= 60000) rates.delete(key);
        const rate = rates.get(member) || { start: now, count: 0 };
        rates.set(member, rate);
        if (++rate.count > perMinute) { res.setHeader('Retry-After', '60'); return reply(429, 'Member request limit reached.'); }
        if (active >= concurrency || busy.has(member)) { res.setHeader('Retry-After', '2'); return reply(429, 'Runner busy; retry after the current request.'); }
        if (Number(req.headers['content-length']) > BODY_LIMIT) return reply(413, 'Request exceeds 112 MiB.');
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, 'Expected application/json.');
        active++; busy.add(member);
        let mcp;
        const deadline = setTimeout(() => res.destroy(), 60000);
        try {
            const chunks = []; let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > BODY_LIMIT) { reply(413, 'Request exceeds 112 MiB.'); return; }
                chunks.push(chunk);
            }
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return reply(400, 'Invalid JSON.'); }
            // ponytail: one tool call per request bounds worker count; add batch scheduling only if a client needs it.
            if (Array.isArray(body)) return reply(400, 'Batch requests are not supported.');
            mcp = createServer({ mode: 'remote' });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: BODY_LIMIT });
            await mcp.connect(transport);
            res.setHeader('Cache-Control', 'no-store');
            await transport.handleRequest(req, res, body);
        } catch {
            if (!res.headersSent && !res.destroyed) reply(500, 'Request failed.');
            else res.destroy();
        } finally {
            clearTimeout(deadline);
            await mcp?.close().catch(() => {});
            active--; busy.delete(member);
        }
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 60000;
    server.keepAliveTimeout = 5000;
    server.maxConnections = 64;
    return server;
}
module.exports = { createHttpServer, publicUrl, BODY_LIMIT };
