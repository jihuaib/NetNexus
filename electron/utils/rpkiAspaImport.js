const fs = require('fs');
const path = require('path');
const readline = require('readline');
const RpkiAspa = require('../worker/rpki/rpkiAspa');
const RpkiConst = require('../const/rpkiConst');
const { ensureParentDir, writeLine, closeWriteStream, renameWithRetry } = require('./rpkiRoaImport');

const ASPA_ARRAY_KEYS = new Set([
    'aspas',
    'aspa',
    'aspaRecords',
    'aspa_records',
    'customerProviderAuthorizations',
    'customer_provider_authorizations',
    'data',
    'items',
    'records'
]);

function getAspaDataFilePath(userDataPath) {
    return path.join(userDataPath, 'rpki-aspa.jsonl');
}

function makeAspaStorageKey(aspa) {
    return RpkiAspa.makeKey(aspa.customerAsn);
}

function pickField(object, names) {
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(object, name) && object[name] !== null && object[name] !== undefined) {
            return object[name];
        }
    }
    return undefined;
}

function normalizeAsn(value) {
    if (typeof value === 'string') {
        value = value.trim().replace(/^AS/i, '');
    }
    const asn = Number(value);
    if (!Number.isInteger(asn) || asn < 0 || asn > 0xffffffff) {
        return null;
    }
    return String(asn);
}

function normalizeProviderAsnValue(value) {
    if (typeof value === 'string') {
        value = value.trim().replace(/^AS/i, '');
    }
    const asn = Number(value);
    if (!Number.isInteger(asn) || asn < 0 || asn > 0xffffffff) {
        return null;
    }
    return asn;
}

function splitProviderString(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    return trimmed
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeProviderAsns(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? splitProviderString(value) : null;
    if (!rawValues) {
        return null;
    }

    const providerAsns = [];
    for (const item of rawValues) {
        const asn = normalizeProviderAsnValue(item);
        if (asn === null) {
            return null;
        }
        providerAsns.push(asn);
    }

    try {
        return RpkiAspa.parseProviderAsns(providerAsns);
    } catch (_) {
        return null;
    }
}

function normalizeAfiToken(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 1 && value <= 3 ? value : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '');
    if (!normalized) {
        return null;
    }

    if (['1', 'ipv4', 'ip4', 'v4', 'afiipv4'].includes(normalized)) {
        return RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4;
    }
    if (['2', 'ipv6', 'ip6', 'v6', 'afiipv6'].includes(normalized)) {
        return RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV6;
    }
    if (
        ['3', 'both', 'all', 'ipv4+ipv6', 'ipv6+ipv4', 'ipv4,ipv6', 'ipv6,ipv4', 'ipv4/ipv6'].includes(
            normalized
        ) ||
        ((normalized.includes('ipv4') || normalized.includes('v4')) &&
            (normalized.includes('ipv6') || normalized.includes('v6')))
    ) {
        return RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4 | RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV6;
    }

    return null;
}

function normalizeAfiFlags(value) {
    if (value === undefined || value === null || value === '') {
        return RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4 | RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV6;
    }

    if (Array.isArray(value)) {
        let flags = 0;
        for (const item of value) {
            const token = normalizeAfiToken(item);
            if (!token) {
                return null;
            }
            flags |= token;
        }
        return flags === 1 || flags === 2 || flags === 3 ? flags : null;
    }

    return normalizeAfiToken(value);
}

