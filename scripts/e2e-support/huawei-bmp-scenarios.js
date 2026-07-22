const BgpConst = require('../../electron/const/bgpConst');

const ALL_ADJ_RIB_TYPES = Object.freeze([1, 2, 4, 5]);
const TEST_VRF = 'NETNEXUS_E2E';
const EVPN_VRF = 'NETNEXUS_EVPN';

const SCENARIO_DEVICE_PROFILES = Object.freeze([
    Object.freeze({
        index: 0,
        asn: 65001,
        peerAsn: 65002,
        routerId: '198.18.0.1',
        peerRouterId: '198.18.0.2',
        publicLocalIpv4: '11.1.1.1',
        publicPeerIpv4: '11.1.1.2',
        secondaryLocalIpv4: '12.1.1.1',
        secondaryPeerIpv4: '12.1.1.2',
        publicPeerIpv6: '11::2',
        privateIpv4: '172.31.12.1',
        privatePeerIpv4: '172.31.12.2',
        privateIpv6: '2001:db8:12::1',
        privatePeerIpv6: '2001:db8:12::2',
        routeIpv4: '198.18.101.0',
        routeIpv6: '2001:db8:1101::',
        labeledRoute: '198.19.101.0',
        privateRouteIpv4: '10.201.1.0',
        privateRouteIpv6: '2001:db8:201::',
        vpnRdIpv4: '65001:100',
        vpnRdIpv6: '65001:106',
        evpnRd: '65001:170',
        evpnRoute: '10.171.1.0',
        isisNet: '49.0001.0000.0000.0001.00',
        med: 101,
        localPreference: 201,
        community: '65001:101'
    }),
    Object.freeze({
        index: 1,
        asn: 65002,
        peerAsn: 65001,
        routerId: '198.18.0.2',
        peerRouterId: '198.18.0.1',
        publicLocalIpv4: '11.1.1.2',
        publicPeerIpv4: '11.1.1.1',
        secondaryLocalIpv4: '12.1.1.2',
        secondaryPeerIpv4: '12.1.1.1',
        publicPeerIpv6: '11::1',
        privateIpv4: '172.31.12.2',
        privatePeerIpv4: '172.31.12.1',
        privateIpv6: '2001:db8:12::2',
        privatePeerIpv6: '2001:db8:12::1',
        routeIpv4: '198.18.102.0',
        routeIpv6: '2001:db8:1102::',
        labeledRoute: '198.19.102.0',
        privateRouteIpv4: '10.202.2.0',
        privateRouteIpv6: '2001:db8:202::',
        vpnRdIpv4: '65002:100',
        vpnRdIpv6: '65002:106',
        evpnRd: '65002:170',
        evpnRoute: '10.172.2.0',
        isisNet: '49.0001.0000.0000.0002.00',
        med: 102,
        localPreference: 202,
        community: '65002:102'
    })
]);

function routeModes(family, { locRib = true } = {}) {
    const commands = [
        `route-mode ${family} adj-rib-in pre-policy`,
        `route-mode ${family} adj-rib-in post-policy`,
        `route-mode ${family} adj-rib-out pre-policy`,
        `route-mode ${family} adj-rib-out post-policy`
    ];
    if (locRib) commands.push(`route-mode ${family} local-rib all`);
    return commands;
}

function bmpSessionCommands({ host, collectorHost, collectorPort, publicFamilies = [], vpnFamilies = [] }) {
    const commands = [
        'bmp',
        'statistics-timer 15',
        `bmp-session ${collectorHost}`,
        'bmp-version 4',
        `connect-interface ${host}`,
        `tcp connect port ${collectorPort}`
    ];
    if (publicFamilies.length) {
        commands.push('monitor public');
        publicFamilies.forEach(family => commands.push(...routeModes(family)));
        commands.push('quit');
    }
    if (vpnFamilies.length) {
        commands.push(`monitor vpn-instance ${TEST_VRF}`);
        vpnFamilies.forEach(family => commands.push(...routeModes(family, { locRib: false })));
        commands.push('quit');
    }
    commands.push('quit', 'quit');
    return commands;
}

