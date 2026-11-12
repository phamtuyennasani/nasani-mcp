'use strict';

const fs = require('node:fs');
const path = require('node:path');
const runner = require('./engine/runner.cjs');

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function projectRoot(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('--project requires an absolute directory.');
    const root = fs.realpathSync(value);
    if (!fs.statSync(root).isDirectory() || root === path.parse(root).root) throw new Error('Use a project directory, not the filesystem root.');
    return root;
}
function sourceDirectory(root, value, writing = false) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0') || path.isAbsolute(value)) throw new Error('directory must be a nonempty project-relative path.');
    const target = path.resolve(root, value);
    if (!inside(root, target)) throw new Error('directory escapes the configured project root.');
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('directory may not contain symlinks.');
    }
    if (!fs.statSync(target).isDirectory() || !inside(root, fs.realpathSync(target))) throw new Error('directory must remain inside the project.');
    for (const name of ['index.html', 'style.css']) {
        const stat = fs.lstatSync(path.join(target, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > runner.LIMITS.sourceBytes) throw new Error(`${name} must be a regular source file within the source budget.`);
        if (writing && stat.nlink !== 1) throw new Error(`Refusing to format hard-linked ${name}.`);
    }
    return target;
}
function readSources(directory) {
    const source = {
        html: fs.readFileSync(path.join(directory, 'index.html'), 'utf8'),
        css: fs.readFileSync(path.join(directory, 'style.css'), 'utf8')
    };
    if (Buffer.byteLength(source.html) + Buffer.byteLength(source.css) > runner.LIMITS.sourceBytes) throw new Error('Combined HTML/CSS exceeds 16 MiB.');
    return source;
}
function replaceSources(directory, original, next) {
    if (typeof next?.html !== 'string' || typeof next?.css !== 'string'
        || Buffer.byteLength(next.html) + Buffer.byteLength(next.css) > runner.LIMITS.sourceBytes) throw new Error('Invalid formatted source response.');
    const current = readSources(directory);
    if (current.html !== original.html || current.css !== original.css) throw new Error('Source changed while processing; no remote result was applied. Retry after reviewing the current files.');
    const changed = [['html', 'index.html'], ['css', 'style.css']].filter(([key]) => next[key] !== original[key]);
    try {
        for (const [key, name] of changed) fs.writeFileSync(path.join(directory, name), next[key]);
    } catch (error) {
        const failures = [];
        for (const [key, name] of changed) {
            try { fs.writeFileSync(path.join(directory, name), original[key]); }
            catch (restoreError) { failures.push(`${name}: ${restoreError.message}`); }
        }
        throw new Error(`${error.message}${failures.length ? `; restore failed: ${failures.join('; ')}` : '; original sources restored'}`);
    }
}
function collectBundle(directory) {
    const source = readSources(directory);
    const checked = runner.outputAssets({ directory });
    if (!checked.ok) throw new Error(checked.errors.join('; '));
    return {
        ...source,
        assets: checked.assets.map(name => ({ path: name, base64: fs.readFileSync(path.join(directory, name)).toString('base64') }))
    };
}

module.exports = { projectRoot, sourceDirectory, readSources, replaceSources, collectBundle };
