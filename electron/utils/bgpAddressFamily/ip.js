const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../ipUtils');
const { formatIpAddressList } = require('./common');

function parseIpPrefixNlri(buffer, position, afi) {
    const prefixLength = buffer[position];
    position += 1;

    const prefixBytes = Math.ceil(prefixLength / 8);
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position,
        route: {
            prefix,
            rd: null,
            length: prefixLength
        }
    };
}

function parseIpNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

module.exports = {
    parseIpPrefixNlri,
    parseIpNextHop
};
