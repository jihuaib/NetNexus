const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../ipUtils');
const { readBigEndianValue, getBit, setBit, parseFlowSpecLength, formatIpAddressList } = require('./common');

function parseFlowSpecNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

const FLOW_SPEC_COMPONENT_NAMES = {
    1: 'dst',
    2: 'src',
    3: 'proto',
    4: 'port',
    5: 'dst-port',
    6: 'src-port',
    7: 'icmp-type',
    8: 'icmp-code',
    9: 'tcp-flags',
    10: 'packet-length',
    11: 'dscp',
    12: 'fragment',
    13: 'flow-label'
};

function getFlowSpecOperatorValueLength(operator) {
    return 1 << ((operator & 0x30) >> 4);
}

function getFlowSpecOperatorName(operator, isBitmask) {
    const names = [];
    if (operator & 0x40) {
        names.push('and');
    }

    if (isBitmask) {
        const operation = operator & 0x01 ? 'match' : 'any';
        names.push(operator & 0x02 ? `not ${operation}` : operation);
    } else {
        const comparisonNames = {
            0: 'false',
            1: '=',
            2: '>',
            3: '>=',
            4: '<',
            5: '<=',
            6: '!=',
            7: 'true'
        };
        names.push(comparisonNames[operator & 0x07]);
    }

    return names.length > 0 ? names.join(' ') : '=';
}

function buildIpv6PrefixFromPattern(prefixBuffer, prefixLength, prefixOffset) {
    const fullPrefixBuffer = Buffer.alloc(BgpConst.IPV6_HOST_BYTE_LEN);
    const carriedBits = Math.max(prefixLength - prefixOffset, 0);

    for (let bitIndex = 0; bitIndex < carriedBits; bitIndex++) {
        setBit(fullPrefixBuffer, prefixOffset + bitIndex, getBit(prefixBuffer, bitIndex));
    }

    return ipv6BufferToString(fullPrefixBuffer, prefixLength);
}

function isFlowSpecComponentTypeAllowed(type, afi) {
    if (type < 1 || type > 13) {
        return false;
    }

    return afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 || type !== 13;
}

function validateFlowSpecOperationLength(type, valueLength) {
    if (type === 9 && valueLength > 2) {
        return 'FlowSpec TCP flags bitmask must be encoded as 1 or 2 octets';
    }

    if (type === 11 && valueLength !== 1) {
        return 'FlowSpec DSCP value must be encoded as 1 octet';
    }

    if (type === 12 && valueLength !== 1) {
        return 'FlowSpec fragment bitmask must be encoded as 1 octet';
    }

    return null;
}

