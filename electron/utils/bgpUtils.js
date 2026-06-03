const BgpConst = require('../const/bgpConst');
/**
 * Get readable packet type name
 * @param {Number} type - BGP packet type number
 * @returns {String} Name of the packet type
 */
function getBgpPacketTypeName(type) {
    switch (type) {
        case BgpConst.BGP_PACKET_TYPE.OPEN:
            return 'OPEN';
        case BgpConst.BGP_PACKET_TYPE.UPDATE:
            return 'UPDATE';
        case BgpConst.BGP_PACKET_TYPE.NOTIFICATION:
            return 'NOTIFICATION';
        case BgpConst.BGP_PACKET_TYPE.KEEPALIVE:
            return 'KEEPALIVE';
        case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH:
            return 'ROUTE_REFRESH';
        default:
            return 'UNKNOWN';
    }
}

/**
 * Get capability name from code
 * @param {Number} code - Capability code
 * @returns {String} Capability name
 */
function getBgpOpenCapabilityName(code) {
    switch (code) {
        case BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS:
            return 'Multiprotocol Extensions';
        case BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH:
            return 'Route Refresh';
        case BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS:
            return '4-octet AS Number';
        case BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE:
            return 'BGP Role';
        case BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING:
            return 'Extended Next Hop Encoding';
        default:
            return `Unknown (${code})`;
    }
}

/**
 * Get AFI name from code
 * @param {Number} afi - Address Family Identifier
 * @returns {String} AFI name
 */
function getBgpAfiName(afi) {
    switch (afi) {
        case BgpConst.BGP_AFI_TYPE.AFI_IPV4:
            return 'IPv4';
        case BgpConst.BGP_AFI_TYPE.AFI_IPV6:
            return 'IPv6';
        case BgpConst.BGP_AFI_TYPE.AFI_L2VPN:
            return 'L2VPN';
        case BgpConst.BGP_AFI_TYPE.AFI_BGP_LS:
            return 'BGP-LS';
        default:
            return `Unknown (${afi})`;
    }
}

/**
 * Get SAFI name from code
 * @param {Number} safi - Subsequent Address Family Identifier
 * @returns {String} SAFI name
 */
function getBgpSafiName(safi) {
    switch (safi) {
        case BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST:
            return 'Unicast';
        case BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST:
            return 'Labeled Unicast';
        case BgpConst.BGP_SAFI_TYPE.SAFI_MVPN:
            return 'MVPN';
        case BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS:
            return 'BGP-LS';
        case BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN:
            return 'BGP-LS-VPN';
        case BgpConst.BGP_SAFI_TYPE.SAFI_EVPN:
            return 'EVPN';
        case BgpConst.BGP_SAFI_TYPE.SAFI_VPN:
            return 'VPN';
        case BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC:
            return 'FlowSpec';
        case BgpConst.BGP_SAFI_TYPE.SAFI_QP:
            return 'QP';
        default:
            return `Unknown (${safi})`;
    }
}

/**
 * Get BGP role name from code
 * @param {Number} role - BGP role code
 * @returns {String} Role name
 */
function getBgpOpenRoleName(role) {
    switch (role) {
        case BgpConst.BGP_ROLE_TYPE.ROLE_PROVIDER:
            return 'Provider';
        case BgpConst.BGP_ROLE_TYPE.ROLE_RS:
            return 'Route Server';
        case BgpConst.BGP_ROLE_TYPE.ROLE_RS_CLIENT:
            return 'Route Server Client';
        case BgpConst.BGP_ROLE_TYPE.ROLE_CUSTOMER:
            return 'Customer';
        case BgpConst.BGP_ROLE_TYPE.ROLE_PEER:
            return 'Lateral Peer';
        default:
            return `Unknown (${role})`;
    }
}

/**
 * Get attribute type name from code
 * @param {Number} typeCode - Attribute type code
 * @returns {String} Attribute type name
 */
