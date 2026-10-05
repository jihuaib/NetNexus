const ipaddr = require('ipaddr.js');
const BgpConst = require('../../../const/bgpConst');
const { rdStringToBytes } = require('../bgpEncoding');
const { writeUInt32 } = require('../../ipUtils');
const { isEvpnPerEs } = require('../../../../shared/bgpEvpnSrv6');

const MAX_UINT32 = 0xffffffff;
const MAX_VNI = 0xffffff;
const ZERO_ESI = '00:00:00:00:00:00:00:00:00:00';

function integer(value, min, max, name, fallback) {
    if (value === undefined || value === null || value === '') value = fallback;
    const number = Number(value);
    if (value === undefined || !Number.isSafeInteger(number) || number < min || number > max)
        throw new Error(`${name}范围为 ${min} ~ ${max}`);
    return number;
}

function normalizeRd(value) {
    const parts = String(value ?? '0:0')
        .trim()
        .split(':');
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new Error('RD格式应为 ASN:数值或IPv4:数值');
    let administrator;
    if (parts[0].includes('.')) {
        administrator = address(parts[0], 'RD', 'ipv4').toString();
        return `${administrator}:${integer(parts[1], 0, 0xffff, 'RD数值')}`;
    }
    if (!/^\d+$/.test(parts[0])) throw new Error('RD格式应为 ASN:数值或IPv4:数值');
    administrator = integer(parts[0], 0, MAX_UINT32, 'RD ASN');
    return `${administrator}:${integer(parts[1], 0, administrator <= 0xffff ? MAX_UINT32 : 0xffff, 'RD数值')}`;
}

function address(value, name, kind) {
    try {
        const parsed = ipaddr.parse(String(value ?? '').trim());
        if (kind && parsed.kind() !== kind) throw new Error('Address family mismatch');
        return parsed;
    } catch (_error) {
        throw new Error(`${name}请输入有效的${kind === 'ipv4' ? 'IPv4' : kind === 'ipv6' ? 'IPv6' : 'IP'}地址`);
    }
}

function normalizePrefix(ip, mask, kind) {
    const parsed = address(ip, '路由前缀', kind);
    const bits = parsed.kind() === 'ipv4' ? 32 : 128;
    const prefixLength = integer(mask, 0, bits, '路由前缀长度');
    const type = bits === 32 ? ipaddr.IPv4 : ipaddr.IPv6;
    return { ip: type.networkAddressFromCIDR(`${parsed}/${prefixLength}`).toString(), mask: prefixLength };
}

function hexOctets(value, bytes, name, fallback) {
    const text = String(value ?? fallback ?? '').trim();
    const compact = text.replace(/[:-]/g, '');
    if (!new RegExp(`^[\\da-f]{${bytes * 2}}$`, 'i').test(compact))
        throw new Error(`${name}必须为${bytes}字节十六进制`);
    return compact.toLowerCase().match(/../g).join(':');
}

function normalizeVpnRoute(input, afi) {
    if (![BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_AFI_TYPE.AFI_IPV6].includes(Number(afi)))
        throw new Error('VPN地址族无效');
    return {
        ...normalizePrefix(input.ip ?? input.prefix, input.mask, Number(afi) === 1 ? 'ipv4' : 'ipv6'),
        rd: normalizeRd(input.rd),
        label: integer(input.label ?? input.labelStart, 0, BgpConst.BGP_MPLS_LABEL_MAX, 'MPLS Label', 16),
        pathId: integer(input.pathId, 0, MAX_UINT32, 'Path ID', 0)
    };
}

