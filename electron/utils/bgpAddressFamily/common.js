const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../ipUtils');

function parseQpDqpn(buffer, position, bitLength) {
    const byteLength = Math.ceil(bitLength / 8);
    let dqpn = 0;

    for (let i = 0; i < byteLength; i++) {
        dqpn = dqpn * 256 + buffer[position + i];
    }

    if (bitLength > 0 && bitLength % 8 !== 0) {
        dqpn &= (1 << bitLength % 8) - 1;
    }

    return {
        dqpn,
        byteLength
    };
}

function readBigEndianValue(buffer, position, length) {
    let value = 0n;
    for (let i = 0; i < length && position + i < buffer.length; i++) {
        value = (value << 8n) + BigInt(buffer[position + i]);
    }

    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    return value.toString();
}

function getBit(buffer, bitIndex) {
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = 7 - (bitIndex % 8);
    return (buffer[byteIndex] >> bitOffset) & 0x01;
}

function setBit(buffer, bitIndex, value) {
    if (!value) {
        return;
    }

    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = 7 - (bitIndex % 8);
    buffer[byteIndex] |= 1 << bitOffset;
}

function formatIpAddressList(buffer, position, byteLength) {
    if (byteLength === 0) {
        return '';
    }

    if (byteLength === BgpConst.IP_HOST_BYTE_LEN) {
        return ipv4BufferToString(buffer.subarray(position, position + 4), BgpConst.IP_HOST_LEN);
    }

    if (byteLength === BgpConst.IPV6_HOST_BYTE_LEN) {
        return ipv6BufferToString(buffer.subarray(position, position + 16), BgpConst.IPV6_HOST_LEN);
    }

    if (byteLength === BgpConst.IPV6_HOST_BYTE_LEN * 2) {
        const globalNextHop = ipv6BufferToString(buffer.subarray(position, position + 16), BgpConst.IPV6_HOST_LEN);
        const linkLocalNextHop = ipv6BufferToString(
            buffer.subarray(position + 16, position + 32),
            BgpConst.IPV6_HOST_LEN
        );
        return `${globalNextHop}, ${linkLocalNextHop}`;
    }

    return buffer.subarray(position, position + byteLength).toString('hex');
}

function parseFlowSpecLength(buffer, position) {
    const errors = [];
    if (position >= buffer.length) {
        return {
            nlriLength: 0,
            lengthBytes: 0,
            errors: ['FlowSpec NLRI length is missing']
        };
    }

    const firstByte = buffer[position];
    if (firstByte < 240) {
        return {
            nlriLength: firstByte,
            lengthBytes: 1,
            errors
        };
    }

    if (position + 1 >= buffer.length) {
        return {
            nlriLength: 0,
            lengthBytes: 1,
            errors: ['FlowSpec extended NLRI length is truncated']
        };
    }

    return {
        nlriLength: ((firstByte & 0x0f) << 8) + buffer[position + 1],
        lengthBytes: 2,
        errors
    };
}

function isSimpleIpNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );
}

function parseFallbackNlri(buffer, position) {
    const routeType = buffer[position];
    position += 1;
    const routeLength = position < buffer.length ? buffer[position] : 0;
    position += 1;
    const routeValue = buffer.subarray(position, position + routeLength);
    position += routeLength;

    return {
        position,
        route: {
            prefix: routeValue.toString('hex'),
            rd: null,
            length: routeLength,
            nlriLength: routeLength,
            routeType,
            rawNlri: routeValue.toString('hex')
        }
    };
}

function parseMplsLabelStack(buffer, position, nlriBitLength, nlriEnd) {
    const labels = [];
    let labelBits = 0;

    while (position + 3 <= nlriEnd && nlriBitLength - labelBits >= 24) {
        const entry = (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
        labels.push({
            label: entry >> 4,
            exp: (entry >> 1) & 0x07,
            bottom: (entry & 0x01) === 1
        });
        position += 3;
        labelBits += 24;

        if (labels[labels.length - 1].bottom) {
            break;
        }
    }

    return {
        labels,
        labelBits,
        position
    };
}

module.exports = {
    parseQpDqpn,
    readBigEndianValue,
    getBit,
    setBit,
    formatIpAddressList,
    parseFlowSpecLength,
    isSimpleIpNlri,
    parseFallbackNlri,
    parseMplsLabelStack
};
