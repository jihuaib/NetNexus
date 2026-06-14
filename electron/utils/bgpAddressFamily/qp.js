
const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../ipUtils');
const { parseQpDqpn, formatIpAddressList } = require('./common');

function parseQpNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

function parseQpNlri(buffer, position, afi) {
    const nlriTotalLength = buffer[position];
    position += 1;
    position += 1;
    const dqpnBitLength = buffer[position];
    position += 1;
    const { dqpn, byteLength: dqpnByteLength } = parseQpDqpn(buffer, position, dqpnBitLength);
    position += dqpnByteLength;
    position += 1;
    const prefixLength = buffer[position];
    position += 1;
    const prefixBytes = Math.ceil(prefixLength / 8);
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;
    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4
            ? ipv4BufferToString(prefixBuffer, prefixLength)
            : ipv6BufferToString(prefixBuffer, prefixLength);

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