function normalizeEvpnRoute(input) {
    const routeType = integer(input.routeType, 1, 5, 'EVPN路由类型');
    const encapsulationType = input.encapsulationType ?? 'mpls';
    if (!['mpls', 'vxlan', 'srv6'].includes(encapsulationType)) throw new Error('EVPN封装仅支持MPLS、VXLAN或SRv6');
    const route = { routeType, rd: normalizeRd(input.rd), encapsulationType };
    if ([1, 2, 4, 5].includes(routeType)) route.esi = hexOctets(input.esi, 10, 'ESI', ZERO_ESI);
    if ([1, 2, 3, 5].includes(routeType))
        route.ethernetTagId = integer(input.ethernetTagId ?? input.ethernetTag, 0, MAX_UINT32, 'Ethernet Tag ID', 0);
    if ([1, 2, 3, 5].includes(routeType)) {
        if (encapsulationType === 'vxlan') {
            route.vni = integer(input.vni, 0, MAX_VNI, 'VNI', 1000);
            if (routeType === 2 && input.vni2 !== undefined && input.vni2 !== null && input.vni2 !== '')
                route.vni2 = integer(input.vni2, 0, MAX_VNI, 'VNI 2');
        } else if (encapsulationType !== 'srv6' || routeType !== 3) {
            route.label = integer(input.label ?? input.labelStart, 0, BgpConst.BGP_MPLS_LABEL_MAX, 'MPLS Label', 16);
            if (routeType === 2 && input.label2 !== undefined && input.label2 !== null && input.label2 !== '')
                route.label2 = integer(input.label2, 0, BgpConst.BGP_MPLS_LABEL_MAX, 'MPLS Label 2');
        }
    }
    if (routeType === 2) {
        route.macAddress = hexOctets(input.macAddress ?? input.mac, 6, 'MAC');
        const ip = input.ipAddress ?? input.ip;
        route.ipAddress = ip === undefined || ip === null || ip === '' ? '' : address(ip, 'IP Address').toString();
    }
    if ([3, 4].includes(routeType))
        route.originatingRouterIp = address(input.originatingRouterIp, 'Originating Router IP').toString();
    if (routeType === 4) {
        if (!route.rd.split(':')[0].includes('.')) throw new Error('EVPN Type 4的RD必须为IPv4:数值（Type 1）');
        if (route.esi === ZERO_ESI) throw new Error('EVPN Type 4的ESI不能为零');
        const esiType = Number.parseInt(route.esi.slice(0, 2), 16);
        const esImport =
            input.esImportRt || ([1, 2, 3].includes(esiType) ? route.esi.split(':').slice(1, 7).join(':') : '');
        if (esImport) route.esImportRt = hexOctets(esImport, 6, 'ES-Import RT');
    }
    if (isEvpnPerEs(route)) {
        if (!route.rd.split(':')[0].includes('.')) throw new Error('EVPN Type 1 per-ES的RD必须为IPv4:数值');
        if (Number(route.rd.split(':')[1]) === 0) throw new Error('EVPN Type 1 per-ES的RD数值不能为0');
        if (route.esi === ZERO_ESI) throw new Error('EVPN Type 1 per-ES的ESI不能为零');
        if ((route.label ?? route.vni) !== 0) throw new Error('EVPN Type 1 per-ES的NLRI Label必须为0');
    }
    if (routeType === 5) {
        Object.assign(
            route,
            normalizePrefix(input.ip ?? input.prefix ?? input.ipPrefix, input.mask ?? input.prefixLength)
        );
        const kind = address(route.ip, 'IP Prefix').kind();
        route.gatewayIp = address(
            input.gatewayIp || (kind === 'ipv4' ? '0.0.0.0' : '::'),
            'Gateway IP',
            kind
        ).toString();
        if (
            route.esi !== ZERO_ESI &&
            address(route.gatewayIp, 'Gateway IP')
                .toByteArray()
                .some(byte => byte !== 0)
        )
            throw new Error('EVPN Type 5的ESI和Gateway IP不能同时非零');
    }
    if (input.pathId !== undefined) route.pathId = integer(input.pathId, 0, MAX_UINT32, 'Path ID', 0);
    return route;
}

function makeVpnRouteKey(input, afi) {
    const route = normalizeVpnRoute({ ...input, label: 16 }, afi);
    return [route.rd, route.pathId, route.ip, route.mask].join('|');
}

