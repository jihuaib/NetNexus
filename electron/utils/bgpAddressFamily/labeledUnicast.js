const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../ipUtils');
const { parseMplsLabelStack, formatIpAddressList } = require('./common');

function parseLabeledUnicastNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

function parseLabeledUnicastNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const valueStart = position;

    if (nlriEnd > buffer.length) {
        errors.push('Labeled Unicast NLRI length exceeds remaining buffer');
    }

    if (nlriBitLength < 24) {
        errors.push(`Labeled Unicast NLRI length is too short: ${nlriBitLength}`);
    }

    const {
        labels,
        labelBits,
        position: prefixPosition
    } = parseMplsLabelStack(buffer, position, nlriBitLength, Math.min(nlriEnd, buffer.length));
    position = prefixPosition;
    if (labels.length === 0) {
        errors.push('Labeled Unicast NLRI has no MPLS label');
    } else if (!labels[labels.length - 1].bottom) {
        errors.push('Labeled Unicast label stack does not contain bottom-of-stack bit');
    }

    const prefixLength = Math.max(nlriBitLength - labelBits, 0);
    const maxPrefixLength = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`Labeled Unicast prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }
    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('Labeled Unicast prefix is truncated');
    }
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
            length: prefixLength,
            labels,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, Math.min(nlriEnd, buffer.length)).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

function parseLabeledUnicastWithdrawalNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const valueStart = position;

    if (nlriEnd > buffer.length) {
        errors.push('Labeled Unicast withdrawal NLRI length exceeds remaining buffer');
    }

    if (nlriBitLength < 24) {
        errors.push(`Labeled Unicast withdrawal NLRI length is too short: ${nlriBitLength}`);
    }

    const compatibilityField = buffer.subarray(position, Math.min(position + 3, buffer.length)).toString('hex');
    if (position + 3 > buffer.length) {
        errors.push('Labeled Unicast withdrawal compatibility field is truncated');
        position = buffer.length;
    } else {
        position += 3;
    }

    const prefixLength = Math.max(nlriBitLength - 24, 0);
    const maxPrefixLength = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`Labeled Unicast withdrawal prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }

    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('Labeled Unicast withdrawal prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position: Math.min(position, buffer.length),
        route: {
            prefix,
            rd: null,
            length: prefixLength,
            compatibilityField,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, Math.min(nlriEnd, buffer.length)).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

module.exports = {
    parseLabeledUnicastNlri,
    parseLabeledUnicastWithdrawalNlri,
    parseLabeledUnicastNextHop
};
