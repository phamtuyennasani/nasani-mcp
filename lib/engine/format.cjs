'use strict';

// Formatting is deliberately separate from the runner's security/BEM validation.
// Keep these budgets at or below runner.cjs; never serialize a repaired HTML tree.
const LIMITS = Object.freeze({ sourceBytes: 16 * 1024 * 1024, nodes: 100000, depth: 320 });
const HTML_SPACE = /^[\t\n\f\r ]*$/;
// Block tags are a conservative HTML default, not computed CSS display or
// white-space. External styles are unavailable to this standalone formatter.
const BLOCK_TAGS = new Set(('address article aside blockquote body caption center colgroup dd details dialog dir div dl dt '
    + 'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html legend li main menu nav ol p '
    + 'pre section summary table tbody td tfoot th thead tr ul').split(' '));
const EXACT_TAGS = new Set('pre code textarea script style title xmp iframe noembed noframes plaintext listing'.split(' '));
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const OPTIONAL_END_TAGS = new Set('html head body p li dt dd rt rp optgroup option colgroup thead tbody tfoot tr td th'.split(' '));

function checkSource(source, language, punctuation) {
    if (typeof source !== 'string') throw new TypeError(`${language} source must be a string.`);
    if (Buffer.byteLength(source, 'utf8') > LIMITS.sourceBytes) throw new Error(`${language} source byte budget exceeded.`);
    // The runner also bounds punctuation before handing source to either parser.
    let count = 0;
    for (const character of source) {
        if (punctuation.includes(character) && ++count > LIMITS.nodes) throw new Error(`${language} token/node budget exceeded.`);
    }
}

function lowerBound(items, offset, startOf) {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (startOf(items[middle]) < offset) low = middle + 1;
        else high = middle;
    }
    return low;
}

function indent(depth) {
    return '    '.repeat(depth);
}

function finalNewline(source) {
    return source.endsWith('\n') ? source : `${source}\n`;
}

function htmlRange(node) {
    const location = node.sourceCodeLocation;
    if (!location) return null;
    return {
        start: location.startTag?.startOffset ?? location.startOffset,
        // parse5 can extend html/body locations to include text after their end tags.
        end: location.endTag?.endOffset ?? location.endOffset
    };
}

function compactStartTag(source, location) {
    const attributes = Object.values(location.attrs || {}).sort((left, right) => left.startOffset - right.startOffset);
    const tag = location.startTag;
    if (!attributes.length) {
        return source.slice(tag.startOffset, tag.endOffset)
            .replace(/[\t\n\f\r ]+/g, ' ').replace(/ +>$/, '>');
    }
    const prefix = source.slice(tag.startOffset, attributes[0].startOffset).replace(/[\t\n\f\r ]+$/, '');
    const values = attributes.map(attribute => source.slice(attribute.startOffset, attribute.endOffset)
        // Only the name/equals prefix is changed; quoted and unquoted values stay exact.
        .replace(/^([^\t\n\f\r =]+)[\t\n\f\r ]*=[\t\n\f\r ]*/, '$1='));
    const suffix = source.slice(attributes[attributes.length - 1].endOffset, tag.endOffset)
        .replace(/[\t\n\f\r ]+/g, ' ').replace(/ +>$/, '>');
    return `${prefix} ${values.join(' ')}${suffix}`;
}