function publicPolicyCommands(profile) {
    const exportPolicy = `NETNEXUS_E2E_EXPORT_${profile.index + 1}`;
    const importPolicy = `NETNEXUS_E2E_IMPORT_${profile.index + 1}`;
    return {
        exportPolicy,
        importPolicy,
        commands: [
            `route-policy ${exportPolicy} permit node 10`,
            `apply cost ${profile.med}`,
            `apply community ${profile.community} additive`,
            'quit',
            `route-policy ${importPolicy} permit node 10`,
            `apply cost ${profile.med + 100}`,
            `apply local-preference ${profile.localPreference + 100}`,
            `apply community ${profile.asn}:201 additive`,
            'quit'
        ]
    };
}

function buildPublicCommands(profile, context) {
    const policies = publicPolicyCommands(profile);
    return [
        'system-view',
        `ip route-static ${profile.routeIpv4} 255.255.255.0 NULL0`,
        `ipv6 route-static ${profile.routeIpv6} 64 NULL0`,
        ...policies.commands,
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        `peer ${profile.publicPeerIpv6} as-number ${profile.peerAsn}`,
        'ipv4-family unicast',
        `network ${profile.routeIpv4} 255.255.255.0 route-policy ${policies.exportPolicy}`,
        `peer ${profile.publicPeerIpv4} enable`,
        `peer ${profile.publicPeerIpv4} keep-all-routes`,
        `peer ${profile.publicPeerIpv4} route-policy ${policies.importPolicy} import`,
        'quit',
        'ipv6-family unicast',
        `network ${profile.routeIpv6} 64 route-policy ${policies.exportPolicy}`,
        `peer ${profile.publicPeerIpv6} enable`,
        `peer ${profile.publicPeerIpv6} keep-all-routes`,
        `peer ${profile.publicPeerIpv6} route-policy ${policies.importPolicy} import`,
        'quit',
        'quit',
        ...bmpSessionCommands({
            host: context.host,
            collectorHost: context.collectorHost,
            collectorPort: context.collectorPort,
            publicFamilies: ['ipv4-family unicast', 'ipv6-family unicast']
        })
    ];
}

function buildLabeledCommands(profile, context) {
    return [
        'system-view',
        `ip route-static ${profile.labeledRoute} 255.255.255.0 NULL0`,
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        'ipv4-family labeled-unicast',
        'apply-label per-path',
        `network ${profile.labeledRoute} 255.255.255.0`,
        `peer ${profile.publicPeerIpv4} enable`,
        'quit',
        'quit',
        ...bmpSessionCommands({
            host: context.host,
            collectorHost: context.collectorHost,
            collectorPort: context.collectorPort,
            publicFamilies: ['ipv4-family labeled-unicast']
        })
    ];
}

function vpnInstanceCommands(profile) {
    return [
        `ip vpn-instance ${TEST_VRF}`,
        'ipv4-family',
        `route-distinguisher ${profile.vpnRdIpv4}`,
        'vpn-target 65000:100 both',
        'quit',
        'ipv6-family',
        `route-distinguisher ${profile.vpnRdIpv6}`,
        'vpn-target 65000:106 both',
        'quit',
        'quit',
        'interface GigabitEthernet0/7/2',
        `description ${TEST_VRF}`,
        `ip binding vpn-instance ${TEST_VRF}`,
        `ip address ${profile.privateIpv4} 255.255.255.0`,
        'ipv6 enable',
        `ipv6 address ${profile.privateIpv6}/64`,
        'quit',
        `ip route-static vpn-instance ${TEST_VRF} ${profile.privateRouteIpv4} 255.255.255.0 NULL0`,
        `ipv6 route-static vpn-instance ${TEST_VRF} ${profile.privateRouteIpv6} 64 NULL0`
    ];
}