function getBgpPathAttrTypeName(typeCode) {
    switch (typeCode) {
        case BgpConst.BGP_PATH_ATTR.ORIGIN:
            return 'ORIGIN';
        case BgpConst.BGP_PATH_ATTR.AS_PATH:
            return 'AS_PATH';
        case BgpConst.BGP_PATH_ATTR.NEXT_HOP:
            return 'NEXT_HOP';
        case BgpConst.BGP_PATH_ATTR.MED:
            return 'MULTI_EXIT_DISC';
        case BgpConst.BGP_PATH_ATTR.LOCAL_PREF:
            return 'LOCAL_PREF';
        case BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE:
            return 'ATOMIC_AGGREGATE';
        case BgpConst.BGP_PATH_ATTR.AGGREGATOR:
            return 'AGGREGATOR';
        case BgpConst.BGP_PATH_ATTR.COMMUNITY:
            return 'COMMUNITY';
        case BgpConst.BGP_PATH_ATTR.ORIGINATOR_ID:
            return 'ORIGINATOR_ID';
        case BgpConst.BGP_PATH_ATTR.CLUSTER_LIST:
            return 'CLUSTER_LIST';
        case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI:
            return 'MP_REACH_NLRI';
        case BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI:
            return 'MP_UNREACH_NLRI';
        case BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES:
            return 'EXTENDED_COMMUNITIES';
        case BgpConst.BGP_PATH_ATTR.AS4_PATH:
            return 'AS4_PATH';
        case BgpConst.BGP_PATH_ATTR.AS4_AGGREGATOR:
            return 'AS4_AGGREGATOR';
        case BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL:
            return 'PMSI_TUNNEL';
        case BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION:
            return 'TUNNEL_ENCAPSULATION';
        case BgpConst.BGP_PATH_ATTR.PATH_OTC:
            return 'OTC';
        case BgpConst.BGP_PATH_ATTR.PREFIX_SID:
            return 'PREFIX_SID';
        default:
            return `Unknown (${typeCode})`;
    }
}

/**
 * Get origin type from code
 * @param {Number} origin - Origin code
 * @returns {String} Origin name
 */
function getBgpOriginType(origin) {
    switch (origin) {
        case BgpConst.BGP_ORIGIN_TYPE.IGP:
            return 'IGP';
        case BgpConst.BGP_ORIGIN_TYPE.EGP:
            return 'EGP';
        case BgpConst.BGP_ORIGIN_TYPE.INCOMPLETE:
            return 'INCOMPLETE';
        default:
            return `Unknown (${origin})`;
    }
}

/**
 * Get AS_PATH segment type name from code
 * @param {Number} segmentType - AS_PATH segment type code
 * @returns {String} Segment type name
 */
function getBgpAsPathTypeName(segmentType) {
    switch (segmentType) {
        case BgpConst.BGP_AS_PATH_TYPE.AS_SET:
            return 'AS_SET';
        case BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE:
            return 'AS_SEQUENCE';
        case BgpConst.BGP_AS_PATH_TYPE.AS_CONFED_SEQUENCE:
            return 'AS_CONFED_SEQUENCE';
        case BgpConst.BGP_AS_PATH_TYPE.AS_CONFED_SET:
            return 'AS_CONFED_SET';
        default:
            return `Unknown (${segmentType})`;
    }
}

function getBgpAddPathTypeName(type) {
    switch (type) {
        case BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE:
            return 'Send/Receive';
        case BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY:
            return 'Send Only';
        case BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY:
            return 'Receive Only';
        default:
            return `Unknown (${type})`;
    }
}

/**
 * Get readable Error name based on code and subcode
 * @param {Number} errorCode - Error Code
 * @param {Number} errorSubcode - Error Subcode
 * @returns {String} Name of the Error
 */
