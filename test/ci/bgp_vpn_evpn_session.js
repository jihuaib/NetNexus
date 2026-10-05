const assert = require('node:assert/strict');
const net = require('net');
const { once } = require('events');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpSession = require('../../electron/worker/bgp/bgpSession');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const families = BgpConst.BGP_ADDR_FAMILY;
const newFamilies = [families.VPNV4, families.VPNV6, families.L2VPN_EVPN];

function message(type, body = Buffer.alloc(0)) {
    const header = Buffer.alloc(19, 0xff);
    header.writeUInt16BE(19 + body.length, 16);
    header[18] = type;
    return Buffer.concat([header, body]);
}

// Encode the remote OPEN independently from BgpSession's builder.
function remoteOpen(remoteFamilies, extendedNextHops = [[1, 128, 2]]) {
    const capabilityTuples = { [families.VPNV4]: [0, 1, 0, 128], [families.VPNV6]: [0, 2, 0, 128] };
    capabilityTuples[families.L2VPN_EVPN] = [0, 25, 0, 70];
    const parametersBytes = remoteFamilies.flatMap(family => [2, 6, 1, 4, ...capabilityTuples[family]]);
    if (extendedNextHops.length) {
        const tuples = extendedNextHops.flatMap(([afi, safi, nextHopAfi]) => [
            afi >>> 8,
            afi & 255,
            safi >>> 8,
            safi & 255,
            nextHopAfi >>> 8,
            nextHopAfi & 255
        ]);
        parametersBytes.push(2, tuples.length + 2, 5, tuples.length, ...tuples);
    }
    const parameters = Buffer.from(parametersBytes);
    return message(1, Buffer.concat([Buffer.from([4, 0xfd, 0xe9, 0, 0, 192, 0, 2, 1, parameters.length]), parameters]));
}

