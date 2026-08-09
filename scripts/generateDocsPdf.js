const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'output/pdf/netnexus-docs.pdf');
const TMP_DIR = path.join(ROOT, 'tmp/pdfs');
const PDF_TITLE = 'NetNexus 功能手册';
const PDF_SUBJECT = 'NetNexus 协议仿真、网络服务、监控和本地工具用户手册';

// Public, user-facing chapters only. The order here is the published PDF order;
// do not discover Markdown files from docs because that can expose internal guides.
const PDF_CHAPTERS = Object.freeze([
    'docs/BGP_SIMULATOR.md',
    'docs/BMP_MONITOR.md',
    'docs/BMP_SQLITE_DATABASE.md',
    'docs/RPKI_VALIDATOR.md',
    'docs/SNMP_MANAGER.md',
    'docs/NETCONF_YANG.md',
    'docs/FTP_SERVER.md',
    'docs/DHCP_SERVER.md',
    'docs/NTP_SERVER.md',
    'docs/RADIUS_SERVER.md',
    'docs/TFTP_SERVER.md',
    'docs/SYSLOG_SERVER.md',
    'docs/TOOLS.md',
    'docs/SETTINGS.md'
]);

function getMarkdownTitle(markdown, fallback) {
    const title = markdown.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
    return title || fallback;
}

function removeLeadingTitle(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const firstContentIndex = lines.findIndex(line => line.trim());
    if (firstContentIndex >= 0 && /^#\s+/.test(lines[firstContentIndex].trim())) {
        lines.splice(firstContentIndex, 1);
    }
    return lines.join('\n');
}

function getDocId(title, index) {
    return `doc-${index}-${slugify(title, 'section')}`;
}

function getHeadingNumber(level, counters, docNumber) {
    if (level < 2) {
        return '';
    }

    counters[level] = (counters[level] || 0) + 1;
    for (let index = level + 1; index <= 6; index++) {
        counters[index] = 0;
    }

    const parts = [docNumber];
    for (let index = 2; index <= level; index++) {
        if (!counters[index]) {
            break;
        }
        parts.push(counters[index]);
    }

    return parts.join('.');
}

