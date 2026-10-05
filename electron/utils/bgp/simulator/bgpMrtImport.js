const fs = require('fs');
const zlib = require('zlib');
const { ipv4BufferToString, ipv6BufferToString } = require('../../ipUtils');

// Bound retained data even when a corrupt header declares an enormous record.
const MAX_MRT_RECORD_LENGTH = 64 * 1024 * 1024;
const RIB_SUBTYPES = new Map([
    [2, { afi: 1, safi: 1, addPath: false }],
    [4, { afi: 2, safi: 1, addPath: false }],
    [8, { afi: 1, safi: 1, addPath: true }],
    [10, { afi: 2, safi: 1, addPath: true }]
]);

function reader(data, context) {
    let offset = 0;
    return {
        bytes(length) {
            if (offset + length > data.length) throw new Error(`MRT ${context}截断（偏移${offset}）`);
            const value = data.subarray(offset, offset + length);
            offset += length;
            return value;
        },
        uint8() {
            return this.bytes(1)[0];
        },
        uint16() {
            return this.bytes(2).readUInt16BE(0);
        },
        uint32() {
            return this.bytes(4).readUInt32BE(0);
        },
        end() {
            if (offset !== data.length) throw new Error(`MRT ${context}含多余数据（偏移${offset}）`);
        }
    };
}

function prefixAddress(bytes, mask, afi) {
    if (mask > (afi === 1 ? 32 : 128)) throw new Error(`MRT IPv${afi === 1 ? 4 : 6}前缀长度无效: ${mask}`);
    const prefix = bytes.subarray(0, Math.ceil(mask / 8));
    return afi === 1 ? ipv4BufferToString(prefix, mask) : ipv6BufferToString(prefix, mask);
}

function parsePeerIndexTable(data) {
    const input = reader(data, 'PEER_INDEX_TABLE');
    input.bytes(4);
    input.bytes(input.uint16());
    const count = input.uint16();
    for (let index = 0; index < count; index++) {
        const type = input.uint8();
        input.bytes(4 + (type & 1 ? 16 : 4) + (type & 2 ? 4 : 2));
    }
    input.end();
    return count;
}

function decodeAsPath(value, asnSize) {
    const numbers = [];
    let offset = 0;
    // Sets and confederations must remain raw: flattening changes semantics.
    while (offset < value.length) {
        if (offset + 2 > value.length || value[offset] !== 2) return null;
        const count = value[offset + 1];
        offset += 2;
        if (offset + count * asnSize > value.length) return null;
        for (let index = 0; index < count; index++, offset += asnSize)
            numbers.push(asnSize === 4 ? value.readUInt32BE(offset) : value.readUInt16BE(offset));
    }
    return numbers.join(' ');
}

function rawAttribute(flags, code, bytes) {
    const extended = Boolean(flags & 0x10) || bytes.length > 0xff;
    const header = Buffer.alloc(extended ? 4 : 3);
    header.set([extended ? flags | 0x10 : flags, code]);
    if (extended) header.writeUInt16BE(bytes.length, 2);
    else header[2] = bytes.length;
    return Buffer.concat([header, bytes]).toString('hex');
}

function convertAs2RawAttribute(flags, value) {
    const segments = [];
    for (let offset = 0; offset < value.length; ) {
        if (offset + 2 > value.length) throw new Error('MRT AS_PATH段头截断');
        const type = value[offset];
        const count = value[offset + 1];
        offset += 2;
        if (offset + count * 2 > value.length) throw new Error('MRT AS_PATH两字节ASN段截断');
        const segment = Buffer.alloc(2 + count * 4);
        segment.set([type, count]);
        for (let index = 0; index < count; index++, offset += 2)
            segment.writeUInt32BE(value.readUInt16BE(offset), 2 + index * 4);
        segments.push(segment);
    }
    return rawAttribute(flags, 2, Buffer.concat(segments));
}

function decodeExtendedCommunities(value) {
    const communities = [];
    for (let offset = 0; offset < value.length; offset += 8) {
        const bytes = value.subarray(offset, offset + 8);
        const subtype = bytes[1] === 2 ? 'rt' : bytes[1] === 3 ? 'soo' : null;
        let token;
        if (subtype && bytes[0] === 0) token = `${subtype}:${bytes.readUInt16BE(2)}:${bytes.readUInt32BE(4)}`;
        else if (subtype && bytes[0] === 1)
            token = `${subtype}:${Array.from(bytes.subarray(2, 6)).join('.')}:${bytes.readUInt16BE(6)}`;
        else if (subtype && bytes[0] === 2 && bytes.readUInt32BE(2) > 0xffff)
            token = `${subtype}:${bytes.readUInt32BE(2)}:${bytes.readUInt16BE(6)}`;
        // Small ASNs encoded as AS4 would become AS2 if represented as tokens.
        communities.push(token || `hex:${bytes.toString('hex')}`);
    }
    return communities;
}

