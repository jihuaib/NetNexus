const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { rdBufferToString, ipv4BufferToString, ipv6BufferToString } = require('./ipUtils');

const PER_AFI_SAFI_STATS_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_ADJ_RIB_IN,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT
]);

function getInitiationTlvName(tlvType) {
    switch (tlvType) {
        case BmpConst.BMP_INITIATION_TLV_TYPE.STRING:
            return 'string';
        case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME:
            return 'sysName';
        case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC:
            return 'sysDesc';
        default:
            return `tlv${tlvType}`;
    }
}

function parseCommonHeader(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < BmpConst.BMP_HEADER_LENGTH) {
        return {
            valid: false,
            error: 'BMP common header is truncated'
        };
    }

    return {
        valid: true,
        version: buffer.readUInt8(0),
        length: buffer.readUInt32BE(1),
        type: buffer.readUInt8(5)
    };
}

function toUnixTimestampMs(seconds, microseconds = 0) {
    const secondsValue = Number(seconds);
    const microsecondsValue = Number(microseconds);
    if (!Number.isInteger(secondsValue) || secondsValue < 0) {
        return null;
    }
    if (!Number.isInteger(microsecondsValue) || microsecondsValue < 0 || microsecondsValue > 999999) {
        return secondsValue * 1000;
    }
    return secondsValue * 1000 + Math.floor(microsecondsValue / 1000);
}

function parsePeerHeader(buffer, offset = 0) {
    const startOffset = offset;
    if (!Buffer.isBuffer(buffer) || offset + 42 > buffer.length) {
        return {
            valid: false,
            offset: startOffset,
            error: 'BMP per-peer header is truncated'
        };
    }

    const peerType = buffer[offset];
    offset += 1;
    const peerFlags = buffer[offset];
    offset += 1;

    const rdBuffer = buffer.subarray(offset, offset + BgpConst.BGP_RD_LEN);
    offset += BgpConst.BGP_RD_LEN;
    const peerRd = rdBufferToString(rdBuffer);
    const peerRdRaw = `raw:${rdBuffer.toString('hex')}`;

    let peerAddress;
    if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
        peerAddress = '0.0.0.0';
        offset += 16;
    } else if (peerFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
        peerAddress = ipv6BufferToString(buffer.subarray(offset, offset + 16), 128);
        offset += 16;
    } else {
        offset += 12;
        peerAddress = ipv4BufferToString(buffer.subarray(offset, offset + 4), 32);
        offset += 4;
    }

    const peerAs = buffer.readUInt32BE(offset);
    offset += 4;
    const peerRouterId = ipv4BufferToString(buffer.subarray(offset, offset + 4), 32);
    offset += 4;
    const peerTimestamp = buffer.readUInt32BE(offset);
    offset += 4;
    const peerTimestampMicroseconds = buffer.readUInt32BE(offset);
    offset += 4;
    const peerTimestampMs = toUnixTimestampMs(peerTimestamp, peerTimestampMicroseconds);

    return {
        valid: true,
        offset,
        peer: {
            peerType,
            peerFlags,
            peerRd,
            peerRdRaw,
            peerAddress,
            peerAs,
            peerRouterId,
            peerTimestamp,
            peerTimestampMicroseconds,
            peerTimestampMs
        }
    };
}

function parseBmpTlvs(buffer, offset = 0, options = {}) {
    const indexed = options.indexed === true;
    const tlvs = [];
    const warnings = [];
    let position = offset;

    while (position < buffer.length) {
        const tlvStart = position;
        if (position + 4 > buffer.length) {
            warnings.push(`TLV header is truncated at offset ${tlvStart}`);
            break;
        }

        const rawType = buffer.readUInt16BE(position);
        position += 2;
        const enterprise = (rawType & 0x8000) !== 0;
        const type = rawType & 0x7fff;

        const length = buffer.readUInt16BE(position);
        position += 2;

        let rawIndex = null;
        let index = null;
        let group = false;
        if (indexed) {
            if (position + 2 > buffer.length) {
                warnings.push(`Indexed TLV index is truncated at offset ${tlvStart}`);
                break;
            }
            rawIndex = buffer.readUInt16BE(position);
            position += 2;
            group = (rawIndex & 0x8000) !== 0;
            index = rawIndex & 0x7fff;
        }

        if (position + length > buffer.length) {
            warnings.push(`TLV type ${type} length ${length} exceeds remaining message bytes`);
            break;
        }

        let enterpriseNumber = null;
        let valueOffset = position;
        if (enterprise) {
            if (length < 4) {
                warnings.push(`Enterprise TLV type ${type} is shorter than the enterprise number`);
            } else {
                enterpriseNumber = buffer.readUInt32BE(position);
                valueOffset += 4;
            }
        }

        const rawValue = buffer.subarray(position, position + length);
        const value = buffer.subarray(valueOffset, position + length);
        position += length;

        tlvs.push({
            rawType,
            type,
            enterprise,
            enterpriseNumber,
            length,
            rawIndex,
            index,
            group,
            value,
            rawValue,
            valueHex: value.toString('hex'),
            rawValueHex: rawValue.toString('hex'),
            offset: tlvStart
        });
    }

    return { tlvs, warnings, offset: position };
}

