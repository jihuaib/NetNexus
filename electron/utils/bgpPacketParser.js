/**
 * BGP Packet Parser
 *
 * Parses BGP protocol packets from raw buffers and returns structured data.
 * Based on RFC 4271 and other BGP extension RFCs.
 */

// Import constants from existing BGP constants file
const BgpConst = require('../const/bgpConst');
const {
    ipv4BufferToString,
    ipv6BufferToString,
    getIpTypeName,
    extCommunitiesBufferToString
} = require('../utils/ipUtils');
const {
    getBgpPacketTypeName,
    getBgpOpenCapabilityName,
    getBgpAfiName,
    getBgpSafiName,
    getBgpOpenRoleName,
    getBgpPathAttrTypeName,
    getBgpOriginType,
    getBgpAsPathTypeName,
    getBgpNotificationErrorName,
    getBgpAddPathTypeName
} = require('../utils/bgpUtils');
const bgpAddressFamily = require('./bgpAddressFamily');

const LABEL_UNICAST_ADD_PATH_INFERRED_WARNING =
    'label-unicast ADD-PATH is inferred from same-AFI unicast capability; Peer Up did not advertise ADD-PATH for label-unicast';
const ADD_PATH_NLRI_LENGTH_COMPAT_WARNING =
    'ADD-PATH parsing context did not match NLRI length; parsed as non-ADD-PATH and ignored Path Identifier';
const STATELESS_ADD_PATH_NLRI_COMPAT_WARNING =
    'BMP Stateless Parsing TLV advertised ADD-PATH but NLRI length fits non-ADD-PATH; parsed without Path Identifier';

function getAddPathWarning(addPathInfo, safi) {
    if (typeof addPathInfo.warning === 'string' && addPathInfo.warning.length > 0) {
        return addPathInfo.warning;
    }

    return addPathInfo.inferred === true && safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        ? LABEL_UNICAST_ADD_PATH_INFERRED_WARNING
        : null;
}

function getAddPathReceiveInfo(context, afi, safi) {
    if (context && typeof context.getAddPathReceiveInfo === 'function') {
        return context.getAddPathReceiveInfo(afi, safi) || {};
    }

    if (context && typeof context.isAddPathReceiveEnabled === 'function') {
        return {
            enabled: context.isAddPathReceiveEnabled(afi, safi)
        };
    }

    return {
        enabled: false
    };
}

function isWeakAddPathInfo(addPathInfo) {
    return addPathInfo?.source === 'bmp-stateless-parsing-tlv' && addPathInfo.fallbackEnabled !== true;
}

function appendUniqueWarning(warnings, warning) {
    if (!warning) {
        return Array.isArray(warnings) ? warnings : [];
    }

    const normalizedWarnings = Array.isArray(warnings) ? [...warnings] : [];
    if (!normalizedWarnings.includes(warning)) {
        normalizedWarnings.push(warning);
    }
    return normalizedWarnings;
}

function withRouteWarning(route, warning) {
    const warnings = appendUniqueWarning(route.warnings, warning);
    return {
        ...route,
        parseWarning: true,
        warnings
    };
}

function withNlriParseWarning(result, warning) {
    return {
        ...result,
        routes: result.routes.map(route => withRouteWarning(route, warning)),
        warnings: appendUniqueWarning(result.warnings, warning),
        compatibilityWarning: warning
    };
}

function chooseNlriParseByLength(parseCandidate, addPathInfo) {
    if (addPathInfo?.enabled !== true) {
        return parseCandidate(false);
    }

    const addPathResult = parseCandidate(true);
    const nonAddPathResult = parseCandidate(false);
    const warning = isWeakAddPathInfo(addPathInfo)
        ? STATELESS_ADD_PATH_NLRI_COMPAT_WARNING
        : ADD_PATH_NLRI_LENGTH_COMPAT_WARNING;

    if (isWeakAddPathInfo(addPathInfo) && nonAddPathResult.valid) {
        return withNlriParseWarning(nonAddPathResult, warning);
    }

    if (addPathResult.valid) {
        return addPathResult;
    }

    if (nonAddPathResult.valid) {
        return withNlriParseWarning(nonAddPathResult, warning);
    }

    return addPathResult;
}