function makeEvpnRouteKey(input) {
    const route = normalizeEvpnRoute({
        ...input,
        encapsulationType: 'mpls',
        label: isEvpnPerEs(input) ? 0 : 16,
        label2: undefined,
        esi: [2, 5].includes(Number(input.routeType)) ? ZERO_ESI : input.esi,
        gatewayIp: '',
        esImportRt: '',
        vni: isEvpnPerEs(input) ? 0 : 1000,
        vni2: undefined
    });
    const keys = {
        1: ['esi', 'ethernetTagId'],
        2: ['ethernetTagId', 'macAddress', 'ipAddress'],
        3: ['ethernetTagId', 'originatingRouterIp'],
        4: ['esi', 'originatingRouterIp'],
        5: ['ethernetTagId', 'ip', 'mask']
    };
    return [route.routeType, route.rd, route.pathId ?? 0, ...keys[route.routeType].map(key => route[key])].join('|');
}

function uint24(value) {
    return Buffer.from([(value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function encodeVpnNlri(input, afi, options = {}) {
    const route = normalizeVpnRoute(input, afi);
    const prefix = Buffer.from(address(route.ip, 'VPN Prefix').toByteArray()).subarray(0, Math.ceil(route.mask / 8));
    // RFC 8277: withdrawals carry a compatibility field rather than the advertised label.
    const label = options.withdraw ? Buffer.from([0x80, 0, 0]) : uint24(route.label * 16 + 1);
    return Buffer.concat([
        ...(options.includePathId ? [Buffer.from(writeUInt32(route.pathId))] : []),
        Buffer.from([24 + 64 + route.mask]),
        label,
        rdStringToBytes(route.rd),
        prefix
    ]);
}

function encodeEvpnNlri(input, options = {}) {
    const route = normalizeEvpnRoute(input);
    const parts = [rdStringToBytes(route.rd)];
    if ([1, 2, 4, 5].includes(route.routeType)) parts.push(Buffer.from(route.esi.replace(/:/g, ''), 'hex'));
    if ([1, 2, 3, 5].includes(route.routeType)) parts.push(Buffer.from(writeUInt32(route.ethernetTagId)));
    const ipBytes = value => Buffer.from(address(value, 'EVPN IP').toByteArray());
    if (route.routeType === 2) {
        parts.push(Buffer.from([48]), Buffer.from(route.macAddress.replace(/:/g, ''), 'hex'));
        const ip = route.ipAddress ? ipBytes(route.ipAddress) : Buffer.alloc(0);
        parts.push(Buffer.from([ip.length * 8]), ip);
    }
    if ([3, 4].includes(route.routeType)) {
        const ip = ipBytes(route.originatingRouterIp);
        parts.push(Buffer.from([ip.length * 8]), ip);
    }
    if (route.routeType === 5) parts.push(Buffer.from([route.mask]), ipBytes(route.ip), ipBytes(route.gatewayIp));
    if ([1, 2, 5].includes(route.routeType)) {
        // EVPN fields are independent label values, not a VPN label stack; VXLAN consumes all 24 bits.
        parts.push(uint24(route.encapsulationType === 'vxlan' ? route.vni : route.label * 16));
        const second = route.encapsulationType === 'vxlan' ? route.vni2 : route.label2;
        if (second !== undefined) parts.push(uint24(route.encapsulationType === 'vxlan' ? second : second * 16));
    }
    const value = Buffer.concat(parts);
    return Buffer.concat([
        ...(options.includePathId ? [Buffer.from(writeUInt32(route.pathId ?? 0))] : []),
        Buffer.from([route.routeType, value.length]),
        value
    ]);
}

function encodeVpnNextHop(value, afi) {
    const parsed = address(value, 'VPN MP Next Hop');
    const ip =
        Number(afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV6 && parsed.kind() === 'ipv4'
            ? parsed.toIPv4MappedAddress()
            : parsed;
    return Buffer.concat([Buffer.alloc(BgpConst.BGP_RD_LEN), Buffer.from(ip.toByteArray())]);
}

function generationCount(config) {
    return integer(
        Array.isArray(config.routes) ? config.routes.length : config.count,
        1,
        Number.MAX_SAFE_INTEGER,
        '路由数量',
        1
    );
}

function assertGeneratedPathId(route) {
    if ((route.pathId ?? 0) !== 0) throw new Error('VPN/EVPN地址族尚不支持ADD-PATH，Path ID必须为0');
}

function ipSeries(ip, mask, count, rawStep = 1) {
    const parsed = address(ip, '路由IP');
    const bits = parsed.kind() === 'ipv4' ? 32 : 128;
    const step = integer(rawStep, 1, Number.MAX_SAFE_INTEGER, 'IP步长', 1);
    const prefix = normalizePrefix(ip, mask, parsed.kind());
    const start = address(prefix.ip, '路由IP')
        .toByteArray()
        .reduce((value, byte) => value * 256n + BigInt(byte), 0n);
    const stride = (1n << BigInt(bits - prefix.mask)) * BigInt(step);
    if (start + BigInt(count - 1) * stride >= 1n << BigInt(bits)) throw new Error('IP连续生成超出地址范围');
    return index => {
        let value = start + BigInt(index) * stride;
        const bytes = Array(bits / 8).fill(0);
        for (let byte = bytes.length - 1; byte >= 0; byte -= 1) {
            bytes[byte] = Number(value & 255n);
            value >>= 8n;
        }
        return ipaddr.fromByteArray(bytes).toString();
    };
}

function* iterateVpnRouteInputs(config) {
    const afi = Number(config.addressFamily) === BgpConst.BGP_ADDR_FAMILY.VPNV6 ? 2 : 1;
    const count = generationCount(config);
    if (Array.isArray(config.routes)) {
        // Validate every explicit candidate before yielding any routes to a caller.
        config.routes.forEach(route => assertGeneratedPathId(normalizeVpnRoute({ ...config, ...route }, afi)));
        for (const input of config.routes) yield normalizeVpnRoute({ ...config, ...input }, afi);
        return;
    }
    const base = {
        ...normalizePrefix(config.ip ?? config.prefix, config.mask, afi === 1 ? 'ipv4' : 'ipv6'),
        pathId: integer(config.pathId, 0, MAX_UINT32, 'Path ID', 0)
    };
    assertGeneratedPathId(base);
    const ipAt = ipSeries(base.ip, base.mask, count, config.ipStep);
    for (let index = 0; index < count; index += 1) yield { ...base, ip: ipAt(index) };
}

function* iterateEvpnRouteInputs(config) {
    const count = generationCount(config);
    // The required RD rule is resolved per route; a Type 1 placeholder lets Type 4
    // validate its other fields before that generated RD is applied.
    const prepare = input => {
        const combined = { ...config, ...input };
        if (config.nlriRules?.some(rule => rule.type === 'rd'))
            combined.rd = isEvpnPerEs(combined)
                ? '192.0.2.1:1'
                : Number(combined.routeType) === 4
                  ? '192.0.2.1:0'
                  : '0:0';
        if (isEvpnPerEs(combined) && config.nlriRules?.length) {
            combined.label = 0;
            combined.vni = 0;
        }
        return normalizeEvpnRoute(combined);
    };
    if (Array.isArray(config.routes)) {
        config.routes.forEach(route => assertGeneratedPathId(prepare(route)));
        for (const input of config.routes) yield prepare(input);
        return;
    }
    const base = prepare({});
    assertGeneratedPathId(base);
    let at;
    if (base.routeType === 1) {
        const step = isEvpnPerEs(base)
            ? 0
            : integer(config.ethernetTagStep, 1, Number.MAX_SAFE_INTEGER, 'Ethernet Tag步长', 1);
        if (BigInt(base.ethernetTagId) + BigInt(count - 1) * BigInt(step) > BigInt(MAX_UINT32))
            throw new Error('Ethernet Tag递增超出uint32范围');
        at = index => ({ ethernetTagId: base.ethernetTagId + index * step });
    } else if (base.routeType === 2) {
        const start = BigInt(`0x${base.macAddress.replace(/:/g, '')}`);
        const step = integer(config.macStep, 1, Number.MAX_SAFE_INTEGER, 'MAC步长', 1);
        if (start + BigInt(count - 1) * BigInt(step) >= 1n << 48n) throw new Error('MAC连续生成超出48bit范围');
        const ipAt = base.ipAddress
            ? ipSeries(
                  base.ipAddress,
                  address(base.ipAddress, 'IP Address').kind() === 'ipv4' ? 32 : 128,
                  count,
                  config.ipStep
              )
            : null;
        at = index => ({
            macAddress: (start + BigInt(index) * BigInt(step)).toString(16).padStart(12, '0').match(/../g).join(':'),
            ipAddress: ipAt ? ipAt(index) : ''
        });
    } else if ([3, 4].includes(base.routeType)) {
        const ipAt = ipSeries(
            base.originatingRouterIp,
            address(base.originatingRouterIp, 'Originating Router IP').kind() === 'ipv4' ? 32 : 128,
            count,
            config.ipStep
        );
        at = index => ({ originatingRouterIp: ipAt(index) });
    } else {
        const ipAt = ipSeries(base.ip, base.mask, count, config.ipStep);
        at = index => ({ ip: ipAt(index) });
    }
    for (let index = 0; index < count; index += 1) yield { ...base, ...at(index) };
}

function forEachVpnGeneratedRoute(config, callback) {
    let count = 0;
    for (const route of iterateVpnRouteInputs(config)) callback(route, count++);
    return count;
}

function forEachEvpnGeneratedRoute(config, callback) {
    let count = 0;
    for (const route of iterateEvpnRouteInputs(config)) callback(route, count++);
    return count;
}

function applyGeneratedEvpnNlri(input, generated = {}) {
    const route = { ...input };
    for (const field of ['rd', 'label', 'label2', 'vni', 'vni2'])
        if (generated[field] !== undefined) route[field] = generated[field];
    const services = generated.attr?.srv6Services || [];
    if (route.encapsulationType === 'srv6') {
        const l2 = services.find(service => service.serviceType === 'l2');
        const l3 = services.find(service => service.serviceType === 'l3');
        if (Number(route.routeType) === 4 && services.length) throw new Error('EVPN Type 4不携带SRv6 Service SID');
        if (isEvpnPerEs(route)) {
            if (!l2 || l3) throw new Error('EVPN Type 1 per-ES需要L2 Service SID');
            route.label = 0;
        } else if ([1, 2, 3].includes(Number(route.routeType))) {
            if (!l2) throw new Error('EVPN SRv6路由需要L2 Service SID');
            if (l3 && Number(route.routeType) !== 2) throw new Error('当前EVPN路由类型不支持L3 Service SID');
            if (l3 && !route.ipAddress) throw new Error('EVPN Type 2的L3 Service SID需要IP Address');
            // RFC 9252: a complete SID uses Implicit NULL in the corresponding
            // EVPN label field. EVPN encodes labels without a VPN BOS bit.
            if (Number(route.routeType) !== 3) route.label = 3;
            if (l3) route.label2 = 3;
            else delete route.label2;
        } else if (Number(route.routeType) === 5) {
            if (!l3 || l2) throw new Error('EVPN Type 5需要L3 Service SID');
            route.label = 3;
        }
    } else if (services.length) throw new Error('SRv6 Service SID仅适用于SRv6封装');
    return normalizeEvpnRoute(route);
}

module.exports = {
    normalizeVpnRoute,
    normalizeEvpnRoute,
    makeVpnRouteKey,
    makeEvpnRouteKey,
    encodeVpnNlri,
    encodeEvpnNlri,
    encodeVpnNextHop,
    iterateVpnRouteInputs,
    iterateEvpnRouteInputs,
    forEachVpnGeneratedRoute,
    forEachEvpnGeneratedRoute,
    applyGeneratedEvpnNlri
};