// Edit only real attribute ranges: preserve text, escaped examples and SVG geometry.
// The runner validates original candidates first; downloaded assets never pass here.
function omitSupplementaryAttributes(source, parse5) {
    checkSource(source, 'HTML', '<');
    const document = parse5.parse(source, {
        sourceCodeLocationInfo: true,
        onParseError(error) {
            if (error.code !== 'missing-doctype') throw new Error(`HTML parse error: ${error.code}.`);
        }
    });
    const edits = [];
    const stack = [{ node: document, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
        const location = node.sourceCodeLocation;
        for (const [name, attribute] of Object.entries(location?.attrs || {})) {
            const htmlId = name.toLowerCase() === 'id' && node.namespaceURI === 'http://www.w3.org/1999/xhtml';
            if (!htmlId && !/^(?:aria-.*|role|tabindex)$/i.test(name)) continue;
            let start = attribute.startOffset;
            while (start > location.startTag.startOffset && /[\t\n\f\r ]/.test(source[start - 1])) start--;
            edits.push({ start, end: attribute.endOffset });
        }
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
        if (node.content) stack.push({ node: node.content, depth: depth + 1 });
    }
    edits.sort((left, right) => left.start - right.start);
    const parts = [];
    let cursor = 0;
    for (const edit of edits) {
        parts.push(source.slice(cursor, edit.start));
        cursor = edit.end;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
}

function formatHtml(source, parse5, options = {}) {
    checkSource(source, 'HTML', '<');
    if (!parse5 || typeof parse5.parse !== 'function') throw new TypeError('A parse5 parser is required.');
    const document = parse5.parse(source, {
        sourceCodeLocationInfo: true,
        onParseError(error) {
            // Fragments and documents without a doctype are still format-able; no
            // missing syntax is ever emitted. All actual reported errors are fatal.
            if (error.code !== 'missing-doctype') throw new Error(`HTML parse error: ${error.code} at ${error.startLine}:${error.startCol}.`);
        }
    });
    const edits = [];
    // Optional caller knowledge of CSS white-space/display can protect a whole
    // subtree (boolean or predicate on parse5 elements), without guessing CSS.
    const preserved = new Set();
    const stack = [{ node: document, depth: 0, exact: false }];
    let nodes = 0;
    while (stack.length) {
        const { node, depth, exact } = stack.pop();
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('HTML node/depth budget exceeded.');
        const location = node.sourceCodeLocation;
        const foreign = node.tagName && node.namespaceURI !== 'http://www.w3.org/1999/xhtml';
        const preserveContext = node.tagName && (options.preserveWhitespace === true
            || (typeof options.preserveWhitespace === 'function' && options.preserveWhitespace(node) === true));
        const protectedSubtree = exact || EXACT_TAGS.has(node.tagName) || foreign || preserveContext;
        if (preserveContext) preserved.add(node);
        if (node.tagName && location?.startTag) {
            const foreignSelfClosing = node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
                && source.slice(location.startTag.startOffset, location.startTag.endOffset).endsWith('/>');
            // parse5 6 omits endTag locations on legitimate integration nodes
            // such as foreignObject. Foreign subtrees remain byte-exact instead.
            if (!foreign && !location.endTag && !VOID_TAGS.has(node.tagName) && !OPTIONAL_END_TAGS.has(node.tagName) && !foreignSelfClosing) {
                throw new Error(`HTML missing closing tag: ${node.tagName}.`);
            }
            if (!protectedSubtree) edits.push({
                start: location.startTag.startOffset,
                end: location.startTag.endOffset,
                text: compactStartTag(source, location)
            });
        }
        for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1, exact: protectedSubtree });
        if (node.content) stack.push({ node: node.content, depth: depth + 1, exact: protectedSubtree });
    }
    edits.sort((left, right) => left.start - right.start);
    function raw(start, end) {
        let cursor = start;
        const parts = [];
        for (let index = lowerBound(edits, start, edit => edit.start); index < edits.length && edits[index].start < end; index++) {
            const edit = edits[index];
            if (edit.end > end) throw new Error('HTML source locations overlap.');
            parts.push(source.slice(cursor, edit.start), edit.text);
            cursor = edit.end;
        }
        parts.push(source.slice(cursor, end));
        return parts.join('');
    }
    function rootChildren(node) {
        const children = [];
        for (const child of node.childNodes || []) {
            if (!child.sourceCodeLocation && ['html', 'head', 'body'].includes(child.tagName)) children.push(...rootChildren(child));
            else children.push(child);
        }
        return children;
    }
    function renderChildren(node, start, end, depth, root = false) {
        const children = root ? rootChildren(node) : node.childNodes || [];
        const meaningful = [];
        let cursor = start;
        for (const child of children) {
            const range = htmlRange(child);
            if (!range) return null; // e.g. implied tbody: retain source, not repaired DOM.
            // parse5 may merge trailing document whitespace across </body></html>.
            if (child.nodeName === '#text' && HTML_SPACE.test(child.value)
                && HTML_SPACE.test(source.slice(range.start, Math.min(range.end, end)))) continue;
            if (range.start < cursor || range.end > end || !HTML_SPACE.test(source.slice(cursor, range.start))) {
                throw new Error(`HTML source locations do not describe an ordered source tree: ${node.nodeName}/${child.nodeName} at ${range.start}:${range.end} within ${start}:${end}.`);
            }
            meaningful.push(child);
            cursor = range.end;
        }
        if (!HTML_SPACE.test(source.slice(cursor, end))) return null;
        if (!meaningful.length) return null;
        // An omitted end tag can own following indentation as text on reparse.
        if (meaningful.some(child => child.tagName && !VOID_TAGS.has(child.tagName)
            && !child.sourceCodeLocation?.endTag)) return null;
        const documentContainer = root || node.tagName === 'html' || node.tagName === 'head';
        if (meaningful.some(child => !child.tagName && child.nodeName !== '#comment'
            && !(documentContainer && child.nodeName === '#documentType'))) return null;
        const blockChild = child => child.tagName && (BLOCK_TAGS.has(child.tagName) || (documentContainer && !root));
        const hasInline = meaningful.some(child => child.tagName && !blockChild(child));
        // Comments between inline siblings must not introduce a visible gap.
        const structural = child => (child.nodeName === '#comment' && !hasInline)
            || (documentContainer && child.nodeName === '#documentType') || blockChild(child);
        if (!meaningful.some(structural)) return null;
        const groups = [];
        let inline = [];
        function flushInline() {
            if (!inline.length) return;
            groups.push(raw(htmlRange(inline[0]).start, htmlRange(inline[inline.length - 1]).end));
            inline = [];
        }
        for (const child of meaningful) {
            if (structural(child)) {
                flushInline();
                groups.push(render(child, depth));
            } else inline.push(child);
        }
        flushInline();
        return groups.map(group => `${indent(depth)}${group}`).join('\n');
    }
    function render(node, depth) {
        const range = htmlRange(node);
        const location = node.sourceCodeLocation;
        if (!node.tagName || preserved.has(node) || EXACT_TAGS.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
            || !location.endTag || node.content) return raw(range.start, range.end);
        const content = renderChildren(node, location.startTag.endOffset, location.endTag.startOffset, depth + 1);
        if (content === null) return raw(range.start, range.end);
        return `${raw(range.start, location.startTag.endOffset)}\n${content}\n${indent(depth)}${source.slice(location.endTag.startOffset, range.end)}`;
    }
    const result = renderChildren(document, 0, source.length, 0, true);
    return finalNewline(result === null ? raw(0, source.length) : result);
}