function buildVpnCommands(profile, context) {
    return [
        'system-view',
        ...vpnInstanceCommands(profile),
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        'ipv4-family vpnv4',
        `peer ${profile.publicPeerIpv4} enable`,
        `peer ${profile.publicPeerIpv4} keep-all-routes`,
        'quit',
        'ipv6-family vpnv6',
        `peer ${profile.publicPeerIpv4} enable`,
        `peer ${profile.publicPeerIpv4} keep-all-routes`,
        'quit',
        `ipv4-family vpn-instance ${TEST_VRF}`,
        `peer ${profile.privatePeerIpv4} as-number ${profile.peerAsn}`,
        `peer ${profile.privatePeerIpv4} keep-all-routes`,
        `network ${profile.privateRouteIpv4} 255.255.255.0`,
        'quit',
        `ipv6-family vpn-instance ${TEST_VRF}`,
        `peer ${profile.privatePeerIpv6} as-number ${profile.peerAsn}`,
        `peer ${profile.privatePeerIpv6} keep-all-routes`,
        `network ${profile.privateRouteIpv6} 64`,
        'quit',
        'quit',
        ...bmpSessionCommands({
            host: context.host,
            collectorHost: context.collectorHost,
            collectorPort: context.collectorPort,
            publicFamilies: ['ipv4-family vpnv4', 'ipv6-family vpnv6'],
            vpnFamilies: ['ipv4-family unicast', 'ipv6-family unicast']
        })
    ];
}

function buildEvpnCommands(profile, context, { encapsulation = 'mpls' } = {}) {
    const isVxlan = encapsulation === 'vxlan';
    const transportCommands = isVxlan
        ? [
              'interface LoopBack100',
              'description NETNEXUS_E2E_VXLAN',
              `ip address ${profile.routerId} 255.255.255.255`,
              'quit',
              `ip route-static ${profile.peerRouterId} 255.255.255.255 ${profile.publicPeerIpv4}`,
              `evpn source-address ${profile.publicLocalIpv4}`,
              'interface Nve1',
              `source ${profile.routerId}`,
              'quit'
          ]
        : [`mpls lsr-id ${profile.publicLocalIpv4}`, 'mpls', 'quit', 'interface GigabitEthernet0/7/1', 'mpls', 'quit'];
    const vpnEncapsulationCommands = isVxlan ? [`vxlan vni ${17000 + profile.index}`] : [];
    const peerEncapsulationCommands = isVxlan ? [`peer ${profile.publicPeerIpv4} advertise encap-type vxlan`] : [];
    return [
        'system-view',
        ...transportCommands,
        `ip vpn-instance ${EVPN_VRF}`,
        'ipv4-family',
        `route-distinguisher ${profile.evpnRd}`,
        'apply-label per-instance',
        'vpn-target 65000:170 both',
        'vpn-target 65000:170 evpn',
        ...(isVxlan ? [] : ['evpn mpls routing-enable']),
        'quit',
        ...vpnEncapsulationCommands,
        'quit',
        `ip route-static vpn-instance ${EVPN_VRF} ${profile.evpnRoute} 255.255.255.0 NULL0`,
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        'l2vpn-family evpn',
        `peer ${profile.publicPeerIpv4} enable`,
        `peer ${profile.publicPeerIpv4} advertise-community`,
        ...peerEncapsulationCommands,
        `peer ${profile.publicPeerIpv4} keep-all-routes`,
        'quit',
        `ipv4-family vpn-instance ${EVPN_VRF}`,
        'advertise l2vpn evpn',
        `network ${profile.evpnRoute} 255.255.255.0`,
        'quit',
        'quit',
        ...bmpSessionCommands({
            host: context.host,
            collectorHost: context.collectorHost,
            collectorPort: context.collectorPort,
            publicFamilies: ['l2vpn-family evpn']
        })
    ];
}

function buildEvpnMplsCommands(profile, context) {
    return buildEvpnCommands(profile, context, { encapsulation: 'mpls' });
}

function buildEvpnVxlanCommands(profile, context) {
    return buildEvpnCommands(profile, context, { encapsulation: 'vxlan' });
}

