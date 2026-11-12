'use strict';

// Internal CLI: node lib/engine/runner.cjs environment|validate|format|preview|assets|scripts [request.json]
// All stdout is one JSON object. Validation is local and requires no browser.
const fs = require('node:fs');
const path = require('node:path');
const svg = require('./svg.cjs');
const swiper = require('./swiper.cjs');

const DEPENDENCIES = Object.freeze({
    parse5: '6.0.1',
    'css-tree': '2.3.1'
});
const LIMITS = Object.freeze({
    requestBytes: 64 * 1024,
    // Published HTML + CSS, including embedded SVGs; not the raw AI response cap.
    sourceBytes: 16 * 1024 * 1024,
    assetBytes: 20 * 1024 * 1024,
    totalAssetBytes: 64 * 1024 * 1024,
    assets: 512,
    nodes: 100000,
    depth: 320,
    dimension: 16384,
    pixels: 16000000,
    totalAssetPixels: 128000000,
    errors: 200
});
const CONTENT_TAGS = new Set('div span h2 h3 h4 h5 h6 p a ul li form label input select textarea button img'.split(' '));
const DOCUMENT_TAGS = new Set(['html', 'head', 'body', 'meta', 'link', 'title']);
const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.otf']);
const NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const BEM = new RegExp(`^(${NAME})(?:__(${NAME}))?(?:--(${NAME}))?$`);
const UNSAFE_CSS_FUNCTIONS = new Set('var env expression paint element image -webkit-cross-fade cross-fade image-set -webkit-image-set src attr local'.split(' '));
const PREVIEW_CSS_NODES = new Set(('StyleSheet Rule SelectorList Selector TypeSelector ClassSelector IdSelector Combinator '
    + 'PseudoClassSelector PseudoElementSelector Nth AnPlusB Block Declaration Value Identifier Number Dimension Percentage '
    + 'Hash String Url Function Operator Parentheses Brackets Atrule AtrulePrelude MediaQueryList MediaQuery MediaFeature Ratio').split(' '));
const PREVIEW_CSS_FUNCTIONS = new Set(('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark '
    + 'calc min max clamp round mod rem abs sign sin cos tan asin acos atan atan2 pow sqrt hypot log exp '
    + 'linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient conic-gradient repeating-conic-gradient '
    + 'translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d '
    + 'skew skewx skewy matrix matrix3d perspective cubic-bezier steps linear blur brightness contrast drop-shadow grayscale '
    + 'hue-rotate invert opacity saturate sepia repeat minmax fit-content format tech counter counters symbols').split(' '));

function dependencies(names) {
    const result = {};
    for (const name of names) {
        try { result[name] = require(name); }
        catch { throw new Error(`Missing dependency ${name}@${DEPENDENCIES[name]}. Run npm ci in the NASANI package directory.`); }
    }
    return result;
}

function environment() {
    const modules = {};
    for (const [name, version] of Object.entries(DEPENDENCIES)) {
        try {
            require(name);
            modules[name] = { available: true, required_version: version };
        } catch {
            modules[name] = { available: false, required_version: version };
        }
    }
    return {
        ok: Object.values(modules).every(item => item.available),
        node: process.version,
        dependencies: modules,
        install_dependencies: 'npm ci (in the NASANI package directory)'
    };
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readLimited(filename, maximum) {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > maximum) throw new Error(`File is missing, not regular, or exceeds ${maximum} bytes: ${filename}`);
    return fs.readFileSync(filename);
}

function assertSourceBudget(html, css, maximum = LIMITS.sourceBytes) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > LIMITS.sourceBytes
        || Buffer.byteLength(html) + Buffer.byteLength(css) > maximum) throw new Error('Published source exceeds the combined source byte budget.');
}

function assertHtmlBudget(document) {
    const stack = [{ node: document, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
        if (node.content) stack.push({ node: node.content, depth: depth + 1 });
    }
}

function integer(value, name, maximum = LIMITS.dimension) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    return value;
}

