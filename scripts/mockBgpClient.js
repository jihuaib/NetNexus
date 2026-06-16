#!/usr/bin/env node

const net = require('net');
const BgpConst = require('../electron/const/bgpConst');
const { parseBgpPacket, getBgpPacketSummary } = require('../electron/utils/bgpPacketParser');

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 179,
    localAs: 100,
    routerId: '192.0.2.2',
    holdTime: 90,
    once: false,
    addressFamilies: ['ipv4-unc']
};

const ADDRESS_FAMILY_CAPS = {
    'ipv4-unc': {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    },
    'ipv4-qp': {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_QP
    }
};

function getArgValue(name, defaultValue) {
    const prefix = `--${name}`;
    const index = process.argv.indexOf(prefix);
    if (index >= 0 && process.argv[index + 1]) {
        return process.argv[index + 1];
    }
    const inlineArg = process.argv.find(item => item.startsWith(`${prefix}=`));
    if (inlineArg) {
        return inlineArg.slice(prefix.length + 1);
    }
    return defaultValue;
}

function hasArg(name) {
    return process.argv.includes(`--${name}`);
}

function getArgValues(name) {
    const prefix = `--${name}`;
    const values = [];
    for (let index = 0; index < process.argv.length; index++) {
        const item = process.argv[index];
        if (item === prefix && process.argv[index + 1]) {
            values.push(process.argv[index + 1]);
            index += 1;
        } else if (item.startsWith(`${prefix}=`)) {
            values.push(item.slice(prefix.length + 1));
        }
    }
    return values;
}

function parseAddressFamilies(values) {
    const families = values
        .flatMap(value => `${value}`.split(','))
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    const selected = families.length > 0 ? families : DEFAULT_OPTIONS.addressFamilies;

    return selected.map(family => {
        if (!ADDRESS_FAMILY_CAPS[family]) {
            throw new Error(`Unsupported address family: ${family}`);
        }
        return family;
    });
}

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function ip(ipAddress) {
    return Buffer.from(ipAddress.split('.').map(part => parseInt(part, 10)));
}

function bgpPacket(type, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function capability(code, value = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from([code, value.length]), value]);
}

function optionalParam(value) {
    return Buffer.concat([Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, value.length]), value]);
}

function buildOpen({ localAs, routerId, holdTime, addressFamilies }) {
    const mpCapabilities = addressFamilies.map(family => {
        const { afi, safi } = ADDRESS_FAMILY_CAPS[family];
        return capability(
            BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
            Buffer.concat([u16(afi), Buffer.from([0, safi])])
        );
    });
    const capabilities = Buffer.concat([
        ...mpCapabilities,
        capability(BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH),
        capability(BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS, u32(localAs))
    ]);
    const optional = optionalParam(capabilities);
    const body = Buffer.concat([
        Buffer.from([BgpConst.BGP_VERSION]),
        u16(Math.min(localAs, 0xffff)),
        u16(holdTime),
        ip(routerId),
        Buffer.from([optional.length]),
        optional
    ]);

    return bgpPacket(BgpConst.BGP_PACKET_TYPE.OPEN, body);
}

function buildKeepalive() {
    return bgpPacket(BgpConst.BGP_PACKET_TYPE.KEEPALIVE);
}

function emit(event, data = {}) {
    process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

function summarizeUpdatePacket(parsed) {
    const pathAttributes = Array.isArray(parsed.pathAttributes) ? parsed.pathAttributes : [];
    const mpReachAttr = pathAttributes.find(attr => attr.mpReach);
    const mpReach = mpReachAttr?.mpReach || null;

    return {
        valid: parsed.valid,
        error: parsed.error || '',
        nlriCount: Array.isArray(parsed.nlri) ? parsed.nlri.length : 0,
        withdrawnCount: Array.isArray(parsed.withdrawnRoutes) ? parsed.withdrawnRoutes.length : 0,
        pathAttrTypes: pathAttributes.map(attr => attr.typeCode),
        pathAttrCount: pathAttributes.length,
        mpReach: mpReach
            ? {
                  afi: mpReach.afi,
                  safi: mpReach.safi,
                  nextHop: mpReach.nextHop,
                  nlriCount: Array.isArray(mpReach.nlri) ? mpReach.nlri.length : 0
              }
            : null
    };
}

function parseOptions() {
    return {
        host: getArgValue('host', DEFAULT_OPTIONS.host),
        port: Number(getArgValue('port', DEFAULT_OPTIONS.port)),
        localAs: Number(getArgValue('local-as', DEFAULT_OPTIONS.localAs)),
        routerId: getArgValue('router-id', DEFAULT_OPTIONS.routerId),
        holdTime: Number(getArgValue('hold-time', DEFAULT_OPTIONS.holdTime)),
        once: hasArg('once'),
        addressFamilies: parseAddressFamilies(getArgValues('address-family'))
    };
}

async function main() {
    const options = parseOptions();
    const socket = net.createConnection({ host: options.host, port: options.port });
    let packetBuffer = Buffer.alloc(0);
    let openSent = false;
    let keepaliveSent = false;
    let established = false;
    let updateCount = 0;

    const sendOpen = () => {
        if (openSent) {
            return;
        }
        socket.write(buildOpen(options));
        openSent = true;
        emit('sent-open', {
            localAs: options.localAs,
            routerId: options.routerId,
            holdTime: options.holdTime
        });
    };

    const sendKeepalive = () => {
        socket.write(buildKeepalive());
        keepaliveSent = true;
        emit('sent-keepalive');
    };

    socket.on('connect', () => {
        emit('connected', { host: options.host, port: options.port });
        sendOpen();
    });

    socket.on('data', chunk => {
        packetBuffer = Buffer.concat([packetBuffer, chunk]);
        while (packetBuffer.length >= BgpConst.BGP_HEAD_LEN) {
            const length = packetBuffer.readUInt16BE(BgpConst.BGP_MARKER_LEN);
            const type = packetBuffer.readUInt8(BgpConst.BGP_MARKER_LEN + 2);
            if (packetBuffer.length < length) {
                break;
            }

            const packet = packetBuffer.subarray(0, length);
            packetBuffer = packetBuffer.subarray(length);

            const parsed = parseBgpPacket(packet);
            const summary = getBgpPacketSummary(parsed);
            emit('received-packet', { type, length, summary });

            if (type === BgpConst.BGP_PACKET_TYPE.OPEN) {
                if (!keepaliveSent) {
                    sendKeepalive();
                }
            } else if (type === BgpConst.BGP_PACKET_TYPE.KEEPALIVE) {
                if (!established) {
                    established = true;
                    emit('established');
                }
            } else if (type === BgpConst.BGP_PACKET_TYPE.UPDATE) {
                updateCount += 1;
                emit('received-update', {
                    updateCount,
                    length,
                    summary,
                    ...summarizeUpdatePacket(parsed)
                });
                if (options.once) {
                    socket.end();
                }
            }
        }
    });

    socket.on('error', error => {
        emit('error', { message: error.message });
        process.exitCode = 1;
    });

    socket.on('close', () => {
        emit('closed', { updateCount });
        if (!established || updateCount === 0) {
            process.exitCode = 1;
        }
    });
}

main().catch(error => {
    emit('error', { message: error.message });
    process.exit(1);
});
