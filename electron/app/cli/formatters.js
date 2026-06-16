function formatDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }
    return date
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/u, '');
}

function formatArray(value) {
    return Array.isArray(value) ? value.join(',') : '-';
}

function formatPrefix(row) {
    if (!row || !row.ip) {
        return '-';
    }
    return `${row.ip}/${row.mask ?? '-'}`;
}

function formatJson(value) {
    return `${JSON.stringify(value, null, 2)}\r\n`;
}

function formatIndexedTable(rows, columns, options = {}) {
    const start = Number(options.start) || 1;
    const title = options.title || 'ID';
    const indexedRows = (rows || []).map((row, index) => ({
        __index: start + index,
        ...row
    }));
    return formatTable(indexedRows, [{ key: '__index', title }, ...columns]);
}

function formatTable(rows, columns) {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    if (normalizedRows.length === 0) {
        return 'No data.\r\n';
    }

    const renderedRows = normalizedRows.map(row =>
        columns.map(column => stringifyCell(column.formatter ? column.formatter(row) : row[column.key]))
    );
    const widths = columns.map((column, index) =>
        Math.min(80, Math.max(String(column.title).length, ...renderedRows.map(row => row[index].length)))
    );
    const header = columns.map((column, index) => padCell(column.title, widths[index])).join('  ');
    const separator = widths.map(width => '-'.repeat(width)).join('  ');
    const body = renderedRows
        .map(row => row.map((value, index) => padCell(truncateCell(value, widths[index]), widths[index])).join('  '))
        .join('\r\n');

    return `${header}\r\n${separator}\r\n${body}\r\n`;
}

function stringifyCell(value) {
    if (value === null || value === undefined || value === '') {
        return '-';
    }
    if (Array.isArray(value)) {
        return value.join(',');
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function truncateCell(value, width) {
    if (value.length <= width) {
        return value;
    }
    if (width <= 3) {
        return value.slice(0, width);
    }
    return `${value.slice(0, width - 3)}...`;
}

function padCell(value, width) {
    return truncateCell(String(value), width).padEnd(width, ' ');
}

module.exports = {
    formatArray,
    formatDate,
    formatIndexedTable,
    formatJson,
    formatPrefix,
    formatTable
};
