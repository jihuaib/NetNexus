export function toggleXmlComments(value, selectionStart, selectionEnd) {
    const source = String(value ?? '');
    const start = Math.max(0, Math.min(source.length, Number(selectionStart) || 0));
    const end = Math.max(start, Math.min(source.length, Number(selectionEnd) || start));
    const lineStart = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
    const lastSelected = end > start ? end - 1 : start;
    const nextNewline = source.indexOf('\n', lastSelected);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline;
    const edits = [];
    const uncomment = (open, close) => {
        const openingEnd = open + 4 + Number(source[open + 4] === ' ');
        edits.push({ start: open, end: openingEnd, text: '' });
        edits.push({
            start: Math.max(openingEnd, close - Number(source[close - 1] === ' ')),
            end: close + 3,
            text: ''
        });
    };
    const open = source.lastIndexOf('<!--', start);
    const close = open < 0 ? -1 : source.indexOf('-->', open + 4);
    if (open >= 0 && close >= start && end <= close + 3) {
        uncomment(open, close);
    } else {
        const selected = source.slice(lineStart, lineEnd);
        const lines = selected.split('\n');
        const contentLines = lines.filter(line => line.trim());
        if (!contentLines.length) return null;
        const allCommented = contentLines.every(line => /^\s*<!--(?:(?!--)[\s\S])*-->\s*$/u.test(line));
        const blockOpen = source.indexOf('<!--', lineStart);
        const blockClose = blockOpen < 0 ? -1 : source.indexOf('-->', blockOpen + 4);
        if (/^\s*<!--[\s\S]*-->\s*$/u.test(selected) && blockClose === selected.lastIndexOf('-->') + lineStart) {
            uncomment(blockOpen, blockClose);
        } else {
            let offset = lineStart;
            for (const line of lines) {
                if (line.trim()) {
                    if (allCommented) {
                        uncomment(offset + line.indexOf('<!--'), offset + line.lastIndexOf('-->'));
                    } else {
                        if (line.includes('--')) return { error: '选区包含 XML 注释或“--”，请调整选区后重试' };
                        const indent = line.match(/^[\t ]*/u)[0].length;
                        const trailing = line.match(/[\t \r]*$/u)[0].length;
                        edits.push({ start: offset + indent, end: offset + indent, text: '<!-- ' });
                        edits.push({
                            start: offset + line.length - trailing,
                            end: offset + line.length - trailing,
                            text: ' -->'
                        });
                    }
                }
                offset += line.length + 1;
            }
        }
    }
    edits.sort((left, right) => left.start - right.start);
    const rangeStart = edits[0].start;
    const rangeEnd = edits[edits.length - 1].end;
    let text = source.slice(rangeStart, rangeEnd);
    for (const edit of [...edits].reverse()) {
        text = text.slice(0, edit.start - rangeStart) + edit.text + text.slice(edit.end - rangeStart);
    }
    const mapOffset = offset => {
        let delta = 0;
        for (const edit of edits) {
            if (offset < edit.start) break;
            if (offset < edit.end) return edit.start + delta;
            delta += edit.text.length - (edit.end - edit.start);
        }
        return offset + delta;
    };
    return { start: rangeStart, end: rangeEnd, text, selectionStart: mapOffset(start), selectionEnd: mapOffset(end) };
}