function assetPath(value, state) {
    // Keep literal semicolons in Figma instance exports; never decode percent escapes:
    // the browser must see exactly what was checked.
    if (typeof value !== 'string' || !/^assets\/[a-zA-Z0-9_./ ;\-]+$/.test(value) || value !== value.trim()
        || value.includes('//') || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe asset URL: ${String(value).slice(0, 160)}`);
    }
    if (!ASSET_EXTENSIONS.has(path.extname(value).toLowerCase())) throw new Error(`Unsupported asset type: ${value}`);
    const filename = path.resolve(state.directory, value);
    const assetsRoot = path.resolve(state.directory, 'assets');
    if (!inside(assetsRoot, filename)) throw new Error(`Asset escapes assets/: ${value}`);
    if (state.preview) assertNoSymlinks(filename);
    const realRoot = fs.realpathSync(assetsRoot);
    const real = fs.realpathSync(filename);
    if (!inside(state.directory, realRoot) || !inside(realRoot, real)) throw new Error(`Asset symlink escapes assets/: ${value}`);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > LIMITS.assetBytes) throw new Error(`Asset is not regular or is too large: ${value}`);
    if (!state.assets.has(filename)) {
        const buffer = readLimited(real, LIMITS.assetBytes);
        state.assetPixels += inspectAsset(buffer, path.extname(value).toLowerCase());
        if (state.assetPixels > LIMITS.totalAssetPixels) throw new Error(`Total decoded asset pixel budget exceeded: ${state.assetPixels} > ${LIMITS.totalAssetPixels}.`);
        state.totalAssetBytes += stat.size;
        if (state.assets.size >= LIMITS.assets || state.totalAssetBytes > LIMITS.totalAssetBytes) throw new Error('Asset budget exceeded.');
        state.assets.set(filename, real);
        if (state.preview) state.assetBuffers.set(filename, buffer);
    }
    return filename;
}

function inspectAsset(buffer, extension) {
    if (extension === '.svg') return svg.inspect(buffer).pixels;
    let width;
    let height;
    if (extension === '.png') {
        const dimensions = pngDimensions(buffer);
        if (buffer.includes(Buffer.from('acTL'))) throw new Error('Animated PNG assets are forbidden.');
        return dimensions.width * dimensions.height;
    }
    if (extension === '.jpg' || extension === '.jpeg') {
        if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) throw new Error('Invalid JPEG asset.');
        let offset = 2;
        while (offset + 4 <= buffer.length) {
            if (buffer[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
            while (buffer[offset] === 0xff) offset++;
            const marker = buffer[offset++];
            if (marker === 0xd9 || marker === 0xda) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (offset + 2 > buffer.length) break;
            const length = buffer.readUInt16BE(offset);
            if (length < 2 || offset + length > buffer.length) throw new Error('Invalid JPEG segment.');
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (length < 7) throw new Error('Invalid JPEG dimensions.');
                height = buffer.readUInt16BE(offset + 3);
                width = buffer.readUInt16BE(offset + 5);
                break;
            }
            offset += length;
        }
        if (!width || !height) throw new Error('JPEG dimensions were not found.');
    } else if (extension === '.webp') {
        if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid WebP asset.');
        const kind = buffer.toString('ascii', 12, 16);
        if (kind === 'VP8X') {
            if (buffer[20] & 2) throw new Error('Animated WebP assets are forbidden.');
            width = 1 + buffer.readUIntLE(24, 3);
            height = 1 + buffer.readUIntLE(27, 3);
        } else if (kind === 'VP8L') {
            if (buffer[20] !== 0x2f) throw new Error('Invalid lossless WebP header.');
            const bits = buffer.readUInt32LE(21);
            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
        } else if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
            width = buffer.readUInt16LE(26) & 0x3fff;
            height = buffer.readUInt16LE(28) & 0x3fff;
        } else throw new Error('Unsupported WebP header.');
    } else if (extension === '.woff' || extension === '.woff2') {
        const signature = extension === '.woff' ? 'wOFF' : 'wOF2';
        if (buffer.length < 48 || buffer.toString('ascii', 0, 4) !== signature || buffer.readUInt32BE(16) > LIMITS.assetBytes) throw new Error('Invalid font or decompressed font byte budget exceeded.');
        return 0;
    } else if (extension === '.ttf' || extension === '.otf') {
        if (buffer.length < 12 || ![0x00010000, 0x4f54544f, 0x74727565].includes(buffer.readUInt32BE(0))) throw new Error('Invalid OpenType font.');
        return 0;
    }
    integer(width, 'Asset width');
    integer(height, 'Asset height');
    if (width * height > LIMITS.pixels) throw new Error('Asset pixel budget exceeded.');
    return width * height;
}

function elementChildren(node) {
    return (node.childNodes || []).filter(child => child.tagName);
}

function classNames(node) {
    return (node.attrs?.find(attr => attr.name === 'class')?.value || '').trim().split(/\s+/).filter(Boolean);
}

function meaningfulChildren(node) {
    return (node.childNodes || []).filter(child => child.tagName || (child.nodeName === '#text' && child.value.trim()));
}

// This exception cannot carry arbitrary geometry: only a single literal zero
// minimum on direct children of a class-scoped parent (or the document roots).
function directChildMinimumRule(node, tree, scoped = true) {
    const declarations = node.block.children.toArray();
    if (declarations.length !== 1 || declarations[0].type !== 'Declaration'
        || declarations[0].important || declarations[0].property.toLowerCase() !== 'min-width'
        || tree.generate(declarations[0].value) !== '0') return false;
    return node.prelude.children.toArray().every(selector => {
        const parts = selector.children.toArray();
        const target = parts.pop();
        const combinator = parts.pop();
        const parentTarget = parts.slice(parts.findLastIndex(part => part.type === 'Combinator') + 1);
        return target?.type === 'TypeSelector' && target.name === '*'
            && combinator?.type === 'Combinator' && combinator.name === '>'
            && (!scoped || parentTarget.some(part => part.type === 'ClassSelector'
                || (part.type === 'TypeSelector' && ['html', 'body'].includes(part.name.toLowerCase()))));
    });
}

function swiperScrollbarNodes(container) {
    const nodes = [];
    const stack = [...(container.childNodes || [])];
    while (stack.length) {
        const node = stack.pop();
        const names = classNames(node);
        // Nested sliders own their own controls.
        if (names.includes('swiper')) continue;
        if (names.includes('swiper-scrollbar')) nodes.push(node);
        stack.push(...(node.childNodes || []));
    }
    return nodes;
}

function validSwiperScrollbar(nodes, container) {
    return nodes.length === 0 || (nodes.length === 1 && nodes[0].tagName === 'div'
        && nodes[0].parentNode === container && classNames(nodes[0]).join(' ') === 'swiper-scrollbar'
        && meaningfulChildren(nodes[0]).length === 0);
}

function ensureSwiperScrollbars(document, entries, repair = false) {
    const edits = [];
    const vertical = entries.filter(entry => swiper.usesVertical(entry.config));
    const stack = [document];
    while (stack.length) {
        const node = stack.pop();
        const names = classNames(node);
        if (names.includes('swiper') && vertical.some(entry => names.includes(entry.selector.slice('.swiper.'.length)))) {
            let scrollbars = swiperScrollbarNodes(node);
            if (!validSwiperScrollbar(scrollbars, node)) {
                if (!repair) throw new Error('Swiper scrollbar requires one direct empty div.swiper-scrollbar outside the wrapper.');
                // Drafts may fail layout validation. Strip the library hook rather
                // than removing arbitrary draft content, then add one safe control.
                for (const scrollbar of scrollbars) {
                    const attr = scrollbar.attrs.find(attr => attr.name === 'class');
                    attr.value = classNames(scrollbar).filter(name => name !== 'swiper-scrollbar').join(' ');
                }
                scrollbars = [];
            }
            if (!scrollbars.length) {
                const scrollbar = { nodeName: 'div', tagName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml',
                    attrs: [{ name: 'class', value: 'swiper-scrollbar' }], childNodes: [], parentNode: node };
                node.childNodes.push(scrollbar);
                const offset = node.sourceCodeLocation?.endTag?.startOffset;
                if (offset !== undefined) edits.push({ offset, text: '<div class="swiper-scrollbar"></div>' });
            }
        }
        stack.push(...(node.childNodes || []));
    }
    return edits;
}

function normalizePublication(html, css, entries, parse5, tree, draft = false) {
    if (entries.some(entry => swiper.usesVertical(entry.config))) {
        const document = parse5.parse(html, { sourceCodeLocationInfo: true });
        const edits = ensureSwiperScrollbars(document, entries, draft).sort((left, right) => right.offset - left.offset);
        if (draft) html = parse5.serialize(document);
        else for (const edit of edits) html = html.slice(0, edit.offset) + edit.text + html.slice(edit.offset);
    }
    const ast = tree.parse(css, { positions: true, parseCustomProperty: true });
    const insertions = [];
    // Insert beside each grid rule, not at the end of a sheet/media block. Later
    // author child rules must keep their cascade position. Only an immediately
    // following equivalent minimum is reusable without moving that position.
    function grids(container, keyframes = false) {
        const children = container.children.toArray();
        for (let index = 0; index < children.length; index++) {
            const rule = children[index];
            if (rule.type === 'Atrule' && rule.block) {
                grids(rule.block, keyframes || rule.name.toLowerCase() === 'keyframes');
            } else if (!keyframes && rule.type === 'Rule' && rule.prelude?.type === 'SelectorList'
                && rule.block.children.toArray().some(declaration => declaration.type === 'Declaration'
                    && declaration.property.toLowerCase() === 'display'
                    && /^(?:inline-)?grid$/i.test(tree.generate(declaration.value)))) {
                const selectors = rule.prelude.children.toArray().map(selector => `${tree.generate(selector)}>*`).join(',');
                const next = children[index + 1];
                if (next?.type === 'Rule' && next.prelude?.type === 'SelectorList'
                    && tree.generate(next.prelude) === selectors && tree.generate(next.block) === '{min-width:0}') continue;
                insertions.push({ offset: rule.loc.end.offset, text: `\n${selectors}{min-width:0}` });
            }
        }
    }
    grids(ast);
    insertions.sort((left, right) => right.offset - left.offset);
    for (const edit of insertions) css = css.slice(0, edit.offset) + edit.text + css.slice(edit.offset);

    const verticalStyles = [];
    for (const entry of entries.filter(item => swiper.usesVertical(item.config))) {
        const selector = entry.selector;
        const wrapper = `${selector} .swiper-wrapper`;
        const base = entry.config.direction || 'horizontal';
        const points = Object.entries(entry.config.breakpoints || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
        // Breakpoints without a direction do not request a direction change.
        // Carry the latest explicit direction through sizing-only breakpoints.
        let direction = base;
        for (const [width, point] of points) if (Number(width) <= 601 && point.direction) direction = point.direction;
        const rules = [`${wrapper}{display:flex;flex-direction:${direction === 'vertical' ? 'column' : 'row'}}`, `${wrapper}>*{min-width:0}`];
        for (const [width, point] of points) {
            if (Number(width) <= 601) continue;
            const next = point.direction || direction;
            if (next !== direction) rules.push(`@media (min-width:${width}px){${wrapper}{display:flex;flex-direction:${next === 'vertical' ? 'column' : 'row'}}}`);
            direction = next;
        }
        // The runtime direction class avoids imposing vertical track geometry on
        // horizontal breakpoints. Owned-class specificity beats pinned Swiper CSS.
        const scrollbar = `${selector}.swiper-vertical .swiper-scrollbar`;
        rules.push(`${scrollbar}{position:absolute;top:0;right:0;left:auto;bottom:auto;width:5px;height:100%;background:rgba(0,0,0,.1);border-radius:5px}`,
            `${scrollbar} .swiper-scrollbar-drag{background:#000;border-radius:5px;cursor:grab}`);
        verticalStyles.push(`@media (min-width:601px){${rules.join('')}}`);
    }
    if (verticalStyles.length) {
        const generated = verticalStyles.join('\n');
        const normalized = tree.generate(tree.parse(css, { parseCustomProperty: true }));
        const suffix = tree.generate(tree.parse(generated));
        if (!normalized.endsWith(suffix)) css += `\n${generated}`;
    }
    return { html, css };
}

function validateInternal(request, sources = null) {
    const errors = [];
    const regions = [];
    const fail = message => { if (errors.length < LIMITS.errors && !errors.includes(message)) errors.push(message); };
    let state;
    let validation = false;
    try {
        if (!request || typeof request.directory !== 'string') throw new Error('directory is required.');
        integer(request.content_width, 'content_width');
        const directory = fs.realpathSync(path.resolve(request.directory));
        if (!fs.statSync(directory).isDirectory()) throw new Error('directory must be a directory.');
        state = { directory, assets: new Map(), totalAssetBytes: 0, assetPixels: 0, svgRoots: [] };
        for (const name of ['index.html', 'style.css']) {
            if (!inside(directory, fs.realpathSync(path.join(directory, name)))) throw new Error(`${name} must remain inside directory.`);
        }
        const html = sources?.html ?? readLimited(path.join(directory, 'index.html'), LIMITS.sourceBytes).toString('utf8');
        const css = sources?.css ?? readLimited(path.join(directory, 'style.css'), LIMITS.sourceBytes).toString('utf8');
        assertSourceBudget(html, css);
        if ((html.match(/</g) || []).length > LIMITS.nodes || (css.match(/[{};,:()]/g) || []).length > LIMITS.nodes) throw new Error('Source token/node budget exceeded.');
        const { parse5, 'css-tree': cssTree } = dependencies(['parse5', 'css-tree']);
        validation = true;
        const document = parse5.parse(html, {
            sourceCodeLocationInfo: true,
            onParseError: error => fail(`HTML parse error: ${error.code} at ${error.startLine}:${error.startCol}.`)
        });
        let nodes = 0;
        let body;
        let links = 0;
        let firstHeading;
        const structural = new Set(['layout', 'wrap-content', ...swiper.SWIPER_CLASSES]);
        const swipers = swiper.normalize(request.swipers);
        // Validate the original candidate, but not the absence of a structure
        // that deterministic publication adds. Do not rewrite/reparse its HTML.
        ensureSwiperScrollbars(document, swipers);
        swiper.validateMarkup(document, swipers);
        // Include SVG descendants in the cumulative publication budget even
        // though their inert content has a separate validation policy below.
        assertHtmlBudget(document);
        const stack = [{ node: document, depth: 0, inHead: false }];
        const allElements = [];
        while (stack.length) {
            const { node, depth, inHead } = stack.pop();
            if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
            if (node.tagName === 'svg' && node.namespaceURI === svg.SVG_NS) {
                const location = node.sourceCodeLocation;
                try {
                    if (inHead || !location?.endTag) throw new Error('SVG requires an explicit root closing tag inside body content.');
                    const source = html.slice(location.startOffset, location.endOffset);
                    svg.validateNode(node, { inline: true, source });
                    const classes = classNames(node);
                    if (!classes.length || classes.some(name => !BEM.test(name))) throw new Error('SVG root requires a BEM class.');
                    state.svgRoots.push(node);
                    allElements.push(node);
                } catch (error) { fail(error.message); }
                // SVG's inert subtree is validated by the shared SVG policy, not
                // HTML/BEM ownership rules for content elements.
                continue;
            }
            if (node.tagName) {
                allElements.push(node);
                const tag = node.tagName;
                if (!firstHeading && /^h[1-6]$/.test(tag)) {
                    firstHeading = tag;
                    if (tag !== 'h2') fail('The first heading must be h2.');
                }
                if ((!CONTENT_TAGS.has(tag) && !DOCUMENT_TAGS.has(tag)) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') fail(`Forbidden HTML tag: ${tag}.`);
                if (['html', 'head', 'body'].includes(tag) && !node.sourceCodeLocation) fail(`Explicit <${tag}> is required.`);
                if (!['meta', 'link', 'input', 'img'].includes(tag) && node.sourceCodeLocation && !node.sourceCodeLocation.endTag) fail(`Explicit closing tag required for ${tag}.`);
                if (tag === 'body') body = node;
                if (inHead && !['meta', 'link', 'title'].includes(tag)) fail(`Forbidden head child: ${tag}.`);
                if (['meta', 'link', 'title'].includes(tag) && !inHead) fail(`${tag} must be inside head.`);
                const attrs = new Map((node.attrs || []).map(attr => [attr.name, attr.value]));
                for (const attr of node.attrs || []) {
                    const name = attr.name;
                    const value = attr.value;
                    if (attr.namespace || attr.prefix || /^on/i.test(name) || ['style', 'srcdoc', 'action', 'formaction', 'form', 'target', 'formtarget', 'http-equiv', 'srcset', 'imagesrcset', 'ping', 'download', 'background', 'manifest', 'xmlns', 'autofocus', 'is'].includes(name)) {
                        fail(`Forbidden HTML attribute: ${name}.`);
                        continue;
                    }
                    const common = /^(class|id|title|lang|dir|role|tabindex|hidden)$/.test(name) || /^(aria|data)-[a-z0-9-]+$/.test(name);
                    const specific = (tag === 'form' && name === 'method')
                        || (tag === 'img' && ['src', 'alt', 'width', 'height', 'loading', 'decoding'].includes(name))
                        || (tag === 'a' && name === 'href')
                        || (tag === 'link' && ['href', 'rel'].includes(name))
                        || (tag === 'meta' && ['charset', 'name', 'content'].includes(name))
                        || (['input', 'select', 'textarea', 'button', 'label', 'form'].includes(tag)
                            && ['type', 'name', 'value', 'placeholder', 'for', 'disabled', 'readonly', 'required', 'checked', 'selected', 'multiple', 'rows', 'cols', 'autocomplete', 'min', 'max', 'step', 'maxlength'].includes(name));
                    if (!common && !specific) fail(`Unsupported attribute ${name} on ${tag}.`);
                    if (name === 'href' && tag === 'a' && !/^#[a-zA-Z0-9_-]*$/.test(value)) fail('Links may only use local #fragments.');
                    if (name === 'src' && tag === 'img') {
                        try {
                            assetPath(value, state);
                            if (path.extname(value).toLowerCase() === '.svg') {
                                if (!classNames(node).length || classNames(node).some(name => !BEM.test(name))) fail('SVG image requires a BEM class.');
                                if (attrs.has('width') || attrs.has('height')) fail('SVG image width/height belong in layout CSS.');
                                state.svgRoots.push(node);
                            }
                        } catch (error) { fail(error.message); }
                    }
                }
                if (tag === 'img' && (!attrs.has('alt') || !attrs.has('src'))) fail('Every img requires alt and a local src.');
                if (tag === 'form' && attrs.get('method') !== 'dialog') fail('Forms require method="dialog" so no submission can navigate or send data.');
                if (tag === 'input' && ['image', 'submit', 'file'].includes((attrs.get('type') || '').toLowerCase())) fail('Submitting/image/file inputs are forbidden.');
                if (tag === 'button' && attrs.get('type') !== 'button') fail('Buttons require type="button" (no form submission).');
                if (tag === 'link') {
                    links++;
                    if (attrs.get('rel') !== 'stylesheet' || attrs.get('href') !== 'style.css') fail('Only <link rel="stylesheet" href="style.css"> is allowed.');
                }
            }
            for (const child of [...(node.childNodes || [])].reverse()) stack.push({ node: child, depth: depth + 1, inHead: inHead || node.tagName === 'head' });
        }
        if (links !== 1) fail('Exactly one local style.css stylesheet link is required.');
        if (!body) fail('A body is required.');
        const chainNodes = new Set();
        for (const wrapper of elementChildren(body || {})) {
            const classes = classNames(wrapper);
            const match = classes.length === 1 && classes[0].match(new RegExp(`^(${NAME})-wrap$`));
            if (wrapper.tagName !== 'div' || !match) {
                fail('Every body region must be div.{role}-wrap.');
                continue;
            }
            const role = match[1];
            if (regions.some(region => region.role === role)) fail(`Duplicate region role: ${role}.`);
            regions.push({ role, selector: `.${role}-wrap` });
            structural.add(`${role}-wrap`);
            structural.add(`${role}-layout`);
            chainNodes.add(wrapper);
            const children = meaningfulChildren(wrapper);
            const content = children[0];
            if (children.length !== 1 || content?.tagName !== 'div' || classNames(content).join(' ') !== 'wrap-content') {
                fail(`Region ${role} requires exactly div.wrap-content as its child.`);
                continue;
            }
            chainNodes.add(content);
            const layouts = meaningfulChildren(content);
            const layout = layouts[0];
            if (layouts.length !== 1 || layout?.tagName !== 'div' || classNames(layout).join(' ') !== `${role}-layout`) {
                fail(`Region ${role} requires exactly div.${role}-layout inside wrap-content.`);
                continue;
            }
            chainNodes.add(layout);
        }
        if (!regions.length) fail('At least one region chain is required.');
        if ((body?.childNodes || []).some(node => node.nodeName === '#text' && node.value.trim())) fail('Body text must be inside a region chain.');
        for (const node of allElements) {
            const classes = classNames(node);
            for (const name of classes) {
                if (!structural.has(name) && name !== 'text-split' && !BEM.test(name)) fail(`Invalid BEM class: ${name}.`);
                if (name.includes('--') && !classes.includes(name.split('--')[0])) fail(`BEM modifier requires its base class: ${name}.`);
                if ((name === 'wrap-content' || /-(wrap|layout)$/.test(name)) && !chainNodes.has(node) && name !== 'layout') fail(`Structural class outside region chain: ${name}.`);
                const bem = name.match(BEM);
                if (bem?.[2]) {
                    let owner = node;
                    let found = false;
                    while (owner && owner !== body) {
                        const ownerClasses = classNames(owner);
                        if (ownerClasses.includes(bem[1]) || ownerClasses.includes(`${bem[1]}-layout`)) { found = true; break; }
                        owner = owner.parentNode;
                    }
                    if (!found) fail(`BEM element has no owning block: ${name}.`);
                }
            }
            if (node.tagName === 'div' && !chainNodes.has(node)) {
                const children = meaningfulChildren(node);
                if (!children.length && !classes.some(name => ['swiper-button-next', 'swiper-button-prev', 'swiper-pagination', 'swiper-scrollbar'].includes(name))) fail('Redundant empty div outside the region chain.');
                if (!classes.length) fail('Div outside the region chain requires a BEM block/element class.');
            }
        }
        validateCss(css, request.content_width, structural, state, cssTree, fail, request.require_responsive_breakpoints === true);
    } catch (error) { fail(error.message); }
    const result = { ok: errors.length === 0, validation, errors, regions };
    if (result.ok) result.assets = [...state.assets.keys()].map(filename => path.relative(state.directory, filename).split(path.sep).join('/')).sort();
    return { result, state };
}

// The only variable grammar accepted by validation and sanitized previews is the
// literal parent coordinate system. Do not permit fallbacks or dynamic operands.
function parentDimensionDeclaration(node) {
    if (node?.type !== 'Declaration' || node.value.type !== 'Value') return false;
    const parts = node.value.children.toArray();
    const number = (part, positive = false) => part?.type === 'Number'
        && Number.isFinite(Number(part.value)) && (!positive || Number(part.value) > 0);
    const operator = (part, value) => part?.type === 'Operator' && part.value === value;
    const variable = (part, name) => {
        const args = part?.type === 'Function' && part.name.toLowerCase() === 'var' ? part.children.toArray() : [];
        return args.length === 1 && args[0].type === 'Identifier' && args[0].name === name;
    };
    if (['--parent-w', '--parent-h'].includes(node.property)) return parts.length === 1 && number(parts[0], true);
    const property = node.property.toLowerCase();
    if (property === 'aspect-ratio') {
        return parts.length === 3 && variable(parts[0], '--parent-w')
            && operator(parts[1], '/') && variable(parts[2], '--parent-h');
    }
    if (!['width', 'left', 'top'].includes(property) || parts.length !== 1
        || parts[0].type !== 'Function' || parts[0].name.toLowerCase() !== 'calc') return false;
    const operands = parts[0].children.toArray();
    return operands.length === 5 && number(operands[0], property === 'width')
        && operator(operands[1], '/') && variable(operands[2], property === 'top' ? '--parent-h' : '--parent-w')
        && operator(operands[3], '*') && operands[4].type === 'Percentage' && Number(operands[4].value) === 100;
}

function maskProperty(property) {
    return /^(?:-webkit-)?mask(?:-image)?$/.test(property || '');
}

// A deliberately narrow exception to the explicit-class geometry rule. The
// baseline removes browser heading defaults; BEM title rules supply typography.
function headingResetRule(node, tree) {
    if (tree.generate(node.prelude).toLowerCase() !== 'h2,h3,h4,h5,h6') return false;
    const expected = new Map([
        ['margin-block', '0'], ['margin-inline', '0'], ['font-size', 'inherit'],
        ['font-weight', 'inherit'], ['line-height', 'inherit']
    ]);
    for (const declaration of node.block.children.toArray()) {
        if (declaration.type !== 'Declaration' || declaration.important
            || tree.generate(declaration.value) !== expected.get(declaration.property.toLowerCase())) return false;
        expected.delete(declaration.property.toLowerCase());
    }
    return expected.size === 0;
}

// Infer only math whose types are certain. Percentages have a property-dependent
// type and unrecognized functions/units remain unknown rather than being guessed.
// Exponent maps allow dimensional cancellation (e.g. px/px) without treating
// every syntactically parsed calc() as valid CSS arithmetic.
function invalidCssMath(node, numericParentVariables) {
    const invalid = Symbol('invalid math');
    const units = {
        length: 'px cm mm q in pc pt em ex ch rem lh rlh cap ic rex rcap rch ric vw vh vi vb vmin vmax svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin lvmax dvw dvh dvi dvb dvmin dvmax cqw cqh cqi cqb cqmin cqmax',
        angle: 'deg grad rad turn', time: 's ms', frequency: 'hz khz', resolution: 'dpi dpcm dppx x', flex: 'fr'
    };
    function combine(left, right, operator) {
        if (left === invalid || right === invalid) return invalid;
        if (!left || !right) return null;
        if (operator === '+' || operator === '-') {
            return JSON.stringify(left) === JSON.stringify(right) ? left : invalid;
        }
        const result = { ...left };
        for (const [type, exponent] of Object.entries(right)) {
            result[type] = (result[type] || 0) + (operator === '/' ? -exponent : exponent);
            if (!result[type]) delete result[type];
        }
        return Object.fromEntries(Object.entries(result).sort());
    }
    function expression(parts) {
        let position = 0;
        function product() {
            let result = value(parts[position++]);
            while (['*', '/'].includes(parts[position]?.value?.trim()) && parts[position].type === 'Operator') {
                const operator = parts[position++].value.trim();
                result = combine(result, value(parts[position++]), operator);
            }
            return result;
        }
        let result = product();
        while (['+', '-'].includes(parts[position]?.value?.trim()) && parts[position].type === 'Operator') {
            const operator = parts[position++].value.trim();
            result = combine(result, product(), operator);
        }
        return position === parts.length ? result : null;
    }
    function value(part) {
        if (part?.type === 'Number') return {};
        if (part?.type === 'Dimension') {
            const type = Object.keys(units).find(name => units[name].split(' ').includes(part.unit.toLowerCase()));
            return type ? { [type]: 1 } : null;
        }
        if (part?.type === 'Parentheses') return expression(part.children.toArray());
        if (part?.type !== 'Function') return null;
        const name = part.name.toLowerCase();
        const args = part.children.toArray();
        if (name === 'var' && numericParentVariables && args.length === 1
            && args[0].type === 'Identifier' && ['--parent-w', '--parent-h'].includes(args[0].name)) return {};
        if (name === 'calc') return expression(args);
        if (!['min', 'max', 'clamp'].includes(name)) return null;
        const groups = [[]];
        for (const arg of args) {
            if (arg.type === 'Operator' && arg.value === ',') groups.push([]);
            else groups[groups.length - 1].push(arg);
        }
        return groups.map(expression).reduce((left, right) => combine(left, right, '+'));
    }
    const type = value(node);
    return type === invalid || (type !== null && (Object.keys(type).length > 1 || Object.values(type).some(exponent => exponent !== 1)));
}

function validateCss(source, contentWidth, structural, state, tree, fail, requireBreakpoints) {
    // Escapes are intentionally unsupported: this closes escaped url/identifier/protocol spellings.
    if (source.includes('\\') || source.includes('\0')) fail('CSS escapes and NUL characters are forbidden.');
    const ast = tree.parse(source, { positions: true, parseCustomProperty: true, onParseError: error => fail(`CSS parse error: ${error.message}`) });
    let nodes = 0;
    let wrapRules = 0;
    let wrapRule;
    const parent = [];
    const gridMinimums = new Set();
    function collectGridMinimums(container, keyframes = false) {
        const children = container.children.toArray();
        children.forEach((node, index) => {
            if (node.type === 'Atrule' && node.block) collectGridMinimums(node.block, keyframes || node.name.toLowerCase() === 'keyframes');
            if (keyframes || node.type !== 'Rule' || node.prelude?.type !== 'SelectorList'
                || !directChildMinimumRule(node, tree, false)) return;
            const previous = children[index - 1];
            if (previous?.type !== 'Rule' || previous.prelude?.type !== 'SelectorList'
                || !previous.block.children.toArray().some(declaration => declaration.type === 'Declaration'
                    && declaration.property.toLowerCase() === 'display' && /^(?:inline-)?grid$/i.test(tree.generate(declaration.value)))) return;
            const expected = previous.prelude.children.toArray().map(selector => `${tree.generate(selector)}>*`).join(',');
            if (tree.generate(node.prelude) === expected) gridMinimums.add(node);
        });
    }
    collectGridMinimums(ast);
    tree.walk(ast, {
        enter(node) {
            if (++nodes > LIMITS.nodes || parent.length > LIMITS.depth) throw new Error('CSS node/depth budget exceeded.');
            parent.push(node);
            if (node.type === 'Raw') fail('CSS could not be parsed into a strict AST.');
            if (node.type === 'Atrule' && !['media', 'supports', 'font-face', 'keyframes'].includes(node.name.toLowerCase())) fail(`Forbidden CSS at-rule: @${node.name}.`);
            if (requireBreakpoints && node.type === 'MediaFeature' && node.name.toLowerCase() === 'max-width'
                && node.value?.type === 'Dimension' && node.value.unit.toLowerCase() === 'px' && Number(node.value.value) > 1024) {
                fail('Desktop styles must be base CSS outside media queries; max-width responsive rules start at 1024px.');
            }
            if (node.type === 'Atrule' && node.name.toLowerCase() === 'font-face') {
                tree.walk(node, child => {
                    if (child.type === 'Function' && child.name.toLowerCase() === 'local') fail('External/system font lookup local() is forbidden; use an assets/ font.');
                });
            }
            const declaration = parent.findLast(item => item.type === 'Declaration');
            if (node.type === 'Function' && invalidCssMath(node, parentDimensionDeclaration(declaration))) fail('Invalid dimensional CSS arithmetic: calc/min/max/clamp must resolve to a number or single dimension.');
            if (node.type === 'Function' && UNSAFE_CSS_FUNCTIONS.has(node.name.toLowerCase())
                && !(node.name.toLowerCase() === 'var' && parentDimensionDeclaration(declaration))) fail(`Forbidden CSS function: ${node.name}().`);
            if (node.type === 'Declaration') {
                const property = node.property.toLowerCase();
                if ((property.startsWith('--') && !parentDimensionDeclaration(node))
                    || ['behavior', '-moz-binding'].includes(property)) fail(`Forbidden CSS property: ${node.property}.`);
            }
            if (node.type === 'Url') {
                try {
                    if (maskProperty(declaration?.property.toLowerCase()) && !['.png', '.svg'].includes(path.extname(node.value).toLowerCase())) throw new Error('Masks require a validated local PNG or SVG asset.');
                    assetPath(node.value, state);
                } catch (error) { fail(error.message); }
            }
            if (node.type === 'ClassSelector' && !structural.has(node.name) && node.name !== 'text-split' && !BEM.test(node.name)) fail(`Invalid CSS BEM class: ${node.name}.`);
            if (node.type === 'AttributeSelector') fail('CSS attribute selectors are forbidden; use BEM classes.');
            if (node.type === 'Rule' && node.prelude?.type === 'SelectorList') {
                node.prelude.children.forEach(selector => {
                    let touchesSwiperStructure = false;
                    tree.walk(selector, part => {
                        if (part.type === 'ClassSelector' && ['swiper-wrapper', 'swiper-slide'].includes(part.name)) touchesSwiperStructure = true;
                    });
                    if (!touchesSwiperStructure) return;
                    let scoped = false;
                    let compound = [];
                    for (const part of selector.children.toArray()) {
                        if (part.type === 'Combinator') {
                            if ([' ', '>'].includes(part.name)) {
                                const names = compound.filter(item => item.type === 'ClassSelector').map(item => item.name);
                                if (names.includes('swiper') && names.some(name => !swiper.SWIPER_CLASSES.has(name) && BEM.test(name))) scoped = true;
                            } else scoped = false;
                            compound = [];
                            continue;
                        }
                        let structural = false;
                        tree.walk(part, child => {
                            if (child.type === 'ClassSelector' && ['swiper-wrapper', 'swiper-slide'].includes(child.name)) structural = true;
                        });
                        if (structural && !scoped) fail('Swiper wrapper/slide CSS must descend from .swiper.<BEM-class>; no global structural selectors.');
                        compound.push(part);
                    }
                });
                let touchesWrap = false;
                tree.walk(node.prelude, child => {
                    if (child.type === 'ClassSelector' && child.name === 'wrap-content') touchesWrap = true;
                });
                const childMinimum = directChildMinimumRule(node, tree) || gridMinimums.has(node);
                if (touchesWrap && !childMinimum) {
                    wrapRules++;
                    if (tree.generate(node.prelude) !== '.wrap-content' || parent.some(item => item.type === 'Atrule')) fail('wrap-content may only be defined by one top-level .wrap-content rule (no region/media overrides).');
                    wrapRule = node;
                }
                // Any width/spacing selector must name its actual target, otherwise
                // :first-child/:is()/universal selectors could silently override wrappers.
                let changesWrapperGeometry = false;
                node.block.children.forEach(child => {
                    if (child.type === 'Declaration' && /^(all|width|min-width|max-width|margin($|-)|padding($|-))/.test(child.property.toLowerCase())) changesWrapperGeometry = true;
                });
                if (changesWrapperGeometry && !childMinimum && !(headingResetRule(node, tree) && !parent.some(item => item.type === 'Atrule'))) {
                    node.prelude.children.forEach(selector => {
                        const last = [];
                        selector.children.forEach(part => {
                            if (part.type === 'Combinator') last.length = 0;
                            else last.push(part);
                        });
                        const explicitTarget = last.some(part => part.type === 'ClassSelector'
                            || (part.type === 'TypeSelector' && ['html', 'body'].includes(part.name.toLowerCase())));
                        if (!explicitTarget) fail('Width/margin/padding rules must explicitly target a BEM class (not anonymous div, *, or pseudo-only targets).');
                    });
                }
                let wrapperAffecting = false;
                tree.walk(node.prelude, child => {
                    if (child.type === 'TypeSelector' && ['*', 'div'].includes(child.name.toLowerCase())) wrapperAffecting = true;
                });
                if (wrapperAffecting && !childMinimum) {
                    node.block.children.forEach(child => {
                        if (child.type === 'Declaration' && /^(all|width|min-width|max-width|margin($|-)|padding($|-))/.test(child.property.toLowerCase())) fail('Universal/div selectors must not override wrapper width, margin or padding.');
                    });
                }
            }
        },
        leave() { parent.pop(); }
    });
    // SVG roots require explicit base width; max-width/flex do not size them.
    // Their viewBox preserves proportions with height:auto.
    // SVG img is accepted as intermediate input and embedded before publication.
    for (const root of state.svgRoots || []) {
        let explicitWidth = false;
        ast.children.forEach(rule => {
            if (rule.type !== 'Rule' || rule.prelude?.type !== 'SelectorList') return;
            const targetsRoot = rule.prelude.children.toArray().some(selector => {
                const parts = selector.children.toArray();
                return parts.length === 1 && parts[0].type === 'ClassSelector' && classNames(root).includes(parts[0].name);
            });
            if (!targetsRoot) return;
            rule.block.children.forEach(declaration => {
                if (declaration.type === 'Declaration' && declaration.property.toLowerCase() === 'width') {
                    explicitWidth = !/^(?:inherit|initial|unset|revert|auto|-[\d.])/i.test(tree.generate(declaration.value))
                        && Boolean(tree.lexer.matchProperty('width', declaration.value).matched
                            || tree.lexer.match('clamp( <length-percentage> , <length-percentage> , <length-percentage> )', declaration.value).matched);
                }
            });
        });
        if (!explicitWidth) fail('SVG root requires an explicit width in its base BEM rule (px, percentage or clamp); max-width, flex-basis and flex do not replace width.');
    }
    if (wrapRules !== 1 || !wrapRule) {
        fail('CSS requires exactly one .wrap-content rule.');
        return;
    }
    const declarations = new Map();
    wrapRule.block.children.forEach(node => {
        if (node.type !== 'Declaration') return;
        const property = node.property.toLowerCase();
        if (declarations.has(property) || node.important) fail('wrap-content cannot have duplicate or !important declarations.');
        declarations.set(property, tree.generate(node.value).toLowerCase());
        if (!['max-width', 'margin-inline', 'padding-inline', 'width', 'box-sizing'].includes(property)) fail(`Unsupported common wrapper declaration: ${property}.`);
    });
    for (const [property, expected] of Object.entries({ 'max-width': `${contentWidth}px`, 'margin-inline': 'auto', 'padding-inline': '15px' })) {
        if (declarations.get(property) !== expected) fail(`wrap-content requires ${property}:${expected}.`);
    }
}

// Preview never relaxes the security boundary just because BEM/layout validation failed.
function assertNoSymlinks(filename) {
    const absolute = path.resolve(filename);
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Preview paths may not contain symlinks: ${current}`);
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }
}

function previewAsset(value, state) {
    try { return assetPath(value, state); }
    catch (error) {
        // Unsafe URLs/asset contents can be omitted. IO and resource failures cannot
        // be mistaken for successfully sanitized content.
        const unsafeAsset = /^(Unsafe asset URL:|Unsupported asset type:|Asset escapes assets\/:|Asset symlink escapes assets\/:|Preview paths may not contain symlinks:|Animated (PNG|WebP) assets are forbidden\.|Invalid (JPEG|WebP|lossless WebP|OpenType font|font)|Unsupported WebP header\.|JPEG dimensions were not found\.|Reference must be a PNG image\.)/;
        if (error.code || /budget|too large|exceeds/i.test(error.message) || !unsafeAsset.test(error.message)) throw error;
        return null;
    }
}

function sanitizePreviewCss(source, state, tree) {
    const ast = tree.parse(source, { positions: true, parseCustomProperty: true, onParseError() {} });
    let nodes = 0;
    let depth = 0;
    tree.walk(ast, {
        enter() {
            if (++nodes > LIMITS.nodes || ++depth > LIMITS.depth) throw new Error('CSS node/depth budget exceeded.');
        },
        leave() { depth--; }
    });
    function safe(node) {
        let allowed = true;
        const dimensionDeclaration = parentDimensionDeclaration(node);
        tree.walk(node, child => {
            if (!PREVIEW_CSS_NODES.has(child.type)) allowed = false;
            if (child.type === 'Function' && invalidCssMath(child, dimensionDeclaration)) allowed = false;
            if (child.type === 'Function' && !(dimensionDeclaration && child.name.toLowerCase() === 'var')
                && (UNSAFE_CSS_FUNCTIONS.has(child.name.toLowerCase())
                    || !PREVIEW_CSS_FUNCTIONS.has(child.name.toLowerCase()))) allowed = false;
            if (child.type === 'String' && /[<>]/.test(child.value)) allowed = false;
            if (child.type === 'Declaration' && ((child.property.startsWith('--') && !dimensionDeclaration)
                || ['behavior', '-moz-binding'].includes(child.property.toLowerCase()))) allowed = false;
            if (child.type === 'Url' && ((maskProperty(node.property?.toLowerCase()) && !['.png', '.svg'].includes(path.extname(child.value).toLowerCase()))
                || !previewAsset(child.value, state))) allowed = false;
        });
        const generated = tree.generate(node);
        // Check the original span too: regeneration must not conceal escaped names,
        // unparsed constructs, or a literal HTML end tag in a CSS string.
        const original = node.loc ? source.slice(node.loc.start.offset, node.loc.end.offset) : generated;
        // A child combinator is safe selector syntax, not HTML markup. Keep angle
        // brackets forbidden in declaration values and strings, and '<' everywhere.
        if (/[\\\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(original)
            || (node.type === 'SelectorList' ? /</ : /[<>]/).test(generated)) allowed = false;
        return allowed;
    }
    function children(list, context) {
        const output = [];
        for (const node of list.toArray()) {
            if (node.type === 'Declaration' && context === 'declarations') {
                if (safe(node)) output.push(tree.generate(node));
            } else if (node.type === 'Rule' && context === 'rules' && node.prelude?.type === 'SelectorList'
                && safe(node.prelude)) {
                const declarations = children(node.block.children, 'declarations');
                if (declarations) output.push(`${tree.generate(node.prelude)}{${declarations}}`);
            } else if (node.type === 'Atrule' && context === 'rules' && node.block) {
                const name = node.name.toLowerCase();
                if (!['media', 'supports', 'font-face', 'keyframes'].includes(name) || !safe(node.prelude || node)) continue;
                const content = children(node.block.children, name === 'font-face' ? 'declarations' : 'rules');
                if (content) output.push(`@${name}${node.prelude ? ` ${tree.generate(node.prelude)}` : ''}{${content}}`);
            }
        }
        return output.join(context === 'declarations' ? ';' : '\n');
    }
    return children(ast.children, 'rules');
}

function sanitizePreviewHtml(source, state, parse5) {
    const document = parse5.parse(source, { sourceCodeLocationInfo: true });
    const stack = [{ node: document, depth: 0 }];
    let nodes = 0;
    let body;
    let sourceHtml;
    let title = '';
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
        if (node.tagName === 'body') body = node;
        if (node.tagName === 'html') sourceHtml = node;
        if (node.tagName === 'title') title = (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value).join('');
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
        if (node.content) stack.push({ node: node.content, depth: depth + 1 });
    }
    const output = parse5.parse('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title></title><link rel="stylesheet" href="style.css"></head><body></body></html>');
    const html = output.childNodes.find(node => node.tagName === 'html');
    const head = html.childNodes.find(node => node.tagName === 'head');
    const outputBody = html.childNodes.find(node => node.tagName === 'body');
    const outputTitle = head.childNodes.find(node => node.tagName === 'title');
    outputTitle.childNodes = [{ nodeName: '#text', value: title, parentNode: outputTitle }];
    const harmless = new Set('section main article header footer nav aside address figure figcaption ol dl dt dd strong em b i u s small br hr table thead tbody tfoot tr td th caption colgroup col option optgroup details summary time mark pre code blockquote'.split(' '));
    function commonAttribute({ name, value, namespace, prefix }) {
        return !namespace && !prefix && !/[\u0000-\u001f\u007f]/.test(value)
            && (/^(class|id|title|lang|dir|role|tabindex|hidden)$/.test(name) || /^aria-[a-z0-9-]+$/.test(name));
    }
    html.attrs = (sourceHtml?.attrs || []).filter(commonAttribute).map(({ name, value }) => ({ name, value }));
    outputBody.attrs = (body?.attrs || []).filter(commonAttribute).map(({ name, value }) => ({ name, value }));
    function clean(node, parent) {
        if (node.nodeName === '#text') return [{ nodeName: '#text', value: node.value, parentNode: parent }];
        if (node.tagName === 'svg' && node.namespaceURI === svg.SVG_NS) {
            try {
                const location = node.sourceCodeLocation;
                if (!location?.endTag) return [];
                // Validate the original XML before cloning. Remove only the root
                // presentation dimensions; shape geometry remains byte-equivalent.
                svg.validateNode(node, { source: source.slice(location.startOffset, location.endOffset) });
                function clone(current, owner, root = false) {
                    const result = { nodeName: current.nodeName, parentNode: owner };
                    if (current.nodeName === '#text') return { ...result, value: current.value };
                    if (current.nodeName === '#comment') return { ...result, data: current.data };
                    Object.assign(result, { tagName: current.tagName, namespaceURI: current.namespaceURI,
                        attrs: current.attrs.filter(attr => !root || !['width', 'height'].includes(attr.name)).map(attr => ({ ...attr })), childNodes: [] });
                    result.childNodes = (current.childNodes || []).map(child => clone(child, result));
                    return result;
                }
                return [clone(node, parent, true)];
            } catch { return []; }
        }
        if (!node.tagName || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return [];
        const tag = node.tagName === 'h1' ? 'h2' : node.tagName;
        // Preserve inert semantic/layout elements and their class hooks. Everything
        // else (including raw-text, metadata, foreign and active subtrees) is dropped.
        if (!CONTENT_TAGS.has(tag) && !harmless.has(tag)) return [];
        const result = { nodeName: tag, tagName: tag, namespaceURI: node.namespaceURI, attrs: [], childNodes: [], parentNode: parent };
        for (const attr of node.attrs || []) {
            const { name, value } = attr;
            if (attr.namespace || attr.prefix || /[\u0000-\u001f\u007f]/.test(value)) continue;
            const common = commonAttribute(attr);
            const control = ['input', 'select', 'textarea', 'button', 'label', 'option', 'optgroup'].includes(tag)
                && ['value', 'placeholder', 'for', 'disabled', 'readonly', 'required', 'checked', 'selected', 'multiple', 'rows', 'cols', 'min', 'max', 'step', 'maxlength'].includes(name);
            const image = tag === 'img' && ['alt', 'width', 'height'].includes(name);
            if (common || control || image || (tag === 'a' && name === 'href' && /^#[a-zA-Z0-9_-]*$/.test(value))) result.attrs.push({ name, value });
            if (tag === 'img' && name === 'src' && ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(value).toLowerCase()) && previewAsset(value, state)) result.attrs.push({ name, value });
            if (tag === 'input' && name === 'type' && ['text', 'email', 'tel', 'url', 'search', 'number', 'range', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'checkbox', 'radio', 'hidden', 'button', 'password'].includes(value.toLowerCase())) result.attrs.push({ name, value: value.toLowerCase() });
        }
        if (tag === 'form') result.attrs.push({ name: 'method', value: 'dialog' });
        if (tag === 'button') result.attrs.push({ name: 'type', value: 'button' });
        if (tag === 'input' && !result.attrs.some(attr => attr.name === 'type')) result.attrs.push({ name: 'type', value: 'text' });
        if (tag === 'img') {
            if (!result.attrs.some(attr => attr.name === 'src')) return [];
            if (!result.attrs.some(attr => attr.name === 'alt')) result.attrs.push({ name: 'alt', value: '' });
        }
        result.childNodes = (node.childNodes || []).flatMap(child => clean(child, result));
        return [result];
    }
    outputBody.childNodes = (body?.childNodes || []).flatMap(node => clean(node, outputBody));
    return parse5.serialize(output);
}

function inlineSvgImages(html, state, parse5) {
    const document = parse5.parse(html, { sourceCodeLocationInfo: true });
    const elements = [];
    const stack = [document];
    const usedIds = new Set();
    while (stack.length) {
        const node = stack.pop();
        const id = node.attrs?.find(attr => attr.name === 'id')?.value;
        if (id) usedIds.add(id);
        elements.push(node);
        stack.push(...(node.childNodes || []));
    }
    const edits = [];
    let sequence = 0;
    let outputBytes = Buffer.byteLength(html);
    for (const node of elements) {
        const source = node.attrs?.find(attr => attr.name === 'src')?.value;
        if (node.tagName !== 'img' || path.extname(source || '').toLowerCase() !== '.svg') continue;
        const filename = assetPath(source, state);
        const buffer = state.assetBuffers?.get(filename) || readLimited(filename, svg.LIMITS.bytes);
        svg.inspect(buffer, parse5);
        const fragment = parse5.parseFragment(svg.xmlEnvelope(buffer.toString('utf8')));
        const root = fragment.childNodes.find(child => child.tagName === 'svg');
        const imageId = node.attrs.find(attr => attr.name === 'id')?.value;
        const imageClass = node.attrs.find(attr => attr.name === 'class')?.value;
        const descendants = [];
        const pending = [root];
        const ids = new Map();
        while (pending.length) {
            const current = pending.pop();
            descendants.push(current);
            const id = current.attrs?.find(attr => attr.name === 'id')?.value;
            if (id) {
                let replacement;
                if (current === root && imageId) replacement = imageId;
                else {
                    do { replacement = `inline-svg-${++sequence}`; } while (usedIds.has(replacement));
                    usedIds.add(replacement);
                }
                ids.set(id, replacement);
            }
            pending.push(...(current.childNodes || []));
        }
        // External SVG documents have independent ID scopes. Inline copies need
        // unique IDs and rewritten local references to preserve that isolation.
        for (const current of descendants) {
            for (const attr of current.attrs || []) {
                if (attr.name === 'id') attr.value = ids.get(attr.value);
                else if (attr.name === 'href' && ids.has(attr.value.slice(1))) attr.value = `#${ids.get(attr.value.slice(1))}`;
                else if (['fill', 'stroke', 'clip-path', 'mask', 'filter'].includes(attr.name) && /^url\(/.test(attr.value)) {
                    attr.value = attr.value.replace(/#([A-Za-z_][A-Za-z0-9_.:-]*)/g, (match, id) => ids.has(id) ? `#${ids.get(id)}` : match);
                }
            }
        }
        root.attrs = root.attrs.filter(attr => !['width', 'height', 'class'].includes(attr.name));
        if (imageClass) root.attrs.push({ name: 'class', value: imageClass });
        if (imageId && !root.attrs.some(attr => attr.name === 'id')) root.attrs.push({ name: 'id', value: imageId });
        const label = node.attrs.find(attr => attr.name === 'alt')?.value || node.attrs.find(attr => attr.name === 'title')?.value;
        if (label) {
            const title = { nodeName: 'title', tagName: 'title', namespaceURI: svg.SVG_NS, attrs: [], childNodes: [], parentNode: root };
            title.childNodes.push({ nodeName: '#text', value: label, parentNode: title });
            root.childNodes.unshift(title);
        }
        svg.validateNode(root, { inline: true });
        fragment.childNodes = [root];
        const text = parse5.serialize(fragment);
        const location = node.sourceCodeLocation;
        outputBytes += Buffer.byteLength(text) - Buffer.byteLength(html.slice(location.startOffset, location.endOffset));
        if (outputBytes > LIMITS.sourceBytes) throw new Error('Inline SVG source byte budget exceeded.');
        edits.push({ start: location.startOffset, end: location.endOffset, text });
    }
    edits.sort((left, right) => left.start - right.start);
    const parts = [];
    let cursor = 0;
    for (const edit of edits) {
        parts.push(html.slice(cursor, edit.start), edit.text);
        cursor = edit.end;
    }
    parts.push(html.slice(cursor));
    return parts.join('');
}

function formattedSources(html, css, parse5, tree, state, swipers = []) {
    const { formatHtml, formatCss } = require('./format.cjs');
    ({ html, css } = normalizePublication(html, css, swipers, parse5, tree, state.preview === true));
    const ast = tree.parse(css, { parseCustomProperty: true });
    const inlineClasses = new Set();
    const inlineTags = new Set();
    let preserveBody = false;
    tree.walk(ast, function (node) {
        if (node.type !== 'Declaration') return;
        const property = node.property.toLowerCase();
        const value = tree.generate(node.value).toLowerCase();
        // CSS can make ordinary block whitespace significant. In those cases
        // keep the original body text boundaries rather than guessing layout.
        if (['white-space', 'white-space-collapse', 'text-space-collapse'].includes(property)
            && !['normal', 'nowrap', 'collapse'].includes(value)) preserveBody = true;
        const outOfFlow = (property === 'display' && /^(inline(?:-block|-flex|-grid|-table)?|contents|none)$/.test(value))
            || (property === 'position' && ['absolute', 'fixed'].includes(value))
            || (property === 'float' && value !== 'none');
        if (!outOfFlow || !this.rule?.prelude) return;
        tree.walk(this.rule.prelude, selector => {
            if (selector.type === 'ClassSelector') inlineClasses.add(selector.name);
            if (selector.type === 'IdSelector') preserveBody = true;
            if (selector.type === 'TypeSelector') {
                if (selector.name === '*') preserveBody = true;
                else inlineTags.add(selector.name.toLowerCase());
            }
        });
    });
    const defaultBlocks = new Set('div p h2 h3 h4 h5 h6 form ul li section main article header footer nav aside figure figcaption ol dl dt dd table tbody thead tfoot tr td th blockquote pre hr'.split(' '));
    const preserveWhitespace = node => (preserveBody && node.tagName === 'body')
        || (node.childNodes || []).some(child => defaultBlocks.has(child.tagName)
            && (inlineTags.has(child.tagName) || classNames(child).some(name => inlineClasses.has(name))));
    // Truncation is a design decision; never add text-split to ordinary text.
    html = inlineSvgImages(html, state, parse5);
    if (/class=["'][^"']*\btext-split\b/.test(html) && !/\.text-split\s*\{/.test(css)) {
        css = '.text-split { overflow: hidden; text-overflow: ellipsis; white-space: normal; -webkit-box-orient: vertical; display: -webkit-box; -webkit-line-clamp: 3; }\n' + css;
    }
    const sources = { html: formatHtml(html, parse5, { preserveWhitespace }), css: formatCss(css, tree) };
    assertSourceBudget(sources.html, sources.css);
    return sources;
}

function format(request) {
    try {
        if (!request || typeof request.directory !== 'string') throw new Error('directory is required.');
        const directory = path.resolve(request.directory);
        assertNoSymlinks(directory);
        const htmlPath = path.join(directory, 'index.html');
        const cssPath = path.join(directory, 'style.css');
        assertNoSymlinks(htmlPath);
        assertNoSymlinks(cssPath);
        const original = {
            html: readLimited(htmlPath, LIMITS.sourceBytes).toString('utf8'),
            css: readLimited(cssPath, LIMITS.sourceBytes).toString('utf8')
        };
        // Never let a formatter's parser recovery hide an actual candidate error.
        const checked = validateInternal(request, original);
        const before = checked.result;
        if (!before.ok) throw new Error('Only an AST-valid candidate may be formatted.');
        const { parse5, 'css-tree': tree } = dependencies(['parse5', 'css-tree']);
        const sources = formattedSources(original.html, original.css, parse5, tree, checked.state, swiper.normalize(request.swipers));
        if (request.max_source_bytes !== undefined) assertSourceBudget(sources.html, sources.css, request.max_source_bytes);
        const after = validateInternal(request, sources).result;
        if (!after.ok) throw new Error('Formatted source failed AST validation; original candidate retained.');
        fs.writeFileSync(htmlPath, sources.html);
        fs.writeFileSync(cssPath, sources.css);
        return { ok: true, formatted: true, errors: [] };
    } catch (error) {
        return { ok: false, formatted: true, errors: [error.message] };
    }
}

// Re-scan final sources, not the cache of assets visited while sanitizing or
// embedding SVGs. Rejected CSS declarations and inline-only SVGs are not output
// dependencies; retained CSS (even selectors not currently matched) still is.
function referencedAssets(html, css, state, parse5, tree) {
    const filenames = new Set();
    const reference = value => {
        if (value.startsWith('#') || value === 'style.css') return;
        filenames.add(assetPath(value, state));
    };
    const document = parse5.parse(html);
    assertHtmlBudget(document);
    const stack = [{ node: document, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
        if (node.tagName === 'svg' && node.namespaceURI === svg.SVG_NS) {
            // The shared policy permits only document-local gradient/paint/mask
            // fragments, never files hidden inside inline SVG attributes.
            svg.validateNode(node, { inline: true });
            continue;
        }
        for (const attr of node.attrs || []) {
            if (['src', 'href'].includes(attr.name)) reference(attr.value);
        }
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
    }
    if (css.includes('\\') || css.includes('\0')) throw new Error('CSS escapes and NUL characters are forbidden.');
    const ast = tree.parse(css, { parseCustomProperty: true, onParseError(error) { throw error; } });
    let depth = 0;
    nodes = 0;
    tree.walk(ast, {
        enter(node) {
            if (++nodes > LIMITS.nodes || ++depth > LIMITS.depth) throw new Error('CSS node/depth budget exceeded.');
            if (node.type === 'Raw') throw new Error('CSS could not be parsed into a strict AST.');
            if (node.type === 'Url') filenames.add(assetPath(node.value, state));
        },
        leave() { depth--; }
    });
    return [...filenames].sort();
}

function outputAssets(request) {
    try {
        if (!request || typeof request.directory !== 'string') throw new Error('directory is required.');
        const directory = path.resolve(request.directory);
        assertNoSymlinks(directory);
        const sources = {};
        for (const name of ['index.html', 'style.css']) {
            const filename = path.join(directory, name);
            assertNoSymlinks(filename);
            sources[name] = readLimited(filename, LIMITS.sourceBytes).toString('utf8');
        }
        assertSourceBudget(sources['index.html'], sources['style.css']);
        if ((sources['index.html'].match(/</g) || []).length > LIMITS.nodes || (sources['style.css'].match(/[{};,:()]/g) || []).length > LIMITS.nodes) throw new Error('Source token/node budget exceeded.');
        const { parse5, 'css-tree': tree } = dependencies(['parse5', 'css-tree']);
        const state = { directory, preview: true, assets: new Map(), assetBuffers: new Map(), totalAssetBytes: 0, assetPixels: 0 };
        const filenames = referencedAssets(sources['index.html'], sources['style.css'], state, parse5, tree);
        if (request.prune_output_assets === true) {
            // Never prune the job's original import pool, even on a bad request.
            if (!['versions', 'previews'].includes(path.basename(path.dirname(directory))) || !/^\d+$/.test(path.basename(directory))) throw new Error('Asset pruning requires a numbered version or preview output directory.');
            const retained = new Set(filenames);
            const unused = [];
            const pending = [path.join(directory, 'assets')];
            while (pending.length) {
                const current = pending.pop();
                if (!fs.existsSync(current)) continue;
                assertNoSymlinks(current);
                if (fs.statSync(current).isDirectory()) {
                    for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
                } else if (!retained.has(current)) unused.push(current);
            }
            // Enumerate and check the whole tree before deleting any output copy.
            for (const filename of unused) fs.unlinkSync(filename);
        }
        return { ok: true, errors: [], assets: filenames.map(filename => path.relative(directory, filename).split(path.sep).join('/')) };
    } catch (error) {
        return { ok: false, errors: [error.message] };
    }
}

function preview(request) {
    let directory;
    let outputDirectory;
    let createdOutput = false;
    try {
        if (!request || typeof request.directory !== 'string' || typeof request.output_directory !== 'string' || !request.output_directory.trim()) throw new Error('directory and output_directory are required.');
        integer(request.content_width, 'content_width');
        directory = path.resolve(request.directory);
        outputDirectory = path.resolve(request.output_directory);
        assertNoSymlinks(directory);
        assertNoSymlinks(outputDirectory);
        directory = fs.realpathSync(directory);
        if (!fs.statSync(directory).isDirectory()) throw new Error('directory must be a directory.');
        // Versions and previews are cousins: <job>/versions/<n>, <job>/previews/<n>.
        const jobRoot = path.dirname(path.dirname(directory));
        if (!inside(jobRoot, outputDirectory) || inside(directory, outputDirectory) || inside(outputDirectory, directory)) throw new Error('output_directory must be a separate directory inside the same job root, never source or its ancestor/descendant.');
        if (fs.existsSync(outputDirectory) && (!fs.statSync(outputDirectory).isDirectory() || fs.readdirSync(outputDirectory).length)) throw new Error('output_directory must be new or empty.');
        const sources = {};
        for (const name of ['index.html', 'style.css']) {
            const filename = path.join(directory, name);
            assertNoSymlinks(filename);
            sources[name] = readLimited(filename, LIMITS.sourceBytes).toString('utf8');
        }
        assertSourceBudget(sources['index.html'], sources['style.css']);
        if ((sources['index.html'].match(/</g) || []).length > LIMITS.nodes || (sources['style.css'].match(/[{};,:()]/g) || []).length > LIMITS.nodes) throw new Error('Source token/node budget exceeded.');
        const { parse5, 'css-tree': tree } = dependencies(['parse5', 'css-tree']);
        const state = { directory, preview: true, assets: new Map(), assetBuffers: new Map(), totalAssetBytes: 0, assetPixels: 0 };
        let swipers = [];
        // Invalid runtime declarations remain inert, as in static previews before
        // normalization; only validated selector/config data can generate CSS.
        try { swipers = swiper.normalize(request.swipers); } catch { /* Static content still previews. */ }
        const { html, css } = formattedSources(
            sanitizePreviewHtml(sources['index.html'], state, parse5),
            sanitizePreviewCss(sources['style.css'], state, tree),
            parse5,
            tree,
            state,
            swipers
        );
        // Resolve reachability after sanitization and SVG normalization. Publish
        // precisely the inspected buffers for those final dependencies only.
        const assets = referencedAssets(html, css, state, parse5, tree)
            .map(filename => ({ relative: path.relative(directory, filename), data: state.assetBuffers.get(filename) }));
        assertNoSymlinks(outputDirectory);
        fs.mkdirSync(outputDirectory, { recursive: true });
        if (fs.readdirSync(outputDirectory).length) throw new Error('output_directory must be new or empty.');
        createdOutput = true;
        for (const asset of assets) {
            const target = path.join(outputDirectory, asset.relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, asset.data, { flag: 'wx' });
        }
        fs.writeFileSync(path.join(outputDirectory, 'style.css'), css, { flag: 'wx' });
        fs.writeFileSync(path.join(outputDirectory, 'index.html'), html, { flag: 'wx' });
        return { ok: true, preview: true, errors: [], directory, output_directory: outputDirectory, assets: assets.length };
    } catch (error) {
        if (createdOutput) {
            try { fs.rmSync(outputDirectory, { recursive: true, force: true }); } catch { /* Never claim a partially written preview succeeded. */ }
        }
        return { ok: false, preview: true, errors: [error.message] };
    }
}

function pngDimensions(buffer) {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Reference must be a PNG image.');
    const width = integer(buffer.readUInt32BE(16), 'PNG width');
    const height = integer(buffer.readUInt32BE(20), 'PNG height');
    if (width * height > LIMITS.pixels) throw new Error('PNG pixel budget exceeded.');
    return { width, height };
}

async function main(argv = process.argv.slice(2)) {
    const [command, requestFile] = argv;
    if (command === 'environment') {
        if (argv.length > 2) throw new Error('Usage: runner.cjs environment [request.json]');
        return environment();
    }
    if (!['validate', 'format', 'preview', 'assets', 'scripts'].includes(command) || argv.length !== 2) throw new Error('Usage: runner.cjs environment | validate <request.json> | format <request.json> | preview <request.json> | assets <request.json> | scripts <request.json>');
    const request = JSON.parse(readLimited(path.resolve(requestFile), LIMITS.requestBytes).toString('utf8'));
    if (command === 'scripts') return swiper.scripts(request);
    if (command === 'assets') return outputAssets(request);
    if (command === 'preview') return preview(request);
    if (command === 'format') return format(request);
    return validateInternal(request).result;
}

if (require.main === module) {
    main().then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.ok) process.exitCode = 1;
    }).catch(error => {
        process.stdout.write(`${JSON.stringify({ ok: false, errors: [error.message], regions: [] })}\n`);
        process.exitCode = 1;
    });
}

module.exports = { environment, validate: request => validateInternal(request).result, scripts: swiper.scripts, format, preview, outputAssets, main, LIMITS, pngDimensions };
