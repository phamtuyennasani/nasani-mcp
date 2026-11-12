'use strict';

// One inert SVG policy for local assets, inline HTML and sanitized drafts. parse5's
// foreign-content parser is paired with a strict XML envelope check: HTML parser
// recovery must never turn malformed/XML-active input into an accepted SVG.
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
// Larger vector exports still have finite parsing, nesting and rendering budgets.
const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, nodes: 40000, depth: 256, dimension: 16384, pixels: 16000000 });
const FILTER_LIMITS = Object.freeze({ filters: 256, primitives: 2048 });
const FILTER_PRIMITIVES = new Set('feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDropShadow feFlood feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile'.split(' '));
const TAGS = new Set(('svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask title desc filter '
    + [...FILTER_PRIMITIVES].join(' ')).split(' '));
const ATTRS = new Set(('id class role aria-hidden aria-label aria-labelledby aria-describedby focusable '
    + 'viewBox preserveAspectRatio x y width height rx ry cx cy r x1 x2 y1 y2 dx dy d points pathLength transform '
    + 'fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity '
    + 'opacity clip-path clip-rule mask filter vector-effect color color-interpolation color-interpolation-filters style '
    + 'gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr '
    + 'clipPathUnits maskUnits maskContentUnits mask-type '
    + 'filterUnits primitiveUnits result in in2 mode type values operator k1 k2 k3 k4 stdDeviation flood-color flood-opacity '
    + 'scale edgeMode surfaceScale diffuseConstant specularConstant specularExponent lighting-color azimuth elevation '
    + 'pointsAtX pointsAtY pointsAtZ kernelMatrix order targetX targetY preserveAlpha divisor bias intercept amplitude exponent '
    + 'tableValues limitingConeAngle href').split(' '));
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

const REF_WORK_LIMIT = LIMITS.nodes * 4;

function fail(message, code = 'SVG_INVALID') {
    const error = new Error(`Unsafe SVG: ${message}`);
    error.code = code;
    error.limit = code === 'SVG_LIMIT';
    throw error;
}

function xmlEnvelope(source, { allowUnknownTags = false } = {}) {
    if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.bytes) fail('byte budget exceeded.', 'SVG_LIMIT');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/.test(source)) fail('invalid XML characters/encoding.');
    source = source.replace(/^﻿/, '').replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, '');
    if (/<![^-]|<\?|\]\]>/.test(source)) fail('XML declarations, entities, CDATA and processing instructions are forbidden.');
    const stack = [];
    let position = 0;
    let roots = 0;
    let count = 0;
    while (position < source.length) {
        if (source.startsWith('<!--', position)) {
            const end = source.indexOf('-->', position + 4);
            if (end < 0 || source.slice(position + 4, end).includes('--')) fail('malformed XML comment.');
            position = end + 3;
            continue;
        }
        if (source[position] !== '<') {
            const end = source.indexOf('<', position);
            const text = source.slice(position, end < 0 ? source.length : end);
            if (!stack.length && text.trim()) fail('content outside the SVG root.');
            if (text.includes('>') || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(text)) fail('malformed XML text/entity.');
            position += text.length;
            continue;
        }
        const match = /^<(\/)?([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/.exec(source.slice(position));
        if (!match || (!allowUnknownTags && !TAGS.has(match[2]))) fail('forbidden or malformed element.');
        position += match[0].length;
        const name = match[2];
        if (match[1]) {
            const end = /^\s*>/.exec(source.slice(position));
            if (!end || stack.pop() !== name) fail('mismatched closing tag.');
            position += end[0].length;
            continue;
        }
        if (++count > LIMITS.nodes || stack.length >= LIMITS.depth) fail('node/depth budget exceeded.', 'SVG_LIMIT');
        if (!stack.length && (++roots !== 1 || name !== 'svg')) fail('exactly one SVG root is required.');
        const names = new Set();
        while (true) {
            const end = /^\s*(\/?)>/.exec(source.slice(position));
            if (end) {
                position += end[0].length;
                if (!end[1]) stack.push(name);
                break;
            }
            const attr = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(source.slice(position));
            if (!attr || names.has(attr[1].toLowerCase())) fail('malformed or duplicate attribute.');
            names.add(attr[1].toLowerCase());
            if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(attr[2])) fail('unknown XML entity.');
            position += attr[0].length;
        }
    }
    if (stack.length || roots !== 1) fail('unclosed/missing SVG root.');
    return source;
}