function parseFlowSpecPrefixComponent(buffer, position, type, afi) {
    const errors = [];
    const isIpv6 = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6;
    if (position >= buffer.length) {
        return {
            position: buffer.length,
            component: {
                type,
                name: FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`,
                prefix: '',
                length: 0,
                offset: 0,
                formatted: `${FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`}=truncated`
            },
            errors: ['FlowSpec prefix component length is truncated']
        };
    }

    const prefixLength = buffer[position];
    position += 1;

    let prefixOffset = 0;
    if (isIpv6) {
        if (position >= buffer.length) {
            return {
                position: buffer.length,
                component: {
                    type,
                    name: FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`,
                    prefix: '',
                    length: prefixLength,
                    offset: 0,
                    formatted: `${FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`}=truncated`
                },
                errors: ['IPv6 FlowSpec prefix offset is truncated']
            };
        }
        prefixOffset = buffer[position];
        position += 1;
    }

    if (isIpv6) {
        const isMatchAny = prefixLength === 0 && prefixOffset === 0;
        if (!isMatchAny && !(prefixOffset < prefixLength && prefixLength < 129)) {
            errors.push(`Invalid IPv6 FlowSpec prefix length/offset: length=${prefixLength}, offset=${prefixOffset}`);
        }
    } else if (prefixLength > BgpConst.IP_HOST_LEN) {
        errors.push(`Invalid IPv4 FlowSpec prefix length: ${prefixLength}`);
    }

    const carriedBits = Math.max(prefixLength - prefixOffset, 0);
    const prefixBytes = Math.ceil(carriedBits / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('FlowSpec prefix component is truncated');
    }
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    let prefix;
    if (isIpv6) {
        prefix = buildIpv6PrefixFromPattern(prefixBuffer, prefixLength, prefixOffset);
    } else {
        prefix = ipv4BufferToString(prefixBuffer, prefixLength);
    }

    const name = FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`;
    const offsetText = prefixOffset > 0 ? ` offset ${prefixOffset}` : '';
    return {
        position,
        component: {
            type,
            name,
            prefix,
            length: prefixLength,
            offset: prefixOffset,
            formatted: `${name}=${prefix}/${prefixLength}${offsetText}`
        },
        errors
    };
}

function parseFlowSpecComponents(buffer, afi) {
    const components = [];
    const errors = [];
    let position = 0;
    let lastType = 0;

    while (position < buffer.length) {
        const type = buffer[position];
        position += 1;

        if (!FLOW_SPEC_COMPONENT_NAMES[type] || !isFlowSpecComponentTypeAllowed(type, afi)) {
            errors.push(`Unknown FlowSpec component type: ${type}`);
            components.push({
                type,
                name: `unknown-${type}`,
                rawValue: buffer.subarray(position).toString('hex'),
                formatted: `unknown-${type}=0x${buffer.subarray(position).toString('hex')}`
            });
            position = buffer.length;
            break;
        }

        if (type <= lastType) {
            errors.push(`FlowSpec component type ${type} is not in strict increasing order`);
        }
        lastType = type;

        if (type === 1 || type === 2) {
            const parsed = parseFlowSpecPrefixComponent(buffer, position, type, afi);
            components.push(parsed.component);
            errors.push(...parsed.errors);
            position = parsed.position;
            continue;
        }

        const operations = [];
        const isBitmask = type === 9 || type === 12;
        let endOfList = false;
        while (position < buffer.length && !endOfList) {
            const operator = buffer[position];
            position += 1;

            const valueLength = getFlowSpecOperatorValueLength(operator);
            if (operations.length === 0 && (operator & 0x40) !== 0) {
                errors.push(`FlowSpec component type ${type} first operator has AND bit set`);
            }
            const lengthError = validateFlowSpecOperationLength(type, valueLength);
            if (lengthError) {
                errors.push(lengthError);
            }
            if (position + valueLength > buffer.length) {
                errors.push(`FlowSpec component type ${type} operator value is truncated`);
                position = buffer.length;
                break;
            }
            const value = readBigEndianValue(buffer, position, valueLength);
            position += valueLength;
            endOfList = (operator & 0x80) !== 0;

            operations.push({
                operator,
                operatorName: getFlowSpecOperatorName(operator, isBitmask),
                value
            });
        }

        if (!endOfList) {
            errors.push(`FlowSpec component type ${type} operator list does not contain end-of-list`);
        }

        const name = FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`;
        components.push({
            type,
            name,
            operations,
            formatted: `${name} ${operations.map(op => `${op.operatorName} ${op.value}`).join(' ')}`
        });
    }

    return { components, errors };
}

function parseFlowSpecNlri(buffer, position, afi) {
    const { nlriLength, lengthBytes, errors: lengthErrors } = parseFlowSpecLength(buffer, position);
    position += lengthBytes;

    const errors = [...lengthErrors];
    if (lengthBytes === 0) {
        position = buffer.length;
    }

    if (nlriLength === 0) {
        errors.push('FlowSpec NLRI value must contain at least one component');
    }

    if (position + nlriLength > buffer.length) {
        errors.push('FlowSpec NLRI length exceeds remaining buffer');
    }

    const nlriEnd = Math.min(position + nlriLength, buffer.length);
    const nlriBuffer = buffer.subarray(position, nlriEnd);
    const parsedComponents = parseFlowSpecComponents(nlriBuffer, afi);
    const components = parsedComponents.components;
    errors.push(...parsedComponents.errors);
    position = nlriEnd;

    const formatted = components.length > 0 ? components.map(component => component.formatted).join('; ') : 'flowspec';
    return {
        position,
        route: {
            prefix: formatted,
            rd: null,
            length: nlriLength,
            nlriLength,
            components,
            rawNlri: nlriBuffer.toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

module.exports = {
    parseFlowSpecLength,
    parseFlowSpecComponents,
    parseFlowSpecNlri,
    parseFlowSpecNextHop
};