function renderToc(docs) {
    const items = docs
        .map(doc => {
            const sectionItems = doc.headings
                .filter(heading => heading.level <= 3)
                .map(
                    heading =>
                        `<li class="toc-subitem toc-level-${heading.level}">
                            <a class="toc-link" href="#${escapeHtml(heading.id)}">
                                <span class="toc-number">${escapeHtml(heading.number)}</span>
                                <span class="toc-title">${escapeHtml(heading.text)}</span>
                            </a>
                        </li>`
                )
                .join('');
            return `
                <article class="toc-card">
                    <a class="toc-doc-link" href="#${escapeHtml(doc.id)}">
                        <span class="toc-doc-number">${escapeHtml(String(doc.number).padStart(2, '0'))}</span>
                        <span class="toc-doc-title">${escapeHtml(doc.title)}</span>
                    </a>
                    ${sectionItems ? `<ol>${sectionItems}</ol>` : ''}
                </article>
            `;
        })
        .join('');
    return `
        <section class="toc">
            <div class="toc-heading">
                <h1>目录</h1>
                <p>左侧 PDF 书签可直接跳转到模块和章节；本页标题也可点击跳转。</p>
            </div>
            <div class="toc-grid">${items}</div>
        </section>
    `;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toDataUri(filePath) {
    return fs.readFile(filePath).then(buffer => {
        const ext = path.extname(filePath).toLowerCase();
        const type =
            ext === '.jpg' || ext === '.jpeg'
                ? 'image/jpeg'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : ext === '.webp'
                    ? 'image/webp'
                    : 'image/png';
        return `data:${type};base64,${buffer.toString('base64')}`;
    });
}

function slugify(value, fallback) {
    const slug = value
        .toLowerCase()
        .replace(/[`*_~[\]()#]/g, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    return slug || fallback;
}

function normalizeUrl(url) {
    return url.replace(/^<|>$/g, '').trim();
}

async function renderInline(text, baseDir) {
    const imagePlaceholders = [];
    let working = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, rawUrl) => {
        const placeholder = `@@IMAGE_${imagePlaceholders.length}@@`;
        imagePlaceholders.push({ alt, url: normalizeUrl(rawUrl) });
        return placeholder;
    });

    const codePlaceholders = [];
    working = working.replace(/`([^`]+)`/g, (_match, code) => {
        const placeholder = `@@CODE_${codePlaceholders.length}@@`;
        codePlaceholders.push(code);
        return placeholder;
    });

    working = escapeHtml(working)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, rawUrl) => {
            const url = normalizeUrl(rawUrl);
            if (url.endsWith('.md') || url.startsWith('#')) {
                return escapeHtml(label);
            }
            return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
        });

    codePlaceholders.forEach((code, index) => {
        working = working.replace(`@@CODE_${index}@@`, `<code>${escapeHtml(code)}</code>`);
    });

    const renderedImages = [];
    for (const [index, image] of imagePlaceholders.entries()) {
        const sourcePath = path.resolve(baseDir, image.url);
        let html;
        try {
            const dataUri = await toDataUri(sourcePath);
            html = [
                '<figure>',
                `<img src="${dataUri}" alt="${escapeHtml(image.alt)}" />`,
                image.alt ? `<figcaption>${escapeHtml(image.alt)}</figcaption>` : '',
                '</figure>'
            ].join('');
        } catch (_error) {
            html = `<p class="missing-image">图片缺失: ${escapeHtml(image.url)}</p>`;
        }
        renderedImages.push({ placeholder: `@@IMAGE_${index}@@`, html });
    }

    renderedImages.forEach(image => {
        working = working.replace(image.placeholder, image.html);
    });

    return working;
}

function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
    return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
}

async function renderTable(rows, baseDir) {
    if (rows.length < 2 || !isTableSeparator(rows[1])) {
        return '';
    }

    const header = splitTableRow(rows[0]);
    const body = rows.slice(2).map(splitTableRow);
    const headHtml = (
        await Promise.all(header.map(async cell => `<th>${await renderInline(cell, baseDir)}</th>`))
    ).join('');
    const bodyHtml = await Promise.all(
        body.map(async row => {
            const cells = await Promise.all(row.map(async cell => `<td>${await renderInline(cell, baseDir)}</td>`));
            return `<tr>${cells.join('')}</tr>`;
        })
    );
    return `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml.join('')}</tbody></table>`;
}

async function renderList(items, ordered, baseDir) {
    const tag = ordered ? 'ol' : 'ul';
    const rows = await Promise.all(items.map(async item => `<li>${await renderInline(item, baseDir)}</li>`));
    return `<${tag}>${rows.join('')}</${tag}>`;
}

async function flushParagraph(paragraphLines, output, baseDir) {
    if (paragraphLines.length === 0) {
        return;
    }
    const text = paragraphLines.join(' ').trim();
    if (text) {
        output.push(`<p>${await renderInline(text, baseDir)}</p>`);
    }
    paragraphLines.length = 0;
}

async function renderMarkdown(markdown, baseDir, docIndex, docNumber) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const output = [];
    const paragraph = [];
    const headings = [];
    const headingCounters = {};

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            await flushParagraph(paragraph, output, baseDir);
            const lang = trimmed.slice(3).trim();
            const code = [];
            index++;
            while (index < lines.length && !lines[index].trim().startsWith('```')) {
                code.push(lines[index]);
                index++;
            }
            output.push(`<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        if (!trimmed) {
            await flushParagraph(paragraph, output, baseDir);
            continue;
        }

        const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (heading) {
            await flushParagraph(paragraph, output, baseDir);
            const level = Math.min(heading[1].length, 6);
            const text = heading[2].replace(/\s+#*$/, '');
            const id = `section-${docIndex}-${index}-${slugify(text, 'heading')}`;
            const number = getHeadingNumber(level, headingCounters, docNumber);
            headings.push({ level, text, id, number });
            const inlineText = await renderInline(text, baseDir);
            const numberHtml = number ? `<span class="heading-number">${escapeHtml(number)}</span> ` : '';
            output.push(`<h${level} id="${id}">${numberHtml}${inlineText}</h${level}>`);
            continue;
        }

        if (/^[-*+]\s+/.test(trimmed)) {
            await flushParagraph(paragraph, output, baseDir);
            const items = [];
            while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
                items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
                index++;
            }
            index--;
            output.push(await renderList(items, false, baseDir));
            continue;
        }

        if (/^\d+\.\s+/.test(trimmed)) {
            await flushParagraph(paragraph, output, baseDir);
            const items = [];
            while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
                items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
                index++;
            }
            index--;
            output.push(await renderList(items, true, baseDir));
            continue;
        }

        if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
            await flushParagraph(paragraph, output, baseDir);
            const rows = [line, lines[index + 1]];
            index += 2;
            while (index < lines.length && lines[index].trim().includes('|') && lines[index].trim()) {
                rows.push(lines[index]);
                index++;
            }
            index--;
            output.push(await renderTable(rows, baseDir));
            continue;
        }

        if (/^>\s?/.test(trimmed)) {
            await flushParagraph(paragraph, output, baseDir);
            const quote = trimmed.replace(/^>\s?/, '');
            output.push(`<blockquote>${await renderInline(quote, baseDir)}</blockquote>`);
            continue;
        }

        paragraph.push(trimmed);
    }

    await flushParagraph(paragraph, output, baseDir);
    return {
        html: output.join('\n'),
        headings
    };
}

function toPdfName(id) {
    return encodeURIComponent(id).replace(/[%#()[\]{}<>/\s]/g, char => {
        return `#${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    });
}

function toPdfHexString(value) {
    const bytes = [0xfe, 0xff];
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        bytes.push((code >> 8) & 0xff, code & 0xff);
    }
    return `<${bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('')}>`;
}

