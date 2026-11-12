'use strict';

const fs = require('node:fs');
const path = require('node:path');
const runner = require('./engine/runner.cjs');
const { readSources } = require('./project.cjs');

function run(name, args, directory) {
    if (name === 'nasani_environment') return { ...runner.environment(), mode: 'remote', storage: 'ephemeral per call', figma_auth: 'official Figma MCP in the coding host' };
    const { bundle, ...options } = args;
    if (Buffer.byteLength(bundle.html) + Buffer.byteLength(bundle.css) > runner.LIMITS.sourceBytes) throw new Error('Combined HTML/CSS exceeds 16 MiB.');
    try {
        fs.writeFileSync(path.join(directory, 'index.html'), bundle.html);
        fs.writeFileSync(path.join(directory, 'style.css'), bundle.css);
        const seen = new Set();
        let total = 0;
        for (const asset of bundle.assets) {
            if (!/^assets\/[a-zA-Z0-9_./ ;\-]+$/.test(asset.path) || asset.path.length > 1024
                || asset.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(asset.path)) throw new Error('Unsafe or duplicate asset path.');
            if (asset.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(asset.base64)) throw new Error('Invalid base64 asset.');
            const bytes = Buffer.from(asset.base64, 'base64');
            if (bytes.toString('base64') !== asset.base64) throw new Error('Invalid base64 asset.');
            total += bytes.length;
            if (bytes.length > runner.LIMITS.assetBytes || total > runner.LIMITS.totalAssetBytes) throw new Error('Asset byte budget exceeded.');
            seen.add(asset.path);
            const filename = path.join(directory, asset.path);
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, bytes, { flag: 'wx' });
        }
        const request = { ...options, directory };
        // Check paths and asset contents even for scripts/invalid candidates. Never prune.
        const assets = runner.outputAssets(request);
        if (!assets.ok) return assets;
        if (name === 'nasani_assets') return assets;
        if (name === 'nasani_validate') return runner.validate(request);
        if (name === 'nasani_swiper_scripts') return runner.scripts(request);
        if (name !== 'nasani_format') throw new Error('Unknown operation.');
        const result = runner.format(request);
        return result.ok ? { ...result, source: readSources(directory) } : result;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

process.once('message', ({ name, args, directory }) => {
    let result;
    try { result = run(name, args, directory); }
    catch (error) { result = { ok: false, errors: [error.message] }; }
    if (result.errors) result.errors = result.errors.map(message => message.split(directory).join('[job]'));
    process.send(result, () => process.disconnect());
});
