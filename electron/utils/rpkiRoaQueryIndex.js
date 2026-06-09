const fs = require('fs');
const {
    makeRoaStorageKey,
    normalizeRoaObject,
    fileExists
} = require('./rpkiRoaImport');
const {
    normalizeRoutePrefixPart,
    buildRoutePrefixQuery,
    routeMatchesPrefixQuery
} = require('./routePrefixUtils');

const INDEX_BUILD_YIELD_EVERY = 5000;

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function normalizeAsnFilter(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    const text = String(value).trim().replace(/^AS/i, '');
    const asn = Number(text);
    if (!Number.isInteger(asn) || asn < 0 || asn > 0xffffffff) {
        return '';
    }
    return String(asn);
}

function normalizeIpTypeFilter(value) {
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text === '1' || text === '2' ? text : '';
}

function addIndexValue(index, key, rowId) {
    if (!key) {
        return;
    }

    const current = index.get(key);
    if (current === undefined) {
        index.set(key, rowId);
    } else if (Array.isArray(current)) {
        current.push(rowId);
    } else {
        index.set(key, [current, rowId]);
    }
}

function getIndexRows(index, key) {
    const value = index.get(key);
    if (value === undefined) {
        return null;
    }
    return Array.isArray(value) ? value : [value];
}

function intersectSortedRows(left, right) {
    const result = [];
    let i = 0;
    let j = 0;

    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            result.push(left[i]);
            i += 1;
            j += 1;
        } else if (left[i] < right[j]) {
            i += 1;
        } else {
            j += 1;
        }
    }

    return result;
}

class RpkiRoaQueryIndex {
    constructor() {
        this.reset();
    }

    reset() {
        this.filePath = null;
        this.fileSize = 0;
        this.fileMtimeMs = 0;
        this.offsets = [];
        this.lengths = [];
        this.byIpType = new Map();
        this.byAsn = new Map();
        this.byPrefix = new Map();
    }

    invalidate() {
        this.reset();
    }

    isCurrent(filePath, stat) {
        return this.filePath === filePath && this.fileSize === stat.size && this.fileMtimeMs === stat.mtimeMs;
    }

    addRoaToIndexes(roa, rowId) {
        const prefix = normalizeRoutePrefixPart(roa.ip);

        addIndexValue(this.byIpType, normalizeIpTypeFilter(roa.ipType), rowId);
        addIndexValue(this.byAsn, normalizeAsnFilter(roa.asn), rowId);
        addIndexValue(this.byPrefix, prefix ? `prefix:${prefix}` : '', rowId);
    }

    addRecord(roa, offset, length) {
        const normalizedRoa = normalizeRoaObject(roa);
        if (!normalizedRoa || !Number.isFinite(offset) || !Number.isFinite(length)) {
            return false;
        }

        const rowId = this.offsets.length;
        this.offsets.push(offset);
        this.lengths.push(length);
        this.addRoaToIndexes(normalizedRoa, rowId);
        return true;
    }

    async refreshStat(filePath) {
        if (!(await fileExists(filePath))) {
            this.reset();
            return null;
        }

        return fs.promises.stat(filePath);
    }

    async ensureBuilt(filePath) {
        const stat = await this.refreshStat(filePath);
        if (!stat) {
            return;
        }
        if (this.isCurrent(filePath, stat)) {
            return;
        }

        this.reset();
        this.filePath = filePath;

        let pending = Buffer.alloc(0);
        let position = 0;
        let indexedCount = 0;
        const input = fs.createReadStream(filePath);

        for await (const chunk of input) {
            const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
            const bufferStartOffset = position - pending.length;
            let lineStart = 0;
            let lineEnd = buffer.indexOf(0x0a, lineStart);

            while (lineEnd !== -1) {
                if (this.addLineBuffer(buffer.subarray(lineStart, lineEnd), bufferStartOffset + lineStart)) {
                    indexedCount += 1;
                    if (indexedCount % INDEX_BUILD_YIELD_EVERY === 0) {
                        await yieldToEventLoop();
                    }
                }
                lineStart = lineEnd + 1;
                lineEnd = buffer.indexOf(0x0a, lineStart);
            }

            pending = buffer.subarray(lineStart);
            position += chunk.length;
        }

        if (pending.length > 0) {
            this.addLineBuffer(pending, position - pending.length);
        }

        const newStat = await this.refreshStat(filePath);
        if (newStat) {
            this.fileSize = newStat.size;
            this.fileMtimeMs = newStat.mtimeMs;
        }
    }