function formatCss(source, tree) {
    checkSource(source, 'CSS', '{};,:()');
    if (!tree || typeof tree.parse !== 'function' || typeof tree.tokenize !== 'function') throw new TypeError('A css-tree parser is required.');
    const tokens = [];
    const brackets = [];
    const types = tree.tokenTypes;
    // css-tree intentionally accepts some EOF repairs. Token boundaries let us
    // reject those without interpreting punctuation inside strings/URLs/comments.
    tree.tokenize(source, (type, start, end) => {
        const text = source.slice(start, end);
        if (type === types.BadString || type === types.BadUrl) throw new Error('CSS malformed string or URL.');
        if (type === types.Comment && !text.endsWith('*/')) throw new Error('CSS unterminated comment.');
        if (type === types.String) {
            let escapes = 0;
            for (let index = text.length - 2; index >= 0 && text[index] === '\\'; index--) escapes++;
            if (text.length < 2 || text[text.length - 1] !== text[0] || escapes % 2) throw new Error('CSS unterminated string.');
        }
        if (type === types.Url && !text.endsWith(')')) throw new Error('CSS unterminated URL.');
        if (type === types.Function || type === types.LeftParenthesis) brackets.push(types.RightParenthesis);
        else if (type === types.LeftSquareBracket) brackets.push(types.RightSquareBracket);
        else if (type === types.LeftCurlyBracket) brackets.push(types.RightCurlyBracket);
        else if ([types.RightParenthesis, types.RightSquareBracket, types.RightCurlyBracket].includes(type) && brackets.pop() !== type) {
            throw new Error('CSS unbalanced delimiters.');
        }
        if (brackets.length > LIMITS.depth) throw new Error('CSS node/depth budget exceeded.');
        tokens.push({ type, start, end });
    });
    if (brackets.length) throw new Error('CSS unbalanced delimiters.');
    const ast = tree.parse(source, {
        positions: true,
        parseCustomProperty: true,
        onParseError(error) { throw new Error(`CSS parse error: ${error.message}`); }
    });
    let nodes = 0;
    let depth = 0;
    tree.walk(ast, {
        enter() {
            if (++nodes > LIMITS.nodes || ++depth > LIMITS.depth) throw new Error('CSS node/depth budget exceeded.');
        },
        leave() { depth--; }
    });
    function trimStructuralEnd(start, end) {
        let index = lowerBound(tokens, end, token => token.start) - 1;
        while (index >= 0 && tokens[index].start >= start && tokens[index].type === types.WhiteSpace) {
            end = tokens[index--].start;
        }
        return source.slice(start, end);
    }
    function gap(start, end) {
        const result = [];
        for (let index = lowerBound(tokens, start, token => token.start); index < tokens.length && tokens[index].start < end; index++) {
            const token = tokens[index];
            if ([types.WhiteSpace, types.Semicolon].includes(token.type)) continue;
            if (![types.Comment, types.CDO, types.CDC].includes(token.type) || token.end > end) {
                throw new Error('CSS source range contains unparsed syntax.');
            }
            result.push({ kind: 'comment', text: source.slice(token.start, token.end) });
        }
        return result;
    }
    function renderContainer(node, start, end, level) {
        let cursor = start;
        const items = [];
        for (const child of node.children) {
            const childStart = child.loc.start.offset;
            const childEnd = child.loc.end.offset;
            if (childStart < cursor || childEnd > end) throw new Error('CSS overlapping source ranges.');
            items.push(...gap(cursor, childStart));
            items.push({ kind: child.type === 'Declaration' ? 'declaration' : 'rule', text: render(child, level) });
            cursor = childEnd;
        }
        items.push(...gap(cursor, end));
        return items.map((item, index) => {
            const previous = items[index - 1];
            const separator = !previous ? '' : previous.kind === 'rule' || (item.kind === 'rule' && previous.kind !== 'comment') ? '\n\n' : '\n';
            return `${separator}${indent(level)}${item.text}`;
        }).join('');
    }
    function render(node, level) {
        const start = node.loc.start.offset;
        const end = node.loc.end.offset;
        if (node.type === 'Declaration') {
            let index = lowerBound(tokens, start, token => token.start);
            while (index < tokens.length && tokens[index].start < end && tokens[index].type !== types.Colon) index++;
            if (!tokens[index] || tokens[index].start >= end) throw new Error('CSS declaration has no colon.');
            const colon = tokens[index].start;
            const property = trimStructuralEnd(start, colon);
            const value = source.slice(colon + 1, end).replace(/^[\t\n\f\r ]*/, '');
            return `${property}: ${value};`;
        }
        if (!['Rule', 'Atrule'].includes(node.type)) throw new Error(`CSS unsupported source node: ${node.type}.`);
        if (!node.block) return source.slice(start, end).trimEnd();
        const blockStart = node.block.loc.start.offset;
        const blockEnd = node.block.loc.end.offset;
        if (source[blockStart] !== '{' || source[blockEnd - 1] !== '}') throw new Error('CSS block has no explicit delimiters.');
        const header = trimStructuralEnd(start, blockStart);
        const content = renderContainer(node.block, blockStart + 1, blockEnd - 1, level + 1);
        return content ? `${header} {\n${content}\n${indent(level)}}` : `${header} {}`;
    }
    return finalNewline(renderContainer(ast, 0, source.length, 0));
}

module.exports = { formatHtml, formatCss, omitSupplementaryAttributes };