function getBgpNotificationErrorName(errorCode, errorSubcode) {
    switch (errorCode) {
        case BgpConst.BGP_ERROR_CODE.MESSAGE_HEADER_ERROR:
            switch (errorSubcode) {
                case BgpConst.BGP_ERROR_MESSAGE_HEADER_SUBCODE.CONNECTION_NOT_SYNCHRONIZED:
                    return 'Connection Not Synchronized';
                case BgpConst.BGP_ERROR_MESSAGE_HEADER_SUBCODE.BAD_MESSAGE_LENGTH:
                    return 'Bad Message Length';
                case BgpConst.BGP_ERROR_MESSAGE_HEADER_SUBCODE.BAD_MESSAGE_TYPE:
                    return 'Bad Message Type';
                default:
                    return 'Unknown Message Header Error';
            }
        case BgpConst.BGP_ERROR_CODE.OPEN_MESSAGE_ERROR:
            switch (errorSubcode) {
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNSUPPORTED_VERSION_NUMBER:
                    return 'Unsupported Version Number';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.BAD_PEER_AS:
                    return 'Bad Peer AS';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.BAD_BGP_IDENTIFIER:
                    return 'Bad BGP Identifier';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNSUPPORTED_OPTIONAL_PARAMETER:
                    return 'Unsupported Optional Parameter';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.AUTHENTICATION_FAILURE:
                    return 'Authentication Failure';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNACCEPTABLE_HOLD_TIME:
                    return 'Unacceptable Hold Time';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNSUPPORTED_CAPABILITY:
                    return 'Unsupported Capability';
                case BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.ROLE_MISMATCH:
                    return 'Role Mismatch';
                default:
                    return 'Unknown Open Message Error';
            }
        case BgpConst.BGP_ERROR_CODE.UPDATE_MESSAGE_ERROR:
            switch (errorSubcode) {
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.ATTR_LIST_ERR:
                    return 'Attribute List Error';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.UNKNOWN_ATTR:
                    return 'Unknown Attribute';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.ATTR_MISSING:
                    return 'Attribute Missing';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.ATTR_FLAGS_ERROR:
                    return 'Attribute Flags Error';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.ATTR_LENGTH_ERROR:
                    return 'Attribute Length Error';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.INVALID_ORIGIN_ATTR:
                    return 'Invalid ORIGIN Attribute';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.ATTR_ASLOOP:
                    return 'Attribute AS Loop';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.INVALID_NEXT_HOP_ATTR:
                    return 'Invalid Next Hop Attribute';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.OPTIONAL_ATTR_ERROR:
                    return 'Optional Attribute Error';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.INVALID_NETWORK:
                    return 'Invalid Network';
                case BgpConst.BGP_ERROR_UPDATE_MESSAGE_SUBCODE.MALFORMED_AS_PATH:
                    return 'Malformed AS_PATH';
                default:
                    return 'Unknown Update Message Error';
            }
        case BgpConst.BGP_ERROR_CODE.HOLD_TIMER_EXPIRED:
            return 'Hold Timer Expired';
        case BgpConst.BGP_ERROR_CODE.FSM_ERROR:
            return 'Finite State Machine Error';
        case BgpConst.BGP_ERROR_CODE.CONNECTION_REJECTED:
            switch (errorSubcode) {
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.MAX_PREFIXES:
                    return 'Maximum Number of Prefixes Reached';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.ADMIN_SHUTDOWN:
                    return 'Administrative Shutdown';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.PEER_DE_CONFIGURED:
                    return 'Peer De-configured';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.ADMIN_RESET:
                    return 'Administrative Reset';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.CONNECTION_REJECTED:
                    return 'Connection Rejected';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.CONNECTION_COLLISION_RESOLUTION:
                    return 'Connection Collision Resolution';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.OTHER_CONFIGURATION_CHANGE:
                    return 'Other Configuration Change';
                case BgpConst.BGP_ERROR_CONNECTION_REJECTED_SUBCODE.OUT_OF_RESOURCES:
                    return 'Out of Resources';
                default:
                    return 'Unknown Connection Rejection';
            }
        default:
            return 'Unknown Error';
    }
}

/**
 * 根据地址族和子地址族转为UI的地址组类型
 * @param {BGP_AFI_TYPE} afi 地址族
 * @param {BGP_SAFI_TYPE} safi 子地址族
 */
function getAddrFamilyType(afi, safi) {
    let addrFamily;
    switch (afi) {
        case BgpConst.BGP_AFI_TYPE.AFI_IPV4:
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.VPNV4;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_QP;
            }
            break;
        case BgpConst.BGP_AFI_TYPE.AFI_IPV6:
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_UNC;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.VPNV6;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.IPV6_QP;
            }
            break;
        case BgpConst.BGP_AFI_TYPE.AFI_L2VPN:
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN;
            }
            break;
        case BgpConst.BGP_AFI_TYPE.AFI_BGP_LS:
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.LINK_STATE;
            }
            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN) {
                addrFamily = BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN;
            }
            break;
    }

    return addrFamily;
}

function getAfiAndSafi(addrFamily) {
    let afi;
    let safi;
    addrFamily = parseInt(addrFamily);
    switch (addrFamily) {
        case BgpConst.BGP_ADDR_FAMILY.IPV4_UNC:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_UNC:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
            break;
        case BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN:
            afi = BgpConst.BGP_AFI_TYPE.AFI_L2VPN;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_EVPN;
            break;
        case BgpConst.BGP_ADDR_FAMILY.VPNV4:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_VPN;
            break;
        case BgpConst.BGP_ADDR_FAMILY.VPNV6:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_VPN;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_MVPN;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_MVPN;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV4_QP:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_QP;
            break;
        case BgpConst.BGP_ADDR_FAMILY.IPV6_QP:
            afi = BgpConst.BGP_AFI_TYPE.AFI_IPV6;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_QP;
            break;
        case BgpConst.BGP_ADDR_FAMILY.LINK_STATE:
            afi = BgpConst.BGP_AFI_TYPE.AFI_BGP_LS;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS;
            break;
        case BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN:
            afi = BgpConst.BGP_AFI_TYPE.AFI_BGP_LS;
            safi = BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN;
            break;
    }

    return { afi, safi };
}

module.exports = {
    getBgpPacketTypeName,
    getBgpOpenCapabilityName,
    getBgpAfiName,
    getBgpSafiName,
    getBgpOpenRoleName,
    getBgpPathAttrTypeName,
    getBgpOriginType,
    getBgpAsPathTypeName,
    getBgpNotificationErrorName,
    getAddrFamilyType,
    getAfiAndSafi,
    getBgpAddPathTypeName
};
