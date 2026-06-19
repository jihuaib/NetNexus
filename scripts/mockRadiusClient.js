#!/usr/bin/env node

const crypto = require('crypto');
const dgram = require('dgram');
const Radius = require('../electron/utils/radiusUtils');
const RadiusConst = require('../electron/const/radiusConst');

const { RADIUS_CODES, RADIUS_ATTRIBUTES, RADIUS_ACCT_STATUS_TYPES } = RadiusConst;

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    authPort: 1812,
    accountingPort: 1813,
    coaPort: 3799,
    secret: 'testing123',
    username: 'demo',
    password: 'demo',
    sessionId: '',
    interval: 200,
    timeout: 3000,
    ipv6: false,
    disconnect: false,
    skipCoa: false
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

function hasArgValue(name) {
    const prefix = `--${name}`;
    return process.argv.includes(prefix) || process.argv.some(item => item.startsWith(`${prefix}=`));
}

function emit(event, data = {}) {
    process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

function parseOptions() {
    const ipv6 = hasArg('ipv6');
    const host = getArgValue('host', ipv6 && !hasArgValue('host') ? '::1' : DEFAULT_OPTIONS.host);
    const options = {
        host,
        authPort: Number(getArgValue('auth-port', DEFAULT_OPTIONS.authPort)),
        accountingPort: Number(getArgValue('accounting-port', DEFAULT_OPTIONS.accountingPort)),
        coaPort: Number(getArgValue('coa-port', DEFAULT_OPTIONS.coaPort)),
        secret: getArgValue('secret', DEFAULT_OPTIONS.secret),
        username: getArgValue('username', DEFAULT_OPTIONS.username),
        password: getArgValue('password', DEFAULT_OPTIONS.password),
        sessionId: getArgValue('session-id', DEFAULT_OPTIONS.sessionId) || `mock-${Date.now()}`,
        interval: Number(getArgValue('interval', DEFAULT_OPTIONS.interval)),
        timeout: Number(getArgValue('timeout', DEFAULT_OPTIONS.timeout)),
        ipv6,
        disconnect: hasArg('disconnect'),
        skipCoa: hasArg('skip-coa'),
        help: hasArg('help') || process.argv.includes('-h')
    };

    [
        ['auth-port', options.authPort],
        ['accounting-port', options.accountingPort],
        ['coa-port', options.coaPort]
    ].forEach(([name, value]) => {
        if (!Number.isInteger(value) || value <= 0 || value > 65535) {
            throw new Error(`Invalid --${name}: ${value}`);
        }
    });

    if (!Number.isInteger(options.interval) || options.interval < 0) {
        throw new Error(`Invalid --interval: ${options.interval}`);
    }
    if (!Number.isInteger(options.timeout) || options.timeout <= 0) {
        throw new Error(`Invalid --timeout: ${options.timeout}`);
    }
    if (!options.secret) {
        throw new Error('Invalid --secret: shared secret cannot be empty');
    }
    if (!options.username) {
        throw new Error('Invalid --username: username cannot be empty');
    }

    return options;
}

function printHelp() {
    console.log(`Usage: npm run mock:radius -- [options]

Options:
  --host <ip>              RADIUS server host, default ${DEFAULT_OPTIONS.host}; with --ipv6 default ::1
  --auth-port <port>       Authentication UDP port, default ${DEFAULT_OPTIONS.authPort}
  --accounting-port <port> Accounting UDP port, default ${DEFAULT_OPTIONS.accountingPort}
  --coa-port <port>        Dynamic Authorization UDP port, default ${DEFAULT_OPTIONS.coaPort}
  --secret <secret>        Shared secret, default ${DEFAULT_OPTIONS.secret}
  --username <name>        User-Name, default ${DEFAULT_OPTIONS.username}
  --password <password>    PAP password, default ${DEFAULT_OPTIONS.password}
  --session-id <id>        Acct-Session-Id, default mock-<timestamp>
  --interval <ms>          Delay between requests, default ${DEFAULT_OPTIONS.interval}
  --timeout <ms>           UDP response timeout, default ${DEFAULT_OPTIONS.timeout}
  --ipv6                   Send IPv6 NAS attributes over udp6
  --skip-coa               Skip CoA request
  --disconnect             Send Disconnect-Request after CoA
  -h, --help               Show this help
`);
}

function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function nasAttributes(options) {
    if (options.ipv6) {
        return [Radius.ipv6Attr(RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS, options.host)];
    }
    return [Radius.ipAttr(RADIUS_ATTRIBUTES.NAS_IP_ADDRESS, options.host)];
}

function buildAccessRequest(options, identifier) {
    const requestAuthenticator = crypto.randomBytes(16);
    const attributes = [
        Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, options.username),
        Radius.attr(
            RADIUS_ATTRIBUTES.USER_PASSWORD,
            Radius.encryptUserPassword(options.password, options.secret, requestAuthenticator)
        ),
        ...nasAttributes(options),
        Radius.integerAttr(RADIUS_ATTRIBUTES.NAS_PORT, 1001),
        Radius.stringAttr(RADIUS_ATTRIBUTES.NAS_IDENTIFIER, 'netnexus-radius-mock'),
        Radius.stringAttr(RADIUS_ATTRIBUTES.CALLING_STATION_ID, '00-11-22-33-44-55'),
        Radius.stringAttr(RADIUS_ATTRIBUTES.CALLED_STATION_ID, 'netnexus-lab')
    ];
    const packet = Radius.buildPacket(RADIUS_CODES.ACCESS_REQUEST, identifier, requestAuthenticator, attributes);
    return {
        packet,
        requestAuthenticator
    };
}

