const fs = require('fs');
const { once } = require('events');
const readline = require('readline');
const path = require('path');
const ipaddr = require('ipaddr.js');
const BgpConst = require('../const/bgpConst');
const { getNetworkAddress } = require('./ipUtils');

const ROA_ARRAY_KEYS = new Set([
    'roas',
    'roa',
    'vrps',
    'validatedRoas',
    'validated_roas',
    'validatedRoaPayloads',
    'prefixAssertions',
    'prefix_assertions',
    'data',
    'items',
    'records',
    'routes'
]);

function getRoaDataFilePath(userDataPath) {
    return path.join(userDataPath, 'rpki-roa.jsonl');
}

function makeRoaStorageKey(roa) {
    return `${roa.ip}|${roa.mask}|${roa.asn}|${roa.maxLength}`;
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

function normalizeInteger(value) {
    if (typeof value === 'string') {
        value = value.trim();
    }
    const num = Number(value);
    return Number.isInteger(num) ? num : null;
}

function getPrefixParts(item) {
    const prefix = pickField(item, [
        'prefix',
        'ipPrefix',
        'ip_prefix',
        'IP Prefix',
        'route',
        'network',
        'cidr'
    ]);

    if (typeof prefix === 'string' && prefix.includes('/')) {
        const slashIndex = prefix.lastIndexOf('/');
        return {
            ip: prefix.slice(0, slashIndex).trim(),
            mask: normalizeInteger(prefix.slice(slashIndex + 1))
        };
    }

    const ip = pickField(item, ['ip', 'addr', 'address']);
    const mask = pickField(item, ['mask', 'prefixLength', 'prefix_length', 'length']);
    if (typeof ip === 'string' && mask !== undefined) {
        return {
            ip: ip.trim(),
            mask: normalizeInteger(mask)
        };
    }

    return null;
}

function normalizeRoaObject(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const asn = normalizeAsn(
        pickField(item, [
            'asn',
            'ASN',
            'originAsn',
            'origin_asn',
            'originAS',
            'origin_as',
            'sourceAs',
            'source_as',
            'asID',
            'asid'
        ])
    );
    if (!asn) {
        return null;
    }

    const prefixParts = getPrefixParts(item);
    if (!prefixParts || !prefixParts.ip || prefixParts.mask === null) {
        return null;
    }

    let parsedIp;
    try {
        parsedIp = ipaddr.parse(prefixParts.ip);
    } catch (_) {
        return null;
    }

    const ipType = parsedIp.kind() === 'ipv4' ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
    const maxMask = ipType === BgpConst.IP_TYPE.IPV4 ? 32 : 128;
    const mask = prefixParts.mask;
    const maxLengthValue = pickField(item, [
        'maxLength',
        'max_length',
        'maxPrefixLength',
        'max_prefix_length',
        'maximalLength',
        'Max Length',
        'max'
    ]);
    const maxLength = maxLengthValue === undefined || maxLengthValue === null ? mask : normalizeInteger(maxLengthValue);

    if (mask < 0 || mask > maxMask || maxLength === null || maxLength < mask || maxLength > maxMask) {
        return null;
    }

    const network = getNetworkAddress(prefixParts.ip, mask);
    if (!network) {
        return null;
    }

    return {
        ipType,
        asn,
        ip: network.slice(0, network.lastIndexOf('/')),
        mask: String(mask),
        maxLength: String(maxLength)
    };
}

function safeJsonParse(line) {
    try {
        return JSON.parse(line);
    } catch (_) {
        return null;
    }
}

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch (_) {
        return false;
    }
}

async function ensureParentDir(filePath) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeLine(stream, line) {
    if (!stream.write(`${line}\n`)) {
        await once(stream, 'drain');
    }
}

async function closeWriteStream(stream) {
    if (!stream || stream.destroyed) {
        return;
    }

    await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.end(resolve);
    });
}

async function* iterateJsonlRoas(filePath) {
    if (!(await fileExists(filePath))) {
        return;
    }

    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const parsed = safeJsonParse(trimmed);
        const roa = normalizeRoaObject(parsed);
        if (roa) {
            yield roa;
        }
    }
}

async function readJsonlPage(filePath, page, pageSize) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 10));
    const startIndex = (safePage - 1) * safePageSize;
    const endIndex = startIndex + safePageSize;
    const items = [];
    let index = 0;

    for await (const roa of iterateJsonlRoas(filePath)) {
        if (index >= startIndex && index < endIndex) {
            items.push(roa);
        }
        index += 1;
        if (index >= endIndex) {
            break;
        }
    }

    return items;
}

async function countJsonlRows(filePath) {
    let count = 0;
    for await (const _roa of iterateJsonlRoas(filePath)) {
        count += 1;
    }
    return count;
}

async function writeRoasToJsonl(filePath, roas) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const seen = new Set();
    let count = 0;

    try {
        for (const item of roas || []) {
            const roa = normalizeRoaObject(item);
            if (!roa) {
                continue;
            }
            const key = makeRoaStorageKey(roa);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            await writeLine(stream, JSON.stringify(roa));
            count += 1;
        }
        await closeWriteStream(stream);
        await fs.promises.rename(tempPath, filePath);
        return count;
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function parseRoaJsonFile(filePath, onRoa) {
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

    const handleObject = async objectText => {
        stats.objects += 1;
        let parsed;
        try {
            parsed = JSON.parse(objectText);
        } catch (error) {
            throw new Error(`ROA JSON对象解析失败: ${error.message}`);
        }

        const roa = normalizeRoaObject(parsed);
        if (!roa) {
            stats.invalid += 1;
            return;
        }

        stats.valid += 1;
        await onRoa(roa);
    };

    for await (const chunk of input) {
        for (let i = 0; i < chunk.length; i++) {
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
                const target = stack.length === 0 || ROA_ARRAY_KEYS.has(key);
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
    }

    if (collecting || inString || collectInString) {
        throw new Error('ROA JSON文件不完整或格式错误');
    }

    return stats;
}

module.exports = {
    getRoaDataFilePath,
    makeRoaStorageKey,
    normalizeRoaObject,
    fileExists,
    ensureParentDir,
    writeLine,
    closeWriteStream,
    iterateJsonlRoas,
    readJsonlPage,
    countJsonlRows,
    writeRoasToJsonl,
    parseRoaJsonFile
};