function buildBgpLsCommands(profile, context) {
    return [
        'system-view',
        'isis 100',
        'is-level level-2',
        `network-entity ${profile.isisNet}`,
        'bgp-ls enable',
        'quit',
        'interface GigabitEthernet0/7/1',
        'isis enable 100',
        'quit',
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        'link-state-family unicast',
        `domain as ${profile.asn}`,
        `domain identifier ${profile.routerId}`,
        'local-route link-identifiers standard-compatible',
        `peer ${profile.publicPeerIpv4} enable`,
        `peer ${profile.publicPeerIpv4} keep-all-routes`,
        'quit',
        'quit',
        ...bmpSessionCommands({
            host: context.host,
            collectorHost: context.collectorHost,
            collectorPort: context.collectorPort,
            publicFamilies: ['link-state-family unicast']
        })
    ];
}

const HUAWEI_BMP_SCENARIOS = Object.freeze([
    Object.freeze({
        key: 'public-unicast',
        name: 'Public IPv4/IPv6 all RIB stages',
        buildCommands: buildPublicCommands,
        families: Object.freeze([
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, locRib: true, prePolicy: true }),
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC, locRib: true, prePolicy: true })
        ]),
        expectedPrefixes: Object.freeze(['198.18.101.0', '198.18.102.0', '2001:db8:1101::', '2001:db8:1102::'])
    }),
    Object.freeze({
        key: 'ipv4-labeled',
        name: 'IPv4 Labeled-Unicast all supported RIB stages',
        buildCommands: buildLabeledCommands,
        families: Object.freeze([
            Object.freeze({
                af: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
                locRib: true,
                prePolicy: false,
                limitation: 'Huawei IPv4 labeled-unicast view does not support peer keep-all-routes'
            })
        ]),
        expectedPrefixes: Object.freeze(['198.19.101.0', '198.19.102.0'])
    }),
    Object.freeze({
        key: 'vpn-and-private',
        name: 'GE0/7/2 private IPv4/IPv6 and VPNv4/VPNv6',
        buildCommands: buildVpnCommands,
        families: Object.freeze([
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, locRib: false, prePolicy: true, vrf: TEST_VRF }),
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC, locRib: false, prePolicy: true, vrf: TEST_VRF }),
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.VPNV4, locRib: true, prePolicy: true }),
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.VPNV6, locRib: true, prePolicy: true })
        ]),
        expectedPrefixes: Object.freeze(['10.201.1.0', '10.202.2.0', '2001:db8:201::', '2001:db8:202::'])
    }),
    Object.freeze({
        key: 'evpn',
        name: 'L2VPN EVPN over MPLS all RIB stages',
        encapsulation: 'mpls',
        buildCommands: buildEvpnMplsCommands,
        families: Object.freeze([
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN, locRib: true, prePolicy: true })
        ]),
        expectedPrefixes: Object.freeze(['10.171.1.0', '10.172.2.0'])
    }),
    Object.freeze({
        key: 'evpn-vxlan',
        name: 'L2VPN EVPN over VXLAN all RIB stages',
        encapsulation: 'vxlan',
        buildCommands: buildEvpnVxlanCommands,
        families: Object.freeze([
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN, locRib: true, prePolicy: true })
        ]),
        expectedPrefixes: Object.freeze(['10.171.1.0', '10.172.2.0'])
    }),
    Object.freeze({
        key: 'bgp-ls',
        name: 'BGP Link-State all RIB stages',
        buildCommands: buildBgpLsCommands,
        families: Object.freeze([
            Object.freeze({ af: BgpConst.BGP_ADDR_FAMILY.LINK_STATE, locRib: true, prePolicy: true })
        ]),
        expectedPrefixes: Object.freeze([])
    })
]);

function getScenario(key) {
    const scenario = HUAWEI_BMP_SCENARIOS.find(item => item.key === key);
    if (!scenario) throw new Error(`Unknown Huawei BMP scenario: ${key}`);
    return scenario;
}

module.exports = {
    ALL_ADJ_RIB_TYPES,
    EVPN_VRF,
    HUAWEI_BMP_SCENARIOS,
    SCENARIO_DEVICE_PROFILES,
    TEST_VRF,
    bmpSessionCommands,
    getScenario,
    routeModes
};