function parseMpNextHop(value, compact, afi, safi) {
    let bytes;
    if (compact) {
        if (!value.length || value.length !== value[0] + 1) throw new Error('MRT紧凑MP_REACH下一跳长度无效');
        bytes = value.subarray(1);
    } else {
        if (value.length < 5 || value.length < value[3] + 5) throw new Error('MRT MP_REACH下一跳截断');
        if (value.readUInt16BE(0) !== afi || value[2] !== safi) throw new Error('MRT MP_REACH地址族与RIB不匹配');
        bytes = value.subarray(4, 4 + value[3]);
    }
    if (![0, 4, 16, 32].includes(bytes.length)) throw new Error(`MRT MP_REACH不支持的下一跳长度: ${bytes.length}`);
    return {
        mpNextHop:
            bytes.length === 0
                ? null
                : bytes.length === 4
                  ? ipv4BufferToString(bytes, 32)
                  : ipv6BufferToString(bytes.subarray(0, 16), 128),
        ...(bytes.length === 32 ? { mrtMpNextHopBytes: bytes.toString('hex') } : {})
    };
}

function parseBgpAttributes(buffer, { asnSize, compact, afi, safi }) {
    const attrs = { attributePolicy: 'configured', configuredAttributes: [], pathAttributes: [] };
    const nlri = { nlriEncoding: 'auto', mpNextHop: null };
    let hasMp = false;
    for (let offset = 0; offset < buffer.length; ) {
        if (buffer.length - offset < 3) throw new Error('MRT路径属性头截断');
        const flags = buffer[offset];
        const code = buffer[offset + 1];
        const headerLength = flags & 0x10 ? 4 : 3;
        if (buffer.length - offset < headerLength) throw new Error('MRT路径属性长度字段截断');
        const length = headerLength === 4 ? buffer.readUInt16BE(offset + 2) : buffer[offset + 2];
        const end = offset + headerLength + length;
        if (end > buffer.length) throw new Error('MRT路径属性值截断');
        const value = buffer.subarray(offset + headerLength, end);
        const raw = buffer.subarray(offset, end).toString('hex');
        offset = end;
        if (code === 14) {
            if (hasMp) throw new Error('MRT RIB含多个MP_REACH下一跳，无法无损导入');
            hasMp = true;
            const { mrtMpNextHopBytes, ...mp } = parseMpNextHop(value, compact, afi, safi);
            Object.assign(nlri, mp, { nlriEncoding: 'mpReach' });
            if (mrtMpNextHopBytes) attrs.mrtMpNextHopBytes = mrtMpNextHopBytes;
            continue;
        }
        let entry;
        const regularFlags = flags & ~0x10;
        if (code === 1 && regularFlags === 0x40 && value.length === 1) entry = { type: 'origin', value: value[0] };
        else if (code === 2 && regularFlags === 0x40) {
            const asPath = decodeAsPath(value, asnSize);
            if (asPath !== null) entry = { type: 'asPath', value: asPath };
        } else if (code === 3 && regularFlags === 0x40 && value.length === 4)
            entry = { type: 'nextHop', value: ipv4BufferToString(value, 32) };
        else if (code === 4 && regularFlags === 0x80 && value.length === 4)
            entry = { type: 'med', value: value.readUInt32BE(0) };
        else if (code === 5 && regularFlags === 0x40 && value.length === 4)
            entry = { type: 'localPref', value: value.readUInt32BE(0) };
        else if (code === 8 && regularFlags === 0xc0 && value.length % 4 === 0) {
            const communities = [];
            for (let index = 0; index < value.length; index += 4)
                communities.push(`${value.readUInt16BE(index)}:${value.readUInt16BE(index + 2)}`);
            entry = { type: 'communities', value: communities };
        } else if (code === 16 && regularFlags === 0xc0 && value.length % 8 === 0)
            entry = { type: 'extendedCommunities', value: decodeExtendedCommunities(value) };
        if (!entry) {
            let custom = raw;
            if (code === 2 && asnSize === 2) custom = convertAs2RawAttribute(flags, value);
            else if (code === 7 && asnSize === 2 && value.length === 6) {
                const asn = Buffer.alloc(4);
                asn.writeUInt32BE(value.readUInt16BE(0));
                custom = rawAttribute(flags, code, Buffer.concat([asn, value.subarray(2)]));
            }
            entry = { type: 'custom', value: custom };
        }
        attrs.pathAttributes.push(entry);
        if (!attrs.configuredAttributes.includes(entry.type)) attrs.configuredAttributes.push(entry.type);
        if (entry.type === 'custom') attrs.customAttr = (attrs.customAttr || '') + entry.value;
        else if (!Object.hasOwn(attrs, entry.type)) attrs[entry.type] = entry.value;
    }
    return { ...attrs, ...nlri };
}