function normalizeAspaObject(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const customerAsn = normalizeAsn(
        pickField(item, [
            'customerAsn',
            'customer_asn',
            'customerASN',
            'customerAS',
            'customer_as',
            'customer',
            'customerAsid',
            'customer_asid',
            'customerASID',
            'Customer ASN'
        ])
    );
    if (!customerAsn) {
        return null;
    }

    const providerAsns = normalizeProviderAsns(
        pickField(item, [
            'providerAsns',
            'provider_asns',
            'providerASNs',
            'providers',
            'provider',
            'providerAsSet',
            'provider_as_set',
            'providerSet',
            'Provider ASNs'
        ])
    );
    if (!providerAsns) {
        return null;
    }

    const afiFlags = normalizeAfiFlags(
        pickField(item, ['afiFlags', 'afi_flags', 'afi', 'addressFamily', 'address_family', 'ipType', 'family'])
    );
    if (!afiFlags) {
        return null;
    }

    return {
        customerAsn,
        providerAsns,
        afiFlags
    };
}

function safeJsonParse(line) {
    try {
        return JSON.parse(line);
    } catch (_) {
        return null;
    }
}

async function closeReadStream(input) {
    if (!input || input.closed) {
        return;
    }

    await new Promise(resolve => {
        input.once('close', resolve);
        if (!input.destroyed) {
            input.destroy();
        }
    });
}

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch (_) {
        return false;
    }
}

async function* iterateJsonlAspas(filePath) {
    if (!(await fileExists(filePath))) {
        return;
    }

    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input,
        crlfDelay: Infinity
    });

    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const parsed = safeJsonParse(trimmed);
            const aspa = normalizeAspaObject(parsed);
            if (aspa) {
                yield aspa;
            }
        }
    } finally {
        rl.close();
        await closeReadStream(input);
    }
}

async function readAspaJsonlPage(filePath, page, pageSize) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 20));
    const startIndex = (safePage - 1) * safePageSize;
    const endIndex = startIndex + safePageSize;
    const items = [];
    let index = 0;

    for await (const aspa of iterateJsonlAspas(filePath)) {
        if (index >= startIndex && index < endIndex) {
            items.push(aspa);
        }
        index += 1;
        if (index >= endIndex) {
            break;
        }
    }

    return items;
}

async function countJsonlAspas(filePath) {
    let count = 0;
    for await (const _aspa of iterateJsonlAspas(filePath)) {
        count += 1;
    }
    return count;
}

