'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fork } = require('node:child_process');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const runner = require('./engine/runner.cjs');
const { sourceDirectory, collectBundle, readSources, replaceSources } = require('./project.cjs');
const { version } = require('../package.json');
const { workflow } = require('./workflow.cjs');

const entries = z.array(z.strictObject({
    selector: z.string().min(1).max(160),
    mobile_only: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional()
})).max(20);
const bundle = z.strictObject({
    html: z.string().max(runner.LIMITS.sourceBytes),
    css: z.string().max(runner.LIMITS.sourceBytes),
    assets: z.array(z.strictObject({ path: z.string().max(1024), base64: z.string().max(Math.ceil(runner.LIMITS.assetBytes / 3) * 4) })).max(runner.LIMITS.assets)
});
const definitions = [
    ['nasani_workflow', 'Hand off Figma reading to the already connected host Figma MCP: use skill figma-design-to-code and call get_design_context directly. Do not probe Figma or call nasani_environment first. Get bundled implementation instructions when the nasani-figma skill is not already loaded; reuse them in this session. Pass the Figma URL, target and optional context returned by the host Figma MCP. Use the host model and file tools to write directly into the project. No separate AI key, NASANI URL or ZIP is needed in local mode.'],
    ['nasani_environment', 'Check NASANI runner dependencies and project root only when a runner tool is needed. It does not check or authenticate Figma; the host Figma MCP owns that connection.'],
    ['nasani_validate', 'AST validation for NASANI standalone index.html + style.css; not an app-framework validator or visual comparison.'],
    ['nasani_format', 'Check assets, validate before/after and format a NASANI standalone candidate in one call. No separate validation is needed on success unless source/assets/options change. Local/bridge mode rewrites only index.html and style.css; direct remote mode returns source. Inspect the resulting diff and render afterwards.'],
    ['nasani_assets', 'Audit local asset references and the existing asset security policy. Never downloads or deletes assets.'],
    ['nasani_swiper_scripts', 'Check NASANI slider markup and return trusted helper/app source, normalized Swiper config and pinned URLs. Does not write or run JS.']
];
function schema(name, remote) {
    if (name === 'nasani_workflow') return z.strictObject({
        design_url: z.url().max(4096).refine(value => { const url = new URL(value); return url.protocol === 'https:' && ['figma.com', 'www.figma.com'].includes(url.hostname) && !url.username && !url.password; }, 'Use an HTTPS Figma design URL.'),
        target: z.string().min(1).max(4096).describe('Requested project route, component or project-relative output directory.'),
        output_mode: z.enum(['application', 'standalone']).default('application'),
        figma_context: z.string().max(16000).optional().describe('Concise design data returned by the coding host Figma MCP. No credentials; full context and screenshots can remain in the coding session.')
    });
    if (name === 'nasani_environment') return z.strictObject({});
    const fields = remote ? { bundle } : { directory: z.string().min(1).max(4096).describe('Existing output directory relative to the configured project root.') };
    if (['nasani_validate', 'nasani_format'].includes(name)) {
        fields.content_width = z.number().int().min(1).max(16384).describe('Exact .wrap-content CSS max-width, including padding.');
        fields.require_responsive_breakpoints = z.boolean().optional();
        fields.swipers = entries.optional();
    }
    if (name === 'nasani_swiper_scripts') fields.swipers = entries;
    return z.strictObject(fields);
}
function processBundle(name, args) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nasani-job-'));
    return new Promise((resolve, reject) => {
        let worker;
        try { worker = fork(path.join(__dirname, 'worker.cjs'), [], {
            execArgv: ['--max-old-space-size=384'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            // No access-file path, user API keys or provider secrets in worker env.
            env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || require('node:os').tmpdir() }
        }); } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); reject(error); return; }
        let result, failure;
        let settled = false;
        const timer = setTimeout(() => { failure = new Error('Runner timed out after 30 seconds.'); worker.kill('SIGKILL'); }, 30000);
        function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { fs.rmSync(directory, { recursive: true, force: true }); }
            catch (cleanupError) { error ||= cleanupError; }
            error ? reject(error) : resolve(result);
        }
        worker.on('message', value => { result = value; });
        worker.once('error', finish);
        worker.once('exit', code => finish(failure || (result ? null : new Error(`Runner exited without a result (${code}).`))));
        worker.send({ name, args, directory }, error => { if (error) { failure = error; worker.kill('SIGKILL'); } });
    });
}
function createServer({ mode, root, remoteCall }) {
    const remote = mode === 'remote';
    const server = new McpServer({ name: 'nasani-mcp', version }, {
        instructions: 'For Figma-to-code, use the loaded nasani-figma skill or call nasani_workflow once for the Figma handoff and bundled instructions. The host must call its connected Figma MCP get_design_context directly before implementation; do not run a Figma health check or call nasani_environment first. If Figma returns an error, report that exact error. Use nasani_environment only when a NASANI runner tool is needed. Use the active coding session model to analyze design context from the host official Figma MCP, and the host file tools to implement directly in the selected project. Do not produce a ZIP unless requested. NASANI does not access AI login tokens or call an AI API. Local mode needs no NASANI URL or token. Local/bridge source tools use project-relative directories; remote source tools accept explicit bundles. Never upload secrets or unrelated project files.'
    });
    for (const [name, description] of definitions) {
        server.registerTool(name, {
            description, inputSchema: schema(name, remote),
            annotations: { readOnlyHint: remote || name !== 'nasani_format', destructiveHint: !remote && name === 'nasani_format', idempotentHint: true, openWorldHint: mode !== 'local' }
        }, async args => {
            try {
                let result;
                if (name === 'nasani_workflow') result = workflow(args, mode, root);
                else if (remote) result = await processBundle(name, args);
                else if (name === 'nasani_environment') {
                    result = mode === 'bridge' ? await remoteCall(name, {}) : runner.environment();
                    result = { ...result, mode, project_root: root };
                } else {
                    const writing = name === 'nasani_format';
                    const directory = sourceDirectory(root, args.directory, writing);
                    const input = collectBundle(directory);
                    const { directory: ignored, ...options } = args;
                    result = mode === 'bridge' ? await remoteCall(name, { ...options, bundle: input }) : await processBundle(name, { ...options, bundle: input });
                    if (writing && result.ok) {
                        // Recheck containment and concurrent edits before applying the result.
                        sourceDirectory(root, args.directory, true);
                        replaceSources(directory, { html: input.html, css: input.css }, result.source);
                        const verified = readSources(directory);
                        if (verified.html !== result.source.html || verified.css !== result.source.css) throw new Error('Formatted source read-back mismatch.');
                        delete result.source;
                    }
                }
                return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.ok === false };
            } catch (error) {
                return { content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: [error.message] }) }], isError: true };
            }
        });
    }
    return server;
}

module.exports = { createServer, processBundle };