function accountingAttributes(options, statusType) {
    const attributes = [
        Radius.integerAttr(RADIUS_ATTRIBUTES.ACCT_STATUS_TYPE, statusType),
        Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, options.username),
        Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, options.sessionId),
        ...nasAttributes(options),
        Radius.integerAttr(RADIUS_ATTRIBUTES.NAS_PORT, 1001),
        Radius.stringAttr(RADIUS_ATTRIBUTES.NAS_IDENTIFIER, 'netnexus-radius-mock'),
        Radius.stringAttr(RADIUS_ATTRIBUTES.CALLING_STATION_ID, '00-11-22-33-44-55'),
        Radius.stringAttr(RADIUS_ATTRIBUTES.CALLED_STATION_ID, 'netnexus-lab')
    ];

    if (options.ipv6) {
        attributes.push(Radius.ipv6PrefixAttr(RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX, '2001:db8:100::/64'));
    } else {
        attributes.push(Radius.ipAttr(RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS, '10.10.10.100'));
    }

    return attributes;
}

function buildAccountingRequest(options, identifier, statusType) {
    return Radius.buildAccountingLikeRequestPacket(
        RADIUS_CODES.ACCOUNTING_REQUEST,
        identifier,
        accountingAttributes(options, statusType),
        options.secret
    );
}

function buildCoaRequest(options, identifier) {
    return Radius.buildAccountingLikeRequestPacket(
        RADIUS_CODES.COA_REQUEST,
        identifier,
        [
            Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, options.sessionId),
            Radius.stringAttr(RADIUS_ATTRIBUTES.FILTER_ID, 'netnexus-mock-filter'),
            Radius.integerAttr(RADIUS_ATTRIBUTES.SESSION_TIMEOUT, 3600),
            ...(options.ipv6
                ? [Radius.ipv6PrefixAttr(RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX, '2001:db8:200::/64')]
                : [Radius.ipAttr(RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS, '10.10.10.200')])
        ],
        options.secret,
        { includeMessageAuthenticator: true }
    );
}

