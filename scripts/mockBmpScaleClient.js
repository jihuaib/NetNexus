#!/usr/bin/env node

// Large-scale BMP load generator: many peers with a full table each, plus
// Loc-RIB instances with even larger tables. Messages are generated lazily and
// written with socket backpressure so a multi-million route run stays cheap
// on the sending side. scripts/mockBmpClient.js (the `full` scenario used by
// e2e tests and docs screenshots) is deliberately left untouched.
//
//   npm run mock:bmp:scale -- [options]
//
// Defaults: 100 peers x 10,000 routes (split evenly over the four address
// families), one Loc-RIB with 100,000 routes per address family.

const net = require('net');
const BmpConst = require('../electron/const/bmpConst');
const BgpConst = require('../electron/const/bgpConst');
const { builders } = require('./mockBmpClient');

const {
    u16,
    u32,
    ip,
    ipBytes,
    rd,
    bmpMessage,
    peerUpPayload,
    locRibPeerUpPayload,
    initiationMessage,
    routeMonitoringMessage,
    statisticsReportMessage,
    ipv4Update,
    multiprotocolUpdate,
    endOfRibUpdate
} = builders;

const FAMILIES = Object.freeze({
    'ipv4-unicast': { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    'ipv6-unicast': { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6, safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST },
    vpnv4: { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4, safi: BgpConst.BGP_SAFI_TYPE.SAFI_VPN },
    vpnv6: { afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6, safi: BgpConst.BGP_SAFI_TYPE.SAFI_VPN }
});

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 1790,
    peers: 100,
    routes: 10000,
    locRibRoutes: 100000,
    families: ['ipv4-unicast', 'ipv6-unicast', 'vpnv4', 'vpnv6'],
    batch: 50,
    interval: 0,
    uniquePrefixes: false,
    withdrawPercent: 0,
    once: false,
    dryRun: false,
    sysName: 'netnexus-scale-router'
};