function parseRibEntry(data, subtype, targetAfi, targetSafi, peerCount) {
    const input = reader(data, `RIB subtype ${subtype}`);
    input.uint32();
    const generic = subtype === 6 || subtype === 12;
    const definition = generic
        ? { afi: input.uint16(), safi: input.uint8(), addPath: subtype === 12 }
        : RIB_SUBTYPES.get(subtype);
    const { afi, safi, addPath } = definition;
    if (![1, 2].includes(afi) || ![1, 4].includes(safi)) return [];
    if (afi !== targetAfi || safi !== targetSafi) return [];
    const pathId = generic && addPath ? input.uint32() : 0;
    const nlriBits = input.uint8();
    const nlriBytes = input.bytes(Math.ceil(nlriBits / 8));
    let mask = nlriBits;
    let prefix = nlriBytes;
    let label;
    if (safi === 4) {
        if (nlriBits < 24 || nlriBytes.length < 3) throw new Error('MRT Label NLRI缺少完整标签');
        if (!(nlriBytes[2] & 1)) throw new Error('MRT多标签栈无法无损导入');
        label = ((nlriBytes[0] << 16) | (nlriBytes[1] << 8) | nlriBytes[2]) >>> 4;
        mask -= 24;
        prefix = nlriBytes.subarray(3);
    }
    const ip = prefixAddress(prefix, mask, afi);
    const entryCount = input.uint16();
    const entries = [];
    let firstPeer;
    for (let index = 0; index < entryCount; index++) {
        const peer = input.uint16();
        if (peerCount !== null && peer >= peerCount) throw new Error(`MRT RIB Peer Index无效: ${peer}`);
        const originatedTime = input.uint32();
        const entryPathId = addPath && !generic ? input.uint32() : pathId;
        const attributes = input.bytes(input.uint16());
        if (firstPeer === undefined) firstPeer = peer;
        if (peer === firstPeer) {
            const attrs = parseBgpAttributes(attributes, { asnSize: 4, compact: true, afi, safi });
            entries.push({
                ip,
                mask,
                pathId: entryPathId,
                ...(safi === 4 ? { label } : {}),
                createdAtMs: originatedTime * 1000,
                ...attrs
            });
        }
    }
    input.end();
    return entries;
}

function parseTableDump(data, afi) {
    const input = reader(data, 'TABLE_DUMP');
    input.bytes(4);
    const prefix = input.bytes(afi === 1 ? 4 : 16);
    const mask = input.uint8();
    input.uint8();
    const originatedTime = input.uint32();
    input.bytes(afi === 1 ? 4 : 16);
    input.uint16();
    const attrs = parseBgpAttributes(input.bytes(input.uint16()), { asnSize: 2, compact: false, afi, safi: 1 });
    input.end();
    return { ip: prefixAddress(prefix, mask, afi), mask, pathId: 0, createdAtMs: originatedTime * 1000, ...attrs };
}

/** Streams one peer's entries per RIB record, retaining its ADD-PATH paths. */
async function* iterateMrtRoutes(filePath, limit = 10000, targetAfi, onProgress, targetSafi = 1) {
    if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
    const numericLimit = Number(limit);
    const routeLimit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : 10000;
    if (onProgress) onProgress('正在准备解析 MRT 文件...');
    if (routeLimit === 0) return;
    const readStream = fs.createReadStream(filePath);
    let input = readStream;
    let readError = null;
    let forwardReadError = null;
    if (filePath.endsWith('.gz')) {
        input = zlib.createGunzip();
        forwardReadError = error => {
            readError = error;
            input.destroy(error);
        };
        readStream.on('error', forwardReadError);
        readStream.pipe(input);
    }
    let buffer = Buffer.alloc(0);
    let count = 0;
    let lastReportedCount = 0;
    let peerCount = null;
    try {
        for await (const chunk of input) {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            while (buffer.length >= 12 && count < routeLimit) {
                const length = buffer.readUInt32BE(8);
                if (length > MAX_MRT_RECORD_LENGTH) throw new Error(`MRT 记录长度异常: ${length}`);
                const recordLength = 12 + length;
                if (buffer.length < recordLength) break;
                const type = buffer.readUInt16BE(4);
                const subtype = buffer.readUInt16BE(6);
                const data = buffer.subarray(12, recordLength);
                buffer = buffer.subarray(recordLength);
                let routes = [];
                if (type === 13 && subtype === 1) peerCount = parsePeerIndexTable(data);
                else if (type === 13 && (RIB_SUBTYPES.has(subtype) || subtype === 6 || subtype === 12))
                    routes = parseRibEntry(data, subtype, targetAfi, targetSafi, peerCount);
                else if (type === 12 && (subtype === 1 || subtype === 2)) {
                    const afi = subtype === 1 ? 1 : 2;
                    if (afi === targetAfi && targetSafi === 1) routes = [parseTableDump(data, afi)];
                }
                for (const route of routes) {
                    if (count >= routeLimit) break;
                    count++;
                    if (count - lastReportedCount >= 500) {
                        if (onProgress) onProgress(`已解析 ${count} 条路由...`);
                        lastReportedCount = count;
                    }
                    yield route;
                }
            }
            if (count >= routeLimit) return;
        }
        if (readError) throw readError;
        if (buffer.length) throw new Error(`MRT文件截断: 仍有${buffer.length}字节不完整记录`);
    } finally {
        if (forwardReadError) readStream.removeListener('error', forwardReadError);
        if (!readStream.destroyed) readStream.destroy();
        if (input !== readStream && !input.destroyed) input.destroy();
    }
}

module.exports = { iterateMrtRoutes };