function parseIpv4NlriSequenceCandidate(buffer, startPosition, endPosition, addPathEnabled, routeLabel) {
    let position = startPosition;
    const routes = [];
    const errors = [];
    const warnings = [];
    const maxPrefixLength = BgpConst.IP_HOST_LEN;

    while (position < endPosition) {
        const routeIndex = routes.length + 1;
        let pathId = 0;

        if (addPathEnabled) {
            if (position + 4 > endPosition) {
                errors.push(`${routeLabel} ${routeIndex}: ADD-PATH Path Identifier is truncated`);
                position = endPosition;
                break;
            }
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        if (position >= endPosition) {
            errors.push(`${routeLabel} ${routeIndex}: prefix length is missing`);
            position = endPosition;
            break;
        }

        const prefixLength = buffer[position];
        position += 1;
        const prefixBytes = Math.ceil(prefixLength / 8);
        const routeErrors = [];

        if (prefixLength > maxPrefixLength) {
            routeErrors.push(`prefix length ${prefixLength} exceeds IPv4 maximum ${maxPrefixLength}`);
        }

        if (position + prefixBytes > endPosition) {
            routeErrors.push('prefix is truncated');
        }

        const prefixBuffer = buffer.subarray(position, Math.min(position + prefixBytes, endPosition));
        position = Math.min(position + prefixBytes, endPosition);
        errors.push(...routeErrors.map(error => `${routeLabel} ${routeIndex}: ${error}`));

        routes.push({
            pathId,
            prefix: ipv4BufferToString(prefixBuffer, Math.min(prefixLength, maxPrefixLength)),
            length: prefixLength,
            valid: routeErrors.length === 0,
            errors: routeErrors.length > 0 ? routeErrors : undefined
        });
    }

    return {
        routes,
        errors,
        warnings,
        position,
        valid: errors.length === 0 && position === endPosition
    };
}

function parseIpv4NlriSequence(buffer, startPosition, endPosition, addPathInfo, routeLabel = 'NLRI') {
    return chooseNlriParseByLength(
        addPathEnabled =>
            parseIpv4NlriSequenceCandidate(buffer, startPosition, endPosition, addPathEnabled, routeLabel),
        addPathInfo
    );
}

function parseAddressFamilyNlriSequenceCandidate(
    buffer,
    startPosition,
    endPosition,
    afi,
    safi,
    isWithdrawn,
    addPathEnabled,
    addPathWarning,
    routeLabel
) {
    let position = startPosition;
    const routes = [];
    const errors = [];
    const warnings = [];

    while (position < endPosition) {
        const routeIndex = routes.length + 1;
        let pathId = 0;

        if (addPathEnabled) {
            if (position + 4 > endPosition) {
                errors.push(`${routeLabel} ${routeIndex}: ADD-PATH Path Identifier is truncated`);
                position = endPosition;
                break;
            }
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        if (position >= endPosition) {
            errors.push(`${routeLabel} ${routeIndex}: NLRI is truncated`);
            position = endPosition;
            break;
        }

        const nlriStart = position;
        const parsedNlri = bgpAddressFamily.parseNlriEntry(buffer, position, afi, safi, isWithdrawn);
        if (!parsedNlri || parsedNlri.position <= nlriStart) {
            errors.push(`${routeLabel} ${routeIndex}: parser did not advance`);
            position = endPosition;
            break;
        }

        position = parsedNlri.position;
        if (position > endPosition) {
            errors.push(`${routeLabel} ${routeIndex}: NLRI length exceeds remaining buffer`);
            position = endPosition;
        }

        if (parsedNlri.route.valid === false && Array.isArray(parsedNlri.route.errors)) {
            errors.push(...parsedNlri.route.errors.map(error => `${routeLabel} ${routeIndex}: ${error}`));
        }
        if (Array.isArray(parsedNlri.route.warnings)) {
            warnings.push(...parsedNlri.route.warnings.map(warning => `${routeLabel} ${routeIndex}: ${warning}`));
        }

        let routeWarnings = Array.isArray(parsedNlri.route.warnings) ? [...parsedNlri.route.warnings] : [];
        if (addPathWarning) {
            routeWarnings = appendUniqueWarning(routeWarnings, addPathWarning);
        }

        routes.push({
            pathId,
            ...parsedNlri.route,
            parseWarning: routeWarnings.length > 0,
            warnings: routeWarnings
        });
    }

    return {
        routes,
        errors,
        warnings,
        position,
        valid: errors.length === 0 && position === endPosition
    };
}

function parseAddressFamilyNlriSequence(
    buffer,
    startPosition,
    endPosition,
    afi,
    safi,
    isWithdrawn,
    addPathInfo,
    routeLabel
) {
    const addPathWarning = getAddPathWarning(addPathInfo || {}, safi);
    return chooseNlriParseByLength(
        addPathEnabled =>
            parseAddressFamilyNlriSequenceCandidate(
                buffer,
                startPosition,
                endPosition,
                afi,
                safi,
                isWithdrawn,
                addPathEnabled,
                addPathWarning,
                routeLabel
            ),
        addPathInfo || {}
    );
}

/**
 * Parse a BGP packet from a buffer
 * @param {Buffer} buffer - The raw BGP packet buffer
 * @param {Object} context - Context object (e.g. bgpSession)
 * @returns {Object} Parsed BGP packet data
 */
function parseBgpPacket(buffer, context) {
    try {
        // Check if buffer is valid
        if (!Buffer.isBuffer(buffer) || buffer.length < BgpConst.BGP_HEAD_LEN) {
            return {
                valid: false,
                error: 'Invalid buffer or buffer too small'
            };
        }

        // Check if the BGP marker is valid (16 bytes of 0xFF)
        const marker = buffer.subarray(0, BgpConst.BGP_MARKER_LEN);
        if (!marker.every(byte => byte === 0xff)) {
            return {
                valid: false,
                error: 'Invalid BGP marker'
            };
        }

        // Parse the header
        const length = buffer.readUInt16BE(BgpConst.BGP_MARKER_LEN);
        const type = buffer[BgpConst.BGP_MARKER_LEN + 2];

        // Check if the buffer contains the complete packet
        if (buffer.length < length) {
            return {
                valid: false,
                error: `Incomplete packet: expected ${length} bytes, got ${buffer.length}`
            };
        }

        // Parse the packet based on the message type
        let packet = {
            type,
            length,
            valid: true
        };

        // Add the parsed data based on message type
        switch (type) {
            case BgpConst.BGP_PACKET_TYPE.OPEN:
                packet = { ...packet, ...parseOpenMessage(buffer) };
                break;
            case BgpConst.BGP_PACKET_TYPE.UPDATE:
                packet = { ...packet, ...parseUpdateMessage(buffer, context) };
                break;
            case BgpConst.BGP_PACKET_TYPE.NOTIFICATION:
                // ...
                packet = { ...packet, ...parseNotificationMessage(buffer) };
                break;
            case BgpConst.BGP_PACKET_TYPE.KEEPALIVE:
                // Keepalive has no additional data
                break;
            case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH:
                packet = { ...packet, ...parseRouteRefreshMessage(buffer) };
                break;
            default:
                packet.valid = false;
                packet.error = `Unknown packet type: ${type}`;
        }

        return packet;
    } catch (error) {
        return {
            valid: false,
            error: `Error parsing BGP packet: ${error.message}`
        };
    }
}

/**
 * Parse BGP OPEN message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed OPEN message data
 */
function parseOpenMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const version = buffer[position];
    position += 1;
    const asn = buffer.readUInt16BE(position);
    position += 2;
    const holdTime = buffer.readUInt16BE(position);
    position += 2;
    const routerId = `${buffer[position]}.${buffer[position + 1]}.${buffer[position + 2]}.${buffer[position + 3]}`;
    position += 4;
    const optParamLen = buffer[position];
    position += 1;

    const result = {
        version,
        asn,
        holdTime,
        routerId,
        optParamLen,
        capabilities: []
    };

    // Parse optional parameters (capabilities)
    if (optParamLen > 0) {
        const optParamsEnd = position + optParamLen;

        while (position < optParamsEnd) {
            const paramType = buffer[position];
            const paramLen = buffer[position + 1];
            position += 2;

            // Parameter type 2 is capability
            if (paramType === BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE) {
                let capPosition = position;
                let capPositionEnd = capPosition + paramLen;

                // Parse capability value based on capability code
                while (capPosition < capPositionEnd) {
                    const capCode = buffer[capPosition];
                    const capLen = buffer[capPosition + 1];
                    capPosition += 2;

                    const capability = {
                        code: capCode,
                        length: capLen
                    };

                    let tempPosition = capPosition;
                    switch (capCode) {
                        case BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS: // Multiprotocol Extensions
                            if (capLen >= 4) {
                                const afi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                // 1字节保留字段
                                tempPosition += 1;
                                const safi = buffer[tempPosition];
                                tempPosition += 1;
                                capability.afi = afi;
                                capability.safi = safi;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS: // 4-octet AS number
                            if (capLen >= 4) {
                                capability.as4 = buffer.readUInt32BE(tempPosition);
                                tempPosition += 4;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE: // BGP Role Capability
                            if (capLen >= 1) {
                                capability.role = buffer[tempPosition];
                                tempPosition += 1;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING: // Extended Next Hop Encoding
                            capability.nextHops = [];
                            while (tempPosition + 6 <= capPosition + capLen) {
                                const afi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                const safi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                const ipType = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                capability.nextHops.push({ afi, safi, ipType });
                            }

                            if (capability.nextHops.length > 0) {
                                capability.afi = capability.nextHops[0].afi;
                                capability.safi = capability.nextHops[0].safi;
                                capability.ipType = capability.nextHops[0].ipType;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH: // ADD-PATH
                            capability.addPaths = [];
                            // Capability value contains one or more tuples of (AFI, SAFI, Send/Receive)
                            // Each tuple is 4 bytes: AFI(2) + SAFI(1) + Send/Receive(1)
                            while (tempPosition < capPosition + capLen) {
                                if (tempPosition + 4 <= capPosition + capLen) {
                                    const afi = buffer.readUInt16BE(tempPosition);
                                    tempPosition += 2;
                                    const safi = buffer[tempPosition];
                                    tempPosition += 1;
                                    const sendReceive = buffer[tempPosition];
                                    tempPosition += 1;
                                    capability.addPaths.push({
                                        afi,
                                        safi,
                                        sendReceive
                                    });
                                } else {
                                    break;
                                }
                            }
                            break;
                        // Other capabilities could be added here
                    }
                    result.capabilities.push(capability);
                    capPosition += capLen;
                }
                position += paramLen;
            } else {
                position += paramLen;
            }
        }
    }

    return result;
}

/**
 * Parse BGP UPDATE message
 * @param {Object} context - Context object
 * @returns {Object} Parsed UPDATE message data
 */
function parseUpdateMessage(buffer, context) {
    let position = BgpConst.BGP_HEAD_LEN;
    const withdrawnRoutesLength = buffer.readUInt16BE(position);
    position += 2;

    const addPathInfo = getAddPathReceiveInfo(
        context,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );

    // Parse withdrawn routes
    const withdrawnRoutesEnd = position + withdrawnRoutesLength;
    const parsedWithdrawnRoutes = parseIpv4NlriSequence(
        buffer,
        position,
        Math.min(withdrawnRoutesEnd, buffer.length),
        addPathInfo,
        'Withdrawn route'
    );
    const withdrawnRoutes = parsedWithdrawnRoutes.routes;
    position = withdrawnRoutesEnd;

    // Parse path attributes
    const pathAttributesLength = buffer.readUInt16BE(position);
    position += 2;

    const pathAttributesEnd = position + pathAttributesLength;
    const { pathAttributes, nextPosition } = parsePathAttributes(buffer, position, pathAttributesEnd, context);
    position = nextPosition;
    annotateEvpnPathAttributes(pathAttributes);
    const attributeErrors = [];
    const attributeWarnings = [];
    pathAttributes.forEach(attr => {
        if (attr.valid === false && Array.isArray(attr.errors)) {
            attributeErrors.push(...attr.errors.map(error => `${getBgpPathAttrTypeName(attr.typeCode)}: ${error}`));
        }
        if (Array.isArray(attr.warnings)) {
            attributeWarnings.push(
                ...attr.warnings.map(warning => `${getBgpPathAttrTypeName(attr.typeCode)}: ${warning}`)
            );
        }
    });

    // Parse NLRI
    const parsedNlri = parseIpv4NlriSequence(buffer, position, buffer.length, addPathInfo, 'NLRI');
    const nlri = parsedNlri.routes;
    const routeErrors = [...parsedWithdrawnRoutes.errors, ...parsedNlri.errors];
    const routeWarnings = [...parsedWithdrawnRoutes.warnings, ...parsedNlri.warnings];

    return {
        withdrawnRoutesLength,
        withdrawnRoutes,
        pathAttributesLength,
        pathAttributes,
        nlri,
        valid: attributeErrors.length === 0 && routeErrors.length === 0,
        error: [...attributeErrors, ...routeErrors].join('; '),
        errors: [...attributeErrors, ...routeErrors],
        warnings: [...attributeWarnings, ...routeWarnings]
    };
}

/**
 * Parses BGP path attributes from a buffer
 * @param {Buffer} buffer - Raw buffer
 * @param {number} startPosition - Start position in buffer
 * @param {number} endPosition - End position in buffer
 * @param {Object} context - Context object
 * @returns {Object} { attributes: Array, nextPosition: number }
 */
function parsePathAttributes(buffer, startPosition, endPosition, context) {
    let position = startPosition;
    const pathAttributes = [];
    const asnSize = (context && context.asnSize) || 4;

    while (position < endPosition) {
        if (position + 2 > buffer.length) break;
        const flags = buffer[position];
        const typeCode = buffer[position + 1];
        position += 2;

        const extendedLength = (flags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH) !== 0;
        let attributeLength;

        if (extendedLength) {
            if (position + 2 > buffer.length) break;
            attributeLength = buffer.readUInt16BE(position);
            position += 2;
        } else {
            if (position + 1 > buffer.length) break;
            attributeLength = buffer[position];
            position += 1;
        }

        if (position + attributeLength > buffer.length) break;
        const attributeValue = buffer.subarray(position, position + attributeLength);
        position += attributeLength;

        const attribute = {
            flags,
            typeCode,
            length: attributeLength,
            value: attributeValue
        };

        // Parse specific attribute types
        switch (typeCode) {
            case BgpConst.BGP_PATH_ATTR.ORIGIN: {
                // ORIGIN
                if (attributeValue.length >= 1) attribute.origin = getBgpOriginType(attributeValue[0]);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.AS_PATH: {
                // AS_PATH
                // Heuristic to detect ASN size if not provided
                let effectiveAsnSize = asnSize;
                if (!context || !context.asnSize) {
                    // Check if total length matches 2-byte or 4-byte ASNs
                    // Very simple check: header is 2 bytes (Type, Count).
                    if (attributeValue.length >= 2) {
                        const count = attributeValue[1];
                        if (attributeValue.length === 2 + count * 2) effectiveAsnSize = 2;
                        else if (attributeValue.length === 2 + count * 4) effectiveAsnSize = 4;
                    }
                }
                attribute.segments = parseAsPath(attributeValue, effectiveAsnSize);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.NEXT_HOP: {
                // NEXT_HOP
                if (attributeValue.length === 4) {
                    attribute.nextHop = `${attributeValue[0]}.${attributeValue[1]}.${attributeValue[2]}.${attributeValue[3]}`;
                }
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MED: {
                // MED
                if (attributeValue.length >= 4) attribute.med = attributeValue.readUInt32BE(0);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.LOCAL_PREF: {
                // LOCAL_PREF
                if (attributeValue.length >= 4) attribute.localPref = attributeValue.readUInt32BE(0);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE: {
                // ATOMIC_AGGREGATE
                break;
            }
            case BgpConst.BGP_PATH_ATTR.AGGREGATOR: {
                // AGGREGATOR
                if (attributeValue.length >= 6) {
                    attribute.aggregatorAs = attributeValue.readUInt16BE(0);
                    attribute.aggregatorIp = `${attributeValue[2]}.${attributeValue[3]}.${attributeValue[4]}.${attributeValue[5]}`;
                }
                break;
            }
            case BgpConst.BGP_PATH_ATTR.COMMUNITY: {
                // COMMUNITY
                attribute.communities = parseCommunities(attributeValue);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES: {
                // EXTENDED_COMMUNITIES
                attribute.extCommunities = parseExtCommunities(attributeValue);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL: {
                attribute.pmsiTunnel = parsePmsiTunnelAttribute(attributeValue);
                attribute.valid = attribute.pmsiTunnel.valid;
                attribute.errors = attribute.pmsiTunnel.errors;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION: {
                attribute.tunnelEncapsulation = parseTunnelEncapsulationAttribute(attributeValue);
                attribute.valid = attribute.tunnelEncapsulation.valid;
                attribute.errors = attribute.tunnelEncapsulation.errors;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PREFIX_SID: {
                attribute.prefixSid = parseBgpPrefixSidAttribute(attributeValue);
                attribute.valid = attribute.prefixSid.valid;
                attribute.errors = attribute.prefixSid.errors;
                attribute.warnings = attribute.prefixSid.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI: {
                // MP_REACH_NLRI
                attribute.mpReach = parseMpReachNlri(attributeValue, context);
                attribute.valid = attribute.mpReach.valid;
                attribute.errors = attribute.mpReach.errors;
                attribute.warnings = attribute.mpReach.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI: {
                // MP_UNREACH_NLRI
                attribute.mpUnreach = parseMpUnreachNlri(attributeValue, context);
                attribute.valid = attribute.mpUnreach.valid;
                attribute.errors = attribute.mpUnreach.errors;
                attribute.warnings = attribute.mpUnreach.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PATH_OTC: {
                // OTC
                if (attributeValue.length >= 4) attribute.otc = attributeValue.readUInt32BE(0);
                break;
            }
        }

        pathAttributes.push(attribute);
    }

    return { pathAttributes, nextPosition: position };
}

/**
 * Parse BGP NOTIFICATION message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed NOTIFICATION message data
 */
function parseNotificationMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const errorCode = buffer[position];
    position += 1;
    const errorSubcode = buffer[position];
    position += 1;

    const data = buffer.subarray(position);

    return {
        errorCode,
        errorSubcode,
        data
    };
}

/**
 * Parse BGP ROUTE-REFRESH message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed ROUTE-REFRESH message data
 */
function parseRouteRefreshMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const subType = buffer[position];
    position += 1;
    const safi = buffer[position];

    return {
        afi,
        subType,
        safi
    };
}

/**
 * Parse AS_PATH attribute
 * @param {Buffer} buffer - AS_PATH attribute value
 * @param {number} asnSize - 2 or 4 byte ASNs
 * @returns {Array} Array of AS path segments
 */
function parseAsPath(buffer, asnSize = 4) {
    const segments = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 2 > buffer.length) break;
        const segmentType = buffer[position];
        const segmentLength = buffer[position + 1];
        position += 2;

        const asNumbers = [];
        for (let i = 0; i < segmentLength; i++) {
            if (position + asnSize > buffer.length) break;
            if (asnSize === 4) {
                asNumbers.push(buffer.readUInt32BE(position));
            } else {
                asNumbers.push(buffer.readUInt16BE(position));
            }
            position += asnSize;
        }

        segments.push({
            type: segmentType,
            typeName: getBgpAsPathTypeName(segmentType),
            asNumbers
        });
    }

    return segments;
}

/**
 * Parse COMMUNITIES attribute
 * @param {Buffer} buffer - COMMUNITIES attribute value
 * @returns {Array} Array of community values
 */
function parseCommunities(buffer) {
    const communities = [];

    for (let i = 0; i < buffer.length; i += 4) {
        const value = buffer.readUInt32BE(i);
        const highOrder = (value >> 16) & 0xffff;
        const lowOrder = value & 0xffff;

        communities.push({
            value,
            formatted: `${highOrder}:${lowOrder}`
        });
    }

    return communities;
}

function parseExtCommunities(buffer) {
    const extCommunities = [];

    for (let i = 0; i < buffer.length; i += 8) {
        const subBuffer = buffer.subarray(i, i + 8);
        if (subBuffer.length !== 8) {
            extCommunities.push({
                rawHex: subBuffer.toString('hex'),
                valid: false,
                formatted: `truncated(${subBuffer.toString('hex')})`
            });
            continue;
        }

        const type = subBuffer[0];
        const subType = subBuffer[1];
        const community = {
            type,
            subType,
            rawHex: subBuffer.toString('hex'),
            valueHex: subBuffer.subarray(2).toString('hex'),
            valid: true
        };

        try {
            community.formatted = extCommunitiesBufferToString(subBuffer);
        } catch (error) {
            community.formatted = `unknown(${type}|${subType})`;
            community.error = error.message;
        }

        const isEncapsulation =
            (type === bgpAddressFamily.EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE ||
                type === bgpAddressFamily.EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE) &&
            subType === bgpAddressFamily.EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION;
        if (isEncapsulation) {
            const tunnelType = subBuffer.readUInt16BE(6);
            community.encapsulation = bgpAddressFamily.buildBgpTunnelEncapsulation(tunnelType, 'extended-community');
            community.formatted = `Encapsulation ${community.encapsulation.tunnelTypeName} (${tunnelType})`;
        }

        extCommunities.push(community);
    }

    return extCommunities;
}

function parsePmsiTunnelAttribute(buffer) {
    const errors = [];
    if (buffer.length < 5) {
        errors.push(`PMSI Tunnel attribute is truncated: ${buffer.length} octets`);
        return {
            valid: false,
            errors,
            flags: buffer.length > 0 ? buffer[0] : null,
            tunnelType: buffer.length > 1 ? buffer[1] : null,
            tunnelTypeName: buffer.length > 1 ? bgpAddressFamily.getPmsiTunnelTypeName(buffer[1]) : null,
            label: null,
            labelPresent: false,
            tunnelIdentifierHex: buffer.length > 2 ? buffer.subarray(2).toString('hex') : ''
        };
    }

    const raw24 = (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
    const label = bgpAddressFamily.buildEvpnLabel(raw24);
    return {
        valid: true,
        errors,
        flags: buffer[0],
        tunnelType: buffer[1],
        tunnelTypeName: bgpAddressFamily.getPmsiTunnelTypeName(buffer[1]),
        label,
        labelPresent: raw24 !== 0,
        tunnelIdentifierHex: buffer.subarray(5).toString('hex')
    };
}

function parseTunnelEncapsulationAttribute(buffer) {
    const tlvs = [];
    const errors = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 4 > buffer.length) {
            errors.push(`Tunnel Encapsulation TLV header is truncated at offset ${position}`);
            break;
        }

        const tunnelType = buffer.readUInt16BE(position);
        position += 2;
        const length = buffer.readUInt16BE(position);
        position += 2;
        if (position + length > buffer.length) {
            errors.push(`Tunnel Encapsulation TLV ${tunnelType} length exceeds attribute: ${length}`);
            break;
        }

        const value = buffer.subarray(position, position + length);
        position += length;
        tlvs.push({
            ...bgpAddressFamily.buildBgpTunnelEncapsulation(tunnelType, 'tunnel-encapsulation-attribute'),
            length,
            valueHex: value.toString('hex')
        });
    }

    return {
        tlvs,
        valid: errors.length === 0,
        errors
    };
}

function readUint24BE(buffer, position) {
    return (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
}

function parseBgpPrefixSidLabelIndexTlv(value, errors) {
    if (value.length !== 7) {
        errors.push(`BGP Prefix-SID Label-Index TLV length must be 7 octets: ${value.length}`);
    }

    return {
        reserved: value.length >= 1 ? value[0] : null,
        flags: value.length >= 3 ? value.readUInt16BE(1) : null,
        labelIndex: value.length >= 7 ? value.readUInt32BE(3) : null
    };
}

function parseBgpPrefixSidOriginatorSrgbTlv(value, errors) {
    if (value.length < 8 || (value.length - 2) % 6 !== 0) {
        errors.push(
            `BGP Prefix-SID Originator SRGB TLV length must be 2 + non-zero multiple of 6 octets: ${value.length}`
        );
    }

    const flags = value.length >= 2 ? value.readUInt16BE(0) : null;
    const ranges = [];
    let position = 2;
    while (position + 6 <= value.length) {
        const start = readUint24BE(value, position);
        const range = readUint24BE(value, position + 3);
        ranges.push({
            start,
            range,
            end: range > 0 ? start + range - 1 : start
        });
        position += 6;
    }

    return {
        flags,
        ranges
    };
}

function parseSrv6ServiceDataSubSubTlvs(buffer, errors) {
    const subSubTlvs = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`SRv6 Service Data Sub-Sub-TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`SRv6 Service Data Sub-Sub-TLV ${type} length exceeds parent: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const subSubTlv = {
            type,
            typeName: bgpAddressFamily.getSrv6ServiceDataSubSubTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if (type === 1) {
            if (length !== 6) {
                errors.push(`SRv6 SID Structure Sub-Sub-TLV length must be 6 octets: ${length}`);
            }
            subSubTlv.sidStructure = {
                locatorBlockLength: value.length >= 1 ? value[0] : null,
                locatorNodeLength: value.length >= 2 ? value[1] : null,
                functionLength: value.length >= 3 ? value[2] : null,
                argumentLength: value.length >= 4 ? value[3] : null,
                transpositionLength: value.length >= 5 ? value[4] : null,
                transpositionOffset: value.length >= 6 ? value[5] : null
            };
        }

        subSubTlvs.push(subSubTlv);
        position = valueEnd;
    }

    return subSubTlvs;
}

function parseSrv6SidInformationSubTlv(value, errors) {
    if (value.length < 21) {
        errors.push(`SRv6 SID Information Sub-TLV length must be at least 21 octets: ${value.length}`);
    }

    const sidBuffer = value.length >= 17 ? value.subarray(1, 17) : Buffer.alloc(0);
    const flags = value.length >= 18 ? value[17] : null;
    const endpointBehavior = value.length >= 20 ? value.readUInt16BE(18) : null;
    const reserved2 = value.length >= 21 ? value[20] : null;
    const subSubTlvBuffer = value.length > 21 ? value.subarray(21) : Buffer.alloc(0);
    const subSubTlvs = parseSrv6ServiceDataSubSubTlvs(subSubTlvBuffer, errors);
    const sidStructureSubSubTlv = subSubTlvs.find(subSubTlv => subSubTlv.type === 1 && subSubTlv.sidStructure);

    return {
        reserved: value.length >= 1 ? value[0] : null,
        sid:
            sidBuffer.length === BgpConst.IPV6_HOST_BYTE_LEN
                ? ipv6BufferToString(sidBuffer, BgpConst.IPV6_HOST_LEN)
                : null,
        sidHex: sidBuffer.toString('hex'),
        endpointBehavior,
        endpointBehaviorName:
            endpointBehavior !== null ? bgpAddressFamily.getSrv6EndpointBehaviorName(endpointBehavior) : null,
        reserved2,
        flags,
        subSubTlvs,
        sidStructure: sidStructureSubSubTlv?.sidStructure || null
    };
}

function parseSrv6ServiceSubTlvs(buffer, errors) {
    const subTlvs = [];
    const sidInfos = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`SRv6 Service Sub-TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`SRv6 Service Sub-TLV ${type} length exceeds service TLV: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const subTlv = {
            type,
            typeName: bgpAddressFamily.getSrv6ServiceSubTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if (type === 1) {
            subTlv.sidInformation = parseSrv6SidInformationSubTlv(value, errors);
            sidInfos.push(subTlv.sidInformation);
        }

        subTlvs.push(subTlv);
        position = valueEnd;
    }

    return {
        subTlvs,
        sidInfos
    };
}

function parseBgpPrefixSidSrv6ServiceTlv(type, value, errors) {
    if (value.length < 1) {
        errors.push(`BGP Prefix-SID ${bgpAddressFamily.getBgpPrefixSidTlvTypeName(type)} TLV is truncated`);
    }

    const serviceTlv = {
        serviceType: type === 5 ? 'l3' : type === 6 ? 'l2' : type === 4 ? 'vpn' : 'transport',
        reserved: value.length >= 1 ? value[0] : null,
        subTlvs: [],
        sidInfos: []
    };

    const parsedSubTlvs = parseSrv6ServiceSubTlvs(value.length > 1 ? value.subarray(1) : Buffer.alloc(0), errors);
    serviceTlv.subTlvs = parsedSubTlvs.subTlvs;
    serviceTlv.sidInfos = parsedSubTlvs.sidInfos;
    return serviceTlv;
}

function formatBgpPrefixSid(prefixSid) {
    if (!prefixSid || !Array.isArray(prefixSid.tlvs)) {
        return '';
    }

    const parts = [];
    if (prefixSid.labelIndex?.labelIndex !== null && prefixSid.labelIndex?.labelIndex !== undefined) {
        parts.push(`Label-Index ${prefixSid.labelIndex.labelIndex}`);
    }
    if (prefixSid.originatorSrgb?.ranges?.length > 0) {
        const ranges = prefixSid.originatorSrgb.ranges.map(range => `${range.start}+${range.range}`).join(',');
        parts.push(`SRGB ${ranges}`);
    }
    if (Array.isArray(prefixSid.srv6Services)) {
        prefixSid.srv6Services.forEach(service => {
            service.sidInfos.forEach(sidInfo => {
                const serviceName =
                    service.serviceType === 'l2'
                        ? 'SRv6 L2'
                        : service.serviceType === 'l3'
                          ? 'SRv6 L3'
                          : service.serviceType === 'vpn'
                            ? 'SRv6 VPN'
                            : 'SRv6';
                parts.push(
                    `${serviceName} ${sidInfo.sid || sidInfo.sidHex} ${sidInfo.endpointBehaviorName || ''}`.trim()
                );
            });
        });
    }
    if (parts.length === 0 && prefixSid.tlvs.length > 0) {
        parts.push(prefixSid.tlvs.map(tlv => `${tlv.typeName}(${tlv.length})`).join(', '));
    }

    return parts.join(', ');
}

function parseBgpPrefixSidAttribute(buffer) {
    const tlvs = [];
    const errors = [];
    const warnings = [];
    const seenRecognizedTypes = new Set();
    let labelIndex = null;
    let originatorSrgb = null;
    const srv6Services = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`BGP Prefix-SID TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`BGP Prefix-SID TLV ${type} length exceeds attribute: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const tlv = {
            type,
            typeName: bgpAddressFamily.getBgpPrefixSidTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if ((type === 1 || type === 3) && seenRecognizedTypes.has(type)) {
            warnings.push(`Duplicate BGP Prefix-SID ${tlv.typeName} TLV ignored`);
            tlv.ignored = true;
            tlvs.push(tlv);
            position = valueEnd;
            continue;
        }

        switch (type) {
            case 1:
                tlv.labelIndex = parseBgpPrefixSidLabelIndexTlv(value, errors);
                labelIndex = tlv.labelIndex;
                seenRecognizedTypes.add(type);
                break;
            case 3:
                tlv.originatorSrgb = parseBgpPrefixSidOriginatorSrgbTlv(value, errors);
                originatorSrgb = tlv.originatorSrgb;
                seenRecognizedTypes.add(type);
                break;
            case 4:
            case 5:
            case 6:
            case 7:
                tlv.srv6Service = parseBgpPrefixSidSrv6ServiceTlv(type, value, errors);
                srv6Services.push(tlv.srv6Service);
                break;
            default:
                break;
        }

        tlvs.push(tlv);
        position = valueEnd;
    }

    const prefixSid = {
        tlvs,
        labelIndex,
        originatorSrgb,
        srv6Services,
        valid: errors.length === 0,
        errors,
        warnings
    };
    prefixSid.formatted = formatBgpPrefixSid(prefixSid);

    return prefixSid;
}

function buildEvpnEncapsulationSummary(pathAttributes) {
    const encapsulations = [];

    pathAttributes.forEach(attr => {
        if (Array.isArray(attr.extCommunities)) {
            attr.extCommunities.forEach(community => {
                if (community.encapsulation) {
                    encapsulations.push(community.encapsulation);
                }
            });
        }

        if (Array.isArray(attr.tunnelEncapsulation?.tlvs)) {
            encapsulations.push(...attr.tunnelEncapsulation.tlvs);
        }
    });

    if (encapsulations.length === 0) {
        return null;
    }

    const uniqueByTunnelType = new Map();
    encapsulations.forEach(encapsulation => {
        uniqueByTunnelType.set(encapsulation.tunnelType, encapsulation);
    });
    const uniqueEncapsulations = Array.from(uniqueByTunnelType.values());
    const hasVni = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'vni');
    const hasMpls = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'mpls');
    const hasUnknown = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'unknown');
    const labelType =
        hasVni && !hasMpls && !hasUnknown ? 'vni' : hasMpls && !hasVni && !hasUnknown ? 'mpls' : 'unknown';

    return {
        labelType,
        isVni: labelType === 'vni',
        isMpls: labelType === 'mpls',
        tunnelType: uniqueEncapsulations.length === 1 ? uniqueEncapsulations[0].tunnelType : null,
        tunnelTypeName: uniqueEncapsulations.length === 1 ? uniqueEncapsulations[0].tunnelTypeName : null,
        tunnelTypes: uniqueEncapsulations.map(encapsulation => encapsulation.tunnelType),
        tunnelTypeNames: uniqueEncapsulations.map(encapsulation => encapsulation.tunnelTypeName),
        encapsulations: uniqueEncapsulations
    };
}

function annotatePmsiTunnel(pmsiTunnel, encapsulation) {
    if (!pmsiTunnel) {
        return null;
    }

    const annotated = {
        ...pmsiTunnel,
        label: bgpAddressFamily.annotateEvpnLabel(pmsiTunnel.label, encapsulation)
    };
    annotated.labels = annotated.labelPresent && annotated.label ? [annotated.label] : [];
    return annotated;
}

function annotateEvpnRoute(route, encapsulation, pmsiTunnel) {
    if (!route || route.routeType === undefined) {
        return;
    }

    if (encapsulation) {
        route.encapsulation = encapsulation;
        route.encapsulationType = encapsulation.labelType;
    }

    if (pmsiTunnel && route.routeType === 3) {
        route.pmsiTunnel = annotatePmsiTunnel(pmsiTunnel, encapsulation);
        if ((!Array.isArray(route.labels) || route.labels.length === 0) && route.pmsiTunnel.labels.length > 0) {
            route.labels = route.pmsiTunnel.labels;
        }
    }

    if (Array.isArray(route.labels)) {
        route.labels = route.labels.map(label => bgpAddressFamily.annotateEvpnLabel(label, encapsulation));
    }
}

function annotateEvpnNlriList(nlriList, afi, safi, encapsulation, pmsiTunnel) {
    if (afi !== BgpConst.BGP_AFI_TYPE.AFI_L2VPN || safi !== BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
        return;
    }

    nlriList.forEach(route => annotateEvpnRoute(route, encapsulation, pmsiTunnel));
}

function annotateEvpnPathAttributes(pathAttributes) {
    const encapsulation = buildEvpnEncapsulationSummary(pathAttributes);
    let pmsiTunnel = null;

    pathAttributes.forEach(attr => {
        if (attr.pmsiTunnel) {
            attr.pmsiTunnel = annotatePmsiTunnel(attr.pmsiTunnel, encapsulation);
            pmsiTunnel = attr.pmsiTunnel;
        }
    });

    pathAttributes.forEach(attr => {
        if (attr.mpReach) {
            annotateEvpnNlriList(attr.mpReach.nlri, attr.mpReach.afi, attr.mpReach.safi, encapsulation, pmsiTunnel);
        }
        if (attr.mpUnreach) {
            annotateEvpnNlriList(
                attr.mpUnreach.withdrawnRoutes,
                attr.mpUnreach.afi,
                attr.mpUnreach.safi,
                encapsulation,
                pmsiTunnel
            );
        }
    });
}

/**
 * Parse MP_REACH_NLRI attribute
 * @param {Buffer} buffer - MP_REACH_NLRI attribute value
 * @param {Object} context - Context object
 * @returns {Object} Parsed MP_REACH_NLRI data
 */
function parseMpReachNlri(buffer, context) {
    let position = 0;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const safi = buffer[position];
    position += 1;
    const nextHopLength = buffer[position];
    position += 1;

    const nextHop = bgpAddressFamily.parseNextHop(buffer, position, nextHopLength, afi, safi);

    position += nextHopLength;

    // Skip the reserved byte
    position += 1;

    const parsedNlri = parseAddressFamilyNlriSequence(
        buffer,
        position,
        buffer.length,
        afi,
        safi,
        false,
        getAddPathReceiveInfo(context, afi, safi),
        'NLRI'
    );

    return {
        afi,
        safi,
        nextHopLength,
        nextHop,
        nlri: parsedNlri.routes,
        valid: parsedNlri.errors.length === 0,
        errors: parsedNlri.errors,
        warnings: parsedNlri.warnings
    };
}

/**
 * Parse MP_UNREACH_NLRI attribute
 * @param {Buffer} buffer - MP_UNREACH_NLRI attribute value
 * @param {Object} context - Context object
 * @returns {Object} Parsed MP_UNREACH_NLRI data
 */
function parseMpUnreachNlri(buffer, context) {
    let position = 0;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const safi = buffer[position];
    position += 1;

    const parsedWithdrawnRoutes = parseAddressFamilyNlriSequence(
        buffer,
        position,
        buffer.length,
        afi,
        safi,
        true,
        getAddPathReceiveInfo(context, afi, safi),
        'Withdrawn NLRI'
    );

    return {
        afi,
        safi,
        withdrawnRoutes: parsedWithdrawnRoutes.routes,
        valid: parsedWithdrawnRoutes.errors.length === 0,
        errors: parsedWithdrawnRoutes.errors,
        warnings: parsedWithdrawnRoutes.warnings
    };
}

/**
 * Helper function to get a human-readable summary of a BGP packet
 * @param {Object} parsedPacket - The parsed BGP packet object
 * @returns {String} Human-readable summary
 */
function isVariableLengthSummaryNlri(afi, safi) {
    return (
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN ||
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC ||
        (afi === BgpConst.BGP_AFI_TYPE.AFI_BGP_LS &&
            (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS || safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN))
    );
}

function getBgpSummaryRouteLength(route, afi, safi) {
    if (isVariableLengthSummaryNlri(afi, safi)) {
        if (route.nlriLength !== undefined && route.nlriLength !== null) {
            return route.nlriLength;
        }
        if (typeof route.rawNlri === 'string') {
            return Math.ceil(route.rawNlri.length / 2);
        }
    }

    return route.length;
}

function formatBgpSummaryRoute(route, afi, safi, indent, includePathId = true) {
    if (route.dqpn !== undefined) {
        return `${indent}- DIP:${route.prefix}/${route.length}, DQPN:=${route.dqpn}/${route.dqpnBits}`;
    }

    const pathId = includePathId && route.pathId !== undefined ? `${route.pathId} ` : '';
    return `${indent}- ${pathId}${route.prefix}/${getBgpSummaryRouteLength(route, afi, safi)}`;
}

function getBgpPacketSummary(parsedPacket) {
    if (!parsedPacket || !parsedPacket.valid) {
        return `Invalid BGP packet: ${parsedPacket?.error || 'Unknown error'}`;
    }

    const typeName = getBgpPacketTypeName(parsedPacket.type);
    let summary = `BGP ${typeName} Message (${parsedPacket.length} bytes)`;

    switch (parsedPacket.type) {
        case BgpConst.BGP_PACKET_TYPE.OPEN: // OPEN
            summary += `\nVersion: ${parsedPacket.version}`;
            summary += `\nAS: ${parsedPacket.asn}`;
            summary += `\nHold Time: ${parsedPacket.holdTime} seconds`;
            summary += `\nRouter ID: ${parsedPacket.routerId}`;

            if (parsedPacket.capabilities && parsedPacket.capabilities.length > 0) {
                summary += '\nCapabilities:';
                parsedPacket.capabilities.forEach(cap => {
                    const capName = getBgpOpenCapabilityName(cap.code);
                    summary += `\n  - ${capName}`;

                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        // Multiprotocol
                        const afiName = getBgpAfiName(cap.afi);
                        const safiName = getBgpSafiName(cap.safi);
                        summary += ` (${afiName}/${safiName})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS) {
                        // 4-octet AS
                        summary += ` (AS${cap.as4})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE) {
                        // BGP Role
                        const roleName = getBgpOpenRoleName(cap.role);
                        summary += ` (${roleName})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING) {
                        // Extended Next Hop Encoding
                        if (cap.nextHops && cap.nextHops.length > 0) {
                            cap.nextHops.forEach(nextHop => {
                                const afiName = getBgpAfiName(nextHop.afi);
                                const safiName = getBgpSafiName(nextHop.safi);
                                const ipTypeName = getIpTypeName(nextHop.ipType);
                                summary += `\n    - ${afiName}/${safiName}/${ipTypeName}`;
                            });
                        } else {
                            const afiName = getBgpAfiName(cap.afi);
                            const safiName = getBgpSafiName(cap.safi);
                            const ipTypeName = getIpTypeName(cap.ipType);
                            summary += ` (${afiName}/${safiName}/${ipTypeName})`;
                        }
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        // ADD-PATH
                        if (cap.addPaths && cap.addPaths.length > 0) {
                            cap.addPaths.forEach(path => {
                                const afiName = getBgpAfiName(path.afi);
                                const safiName = getBgpSafiName(path.safi);
                                const direction = getBgpAddPathTypeName(path.sendReceive);
                                summary += `\n    - ${afiName}/${safiName}: ${direction}`;
                            });
                        }
                    }
                });
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.UPDATE: // UPDATE
            if (parsedPacket.withdrawnRoutes && parsedPacket.withdrawnRoutes.length > 0) {
                summary += '\nWithdrawn Routes:';
                parsedPacket.withdrawnRoutes.forEach(route => {
                    summary += `\n${formatBgpSummaryRoute(route, null, null, '  ', false)}`;
                });
            }

            if (parsedPacket.pathAttributes && parsedPacket.pathAttributes.length > 0) {
                summary += '\nPath Attributes:';
                parsedPacket.pathAttributes.forEach(attr => {
                    const attrName = getBgpPathAttrTypeName(attr.typeCode);
                    summary += `\n  - ${attrName}`;

                    if (attr.typeCode === BgpConst.BGP_PATH_ATTR.ORIGIN) {
                        summary += `: ${attr.origin}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.AS_PATH) {
                        if (attr.segments) {
                            summary += ': ';
                            attr.segments.forEach(seg => {
                                if (seg.typeName === 'AS_SEQUENCE') {
                                    summary += seg.asNumbers.join(' ');
                                } else {
                                    summary += `{${seg.asNumbers.join(' ')}}`;
                                }
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.NEXT_HOP) {
                        summary += `: ${attr.nextHop}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.LOCAL_PREF) {
                        summary += `: ${attr.localPref}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.COMMUNITY) {
                        if (attr.communities) {
                            summary += `: ${attr.communities.map(c => c.formatted).join(' ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES) {
                        if (attr.extCommunities) {
                            summary += `: ${attr.extCommunities.map(c => c.formatted).join(' ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL) {
                        if (attr.pmsiTunnel) {
                            summary += `: ${attr.pmsiTunnel.tunnelTypeName}`;
                            if (attr.pmsiTunnel.labelPresent && attr.pmsiTunnel.label) {
                                summary += ` ${attr.pmsiTunnel.label.display}`;
                            }
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION) {
                        if (attr.tunnelEncapsulation) {
                            summary += `: ${attr.tunnelEncapsulation.tlvs.map(tlv => tlv.tunnelTypeName).join(', ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID) {
                        if (attr.prefixSid?.formatted) {
                            summary += `: ${attr.prefixSid.formatted}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MED) {
                        summary += `: ${attr.med}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpReach.afi);
                        const safiName = getBgpSafiName(attr.mpReach.safi);
                        summary += `\n    - (${afiName}/${safiName}: ${attr.mpReach.nextHop})`;
                        if (attr.mpReach.nlri && attr.mpReach.nlri.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpReach.nlri.forEach(route => {
                                summary += `\n${formatBgpSummaryRoute(route, attr.mpReach.afi, attr.mpReach.safi, '      ')}`;
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpUnreach.afi);
                        const safiName = getBgpSafiName(attr.mpUnreach.safi);
                        summary += `\n    - (${afiName}/${safiName})`;
                        if (attr.mpUnreach.withdrawnRoutes && attr.mpUnreach.withdrawnRoutes.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpUnreach.withdrawnRoutes.forEach(route => {
                                summary += `\n${formatBgpSummaryRoute(
                                    route,
                                    attr.mpUnreach.afi,
                                    attr.mpUnreach.safi,
                                    '      '
                                )}`;
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PATH_OTC) {
                        summary += `: ${attr.otc}`;
                    }
                });
            }

            if (parsedPacket.nlri && parsedPacket.nlri.length > 0) {
                summary += '\nRoutes:';
                parsedPacket.nlri.forEach(route => {
                    summary += `\n${formatBgpSummaryRoute(route, null, null, '  ')}`;
                });
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.NOTIFICATION: // NOTIFICATION
            {
                const errorName = getBgpNotificationErrorName(parsedPacket.errorCode, parsedPacket.errorSubcode);
                summary += `\nError: ${errorName}`;
                summary += `\nError Code: ${parsedPacket.errorCode}`;
                summary += `\nError Subcode: ${parsedPacket.errorSubcode}`;
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.KEEPALIVE: // KEEPALIVE
            // No additional information for keepalive
            break;

        case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH: // ROUTE-REFRESH
            {
                const afiName = getBgpAfiName(parsedPacket.afi);
                const safiName = getBgpSafiName(parsedPacket.safi);
                summary += `\nAddress Family: ${afiName}`;
                summary += `\nSubsequent Address Family: ${safiName}`;
            }
            break;
    }

    return summary;
}

module.exports = {
    parseBgpPacket,
    getBgpPacketSummary,
    parsePathAttributes
};