function parseArgs(argv) {
    const options = { ...DEFAULT_OPTIONS, families: [...DEFAULT_OPTIONS.families] };
    const takeValue = (index, name) => {
        const value = argv[index + 1];
        if (value === undefined) {
            throw new Error(`Missing value for ${name}`);
        }
        return value;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        switch (arg) {
            case '--host':
                options.host = takeValue(index, arg);
                index += 1;
                break;
            case '--port':
            case '--peers':
            case '--routes':
            case '--loc-rib-routes':
            case '--batch':
            case '--interval':
            case '--withdraw-percent': {
                const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
                const value = Number(takeValue(index, arg));
                if (!Number.isFinite(value) || value < 0) {
                    throw new Error(`Invalid ${arg}: ${argv[index + 1]}`);
                }
                options[key] = Math.floor(value);
                index += 1;
                break;
            }
            case '--families':
                options.families = takeValue(index, arg)
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean);
                index += 1;
                break;
            case '--sys-name':
                options.sysName = takeValue(index, arg);
                index += 1;
                break;
            case '--unique-prefixes':
                options.uniquePrefixes = true;
                break;
            case '--once':
                options.once = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    const unknownFamily = options.families.find(name => !FAMILIES[name]);
    if (unknownFamily) {
        throw new Error(`Unknown family ${unknownFamily}; supported: ${Object.keys(FAMILIES).join(', ')}`);
    }
    if (options.families.length === 0) {
        throw new Error('At least one family is required');
    }
    if (options.peers < 1 || options.batch < 1) {
        throw new Error('--peers and --batch must be at least 1');
    }
    if (options.withdrawPercent > 100) {
        throw new Error('--withdraw-percent must be between 0 and 100');
    }
    return options;
}

function printHelp() {
    console.log(`Usage: npm run mock:bmp:scale -- [options]

Options:
  --host <ip>              BMP server host, default ${DEFAULT_OPTIONS.host}
  --port <port>            BMP server port, default ${DEFAULT_OPTIONS.port}
  --peers <count>          BGP peers under the mock router, default ${DEFAULT_OPTIONS.peers}
  --routes <count>         routes per peer, split evenly across --families, default ${DEFAULT_OPTIONS.routes}
  --loc-rib-routes <count> Loc-RIB routes per family, default ${DEFAULT_OPTIONS.locRibRoutes}
  --families <list>        comma separated: ${Object.keys(FAMILIES).join(', ')}
  --batch <count>          NLRIs per UPDATE message, default ${DEFAULT_OPTIONS.batch}
  --interval <ms>          delay after each peer finishes its table, default ${DEFAULT_OPTIONS.interval}
  --unique-prefixes        every peer announces its own prefixes (default: peers share one table,
                           like a real full-table feed, with per-peer next hop / AS path)
  --withdraw-percent <n>   after EOR, withdraw n% of every peer's routes (default 0)
  --sys-name <name>        BMP Initiation sysName, default ${DEFAULT_OPTIONS.sysName}
  --once                   close the TCP connection after sending instead of keeping it open
  --dry-run                only count messages/bytes, do not connect
  -h, --help               show this help`);
}

// ---------------------------------------------------------------------------
// Prefix generators. Every generator yields deterministic, distinct prefixes
// for (familyKey, index); peers reuse the same index space unless
// --unique-prefixes moves each peer into its own block.

// `block` selects a disjoint prefix range (peer N, or the Loc-RIB); `blockSize`
// is the number of indexes reserved per block so ranges never overlap.
function ipv4PrefixBytes(index, block, blockSize) {
    // Consecutive /24s starting at 10.0.0.0/24; each /8 holds 65,536 of them.
    const global = block * blockSize + index;
    const first = 10 + Math.floor(global / 65536);
    if (first > 223) {
        throw new Error(
            'IPv4 prefix space exhausted; lower --routes/--loc-rib-routes/--peers or drop --unique-prefixes'
        );
    }
    return Buffer.from([first, (global >>> 8) & 0xff, global & 0xff]);
}

function ipv4PrefixText(index, block, blockSize) {
    const bytes = ipv4PrefixBytes(index, block, blockSize);
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.0`;
}

function ipv6PrefixBytes(index, block, blockSize) {
    // Consecutive /64s: 2001:1<global>::/64 encoded into the 8 prefix bytes.
    const global = block * blockSize + index;
    return Buffer.from([
        0x20,
        0x01,
        0x01,
        (global >>> 24) & 0xff,
        (global >>> 16) & 0xff,
        (global >>> 8) & 0xff,
        global & 0xff,
        0x00
    ]);
}

function vpnRd(peerIndex, familyKey) {
    return rd(65000, (familyKey === 'vpnv4' ? 1000 : 2000) + peerIndex);
}

function labelBytes(label) {
    // 20-bit label, bottom-of-stack bit set.
    const value = (label << 4) | 0x1;
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

// Builds the UPDATE for `count` consecutive prefixes starting at `start`.
function buildUpdate(familyKey, start, count, block, attrs) {
    const family = FAMILIES[familyKey];
    if (familyKey === 'ipv4-unicast') {
        const prefixes = [];
        for (let index = start; index < start + count; index += 1) {
            prefixes.push(ipv4PrefixText(index, block, attrs.blockSize));
        }
        return ipv4Update(prefixes, {
            nextHop: attrs.nextHop4,
            asns: attrs.asns,
            localPref: attrs.localPref,
            communities: attrs.communities
        });
    }
    const nlris = [];
    for (let index = start; index < start + count; index += 1) {
        switch (familyKey) {
            case 'ipv6-unicast':
                nlris.push(Buffer.concat([Buffer.from([64]), ipv6PrefixBytes(index, block, attrs.blockSize)]));
                break;
            case 'vpnv4':
                nlris.push(
                    Buffer.concat([
                        Buffer.from([24 + 64 + 24]),
                        labelBytes(attrs.label),
                        attrs.rd,
                        ipv4PrefixBytes(index, block, attrs.blockSize)
                    ])
                );
                break;
            case 'vpnv6':
                nlris.push(
                    Buffer.concat([
                        Buffer.from([24 + 64 + 64]),
                        labelBytes(attrs.label),
                        attrs.rd,
                        ipv6PrefixBytes(index, block, attrs.blockSize)
                    ])
                );
                break;
            default:
                throw new Error(`Unsupported family ${familyKey}`);
        }
    }
    const nextHop =
        familyKey === 'ipv6-unicast'
            ? ipBytes(attrs.nextHop6)
            : familyKey === 'vpnv4'
              ? Buffer.concat([Buffer.alloc(8), ip(attrs.nextHop4)])
              : Buffer.concat([Buffer.alloc(8), ipBytes(attrs.nextHop6)]);
    return multiprotocolUpdate(family.afi, family.safi, Buffer.concat(nlris), {
        nextHop,
        localPref: attrs.localPref,
        communities: attrs.communities,
        additionalAttrs: [asPathAttr(attrs.asns)]
    });
}

function asPathAttr(asns) {
    // AS_SEQUENCE with 4-octet ASNs (the OPEN advertises FOUR_OCTET_AS).
    const value = Buffer.concat([Buffer.from([2, asns.length]), ...asns.map(asn => u32(asn))]);
    return Buffer.concat([
        Buffer.from([BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE, BgpConst.BGP_PATH_ATTR.AS_PATH, value.length]),
        value
    ]);
}

function buildWithdraw(familyKey, start, count, block, attrs) {
    const family = FAMILIES[familyKey];
    if (familyKey === 'ipv4-unicast') {
        const withdrawn = [];
        for (let index = start; index < start + count; index += 1) {
            withdrawn.push(Buffer.concat([Buffer.from([24]), ipv4PrefixBytes(index, block, attrs.blockSize)]));
        }
        const body = Buffer.concat(withdrawn);
        return bgpUpdatePacket(Buffer.concat([u16(body.length), body, u16(0)]));
    }
    const nlris = [];
    for (let index = start; index < start + count; index += 1) {
        switch (familyKey) {
            case 'ipv6-unicast':
                nlris.push(Buffer.concat([Buffer.from([64]), ipv6PrefixBytes(index, block, attrs.blockSize)]));
                break;
            case 'vpnv4':
                nlris.push(
                    Buffer.concat([
                        Buffer.from([24 + 64 + 24]),
                        labelBytes(0x80000),
                        attrs.rd,
                        ipv4PrefixBytes(index, block, attrs.blockSize)
                    ])
                );
                break;
            case 'vpnv6':
                nlris.push(
                    Buffer.concat([
                        Buffer.from([24 + 64 + 64]),
                        labelBytes(0x80000),
                        attrs.rd,
                        ipv6PrefixBytes(index, block, attrs.blockSize)
                    ])
                );
                break;
            default:
                throw new Error(`Unsupported family ${familyKey}`);
        }
    }
    const value = Buffer.concat([u16(family.afi), Buffer.from([family.safi]), ...nlris]);
    const attr = Buffer.concat([
        Buffer.from([BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | 0x10, BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI]),
        u16(value.length),
        value
    ]);
    return bgpUpdatePacket(Buffer.concat([u16(0), u16(attr.length), attr]));
}

function bgpUpdatePacket(body) {
    return Buffer.concat([
        Buffer.alloc(16, 0xff),
        u16(19 + body.length),
        Buffer.from([BgpConst.BGP_PACKET_TYPE.UPDATE]),
        body
    ]);
}

// ---------------------------------------------------------------------------
// Message stream

function peerDescriptor(peerIndex) {
    const address = `10.255.${Math.floor(peerIndex / 250)}.${1 + (peerIndex % 250)}`;
    return {
        flags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY,
        peerType: BmpConst.BMP_PEER_TYPE.GLOBAL,
        peerAddress: address,
        peerAs: 64512 + peerIndex,
        routerId: address
    };
}

function familyList(options) {
    return options.families.map(key => ({ key, ...FAMILIES[key] }));
}

function routesPerFamily(options) {
    return Math.floor(options.routes / options.families.length);
}

// Indexes reserved per prefix block: large enough for either a peer table or
// the Loc-RIB table, so block N never overlaps block N+1.
function prefixBlockSize(options) {
    return Math.max(routesPerFamily(options), options.locRibRoutes, 1);
}

function* peerMessages(options, peerIndex) {
    const peer = peerDescriptor(peerIndex);
    const families = familyList(options);
    const perFamily = routesPerFamily(options);
    const block = options.uniquePrefixes ? peerIndex : 0;
    const blockSize = prefixBlockSize(options);
    yield {
        name: `peer-${peerIndex}-up`,
        data: bmpMessage(
            BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
            peerUpPayload({
                ...peer,
                localAddress: '10.255.255.254',
                remotePort: 40000 + peerIndex,
                recvAddressFamilies: families.map(({ afi, safi }) => ({ afi, safi })),
                sendAddressFamilies: families.map(({ afi, safi }) => ({ afi, safi }))
            })
        )
    };
    for (const family of families) {
        const attrs = {
            nextHop4: peer.peerAddress,
            nextHop6: `2001:db8:ff::${(peerIndex + 1).toString(16)}`,
            asns: [peer.peerAs, 65100 + (peerIndex % 7), 65200 + (peerIndex % 13)],
            localPref: 100,
            communities: [`${peer.peerAs}:${100 + (peerIndex % 10)}`],
            rd: vpnRd(peerIndex, family.key),
            label: 1000 + peerIndex,
            blockSize
        };
        for (let start = 0; start < perFamily; start += options.batch) {
            const count = Math.min(options.batch, perFamily - start);
            yield {
                name: `peer-${peerIndex}-${family.key}-${start}`,
                data: routeMonitoringMessage(peer, buildUpdate(family.key, start, count, block, attrs)),
                routes: count
            };
        }
        yield {
            name: `peer-${peerIndex}-${family.key}-eor`,
            data: routeMonitoringMessage(peer, endOfRibUpdate(family.afi, family.safi))
        };
        if (options.withdrawPercent > 0) {
            const withdrawCount = Math.floor((perFamily * options.withdrawPercent) / 100);
            for (let start = 0; start < withdrawCount; start += options.batch) {
                const count = Math.min(options.batch, withdrawCount - start);
                yield {
                    name: `peer-${peerIndex}-${family.key}-withdraw-${start}`,
                    data: routeMonitoringMessage(peer, buildWithdraw(family.key, start, count, block, attrs)),
                    routes: -count
                };
            }
        }
    }
    yield {
        name: `peer-${peerIndex}-statistics`,
        data: statisticsReportMessage(peer, [
            { type: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN, value: perFamily * families.length },
            ...families.map(family => ({
                type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_IN,
                afi: family.afi,
                safi: family.safi,
                value: perFamily
            }))
        ])
    };
}

function* locRibMessages(options) {
    const families = familyList(options);
    const locRib = { flags: BmpConst.BMP_LOC_RIB_FLAGS.FILTERED, peerType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB };
    yield {
        name: 'loc-rib-up',
        data: bmpMessage(
            BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
            locRibPeerUpPayload({
                recvAddressFamilies: families.map(({ afi, safi }) => ({ afi, safi })),
                sendAddressFamilies: families.map(({ afi, safi }) => ({ afi, safi }))
            })
        )
    };
    const attrs = {
        nextHop4: '10.255.255.1',
        nextHop6: '2001:db8:ff::1',
        asns: [65000, 65100],
        localPref: 200,
        communities: ['65000:1'],
        rd: rd(65000, 1),
        label: 3000,
        blockSize: prefixBlockSize(options)
    };
    // Loc-RIB uses its own prefix block (after every peer block) so the tables
    // do not collide with peer prefixes when --unique-prefixes is used.
    const block = options.uniquePrefixes ? options.peers : 1;
    for (const family of families) {
        for (let start = 0; start < options.locRibRoutes; start += options.batch) {
            const count = Math.min(options.batch, options.locRibRoutes - start);
            yield {
                name: `loc-rib-${family.key}-${start}`,
                data: routeMonitoringMessage(locRib, buildUpdate(family.key, start, count, block, attrs), {
                    vrfName: 'global'
                }),
                routes: count
            };
        }
        yield {
            name: `loc-rib-${family.key}-eor`,
            data: routeMonitoringMessage(locRib, endOfRibUpdate(family.afi, family.safi), { vrfName: 'global' })
        };
    }
    yield {
        name: 'loc-rib-statistics',
        data: statisticsReportMessage(locRib, [
            { type: BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB, value: options.locRibRoutes * families.length },
            ...families.map(family => ({
                type: BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB,
                afi: family.afi,
                safi: family.safi,
                value: options.locRibRoutes
            }))
        ])
    };
}

function* scenarioMessages(options) {
    yield {
        name: 'initiation',
        data: initiationMessage({
            sysName: options.sysName,
            sysDesc: `NetNexus scale fixture: ${options.peers} peers x ${options.routes} routes, Loc-RIB ${options.locRibRoutes}/family`
        })
    };
    for (let peerIndex = 0; peerIndex < options.peers; peerIndex += 1) {
        yield* peerMessages(options, peerIndex);
        yield { name: `peer-${peerIndex}-done`, data: null, peerDone: true };
    }
    yield* locRibMessages(options);
}

function summarize(options) {
    const families = familyList(options);
    const perFamily = routesPerFamily(options);
    return {
        peers: options.peers,
        families: families.map(family => family.key),
        peerRoutes: perFamily * families.length * options.peers,
        locRibRoutes: options.locRibRoutes * families.length,
        total: perFamily * families.length * options.peers + options.locRibRoutes * families.length
    };
}

function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

async function writeWithBackpressure(socket, data) {
    if (!socket.write(data)) {
        await new Promise(resolve => socket.once('drain', resolve));
    }
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const plan = summarize(options);
    console.log(
        `scale fixture: peers=${plan.peers} families=${plan.families.join(',')} ` +
            `peerRoutes=${plan.peerRoutes.toLocaleString()} locRibRoutes=${plan.locRibRoutes.toLocaleString()} ` +
            `total=${plan.total.toLocaleString()} batch=${options.batch} uniquePrefixes=${options.uniquePrefixes}`
    );

    if (options.dryRun) {
        let messages = 0;
        let bytes = 0;
        for (const message of scenarioMessages(options)) {
            if (!message.data) continue;
            messages += 1;
            bytes += message.data.length;
        }
        console.log(`dry run: ${messages.toLocaleString()} messages, ${(bytes / 1048576).toFixed(1)} MiB`);
        return;
    }

    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);
    socket.on('error', error => {
        console.error(`BMP mock connection error: ${error.message}`);
        process.exitCode = 1;
    });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    console.log(`connected to BMP server ${options.host}:${options.port}`);

    const startedAt = Date.now();
    let sentRoutes = 0;
    let sentBytes = 0;
    let peersDone = 0;
    let lastReport = startedAt;
    for (const message of scenarioMessages(options)) {
        if (socket.destroyed) {
            throw new Error('BMP connection closed while sending');
        }
        if (message.peerDone) {
            peersDone += 1;
            if (options.interval > 0) {
                await delay(options.interval);
            }
            continue;
        }
        await writeWithBackpressure(socket, message.data);
        sentBytes += message.data.length;
        sentRoutes += message.routes || 0;
        const now = Date.now();
        if (now - lastReport >= 2000) {
            lastReport = now;
            const seconds = (now - startedAt) / 1000;
            console.log(
                `progress: peers=${peersDone}/${options.peers} routes=${sentRoutes.toLocaleString()} ` +
                    `${(sentBytes / 1048576).toFixed(1)} MiB ${Math.round(sentRoutes / seconds).toLocaleString()} routes/s`
            );
        }
    }
    const seconds = (Date.now() - startedAt) / 1000;
    console.log(
        `done: ${sentRoutes.toLocaleString()} route NLRIs, ${(sentBytes / 1048576).toFixed(1)} MiB in ${seconds.toFixed(1)}s ` +
            `(${Math.round(sentRoutes / Math.max(seconds, 0.001)).toLocaleString()} routes/s on the wire)`
    );

    if (options.once) {
        socket.end();
        return;
    }
    console.log('keeping BMP TCP connection open, press Ctrl+C to stop');
    const stop = () => {
        if (!socket.destroyed) {
            socket.end();
        }
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    socket.once('close', () => process.exit(0));
}

if (require.main === module) {
    run().catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { parseArgs, scenarioMessages, summarize, FAMILIES, DEFAULT_OPTIONS };