function toSerializableTlvs(tlvs) {
    if (!Array.isArray(tlvs)) {
        return [];
    }

    return tlvs.map(tlv => {
        const item = {
            type: tlv.type,
            rawType: tlv.rawType,
            length: tlv.length,
            enterprise: tlv.enterprise,
            enterpriseNumber: tlv.enterpriseNumber,
            valueHex: tlv.valueHex,
            rawValueHex: tlv.rawValueHex
        };

        if (tlv.index !== null && tlv.index !== undefined) {
            item.index = tlv.index;
            item.rawIndex = tlv.rawIndex;
            item.group = tlv.group;
        }

        if (tlv.name) {
            item.name = tlv.name;
        }
        if (tlv.valueText !== undefined) {
            item.value = tlv.valueText;
        }
        if (tlv.decoded !== undefined) {
            item.decoded = tlv.decoded;
        }

        return item;
    });
}

const EXTENDED_PEER_FLAGS_COMPAT_MASK =
    BmpConst.BMP_SESSION_FLAGS.IPV6 |
    BmpConst.BMP_SESSION_FLAGS.POST_POLICY |
    BmpConst.BMP_SESSION_FLAGS.AS_PATH |
    BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT |
    BmpConst.BMP_SESSION_FLAGS.FILTERED;
const EXTENDED_PEER_FLAGS_COMPAT_MAX_LENGTH = 4;

function decodeExtendedPeerFlagsValue(value) {
    if (!Buffer.isBuffer(value) || value.length === 0) {
        return null;
    }

    const flags = value[0];
    if (flags !== 0 || value.length === 1 || value.length > EXTENDED_PEER_FLAGS_COMPAT_MAX_LENGTH) {
        return flags;
    }

    const lastByte = value[value.length - 1];
    const rightAlignedFlags = lastByte & EXTENDED_PEER_FLAGS_COMPAT_MASK;
    const leadingBytesAreZero = value.subarray(0, value.length - 1).every(byte => byte === 0);
    if (leadingBytesAreZero && rightAlignedFlags !== 0 && rightAlignedFlags === lastByte) {
        return rightAlignedFlags;
    }

    return flags;
}

function getEffectivePeerFlags(peerFlags, tlvs = []) {
    const extendedFlagsTlv = tlvs.find(
        tlv => !tlv.enterprise && tlv.type === BmpConst.BMP_TLV_TYPE.EXTENDED_FLAGS && tlv.value.length > 0
    );
    if (!extendedFlagsTlv) {
        return peerFlags;
    }

    return decodeExtendedPeerFlagsValue(extendedFlagsTlv.value);
}

function parseStatsRecords(buffer, offset = 0, options = {}) {
    const statistics = [];
    const warnings = [];
    let position = offset;
    const locRib = options.locRib === true;

    if (!Buffer.isBuffer(buffer) || position + 4 > buffer.length) {
        return {
            statistics,
            warnings: ['Stats count is truncated'],
            offset: position
        };
    }

    const statsCount = buffer.readUInt32BE(position);
    position += 4;

    for (let i = 0; i < statsCount; i++) {
        if (position + 4 > buffer.length) {
            warnings.push(`Statistic ${i} header is truncated`);
            break;
        }

        const statType = buffer.readUInt16BE(position);
        position += 2;
        const statLength = buffer.readUInt16BE(position);
        position += 2;

        if (position + statLength > buffer.length) {
            warnings.push(`Statistic ${statType} length ${statLength} exceeds remaining bytes`);
            break;
        }

        const valueBuffer = buffer.subarray(position, position + statLength);
        let statValue;
        let afi = null;
        let safi = null;
        if (statLength === 4) {
            statValue = buffer.readUInt32BE(position);
        } else if (statLength === 8) {
            const bigValue = buffer.readBigUInt64BE(position);
            statValue = bigValue <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bigValue) : bigValue.toString();
        } else if (PER_AFI_SAFI_STATS_TYPES.has(statType) && statLength === 11) {
            afi = buffer.readUInt16BE(position);
            safi = buffer[position + 2];
            const bigValue = buffer.readBigUInt64BE(position + 3);
            statValue = bigValue <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bigValue) : bigValue.toString();
        } else {
            statValue = 0;
        }
        position += statLength;

        statistics.push({
            type: statType,
            value: statValue,
            valueHex: valueBuffer.toString('hex'),
            afi,
            safi,
            typeName:
                (locRib && BmpConst.BMP_LOC_RIB_STATS_TYPE_NAME[statType]) ||
                BmpConst.BMP_STATS_TYPE_NAME[statType] ||
                `Unknown (${statType})`
        });
    }

    return { statistics, warnings, offset: position };
}

module.exports = {
    getInitiationTlvName,
    toUnixTimestampMs,
    parseCommonHeader,
    parsePeerHeader,
    parseBmpTlvs,
    toSerializableTlvs,
    decodeExtendedPeerFlagsValue,
    getEffectivePeerFlags,
    parseStatsRecords
};