function formatPdfDate(date) {
    const pad = value => String(value).padStart(2, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const timezone =
        offsetMinutes === 0
            ? 'Z'
            : `${offsetMinutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}'${pad(
                  Math.abs(offsetMinutes) % 60
              )}'`;

    return [
        'D:',
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        timezone
    ].join('');
}

function buildPdfInfoDictionary(generatedAt) {
    const pdfDate = formatPdfDate(generatedAt);
    return [
        '<<',
        `/Title ${toPdfHexString(PDF_TITLE)}`,
        `/Author ${toPdfHexString('NetNexus')}`,
        `/Subject ${toPdfHexString(PDF_SUBJECT)}`,
        `/Keywords ${toPdfHexString('NetNexus, BGP, BMP, RPKI, SNMP, NETCONF, YANG, network tools')}`,
        `/Creator ${toPdfHexString('NetNexus documentation generator')}`,
        `/Producer ${toPdfHexString('Electron Chromium via NetNexus')}`,
        `/CreationDate (${pdfDate})`,
        `/ModDate (${pdfDate})`,
        '>>'
    ].join('\n');
}

function countOutlineDescendants(node) {
    return node.children.reduce((total, child) => total + 1 + countOutlineDescendants(child), 0);
}

function buildOutlineTree(docs) {
    return docs.map(doc => {
        const docNode = {
            title: `${doc.number} ${doc.title}`,
            id: doc.id,
            children: []
        };
        const parentsByLevel = { 1: docNode };
        doc.headings
            .filter(heading => heading.level <= 3)
            .forEach(heading => {
                const parent = parentsByLevel[heading.level - 1] || docNode;
                const node = {
                    title: `${heading.number} ${heading.text}`,
                    id: heading.id,
                    children: []
                };
                parent.children.push(node);
                parentsByLevel[heading.level] = node;
                for (let level = heading.level + 1; level <= 6; level++) {
                    delete parentsByLevel[level];
                }
            });
        return docNode;
    });
}

function assignOutlineObjectIds(nodes, nextObjectId) {
    for (const node of nodes) {
        node.objectId = nextObjectId;
        nextObjectId++;
        nextObjectId = assignOutlineObjectIds(node.children, nextObjectId);
    }
    return nextObjectId;
}

function collectOutlineObjects(nodes, parentRef) {
    const objects = [];
    nodes.forEach((node, index) => {
        const prev = nodes[index - 1];
        const next = nodes[index + 1];
        const parts = [
            '<<',
            `/Title ${toPdfHexString(node.title)}`,
            `/Parent ${parentRef}`,
            `/Dest /${toPdfName(node.id)}`
        ];
        if (prev) {
            parts.push(`/Prev ${prev.objectId} 0 R`);
        }
        if (next) {
            parts.push(`/Next ${next.objectId} 0 R`);
        }
        if (node.children.length > 0) {
            parts.push(`/First ${node.children[0].objectId} 0 R`);
            parts.push(`/Last ${node.children[node.children.length - 1].objectId} 0 R`);
            parts.push(`/Count ${countOutlineDescendants(node)}`);
        }
        parts.push('>>');
        objects.push({ id: node.objectId, body: parts.join('\n') });
        objects.push(...collectOutlineObjects(node.children, `${node.objectId} 0 R`));
    });
    return objects;
}

function getLastStartXref(pdfText) {
    const matches = Array.from(pdfText.matchAll(/startxref\s+(\d+)\s+%%EOF/g));
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function getTrailerRef(pdfText, key) {
    const trailerIndex = pdfText.lastIndexOf('trailer');
    if (trailerIndex < 0) {
        return null;
    }
    const trailerText = pdfText.slice(trailerIndex);
    const match = new RegExp(`/${key}\\s+(\\d+\\s+\\d+\\s+R)`).exec(trailerText);
    return match?.[1] || null;
}

function getTrailerNumber(pdfText, key) {
    const trailerIndex = pdfText.lastIndexOf('trailer');
    if (trailerIndex < 0) {
        return null;
    }
    const trailerText = pdfText.slice(trailerIndex);
    const match = new RegExp(`/${key}\\s+(\\d+)`).exec(trailerText);
    return match ? Number(match[1]) : null;
}

function parseXrefOffsets(pdfText, startXref) {
    let position = startXref;
    if (pdfText.slice(position, position + 4) !== 'xref') {
        throw new Error('PDF xref table not found');
    }
    position += 4;
    const offsets = new Map();

    while (position < pdfText.length) {
        while (/\s/.test(pdfText[position] || '')) {
            position++;
        }
        if (pdfText.slice(position, position + 7) === 'trailer') {
            break;
        }

        const subsection = /^(\d+)\s+(\d+)/.exec(pdfText.slice(position));
        if (!subsection) {
            throw new Error('PDF xref subsection header not found');
        }
        const startObject = Number(subsection[1]);
        const objectCount = Number(subsection[2]);
        position += subsection[0].length;

        for (let index = 0; index < objectCount; index++) {
            while (pdfText[position] === '\r' || pdfText[position] === '\n') {
                position++;
            }
            const lineEnd = pdfText.indexOf('\n', position);
            const line = pdfText.slice(position, lineEnd < 0 ? undefined : lineEnd).trim();
            const entry = /^(\d{10})\s+(\d{5})\s+([nf])/.exec(line);
            if (entry?.[3] === 'n') {
                offsets.set(startObject + index, Number(entry[1]));
            }
            position = lineEnd < 0 ? pdfText.length : lineEnd + 1;
        }
    }

    return offsets;
}

function updateCatalogDictionary(pdfText, rootObjectId, outlineRootId, xrefOffsets) {
    const objectStart = xrefOffsets.get(rootObjectId);
    if (objectStart === undefined) {
        throw new Error(`PDF catalog object ${rootObjectId} xref entry not found`);
    }
    const marker = `${rootObjectId} 0 obj`;
    if (pdfText.slice(objectStart, objectStart + marker.length) !== marker) {
        throw new Error(`PDF catalog object ${rootObjectId} offset is invalid`);
    }
    const objectEnd = pdfText.indexOf('endobj', objectStart);
    const dictStart = pdfText.indexOf('<<', objectStart);
    if (objectEnd < 0 || dictStart < 0 || dictStart > objectEnd) {
        throw new Error('PDF catalog dictionary not found');
    }
    const original = pdfText.slice(dictStart, objectEnd).trim();
    if (!original.includes('/Type /Catalog')) {
        throw new Error(`PDF root object ${rootObjectId} is not a catalog`);
    }
    const clean = original.replace(/\s*\/Outlines\s+\d+\s+\d+\s+R/g, '').replace(/\s*\/PageMode\s+\/[A-Za-z0-9]+/g, '');
    return clean.replace(/>>\s*$/, `\n/Outlines ${outlineRootId} 0 R\n/PageMode /UseOutlines>>`);
}

function addPdfOutlines(pdfBuffer, docs, generatedAt = new Date()) {
    const outlineTree = buildOutlineTree(docs);
    if (outlineTree.length === 0) {
        return pdfBuffer;
    }

    const pdfText = pdfBuffer.toString('latin1');
    const previousStartXref = getLastStartXref(pdfText);
    const size = getTrailerNumber(pdfText, 'Size');
    const rootRef = getTrailerRef(pdfText, 'Root');
    if (!previousStartXref || !size || !rootRef) {
        throw new Error('PDF trailer does not contain the required Root and Size entries');
    }

    const rootObjectId = Number(rootRef.split(/\s+/)[0]);
    const metadataObjectId = size;
    const outlineRootId = size + 1;
    const xrefOffsets = parseXrefOffsets(pdfText, previousStartXref);
    const nextObjectId = assignOutlineObjectIds(outlineTree, outlineRootId + 1);
    const newSize = nextObjectId;
    const outlineObjects = collectOutlineObjects(outlineTree, `${outlineRootId} 0 R`);
    const outlineRootBody = [
        '<<',
        '/Type /Outlines',
        `/First ${outlineTree[0].objectId} 0 R`,
        `/Last ${outlineTree[outlineTree.length - 1].objectId} 0 R`,
        `/Count ${outlineTree.reduce((total, node) => total + 1 + countOutlineDescendants(node), 0)}`,
        '>>'
    ].join('\n');
    const catalogBody = updateCatalogDictionary(pdfText, rootObjectId, outlineRootId, xrefOffsets);
    const objects = [
        { id: rootObjectId, body: catalogBody },
        { id: metadataObjectId, body: buildPdfInfoDictionary(generatedAt) },
        { id: outlineRootId, body: outlineRootBody },
        ...outlineObjects
    ];

    const offsets = new Map();
    let append = '\n';
    for (const object of objects) {
        offsets.set(object.id, pdfBuffer.length + Buffer.byteLength(append, 'latin1'));
        append += `${object.id} 0 obj\n${object.body}\nendobj\n`;
    }

    const sortedIds = Array.from(offsets.keys()).sort((a, b) => a - b);
    const sections = [];
    let index = 0;
    while (index < sortedIds.length) {
        const start = sortedIds[index];
        const ids = [start];
        index++;
        while (index < sortedIds.length && sortedIds[index] === ids[ids.length - 1] + 1) {
            ids.push(sortedIds[index]);
            index++;
        }
        sections.push(`${start} ${ids.length}`);
        ids.forEach(id => {
            sections.push(`${String(offsets.get(id)).padStart(10, '0')} 00000 n `);
        });
    }

    const xrefOffset = pdfBuffer.length + Buffer.byteLength(append, 'latin1');
    const trailerEntries = [
        `/Size ${newSize}`,
        `/Root ${rootRef}`,
        `/Info ${metadataObjectId} 0 R`,
        `/Prev ${previousStartXref}`
    ];
    append += [
        'xref',
        ...sections,
        'trailer',
        `<<${trailerEntries.join('\n')}>>`,
        'startxref',
        String(xrefOffset),
        '%%EOF',
        ''
    ].join('\n');

    return Buffer.concat([pdfBuffer, Buffer.from(append, 'latin1')]);
}

async function collectDocs() {
    const missing = [];
    for (const relativePath of PDF_CHAPTERS) {
        try {
            const file = await fs.stat(path.join(ROOT, relativePath));
            if (!file.isFile()) {
                missing.push(relativePath);
            }
        } catch (_error) {
            missing.push(relativePath);
        }
    }

    if (missing.length > 0) {
        throw new Error(`PDF chapter manifest contains missing files: ${missing.join(', ')}`);
    }

    return [...PDF_CHAPTERS];
}

async function buildDocument() {
    const docPaths = await collectDocs();
    const renderedDocs = [];

    for (const [index, relativePath] of docPaths.entries()) {
        const absolutePath = path.join(ROOT, relativePath);
        const markdown = await fs.readFile(absolutePath, 'utf8');
        const title = getMarkdownTitle(markdown, path.basename(relativePath, '.md'));
        const bodyMarkdown = removeLeadingTitle(markdown);
        const number = String(index + 1);
        const { html, headings } = await renderMarkdown(bodyMarkdown, path.dirname(absolutePath), index, number);
        const id = getDocId(title, index);
        renderedDocs.push({
            relativePath,
            title,
            number,
            id,
            headings,
            html: `
            <section class="doc-section" id="${escapeHtml(id)}">
                <h1><span class="heading-number">${escapeHtml(number)}</span> ${escapeHtml(title)}</h1>
                ${html}
            </section>
        `
        });
    }

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="author" content="NetNexus" />
    <meta name="description" content="${escapeHtml(PDF_SUBJECT)}" />
    <title>${escapeHtml(PDF_TITLE)}</title>
    <style>
        @page {
            size: A4;
            margin: 14mm 12mm 18mm;
        }
        * {
            box-sizing: border-box;
        }
        body {
            color: #1f2937;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            font-size: 10.5pt;
            line-height: 1.55;
            margin: 0;
        }
        a {
            color: #1d4ed8;
            text-decoration: none;
        }
        .cover {
            align-items: flex-start;
            display: flex;
            flex-direction: column;
            justify-content: center;
            min-height: 230mm;
            page-break-after: always;
        }
        .cover h1 {
            border: 0;
            color: #111827;
            font-size: 34pt;
            margin: 0 0 12mm;
        }
        .cover p {
            color: #4b5563;
            font-size: 13pt;
            margin: 0 0 3mm;
        }
        .cover-subtitle {
            max-width: 120mm;
        }
        .toc {
            page-break-after: always;
        }
        .toc-heading {
            border-bottom: 1px solid #d1d5db;
            margin-bottom: 6mm;
            padding-bottom: 4mm;
        }
        .toc h1 {
            font-size: 26pt;
            margin: 0 0 1.5mm;
        }
        .toc-heading p {
            color: #6b7280;
            font-size: 9.5pt;
            margin: 0;
        }
        .toc ol {
            list-style: none;
            margin: 0;
            padding: 0;
        }
        .toc a {
            color: #111827;
        }
        .toc-grid {
            display: grid;
            gap: 4mm;
            grid-template-columns: 1fr 1fr;
        }
        .toc-card {
            border: 1px solid #e5e7eb;
            border-radius: 3mm;
            break-inside: avoid;
            padding: 3mm;
        }
        .toc-link {
            display: grid;
            gap: 2mm;
            grid-template-columns: 16mm 1fr;
            text-decoration: none;
        }
        .toc-number {
            color: #2563eb;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }
        .toc-title {
            min-width: 0;
        }
        .toc-doc-link {
            align-items: baseline;
            color: #111827;
            display: grid;
            gap: 3mm;
            grid-template-columns: 12mm 1fr;
            margin-bottom: 2mm;
        }
        .toc-doc-number {
            align-items: center;
            background: #2563eb;
            border-radius: 2mm;
            color: #ffffff;
            display: inline-flex;
            font-size: 9pt;
            font-weight: 700;
            height: 7mm;
            justify-content: center;
            line-height: 1;
        }
        .toc-doc-title {
            font-size: 12.5pt;
            font-weight: 700;
            line-height: 1.3;
        }
        .toc-card ol {
            margin: 0;
        }
        .toc-subitem {
            border: 0;
            color: #4b5563;
            font-size: 8.5pt;
            font-weight: 400;
            margin: 0 0 1mm;
            padding-left: 0;
        }
        .toc-subitem .toc-link {
            grid-template-columns: 16mm 1fr;
        }
        .toc-level-3 {
            margin-left: 5mm;
        }
        .doc-section {
            page-break-before: always;
        }
        .doc-section:first-of-type {
            page-break-before: auto;
        }
        .heading-number {
            color: #2563eb;
            font-variant-numeric: tabular-nums;
        }
        h1, h2, h3, h4, h5, h6 {
            color: #111827;
            line-height: 1.28;
            margin: 7mm 0 3mm;
            page-break-after: avoid;
        }
        h1 {
            border-bottom: 1px solid #d1d5db;
            font-size: 24pt;
            padding-bottom: 3mm;
        }
        h2 {
            font-size: 18pt;
        }
        h3 {
            font-size: 14pt;
        }
        h4, h5, h6 {
            font-size: 12pt;
        }
        p {
            margin: 0 0 3mm;
        }
        ul, ol {
            margin: 0 0 3mm 6mm;
            padding: 0;
        }
        li {
            margin: 0 0 1.5mm;
        }
        code {
            background: #f3f4f6;
            border-radius: 3px;
            color: #111827;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
            font-size: 0.9em;
            padding: 0.5mm 1mm;
        }
        pre {
            background: #111827;
            border-radius: 4px;
            color: #f9fafb;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
            font-size: 8.2pt;
            line-height: 1.45;
            margin: 0 0 4mm;
            overflow-wrap: anywhere;
            padding: 3mm;
            white-space: pre-wrap;
        }
        pre code {
            background: transparent;
            color: inherit;
            padding: 0;
        }
        table {
            border-collapse: collapse;
            font-size: 8.5pt;
            margin: 0 0 4mm;
            page-break-inside: avoid;
            width: 100%;
        }
        th, td {
            border: 1px solid #d1d5db;
            padding: 1.5mm 2mm;
            text-align: left;
            vertical-align: top;
            word-break: break-word;
        }
        th {
            background: #f3f4f6;
            color: #111827;
            font-weight: 600;
        }
        figure {
            margin: 4mm 0 6mm;
            page-break-inside: avoid;
        }
        img {
            border: 1px solid #e5e7eb;
            display: block;
            max-height: 175mm;
            max-width: 100%;
            object-fit: contain;
            width: 100%;
        }
        figcaption {
            color: #6b7280;
            font-size: 8.5pt;
            margin-top: 1.5mm;
            text-align: center;
        }
        blockquote {
            border-left: 3px solid #d1d5db;
            color: #4b5563;
            margin: 0 0 4mm;
            padding-left: 4mm;
        }
        .missing-image {
            border: 1px dashed #f97316;
            color: #9a3412;
            padding: 2mm;
        }
    </style>
</head>
<body>
    <section class="cover">
        <h1>${escapeHtml(PDF_TITLE)}</h1>
        <p class="cover-subtitle">协议仿真、服务端、监控与本地工具功能说明。</p>
    </section>
    ${renderToc(renderedDocs)}
    ${renderedDocs.map(doc => doc.html).join('\n')}
</body>
</html>`;

    return { html, docs: renderedDocs };
}

function renderPdfFooterTemplate() {
    return `
        <div style="
            box-sizing: border-box;
            width: 100%;
            margin: 0 12mm;
            padding-top: 2mm;
            border-top: 1px solid #d1d5db;
            color: #6b7280;
            display: flex;
            justify-content: space-between;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
            font-size: 8pt;
            line-height: 1.3;
            white-space: nowrap;
            -webkit-print-color-adjust: exact;
        ">
            <span>${escapeHtml(PDF_TITLE)}</span>
            <span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span>
        </div>
    `;
}

async function writeFileAtomically(filePath, data) {
    const temporaryFile = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}-${Date.now()}.tmp`
    );
    let handle;

    try {
        handle = await fs.open(temporaryFile, 'wx');
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryFile, filePath);
    } finally {
        if (handle) {
            await handle.close().catch(() => {});
        }
        await fs.rm(temporaryFile, { force: true }).catch(() => {});
    }
}

async function run() {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.setPath('userData', path.join(os.tmpdir(), 'netnexus-docs-pdf'));

    await app.whenReady();
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.mkdir(TMP_DIR, { recursive: true });

    const { html, docs } = await buildDocument();
    const htmlFile = path.join(TMP_DIR, `netnexus-docs-${process.pid}-${Date.now()}.html`);
    await fs.writeFile(htmlFile, html, 'utf8');

    const win = new BrowserWindow({
        width: 1280,
        height: 1800,
        show: false,
        backgroundColor: '#ffffff',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    try {
        await win.loadFile(htmlFile);
        await win.webContents.executeJavaScript(`
            Promise.all([
                document.fonts && document.fonts.ready,
                Promise.all(Array.from(document.images).map(image => {
                    if (image.complete) return true;
                    return new Promise(resolve => {
                        image.onload = resolve;
                        image.onerror = resolve;
                    });
                }))
            ])
        `);
        const pdf = await win.webContents.printToPDF({
            landscape: false,
            pageSize: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: renderPdfFooterTemplate(),
            preferCSSPageSize: true
        });
        await writeFileAtomically(OUTPUT_FILE, addPdfOutlines(pdf, docs));
        console.log(`generated ${path.relative(ROOT, OUTPUT_FILE)}`);
    } finally {
        win.destroy();
        await fs.rm(htmlFile, { force: true });
        app.quit();
    }
}

run().catch(error => {
    console.error(error);
    app.exit(1);
});