async function waitFor(predicate, description) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function handshake(host, remoteFamilies) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore();
    const events = [];
    const replies = [];
    worker.routeStore = store;
    worker.bgpConfigData = { localAs: 65000, routerId: '192.0.2.254' };
    worker.messageHandler.sendSuccessResponse = (id, data) => replies.push({ id, data });
    worker.messageHandler.sendErrorResponse = (_id, error) => {
        throw new Error(error);
    };
    worker.messageHandler.sendEvent = (_type, event) => events.push(event.data);
    for (const family of newFamilies) {
        const { afi, safi } = getAfiAndSafi(family);
        const instance = new BgpInstance(0, afi, safi, store);
        worker.bgpInstanceMap.set(instance.instanceKey, instance);
    }
    const openCaps = [
        BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
        BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING
    ];
    if (net.isIP(host) === 4) {
        worker.configIpv4Peer('configure', {
            peerIp: host,
            peerAs: 65001,
            holdTime: 0,
            addressFamily: newFamilies,
            openCap: openCaps
        });
    } else {
        worker.configIpv6Peer('configure', {
            peerIpv6: host,
            peerIpv6As: 65001,
            holdTimeIpv6: 0,
            addressFamilyIpv6: newFamilies,
            openCapIpv6: openCaps
        });
    }
    const session = worker.bgpSessionMap.get(BgpSession.makeKey(0, host));
    let accepted;
    let client;
    let connectionError;
    const server = net.createServer(socket => {
        accepted = socket;
        socket.on('data', data => session.recvMsg(data));
        socket.on('close', () => session.handleSocketClosed(socket));
        socket.on('error', error => {
            connectionError = error;
        });
        session.tcpConnectSuccess(socket);
    });
    const received = [];
    let buffer = Buffer.alloc(0);
    try {
        server.listen({ port: 0, host, ipv6Only: net.isIP(host) === 6 });
        await once(server, 'listening');
        client = net.connect({ host, port: server.address().port });
        client.on('error', error => {
            connectionError = error;
        });
        client.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            while (buffer.length >= 19 && buffer.length >= buffer.readUInt16BE(16)) {
                const length = buffer.readUInt16BE(16);
                const packet = parseBgpPacket(buffer.subarray(0, length));
                assert.ok(packet.valid, packet.error);
                received.push(packet);
                buffer = buffer.subarray(length);
            }
        });
        await once(client, 'connect');
        const open = remoteOpen(remoteFamilies);
        client.write(open.subarray(0, 7));
        await new Promise(resolve => setImmediate(resolve));
        client.write(Buffer.concat([open.subarray(7), message(4)]));
        await waitFor(
            () =>
                session.sessState === BgpConst.BGP_PEER_STATE.ESTABLISHED && received.some(packet => packet.type === 4),
            `BGP handshake on ${host}`
        );
        assert.equal(connectionError, undefined);
        const localOpen = received.find(packet => packet.type === 1);
        assert.ok(localOpen, 'TCP peer must receive a valid OPEN');
        assert.deepEqual(
            localOpen.capabilities
                .filter(cap => cap.code === 1)
                .map(cap => [cap.afi, cap.safi])
                .sort(),
            [
                [1, 128],
                [2, 128],
                [25, 70]
            ].sort()
        );
        const extendedNextHop = localOpen.capabilities.find(cap => cap.code === 5);
        assert.ok(extendedNextHop.nextHops.some(tuple => tuple.afi === 1 && tuple.safi === 128 && tuple.ipType === 2));
        assert.equal(session.isExtendedNextHopEnabled(1, 128, 2), true);
        assert.equal(session.isExtendedNextHopEnabled(1, 1, 2), false);
        worker.getPeerInfo('peers');
        const peerLists = replies.find(reply => reply.id === 'peers').data;
        for (const family of newFamilies) {
            const expectedState = remoteFamilies.includes(family) ? 'Established' : 'No Neg';
            assert.equal(peerLists[family].length, 1);
            assert.equal(peerLists[family][0].peerIp, host);
            assert.equal(peerLists[family][0].peerState, expectedState);
            assert.ok(events.some(event => event.addressFamily === family && event.peerState === expectedState));
        }
        const routeConfigs = [
            {
                addressFamily: families.VPNV4,
                prefix: '198.51.100.0',
                mask: 24,
                label: 16000,
                mpNextHop: net.isIP(host) === 6 ? '2001:db8::254' : '192.0.2.254'
            },
            {
                addressFamily: families.VPNV6,
                prefix: '2001:db8:100::',
                mask: 64,
                label: 16001,
                mpNextHop: '2001:db8::254'
            },
            {
                addressFamily: families.L2VPN_EVPN,
                routeType: 2,
                macAddress: '02:00:00:00:00:01',
                ipAddress: '192.0.2.10',
                encapsulationType: 'vxlan',
                vni: 11000,
                mpNextHop: host
            }
        ].map(config => {
            if (config.addressFamily === families.L2VPN_EVPN)
                return { ...config, rd: '65000:1', rt: '65000:1', count: 1 };
            const { label, mpNextHop, ...prefixConfig } = config;
            return {
                ...prefixConfig,
                count: 1,
                attributeRules: [
                    { type: 'origin', value: 0 },
                    { type: 'asPath', value: '' },
                    { type: 'extendedCommunities', value: ['rt:65000:1'] }
                ],
                nlriRules: [
                    { type: 'rd', mode: 'fixed', value: '65000:1' },
                    { type: 'label', mode: 'fixed', value: label },
                    { type: 'mpNextHop', mode: 'fixed', value: mpNextHop }
                ]
            };
        });
        const withNextHop = (config, value) => ({
            ...config,
            nlriRules: config.nlriRules.map(rule => (rule.type === 'mpNextHop' ? { ...rule, value } : rule))
        });
        const reachAttributes = () =>
            received.flatMap(packet =>
                (packet.pathAttributes || [])
                    .filter(attribute => attribute.typeCode === 14)
                    .map(attribute => attribute.mpReach)
            );
        const withdrawAttributes = () =>
            received.flatMap(packet =>
                (packet.pathAttributes || [])
                    .filter(attribute => attribute.typeCode === 15)
                    .map(attribute => attribute.mpUnreach)
            );
        for (const config of routeConfigs) await worker.generateVpnEvpnRoutes('generate', config);
        await waitFor(() => reachAttributes().length === remoteFamilies.length, `MP_REACH delivery on ${host}`);
        for (const family of newFamilies) {
            const { afi, safi } = getAfiAndSafi(family);
            const receivedFamily = reachAttributes().filter(
                attribute => attribute.afi === afi && attribute.safi === safi
            );
            assert.equal(receivedFamily.length, remoteFamilies.includes(family) ? 1 : 0);
            if (receivedFamily.length) {
                assert.equal(receivedFamily[0].nlri.length, 1);
                assert.equal(receivedFamily[0].nlri[0].rd, '65000:1');
                if (family === families.L2VPN_EVPN) assert.equal(receivedFamily[0].nlri[0].labels[0].raw24, 11000);
                else assert.equal(receivedFamily[0].nlri[0].labels[0].label, family === families.VPNV4 ? 16000 : 16001);
            }
            const instance = worker.bgpInstanceMap.get(BgpInstance.makeKey(0, afi, safi));
            worker.deleteRoute('withdraw', { addressFamily: family, routes: Array.from(instance.routeMap.values()) });
            assert.equal(instance.routeMap.size, 0);
        }
        await waitFor(() => withdrawAttributes().length === remoteFamilies.length, `MP_UNREACH delivery on ${host}`);
        for (const family of remoteFamilies) {
            const { afi, safi } = getAfiAndSafi(family);
            const withdrawal = withdrawAttributes().find(attribute => attribute.afi === afi && attribute.safi === safi);
            assert.equal(withdrawal.withdrawnRoutes.length, 1);
            assert.equal(withdrawal.withdrawnRoutes[0].rd, '65000:1');
        }

        if (remoteFamilies.includes(families.L2VPN_EVPN)) {
            const beforeReach = reachAttributes().length;
            const beforeWithdraw = withdrawAttributes().length;
            const srv6 = {
                addressFamily: families.L2VPN_EVPN,
                groupId: 'srv6-session',
                routeType: 2,
                encapsulationType: 'srv6',
                count: 2,
                macAddress: '02:00:00:10:00:01',
                ipAddress: '2001:db8:10::1',
                attributeRules: [
                    { type: 'origin', value: 0 },
                    { type: 'asPath', value: '' },
                    { type: 'extendedCommunities', value: ['rt:65000:10'] }
                ],
                nlriRules: [
                    { type: 'rd', mode: 'fixed', value: '65000:10' },
                    { type: 'mpNextHop', mode: 'fixed', value: '2001:db8::254' },
                    ...[
                        ['srv6L2', '2001:db8:20::1', 23],
                        ['srv6L3', '2001:db8:30::1', 18]
                    ].map(([type, value, endpointBehavior]) => ({
                        type,
                        mode: 'fixed',
                        value,
                        endpointBehavior,
                        locatorBlockLength: 32,
                        locatorNodeLength: 32,
                        functionLength: 64,
                        argumentLength: 0,
                        transpositionLength: 0,
                        transpositionOffset: 0
                    }))
                ]
            };
            await worker.generateVpnEvpnRoutes('srv6-generate', srv6);
            await waitFor(() => reachAttributes().length > beforeReach, `EVPN SRv6 delivery on ${host}`);
            const mp = reachAttributes().at(-1);
            assert.equal(mp.afi, 25);
            assert.equal(mp.safi, 70);
            assert.equal(mp.nextHopLength, 16);
            assert.equal(mp.nlri.length, 2);
            assert.ok(
                mp.nlri.every(
                    route => route.encapsulationType === 'srv6' && route.labels.every(label => label.raw24 === 0x30)
                )
            );
            const update = received.filter(packet => packet.pathAttributes?.some(attr => attr.typeCode === 40)).at(-1);
            assert.equal(update.pathAttributes.filter(attr => attr.typeCode === 40).length, 1);
            assert.deepEqual(
                update.pathAttributes
                    .find(attr => attr.typeCode === 40)
                    .prefixSid.srv6Services.map(service => service.serviceType),
                ['l2', 'l3']
            );
            await worker.withdrawRouteGroup('srv6-withdraw', { groupId: 'srv6-session' });
            await waitFor(() => withdrawAttributes().length > beforeWithdraw, `EVPN SRv6 withdrawal on ${host}`);
            assert.deepEqual(
                withdrawAttributes()
                    .at(-1)
                    .withdrawnRoutes.map(route => route.macAddress),
                mp.nlri.map(route => route.macAddress)
            );
        }

        // Reusing this session must clear remote capability state while retaining local configuration.
        session.handleSocketClosed(accepted);
        const localFlags = session.localAddrFamilyFlags;
        session.setPeerAddPath(1, 128, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE);
        const reconnectSocket = {
            localAddress: host,
            destroyed: false,
            write: () => true,
            destroy() {
                this.destroyed = true;
            }
        };
        session.tcpConnectSuccess(reconnectSocket);
        assert.equal(session.peerAddrFamilyFlags, 0);
        assert.equal(session.peerCapFlags, 0);
        assert.equal(session.peerAddPathMap.size, 0);
        assert.equal(session.peerExtendedNextHopFamilies.size, 0);
        assert.equal(session.localAddrFamilyFlags, localFlags);
        session.recvMsg(Buffer.concat([remoteOpen([families.L2VPN_EVPN], [[1, 1, 2]]), message(4)]));
        assert.equal(session.isExtendedNextHopEnabled(1, 1, 2), true);
        assert.equal(
            session.isExtendedNextHopEnabled(1, 128, 2),
            false,
            'a unicast extension tuple does not authorize VPNv4 IPv6 next hops'
        );
        assert.equal(session.peerAddrFamilyFlags & BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.VPNV4, 0);
        assert.equal(session.peerAddrFamilyFlags & BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.VPNV6, 0);
        const vpnv6 = getAfiAndSafi(families.VPNV6);
        assert.equal(
            worker.bgpInstanceMap.get(BgpInstance.makeKey(0, vpnv6.afi, vpnv6.safi)).peerMap.get(host).peerState,
            BgpConst.BGP_PEER_STATE.NO_NEG
        );
        const tuplePackets = [];
        session.handleSocketClosed(reconnectSocket);
        session.tcpConnectSuccess({
            ...reconnectSocket,
            write(buffer) {
                tuplePackets.push(Buffer.from(buffer));
                return true;
            }
        });
        session.recvMsg(Buffer.concat([remoteOpen([families.VPNV4, families.L2VPN_EVPN], [[1, 1, 2]]), message(4)]));
        tuplePackets.length = 0;
        await worker.generateVpnEvpnRoutes('extension-negative', {
            ...withNextHop(routeConfigs[0], '2001:db8::254'),
            prefix: '203.0.113.1',
            mask: 32
        });
        assert.equal(
            tuplePackets.filter(packet => packet[18] === 2).length,
            0,
            'unicast next-hop capability cannot authorize VPNv4 transmission'
        );
        await worker.generateVpnEvpnRoutes('ipv4-hop', {
            ...withNextHop(routeConfigs[0], '192.0.2.254'),
            prefix: '203.0.113.2',
            mask: 32
        });
        assert.equal(
            tuplePackets.filter(packet => packet[18] === 2).length,
            1,
            'VPNv4 IPv4 next-hop delivery does not require extended next-hop capability'
        );
        worker.deletePeer('delete', { peerIp: host, addressFamily: families.VPNV4 });
        assert.equal(session.localAddrFamilyFlags & BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.VPNV4, 0);
        assert.ok(session.localAddrFamilyFlags & BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.VPNV6);
        assert.ok(session.localAddrFamilyFlags & BgpConst.BGP_MULTIPROTOCOL_EXTENSIONS_FLAGS.L2VPN_EVPN);
        const vpnv4 = getAfiAndSafi(families.VPNV4);
        assert.equal(worker.bgpInstanceMap.get(BgpInstance.makeKey(0, vpnv4.afi, vpnv4.safi)).peerMap.size, 0);
        session.clearSession();
        assert.equal(session.peerExtendedNextHopFamilies.size, 0);
        assert.equal(session.isExtendedNextHopEnabled(1, 1, 2), false);
    } finally {
        session.clearHoldTimer();
        if (client) client.destroy();
        if (accepted) accepted.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        store.close();
    }
}

(async () => {
    for (const host of ['127.0.0.1', '::1']) {
        await handshake(host, newFamilies);
        await handshake(host, [families.VPNV4, families.L2VPN_EVPN]);
    }
    console.log('BGP VPNv4/VPNv6/EVPN TCP negotiation tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
