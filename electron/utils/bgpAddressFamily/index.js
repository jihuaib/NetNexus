
const BgpConst = require('../../const/bgpConst');
const {
    isSimpleIpNlri,
    formatIpAddressList,
    parseFallbackNlri
} = require('./common');
const { parseIpPrefixNlri, parseIpNextHop } = require('./ip');
const {
    parseLabeledUnicastNlri,
    parseLabeledUnicastWithdrawalNlri,
    parseLabeledUnicastNextHop
} = require('./labeledUnicast');
const { parseRouteDistinguisherNlri, parseVpnNextHop } = require('./vpn');
const { parseFlowSpecNlri, parseFlowSpecNextHop } = require('./flowSpec');
const { parseBgpLsNlri, parseBgpLsNextHop } = require('./bgpLs');
const {
    parseEvpnNlri,
    parseEvpnNextHop,
    buildEvpnLabel,
    annotateEvpnLabel,
    buildBgpTunnelEncapsulation,
    EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION,
    BGP_TUNNEL_TYPE,
    getBgpTunnelTypeName,
    getPmsiTunnelTypeName,
    getBgpPrefixSidTlvTypeName,
    getSrv6ServiceSubTlvTypeName,
    getSrv6ServiceDataSubSubTlvTypeName,
    getSrv6EndpointBehaviorName
} = require('./evpn');
const { parseQpNlri, parseQpNextHop } = require('./qp');
const { parseMvpnNlri, parseMvpnNextHop } = require('./mvpn');

function isVpnNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN
    );
}

function isLabeledUnicastNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    );
}

function isFlowSpecNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC
    );
}

function isBgpLsNlri(afi, safi) {
    return (
        afi === BgpConst.BGP_AFI_TYPE.AFI_BGP_LS &&
        (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS || safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN)
    );
}

function isMvpnNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
    );
}

function parseNextHop(buffer, position, nextHopLength, afi, safi) {
    if (isSimpleIpNlri(afi, safi)) {
        return parseIpNextHop(buffer, position, nextHopLength, afi);
    }

    if (afi === BgpConst.BGP_AFI_TYPE.AFI_L2VPN && safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
        return parseEvpnNextHop(buffer, position, nextHopLength);
    }

    if (isVpnNlri(afi, safi)) {
        return parseVpnNextHop(buffer, position, nextHopLength, afi);
    }

    if (isLabeledUnicastNlri(afi, safi)) {
        return parseLabeledUnicastNextHop(buffer, position, nextHopLength, afi);
    }

    if (isMvpnNlri(afi, safi)) {
        return parseMvpnNextHop(buffer, position, nextHopLength, afi);
    }

    if (isFlowSpecNlri(afi, safi)) {
        return parseFlowSpecNextHop(buffer, position, nextHopLength, afi);
    }

    if (isBgpLsNlri(afi, safi)) {
        return parseBgpLsNextHop(buffer, position, nextHopLength);
    }

    if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
        return parseQpNextHop(buffer, position, nextHopLength, afi);
    }

    return formatIpAddressList(buffer, position, nextHopLength);
}

function parseNlriEntry(buffer, position, afi, safi, isWithdrawn = false) {
    if (isSimpleIpNlri(afi, safi)) {
        return parseIpPrefixNlri(buffer, position, afi);
    }

    if (afi === BgpConst.BGP_AFI_TYPE.AFI_L2VPN && safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
        return parseEvpnNlri(buffer, position);
    }

    if (isVpnNlri(afi, safi)) {
        return parseRouteDistinguisherNlri(buffer, position, afi);
    }

    if (isLabeledUnicastNlri(afi, safi)) {
        if (isWithdrawn) {
            return parseLabeledUnicastWithdrawalNlri(buffer, position, afi);
        }
        return parseLabeledUnicastNlri(buffer, position, afi);
    }

    if (isMvpnNlri(afi, safi)) {
        return parseMvpnNlri(buffer, position, afi);
    }

    if (isFlowSpecNlri(afi, safi)) {
        return parseFlowSpecNlri(buffer, position, afi);
    }

    if (isBgpLsNlri(afi, safi)) {
        return parseBgpLsNlri(buffer, position, safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN);
    }

    if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
        return parseQpNlri(buffer, position, afi);
    }

    return parseFallbackNlri(buffer, position);
}

module.exports = {
    parseNextHop,
    isSimpleIpNlri,
    parseNlriEntry,
    parseIpPrefixNlri,
    parseFallbackNlri,
    parseEvpnNlri,
    buildEvpnLabel,
    annotateEvpnLabel,
    buildBgpTunnelEncapsulation,
    EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION,
    BGP_TUNNEL_TYPE,
    getBgpTunnelTypeName,
    getPmsiTunnelTypeName,
    getBgpPrefixSidTlvTypeName,
    getSrv6ServiceSubTlvTypeName,
    getSrv6ServiceDataSubSubTlvTypeName,
    getSrv6EndpointBehaviorName
};