const SAFE_BLEND_MODES = new Set('normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion'.split(' '));
function safeStyle(value) {
    if (typeof value !== 'string' || /[{}<>]|url\s*\(|expression\s*\(|@|\/\*/i.test(value)) return false;
    const declarations = value.split(';').map(item => item.trim()).filter(Boolean);
    return declarations.length > 0 && declarations.every(declaration => {
        const separator = declaration.indexOf(':');
        if (separator < 1) return false;
        const name = declaration.slice(0, separator).trim().toLowerCase();
        const itemValue = declaration.slice(separator + 1).trim().toLowerCase();
        if (name === 'mix-blend-mode') return SAFE_BLEND_MODES.has(itemValue);
        return name === 'isolation' && itemValue === 'isolate';
    });
}

function sanitize(buffer, parse5 = require('parse5')) {
    const source = xmlEnvelope(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer, { allowUnknownTags: true });
    const errors = [];
    const fragment = parse5.parseFragment(source, { onParseError: error => errors.push(error.code) });
    if (errors.length) fail(`parse error: ${errors[0]}.`);
    const root = fragment.childNodes.find(node => node.tagName === 'svg');
    if (!root || fragment.childNodes.some(node => node !== root && !(node.nodeName === '#comment' || (node.nodeName === '#text' && !node.value.trim())))) {
        fail('exactly one SVG is required.');
    }
    const clean = node => {
        if (node.nodeName === '#comment' || node.nodeName === '#text') return node;
        if (!TAGS.has(node.tagName)) return null;
        node.attrs = (node.attrs || []).filter(attr => {
            const name = attr.name;
            const value = attr.value;
            if (/^on[a-z]/i.test(name)) return false;
            if (name === 'style') return safeStyle(value);
            if (name === 'href' && !FRAGMENT.test(value)) return false;
            if (/url\s*\(/i.test(value) && !/^url\(\s*["']?#[A-Za-z_][A-Za-z0-9_.:-]*["']?\s*\)$/i.test(value)) return false;
            if (attr.namespace && !(name === 'href' && attr.namespace === XLINK_NS)) return false;
            return name === 'xmlns' || (attr.prefix === 'xmlns' && name === 'xlink') || ATTRS.has(name)
                || /^(?:aria-[a-z0-9-]+|tabindex)$/.test(name);
        });
        node.childNodes = (node.childNodes || []).map(clean).filter(Boolean);
        return node;
    };
    const cleaned = clean(root);
    if (!cleaned) fail('SVG root is required.');
    fragment.childNodes = [cleaned];
    return Buffer.from(parse5.serialize(fragment));
}

function validateNode(root, { inline = false, source = null } = {}) {
    if (source !== null) xmlEnvelope(source);
    if (root?.tagName !== 'svg' || root.namespaceURI !== SVG_NS) fail('SVG namespace/root is required.');
    const ids = new Set();
    const references = [];
    const stack = [{ node: root, depth: 0 }];
    let count = 0;
    let filterCount = 0;
    let primitiveCount = 0;
    let referenceWork = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (++count > LIMITS.nodes || depth > LIMITS.depth) fail('node/depth budget exceeded.', 'SVG_LIMIT');
        if (node.nodeName === '#comment') continue;
        if (node.nodeName === '#text') {
            if (node.value.trim() && !['title', 'desc'].includes(node.parentNode?.tagName)) fail('text is only allowed in title/desc.');
            continue;
        }
        if (node.namespaceURI !== SVG_NS || !TAGS.has(node.tagName) || (node !== root && node.tagName === 'svg')) fail('forbidden element/namespace.');
        if (node.tagName === 'filter' && ++filterCount > FILTER_LIMITS.filters) fail('filter budget exceeded.', 'SVG_LIMIT');
        if (FILTER_PRIMITIVES.has(node.tagName)) {
            primitiveCount++;
            if (primitiveCount > FILTER_LIMITS.primitives) fail('filter primitive budget exceeded.', 'SVG_LIMIT');
            if (!node.parentNode || !['filter', 'feMerge'].includes(node.parentNode.tagName)) fail('filter primitives must belong to a filter.');
        }
        if (node.tagName === 'feMergeNode' && node.parentNode?.tagName !== 'feMerge') fail('feMergeNode must belong to feMerge.');
        for (const attr of node.attrs || []) {
            const { name, value } = attr;
            if (/[\\<>\u0000-\u001f\u007f�]/.test(value)) fail(`invalid ${name} value.`);
            if (attr.namespace === 'http://www.w3.org/2000/xmlns/') {
                if (node !== root || !((!attr.prefix && name === 'xmlns' && value === SVG_NS)
                    || (attr.prefix === 'xmlns' && name === 'xlink' && value === XLINK_NS))) fail('forbidden namespace declaration.');
                continue;
            }
            if (attr.namespace && !(name === 'href' && attr.namespace === XLINK_NS && attr.prefix === 'xlink')) fail('forbidden namespaced attribute.');
            if (!ATTRS.has(name) && !/^(?:aria-[a-z0-9-]+|tabindex)$/.test(name)) fail(`forbidden attribute ${name}.`);
            if (inline && node === root && ['width', 'height'].includes(name)) fail('inline root width/height belong in layout CSS.');
            if (node === root && ['width', 'height'].includes(name)
                && (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value) || parseFloat(value) <= 0 || parseFloat(value) > LIMITS.dimension)) fail('intrinsic root dimensions exceed bounds.', 'SVG_LIMIT');
            if (name === 'href') {
                if (!['linearGradient', 'radialGradient'].includes(node.tagName) || !FRAGMENT.test(value)) fail('only local gradient href references are allowed.');
                references.push({ id: value.slice(1), node, kinds: ['linearGradient', 'radialGradient'] });
            } else if (/url\s*\(/i.test(value)) {
                if (!['fill', 'stroke', 'clip-path', 'mask', 'filter'].includes(name) || !/^url\(\s*["']?#[A-Za-z_][A-Za-z0-9_.:-]*["']?\s*\)$/.test(value)) fail('only local paint/mask/clip/filter fragments are allowed.');
                references.push({ id: value.match(/#([A-Za-z_][A-Za-z0-9_.:-]*)/)[1], node,
                    kinds: name === 'mask' ? ['mask'] : name === 'clip-path' ? ['clipPath'] : name === 'filter' ? ['filter'] : ['linearGradient', 'radialGradient'] });
            } else if (name === 'style') {
                if (!safeStyle(value)) fail('unsupported static style.');
            } else if (/[():]/.test(value) && !['d', 'points', 'transform', 'gradientTransform', 'fill', 'stroke', 'color', 'stop-color', 'id', 'class', 'aria-label', 'aria-labelledby', 'aria-describedby'].includes(name)) {
                fail(`unsupported ${name} syntax.`);
            }
            if (['fill', 'stroke', 'color', 'stop-color'].includes(name) && !/^url\(/.test(value)
                && !/^(?:none|currentColor|transparent|[a-zA-Z]+|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/]*\))$/.test(value)) fail('unsupported paint value.');
            if (['transform', 'gradientTransform'].includes(name) && !/^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE.,+\-\s]+\)\s*)+$/.test(value)) fail('invalid static transform.');
            if (name === 'id') {
                if (!ID.test(value) || ids.has(value)) fail('invalid/duplicate id.');
                ids.add(value);
            }
        }
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
    }
    const idNodes = new Map();
    const pending = [root];
    while (pending.length) {
        const node = pending.pop();
        const id = node.attrs?.find(attr => attr.name === 'id')?.value;
        if (id) idNodes.set(id, node);
        pending.push(...(node.childNodes || []));
    }
    const referenceGraph = new Map();
    for (const reference of references) {
        const target = idNodes.get(reference.id);
        referenceWork++;
        if (referenceWork > REF_WORK_LIMIT) fail('reference work budget exceeded.', 'SVG_LIMIT');
        if (!target || !reference.kinds.includes(target.tagName)) fail('fragment does not resolve to the expected SVG definition.');
        // A mask/clip that uses itself (or an indirect chain of definitions) is
        // recursive rendering work, not a harmless document-local reference.
        let owner = reference.node;
        while (owner && !['filter', 'mask', 'clipPath', 'linearGradient', 'radialGradient'].includes(owner.tagName)) owner = owner.parentNode;
        if (owner) {
            if (!referenceGraph.has(owner)) referenceGraph.set(owner, new Set());
            referenceGraph.get(owner).add(target);
        }
    }
    const active = new Set();
    const completed = new Set();
    // Definition chains can be much longer than the XML nesting depth. Traverse
    // iteratively so a bounded, flat SVG cannot overflow the JavaScript stack.
    for (const node of referenceGraph.keys()) {
        if (completed.has(node)) continue;
        const pending = [{ node, exit: false }];
        while (pending.length) {
            const current = pending.pop();
            if (current.exit) {
                active.delete(current.node);
                completed.add(current.node);
                continue;
            }
            if (active.has(current.node)) fail('cyclic SVG definition references.');
            if (completed.has(current.node)) continue;
            active.add(current.node);
            pending.push({ node: current.node, exit: true });
            for (const target of referenceGraph.get(current.node) || []) pending.push({ node: target, exit: false });
        }
    }
    const viewBox = root.attrs.find(attr => attr.name === 'viewBox')?.value;
    const numbers = viewBox?.trim().split(/[\s,]+/).map(Number);
    if (!numbers || numbers.length !== 4 || numbers.some(value => !Number.isFinite(value))
        || numbers[2] <= 0 || numbers[3] <= 0 || numbers.some(value => Math.abs(value) > LIMITS.dimension)
        || numbers[2] * numbers[3] > LIMITS.pixels) fail('a bounded positive viewBox is required.', 'SVG_LIMIT');
    const intrinsicWidth = parseFloat(root.attrs.find(attr => attr.name === 'width')?.value) || numbers[2];
    const intrinsicHeight = parseFloat(root.attrs.find(attr => attr.name === 'height')?.value) || numbers[3];
    const pixels = Math.max(Math.ceil(numbers[2]) * Math.ceil(numbers[3]), Math.ceil(intrinsicWidth) * Math.ceil(intrinsicHeight));
    if (pixels > LIMITS.pixels) fail('intrinsic SVG pixel budget exceeded.', 'SVG_LIMIT');
    return { width: numbers[2], height: numbers[3], pixels };
}

function inspect(buffer, parse5 = require('parse5')) {
    const source = xmlEnvelope(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer);
    const errors = [];
    const fragment = parse5.parseFragment(source, { onParseError: error => errors.push(error.code) });
    if (errors.length) fail(`parse error: ${errors[0]}.`);
    const nodes = fragment.childNodes.filter(node => node.nodeName !== '#comment' && !(node.nodeName === '#text' && !node.value.trim()));
    if (nodes.length !== 1) fail('exactly one SVG is required.');
    const dimensions = validateNode(nodes[0]);
    // Compare validated SVG trees without changing the downloaded source bytes.
    // Figma may rename local definitions or reorder attributes between exports.
    const ids = new Map();
    function collect(node) {
        const id = node.attrs?.find(attr => attr.name === 'id')?.value;
        if (id) ids.set(id, `definition-${ids.size}`);
        for (const child of node.childNodes || []) collect(child);
    }
    collect(nodes[0]);
    function canonical(node) {
        if (node.nodeName === '#comment') return null;
        if (node.nodeName === '#text') return node.value.trim() ? ['text', node.value] : null;
        const attrs = (node.attrs || []).map(attr => {
            let value = attr.value;
            if (attr.name === 'id') value = ids.get(value);
            else if (attr.name === 'href' && value.startsWith('#')) value = '#' + ids.get(value.slice(1));
            else if (/^url\(/.test(value)) value = value.replace(/#[A-Za-z_][A-Za-z0-9_.:-]*/, id => '#' + ids.get(id.slice(1)));
            else if (['aria-labelledby', 'aria-describedby'].includes(attr.name)) value = value.split(/\s+/).map(id => ids.get(id) || id).join(' ');
            return [attr.namespace || '', attr.prefix || '', attr.name, value];
        }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return [node.tagName, attrs, (node.childNodes || []).map(canonical).filter(child => child !== null)];
    }
    const contentHash = require('node:crypto').createHash('sha256').update(JSON.stringify(canonical(nodes[0]))).digest('hex');
    return { ...dimensions, content_hash: contentHash };
}

if (require.main === module) {
    try {
        const fs = require('node:fs');
        const filename = process.argv[2];
        const sanitizeRequested = process.argv[3] === '--sanitize';
        if (process.argv.length !== (sanitizeRequested ? 4 : 3) || !filename || !fs.statSync(filename).isFile() || fs.statSync(filename).size > LIMITS.bytes) fail('invalid asset or byte budget exceeded.', 'SVG_LIMIT');
        const original = fs.readFileSync(filename);
        const output = sanitizeRequested ? sanitize(original) : original;
        const dimensions = inspect(output);
        const changed = !output.equals(original);
        if (sanitizeRequested && changed) fs.writeFileSync(filename, output);
        process.stdout.write(JSON.stringify({ ok: true, ...dimensions, sanitized: sanitizeRequested && changed }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'SVG_INVALID', limit: error.limit === true, errors: [error.message] }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { inspect, sanitize, validateNode, xmlEnvelope, SVG_NS, LIMITS };