    addLineBuffer(lineBuffer, offset) {
        const lineText = lineBuffer.toString('utf8').trim();
        if (!lineText) {
            return false;
        }

        let parsed;
        try {
            parsed = JSON.parse(lineText);
        } catch (_) {
            return false;
        }

        const roa = normalizeRoaObject(parsed);
        if (!roa) {
            return false;
        }

        return this.addRecord(roa, offset, lineBuffer.length);
    }

    async markAppended(filePath, roa, offset, length) {
        if (!this.filePath || this.filePath !== filePath) {
            return;
        }

        const stat = await this.refreshStat(filePath);
        if (!stat) {
            return;
        }

        const expectedPreviousSize = Number(offset);
        if (this.fileSize !== expectedPreviousSize) {
            this.invalidate();
            return;
        }

        if (this.addRecord(roa, offset, length)) {
            this.fileSize = stat.size;
            this.fileMtimeMs = stat.mtimeMs;
        } else {
            this.invalidate();
        }
    }

    async hasRoa(filePath, roa) {
        const normalizedRoa = normalizeRoaObject(roa);
        if (!normalizedRoa) {
            return false;
        }

        await this.ensureBuilt(filePath);
        const prefix = normalizeRoutePrefixPart(normalizedRoa.ip);
        const rows = getIndexRows(this.byPrefix, prefix ? `prefix:${prefix}` : '');
        if (!rows || rows.length === 0) {
            return false;
        }

        const targetKey = makeRoaStorageKey(normalizedRoa);
        const fileHandle = await fs.promises.open(this.filePath, 'r');
        try {
            for (const rowId of rows) {
                const roa = await this.readRow(rowId, fileHandle);
                if (roa && makeRoaStorageKey(roa) === targetKey) {
                    return true;
                }
            }
        } finally {
            await fileHandle.close();
        }
        return false;
    }

    buildExactCandidateLists(filters, prefixQuery) {
        const candidates = [];

        const addCandidate = rows => {
            if (!rows) {
                candidates.push([]);
                return;
            }
            candidates.push(rows);
        };

        if (filters.ipType) {
            addCandidate(getIndexRows(this.byIpType, filters.ipType));
        }
        if (filters.asn) {
            addCandidate(getIndexRows(this.byAsn, filters.asn));
        }
        if (prefixQuery.mode === 'index') {
            const prefixKey = this.getPrefixIndexKey(prefixQuery);
            addCandidate(getIndexRows(this.byPrefix, prefixKey));
        } else if (prefixQuery.mode === 'index-or-scan') {
            const indexedRows = getIndexRows(this.byPrefix, prefixQuery.key);
            if (indexedRows && indexedRows.length > 0) {
                addCandidate(indexedRows);
            }
        }

        return candidates;
    }

    getPrefixIndexKey(prefixQuery) {
        if (!prefixQuery || !prefixQuery.key) {
            return '';
        }
        if (!prefixQuery.key.startsWith('cidr:')) {
            return prefixQuery.key;
        }

        const cidr = prefixQuery.key.slice('cidr:'.length);
        const slashIndex = cidr.lastIndexOf('/');
        return slashIndex > 0 ? `prefix:${cidr.slice(0, slashIndex)}` : '';
    }

