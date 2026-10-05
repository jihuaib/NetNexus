const BgpConst = require('../../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../../ipUtils');
const { parseQpDqpn, formatIpAddressList } = require('./common');

function parseQpNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

function parseQpNlri(buffer, position, afi) {
    const nlriTotalLength = buffer[position];
    position += 1;
    const end = position + nlriTotalLength;
    const invalid = error => ({
        position: Math.min(end, buffer.length),
        route: { prefix: '', rd: null, length: null, dqpn: null, valid: false, errors: [error] }
    });
    if (end > buffer.length) return invalid('QP NLRI is truncated');
    let dqpn = null;
    let dqpnBitLength = null;
    let prefix = null;
    let prefixLength = null;
    while (position < end) {
        if (position + 2 > end) return invalid('QP NLRI TLV is truncated');
        const type = buffer[position++];
        const bitLength = buffer[position++];
        const byteLength = Math.ceil(bitLength / 8);
        if (position + byteLength > end) return invalid('QP NLRI TLV value is truncated');
        if (type === 1) {
            dqpn = parseQpDqpn(buffer, position, bitLength).dqpn;
            dqpnBitLength = bitLength;
        } else if (type === 2) {
            prefixLength = bitLength;
            const prefixBuffer = buffer.subarray(position, position + byteLength);
            prefix =
                afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4
                    ? ipv4BufferToString(prefixBuffer, prefixLength)
                    : ipv6BufferToString(prefixBuffer, prefixLength);
        }
        position += byteLength;
    }
    if (prefix === null) return invalid('QP NLRI prefix TLV is missing');

    return {
        position,
        route: {
            prefix,
            rd: null,
            length: prefixLength,
            dqpn,
            dqpnBits: dqpnBitLength,
            nlriBits: nlriTotalLength * 8
        }
    };
}

module.exports = {
    parseQpNlri,
    parseQpNextHop
};