function buildDisconnectRequest(options, identifier) {
    return Radius.buildAccountingLikeRequestPacket(
        RADIUS_CODES.DISCONNECT_REQUEST,
        identifier,
        [Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, options.sessionId)],
        options.secret
    );
}

function sendUdp(options, port, packet) {
    return new Promise((resolve, reject) => {
        const family = options.ipv6 ? 'udp6' : 'udp4';
        const socket = dgram.createSocket(family);
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`RADIUS response timeout on ${options.host}:${port}`));
        }, options.timeout);

        socket.once('error', error => {
            clearTimeout(timer);
            socket.close();
            reject(error);
        });
        socket.once('message', msg => {
            clearTimeout(timer);
            socket.close();
            resolve(Radius.parsePacket(msg));
        });
        socket.send(packet, port, options.host);
    });
}

function responseName(packet) {
    return packet ? packet.codeName : '-';
}

function verifyResponse(response, requestAuthenticator, secret) {
    const expected = Radius.computeResponseAuthenticator(
        response.code,
        response.identifier,
        requestAuthenticator,
        response.attributes,
        secret
    );
    return Radius.safeEqual(expected, response.authenticator);
}

async function sendRequest(options, step) {
    emit('sent-request', {
        step: step.name,
        port: step.port,
        code: step.codeName,
        identifier: step.identifier,
        sessionId: options.sessionId
    });

    const response = await sendUdp(options, step.port, step.packet);
    const authenticator = step.requestAuthenticator || Radius.parsePacket(step.packet).authenticator;
    emit('received-response', {
        step: step.name,
        code: response.code,
        codeName: responseName(response),
        identifier: response.identifier,
        authenticatorValid: verifyResponse(response, authenticator, options.secret)
    });
    return response;
}

function buildScenario(options) {
    let identifier = 10;
    const access = buildAccessRequest(options, identifier++);
    const scenario = [
        {
            name: 'access-request',
            codeName: 'Access-Request',
            identifier: access.packet.readUInt8(1),
            port: options.authPort,
            packet: access.packet,
            requestAuthenticator: access.requestAuthenticator
        },
        {
            name: 'accounting-start',
            codeName: 'Accounting-Request',
            identifier,
            port: options.accountingPort,
            packet: buildAccountingRequest(options, identifier++, RADIUS_ACCT_STATUS_TYPES.START)
        },
        {
            name: 'accounting-interim-update',
            codeName: 'Accounting-Request',
            identifier,
            port: options.accountingPort,
            packet: buildAccountingRequest(options, identifier++, RADIUS_ACCT_STATUS_TYPES.INTERIM_UPDATE)
        }
    ];

    if (!options.skipCoa) {
        scenario.push({
            name: 'coa-request',
            codeName: 'CoA-Request',
            identifier,
            port: options.coaPort,
            packet: buildCoaRequest(options, identifier++)
        });
    }

    if (options.disconnect) {
        scenario.push({
            name: 'disconnect-request',
            codeName: 'Disconnect-Request',
            identifier,
            port: options.coaPort,
            packet: buildDisconnectRequest(options, identifier++)
        });
    }

    return scenario;
}

async function run() {
    const options = parseOptions();
    if (options.help) {
        printHelp();
        return;
    }

    emit('started', {
        host: options.host,
        authPort: options.authPort,
        accountingPort: options.accountingPort,
        coaPort: options.coaPort,
        username: options.username,
        sessionId: options.sessionId,
        ipv6: options.ipv6
    });

    const scenario = buildScenario(options);
    for (const step of scenario) {
        await sendRequest(options, step);
        if (options.interval > 0) {
            await delay(options.interval);
        }
    }

    emit('completed', {
        sessionId: options.sessionId,
        sessionKept: !options.disconnect
    });
}

if (require.main === module) {
    run().catch(error => {
        emit('error', { message: error.message });
        process.exit(1);
    });
}

module.exports = {
    buildScenario,
    parseOptions
};
