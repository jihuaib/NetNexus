const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString, rdBufferToString } = require('../ipUtils');
const { parseMplsLabelStack } = require('./common');

function parseVpnNextHop(buffer, position, nextHopLength) {
    if (nextHopLength === 0) {
        return '';
    }

    if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN) {
        return ipv4BufferToString(
            buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN),
            BgpConst.IP_HOST_LEN
        );
    }

    if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) {
        return ipv6BufferToString(
            buffer.subarray(
                position + BgpConst.BGP_RD_LEN,
                position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN
            ),
            BgpConst.IPV6_HOST_LEN
        );
    }

    if (nextHopLength === (BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) * 2) {
        const globalNextHop = ipv6BufferToString(
            buffer.subarray(
                position + BgpConst.BGP_RD_LEN,
                position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN
            ),
            BgpConst.IPV6_HOST_LEN
        );
        const linkLocalNextHopPosition =
            position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN + BgpConst.BGP_RD_LEN;
        const linkLocalNextHop = ipv6BufferToString(
            buffer.subarray(linkLocalNextHopPosition, linkLocalNextHopPosition + BgpConst.IPV6_HOST_BYTE_LEN),
            BgpConst.IPV6_HOST_LEN
        );
        return `${globalNextHop}, ${linkLocalNextHop}`;
    }

    return buffer.subarray(position, position + nextHopLength).toString('hex');
}

function parseRouteDistinguisherNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const valueStart = position;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const boundedNlriEnd = Math.min(nlriEnd, buffer.length);

    if (nlriEnd > buffer.length) {
        errors.push('VPN NLRI length exceeds remaining buffer');
    }
    if (nlriBitLength < 24 + (BgpConst.BGP_RD_LEN << 3)) {
        errors.push(`VPN NLRI length is too short: ${nlriBitLength}`);
    }

    const {
        labels,
        labelBits,
        position: rdPosition
    } = parseMplsLabelStack(buffer, position, nlriBitLength, boundedNlriEnd);
    position = rdPosition;
    if (labels.length === 0) {
        errors.push('VPN NLRI has no MPLS label');
    } else if (!labels[labels.length - 1].bottom) {
        errors.push('VPN label stack does not contain bottom-of-stack bit');
    }

    let rd = null;
    if (position + BgpConst.BGP_RD_LEN <= boundedNlriEnd) {
        rd = rdBufferToString(buffer.subarray(position, position + BgpConst.BGP_RD_LEN));
    } else {
        errors.push('VPN RD is truncated');
    }
    position = Math.min(position + BgpConst.BGP_RD_LEN, boundedNlriEnd);

    const prefixLength = Math.max(nlriBitLength - labelBits - (BgpConst.BGP_RD_LEN << 3), 0);
    const maxPrefixLength = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`VPN prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }
    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > boundedNlriEnd) {
        errors.push('VPN prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(position, Math.min(position + prefixBytes, boundedNlriEnd));
    position = Math.min(position + prefixBytes, boundedNlriEnd);

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position,
        route: {
            prefix,
            rd,
            length: prefixLength,
            labels,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, boundedNlriEnd).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

module.exports = {
    parseRouteDistinguisherNlri,
    parseVpnNextHop
};