    getCandidateRows(filters, prefixQuery) {
        const candidates = this.buildExactCandidateLists(filters, prefixQuery);
        if (candidates.some(rows => rows.length === 0)) {
            return [];
        }
        if (candidates.length === 0) {
            return null;
        }

        candidates.sort((a, b) => a.length - b.length);
        let result = candidates[0];
        for (let i = 1; i < candidates.length; i += 1) {
            result = intersectSortedRows(result, candidates[i]);
            if (result.length === 0) {
                break;
            }
        }
        return result;
    }

    hasResidualScan(filters, prefixQuery) {
        return Boolean(
            filters.prefixText &&
                (prefixQuery.mode !== 'index' || (prefixQuery.key || '').startsWith('cidr:'))
        );
    }

    async readRow(rowId, fileHandle) {
        const offset = this.offsets[rowId];
        const length = this.lengths[rowId];
        if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
            return null;
        }

        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
        const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
        if (!text) {
            return null;
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (_) {
            return null;
        }
        return normalizeRoaObject(parsed);
    }

    async readRows(rowIds) {
        const items = [];
        const fileHandle = await fs.promises.open(this.filePath, 'r');

        try {
            for (const rowId of rowIds) {
                const roa = await this.readRow(rowId, fileHandle);
                if (roa) {
                    items.push(roa);
                }
            }
        } finally {
            await fileHandle.close();
        }

        return items;
    }

    matchesFilters(roa, filters, prefixQuery) {
        if (filters.ipType && normalizeIpTypeFilter(roa.ipType) !== filters.ipType) {
            return false;
        }
        if (filters.asn && normalizeAsnFilter(roa.asn) !== filters.asn) {
            return false;
        }
        if (filters.prefixText && !routeMatchesPrefixQuery(roa, prefixQuery)) {
            return false;
        }
        return true;
    }

    async query(filePath, options = {}) {
        await this.ensureBuilt(filePath);

        const page = Math.max(1, Number(options.page) || 1);
        const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 10));
        const start = (page - 1) * pageSize;
        const filters = {
            ipType: normalizeIpTypeFilter(options.ipType),
            asn: normalizeAsnFilter(options.asn),
            prefixText:
                options.prefixFilter === null || options.prefixFilter === undefined
                    ? ''
                    : String(options.prefixFilter).trim()
        };
        const prefixQuery = buildRoutePrefixQuery(filters.prefixText);
        const candidateRows = this.getCandidateRows(filters, prefixQuery);
        const hasFilters = Boolean(filters.ipType || filters.asn || filters.prefixText);
        const hasResidualScan = this.hasResidualScan(filters, prefixQuery);

        if (!hasFilters) {
            const pageRows = [];
            const rowEnd = Math.min(this.offsets.length, start + pageSize);
            for (let rowId = start; rowId < rowEnd; rowId += 1) {
                pageRows.push(rowId);
            }
            return {
                items: await this.readRows(pageRows),
                total: this.offsets.length,
                page,
                pageSize
            };
        }

        if (candidateRows && !hasResidualScan) {
            return {
                items: await this.readRows(candidateRows.slice(start, start + pageSize)),
                total: candidateRows.length,
                page,
                pageSize
            };
        }

        const items = [];
        let total = 0;
        const fileHandle = await fs.promises.open(this.filePath, 'r');

        try {
            const scanRow = async rowId => {
                const roa = await this.readRow(rowId, fileHandle);
                if (!roa || !this.matchesFilters(roa, filters, prefixQuery)) {
                    return;
                }

                if (total >= start && items.length < pageSize) {
                    items.push(roa);
                }
                total += 1;
            };

            if (candidateRows) {
                for (const rowId of candidateRows) {
                    await scanRow(rowId);
                }
            } else {
                for (let rowId = 0; rowId < this.offsets.length; rowId += 1) {
                    await scanRow(rowId);
                }
            }
        } finally {
            await fileHandle.close();
        }

        return {
            items,
            total,
            page,
            pageSize
        };
    }
}

module.exports = RpkiRoaQueryIndex;
