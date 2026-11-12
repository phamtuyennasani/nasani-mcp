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
    ['nasani_workflow', 'Get bundled Figma-to-code instructions once if the nasani-figma skill is not loaded. Use the connected host Figma MCP and active AI session to implement directly in the project; reuse supplied design context. No Figma preflight, separate AI key or ZIP.'],
    ['nasani_environment', 'Inspect runner dependencies or resolve an unknown mode/project root. Skip when initialization, workflow or the local helper already identifies the target. Does not authenticate or test Figma.'],
    ['nasani_validate', 'AST validation for NASANI standalone index.html + style.css; not an app-framework validator or visual comparison.'],
    ['nasani_format', 'Check assets, validate before/after and format standalone HTML/CSS in one call. Returns detailed errors on failure; repair them without a separate diagnostic validate call. On success validate again only if source/assets/options change. Local/bridge writes changed source files; remote returns source. Inspect the diff and render afterwards.'],
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
        instructions: `NASANI mode: ${mode}; project_root: ${JSON.stringify(root || null)}. Local/bridge directories are relative to this root; stop and correct configuration if it differs from the requested project. Remote tools have no filesystem root and accept explicit bundles. Use the loaded nasani-figma skill or call nasani_workflow once. Follow the host Figma design-to-code skill when available; call get_design_context directly for missing data, without health/auth probes. Report actual errors. The active AI session and host file tools implement directly; no AI token access, separate AI API or ZIP unless requested. Use nasani_format once source/assets exist; it includes asset checks and before/after validation with detailed errors. nasani_environment is only needed for an unknown target or runtime diagnosis. Inspect the diff and verify browser rendering. Never upload secrets or unrelated source trees.`
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