async function writeAspasToJsonl(filePath, aspas) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const latestByKey = new Map();
    const order = [];
    let sequence = 0;

    try {
        for (const item of aspas || []) {
            const aspa = normalizeAspaObject(item);
            if (!aspa) {
                continue;
            }
            const key = makeAspaStorageKey(aspa);
            sequence += 1;
            latestByKey.set(key, { aspa, sequence });
            order.push({ key, sequence });
        }

        let count = 0;
        for (const item of order) {
            const latest = latestByKey.get(item.key);
            if (!latest || latest.sequence !== item.sequence) {
                continue;
            }
            await writeLine(stream, JSON.stringify(latest.aspa));
            count += 1;
        }

        await closeWriteStream(stream);
        await renameWithRetry(tempPath, filePath);
        return count;
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function removeAspaFromJsonl(filePath, customerAsn) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.delete.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const targetKey = RpkiAspa.makeKey(customerAsn);
    let deletedAspa = null;
    let deleted = 0;
    let total = 0;

    try {
        for await (const aspa of iterateJsonlAspas(filePath)) {
            if (makeAspaStorageKey(aspa) === targetKey) {
                if (!deletedAspa) {
                    deletedAspa = aspa;
                }
                deleted += 1;
                continue;
            }

            await writeLine(stream, JSON.stringify(aspa));
            total += 1;
        }

        await closeWriteStream(stream);
        await renameWithRetry(tempPath, filePath);
        return { deleted, deletedAspa, total };
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function parseAspaJsonFile(filePath, onAspa) {
    const stats = {
        objects: 0,
        valid: 0,
        invalid: 0
    };
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const stack = [];
    let inString = false;
    let escape = false;
    let stringBuffer = '';
    let lastString = null;
    let pendingKey = null;
    let collecting = false;
    let collectBuffer = '';
    let collectDepth = 0;
    let collectInString = false;
    let collectEscape = false;
    let stopped = false;

    const handleObject = async objectText => {
        stats.objects += 1;
        let parsed;
        try {
            parsed = JSON.parse(objectText);
        } catch (error) {
            throw new Error(`ASPA JSON对象解析失败: ${error.message}`);
        }

        const aspa = normalizeAspaObject(parsed);
        if (!aspa) {
            stats.invalid += 1;
            return;
        }

        stats.valid += 1;
        const shouldContinue = await onAspa(aspa);
        if (shouldContinue === false) {
            stopped = true;
        }
    };

    try {
        for await (const chunk of input) {
            for (let i = 0; i < chunk.length; i++) {
                if (stopped) {
                    break;
                }

                const ch = chunk[i];

                if (collecting) {
                    collectBuffer += ch;
                    if (collectInString) {
                        if (collectEscape) {
                            collectEscape = false;
                        } else if (ch === '\\') {
                            collectEscape = true;
                        } else if (ch === '"') {
                            collectInString = false;
                        }
                        continue;
                    }

                    if (ch === '"') {
                        collectInString = true;
                    } else if (ch === '{') {
                        collectDepth += 1;
                    } else if (ch === '}') {
                        collectDepth -= 1;
                        if (collectDepth === 0) {
                            await handleObject(collectBuffer);
                            collecting = false;
                            collectBuffer = '';
                        }
                    }
                    continue;
                }

                if (inString) {
                    if (escape) {
                        stringBuffer += ch;
                        escape = false;
                    } else if (ch === '\\') {
                        stringBuffer += ch;
                        escape = true;
                    } else if (ch === '"') {
                        inString = false;
                        lastString = safeJsonParse(`"${stringBuffer}"`);
                        stringBuffer = '';
                    } else {
                        stringBuffer += ch;
                    }
                    continue;
                }

                if (ch === '"') {
                    inString = true;
                    stringBuffer = '';
                    continue;
                }

                if (ch === ':') {
                    if (lastString !== null) {
                        pendingKey = lastString;
                        lastString = null;
                    }
                    continue;
                }

                if (ch === '[') {
                    const key = pendingKey;
                    const target = stack.length === 0 || ASPA_ARRAY_KEYS.has(key);
                    stack.push({ type: 'array', target });
                    pendingKey = null;
                    lastString = null;
                    continue;
                }

                if (ch === ']') {
                    while (stack.length > 0) {
                        const current = stack.pop();
                        if (current.type === 'array') {
                            break;
                        }
                    }
                    pendingKey = null;
                    lastString = null;
                    continue;
                }

                if (ch === '{') {
                    const current = stack[stack.length - 1];
                    if (current && current.type === 'array' && current.target) {
                        collecting = true;
                        collectBuffer = '{';
                        collectDepth = 1;
                        collectInString = false;
                        collectEscape = false;
                    } else {
                        stack.push({ type: 'object' });
                    }
                    pendingKey = null;
                    lastString = null;
                    continue;
                }

                if (ch === '}') {
                    while (stack.length > 0) {
                        const current = stack.pop();
                        if (current.type === 'object') {
                            break;
                        }
                    }
                    pendingKey = null;
                    lastString = null;
                    continue;
                }

                if (ch === ',') {
                    pendingKey = null;
                    lastString = null;
                }
            }

            if (stopped) {
                break;
            }
        }
    } finally {
        await closeReadStream(input);
    }

    if (!stopped && (collecting || inString || collectInString)) {
        throw new Error('ASPA JSON文件不完整或格式错误');
    }

    return stats;
}

module.exports = {
    getAspaDataFilePath,
    makeAspaStorageKey,
    normalizeAspaObject,
    fileExists,
    iterateJsonlAspas,
    readAspaJsonlPage,
    countJsonlAspas,
    writeAspasToJsonl,
    removeAspaFromJsonl,
    parseAspaJsonFile
};
