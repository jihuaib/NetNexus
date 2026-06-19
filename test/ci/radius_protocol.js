const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerWithPromise = require(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'worker',
    'core',
    'workerWithPromise.js'
));
const Radius = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'radiusUtils.js'));
const { ensureRadiusDefaultConfigFile, loadRadiusRuntimeConfig } = require(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'utils',
    'radiusConfigLoader.js'
));
const RadiusConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'radiusConst.js'));

const { RADIUS_CODES, RADIUS_ATTRIBUTES, RADIUS_SERVICE_TYPES, RADIUS_ACCT_STATUS_TYPES } = RadiusConst;
const HOST = '127.0.0.1';
const HOST6 = '::1';

function sendUdp(port, packet, family = 'udp4', host = HOST) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket(family);
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`RADIUS response timeout on port ${port}`));
        }, 3000);

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
        socket.send(packet, port, host);
    });
}

function ipv6LoopbackAvailable() {
    return new Promise(resolve => {
        const socket = dgram.createSocket('udp6');
        socket.once('error', () => {
            socket.close();
            resolve(false);
        });
        socket.bind(0, HOST6, () => {
            socket.close();
            resolve(true);
        });
    });
}

function verifyResponseAuthenticator(response, requestAuthenticator, secret) {
    const expected = Radius.computeResponseAuthenticator(
        response.code,
        response.identifier,
        requestAuthenticator,
        response.attributes,
        secret
    );
    assert.ok(Radius.safeEqual(expected, response.authenticator), `${response.codeName} Response Authenticator`);
}

function buildAccessRequest({
    id,
    username,
    password,
    secret,
    nasAttributes = [Radius.ipAttr(RADIUS_ATTRIBUTES.NAS_IP_ADDRESS, HOST)],
    attrs = []
}) {
    const requestAuthenticator = crypto.randomBytes(16);
    const packet = Radius.buildPacket(RADIUS_CODES.ACCESS_REQUEST, id, requestAuthenticator, [
        Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, username),
        Radius.attr(RADIUS_ATTRIBUTES.USER_PASSWORD, Radius.encryptUserPassword(password, secret, requestAuthenticator)),
        ...nasAttributes,
        ...attrs
    ]);
    return { packet, requestAuthenticator };
}

function buildChapAccessRequest({ id, username, password }) {
    const requestAuthenticator = crypto.randomBytes(16);
    const challenge = crypto.randomBytes(16);
    const packet = Radius.buildPacket(RADIUS_CODES.ACCESS_REQUEST, id, requestAuthenticator, [
        Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, username),
        Radius.attr(RADIUS_ATTRIBUTES.CHAP_PASSWORD, Radius.buildChapPassword(7, password, challenge)),
        Radius.attr(RADIUS_ATTRIBUTES.CHAP_CHALLENGE, challenge),
        Radius.ipAttr(RADIUS_ATTRIBUTES.NAS_IP_ADDRESS, HOST)
    ]);
    return { packet, requestAuthenticator };
}

function assertRfc2865PasswordExample() {
    const request = Buffer.from(
        '010000380f403f9473978057bd83d5cb98f4227a01066e656d6f02120dbe708d93d413ce3196e43f782a0aee0406c0a80110050600000003',
        'hex'
    );
    const packet = Radius.parsePacket(request);
    const passwordAttr = Radius.getFirstAttribute(packet, RADIUS_ATTRIBUTES.USER_PASSWORD);
    const decoded = Radius.decryptUserPassword(passwordAttr.value, 'xyzzy5461', packet.authenticator);
    assert.equal(decoded, 'arctangent');
}

async function main() {
    assertRfc2865PasswordExample();

    const secret = 'radius-secret';
    const ipv6Available = await ipv6LoopbackAvailable();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radius-config-'));
    const configFilePath = await ensureRadiusDefaultConfigFile(userDataDir);
    const generatedConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    assert.ok(
        generatedConfig.clients.some(client => client.ipAddress === HOST),
        'default radius config contains IPv4 client defaults'
    );
    assert.ok(
        generatedConfig.clients.some(client => client.ipAddress === HOST6),
        'default radius config contains IPv6 client defaults'
    );
    assert.ok(generatedConfig.users.length > 0, 'default radius config contains user defaults');

    fs.writeFileSync(
        configFilePath,
        JSON.stringify(
            {
                sharedSecret: secret,
                rejectUnknownClients: true,
                clients: [
                    { name: 'loopback', ipAddress: HOST, secret },
                    { name: 'loopback-v6', ipAddress: HOST6, secret }
                ],
                users: [
                    {
                        username: 'demo',
                        password: 'demo',
                        enabled: true,
                        authType: 'PAP',
                        serviceType: RADIUS_SERVICE_TYPES.FRAMED,
                        framedProtocol: 1,
                        framedIpAddress: '10.10.10.10',
                        framedIpv6Prefix: '2001:db8:100::/64',
                        replyMessage: 'ok'
                    },
                    {
                        username: 'chap',
                        password: 'chap',
                        enabled: true,
                        authType: 'CHAP',
                        serviceType: RADIUS_SERVICE_TYPES.FRAMED,
                        framedProtocol: 1
                    }
                ]
            },
            null,
            2
        ),
        'utf8'
    );

    const runtimeConfig = await loadRadiusRuntimeConfig({
        authPort: 0,
        accountingPort: 0,
        coaPort: 0,
        bindAddress: HOST,
        bindAddress6: HOST6,
        enableAuth: true,
        enableAccounting: true,
        enableDynamicAuth: true,
        enableIpv6: ipv6Available
    }, { configFilePath });
    assert.equal(runtimeConfig.sharedSecret, secret);
    assert.equal(runtimeConfig.users.length, 2);
    assert.equal(runtimeConfig.clients.length, 2);

    const workerPath = path.join(__dirname, '..', '..', 'electron', 'worker', 'services', 'radiusWorker.js');
    const worker = new WorkerWithPromise(workerPath).createLongRunningWorker();

    try {
        const start = await worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.START_RADIUS, runtimeConfig);

        const { authPort, accountingPort, coaPort } = start.data;
        assert.ok(authPort > 0, 'auth port assigned');
        assert.ok(accountingPort > 0, 'accounting port assigned');
        assert.ok(coaPort > 0, 'coa port assigned');
        if (ipv6Available) {
            assert.ok(start.data.authPort6 > 0, 'IPv6 auth port assigned');
            assert.ok(start.data.accountingPort6 > 0, 'IPv6 accounting port assigned');
            assert.ok(start.data.coaPort6 > 0, 'IPv6 coa port assigned');
        }

        const papReq = buildAccessRequest({ id: 11, username: 'demo', password: 'demo', secret });
        const papResp = await sendUdp(authPort, papReq.packet);
        assert.equal(papResp.code, RADIUS_CODES.ACCESS_ACCEPT);
        assert.equal(Radius.getIp(papResp, RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS), '10.10.10.10');
        verifyResponseAuthenticator(papResp, papReq.requestAuthenticator, secret);

        const rejectReq = buildAccessRequest({ id: 12, username: 'demo', password: 'bad', secret });
        const rejectResp = await sendUdp(authPort, rejectReq.packet);
        assert.equal(rejectResp.code, RADIUS_CODES.ACCESS_REJECT);
        verifyResponseAuthenticator(rejectResp, rejectReq.requestAuthenticator, secret);

        const chapReq = buildChapAccessRequest({ id: 13, username: 'chap', password: 'chap' });
        const chapResp = await sendUdp(authPort, chapReq.packet);
        assert.equal(chapResp.code, RADIUS_CODES.ACCESS_ACCEPT);
        verifyResponseAuthenticator(chapResp, chapReq.requestAuthenticator, secret);

        const acctSessionId = 'sess-1001';
        const acctReq = Radius.buildAccountingLikeRequestPacket(
            RADIUS_CODES.ACCOUNTING_REQUEST,
            21,
            [
                Radius.integerAttr(RADIUS_ATTRIBUTES.ACCT_STATUS_TYPE, RADIUS_ACCT_STATUS_TYPES.START),
                Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, 'demo'),
                Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, acctSessionId),
                Radius.ipAttr(RADIUS_ATTRIBUTES.NAS_IP_ADDRESS, HOST),
                Radius.integerAttr(RADIUS_ATTRIBUTES.NAS_PORT, 9),
                Radius.ipAttr(RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS, '10.10.10.10')
            ],
            secret
        );
        const acctParsed = Radius.parsePacket(acctReq);
        const acctResp = await sendUdp(accountingPort, acctReq);
        assert.equal(acctResp.code, RADIUS_CODES.ACCOUNTING_RESPONSE);
        verifyResponseAuthenticator(acctResp, acctParsed.authenticator, secret);

        const coaReq = Radius.buildAccountingLikeRequestPacket(
            RADIUS_CODES.COA_REQUEST,
            31,
            [
                Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, acctSessionId),
                Radius.stringAttr(RADIUS_ATTRIBUTES.FILTER_ID, 'lab-filter')
            ],
            secret,
            { includeMessageAuthenticator: true }
        );
        const coaParsed = Radius.parsePacket(coaReq);
        assert.ok(Radius.verifyDynamicRequestMessageAuthenticator(coaParsed, secret));
        const coaResp = await sendUdp(coaPort, coaReq);
        assert.equal(coaResp.code, RADIUS_CODES.COA_ACK);
        verifyResponseAuthenticator(coaResp, coaParsed.authenticator, secret);

        const disconnectReq = Radius.buildAccountingLikeRequestPacket(
            RADIUS_CODES.DISCONNECT_REQUEST,
            32,
            [Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, acctSessionId)],
            secret
        );
        const disconnectParsed = Radius.parsePacket(disconnectReq);
        const disconnectResp = await sendUdp(coaPort, disconnectReq);
        assert.equal(disconnectResp.code, RADIUS_CODES.DISCONNECT_ACK);
        verifyResponseAuthenticator(disconnectResp, disconnectParsed.authenticator, secret);

        const sessions = await worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.GET_SESSION_LIST, null);
        assert.equal(sessions.data.length, 0);

        if (ipv6Available) {
            const pap6Req = buildAccessRequest({
                id: 41,
                username: 'demo',
                password: 'demo',
                secret,
                nasAttributes: [Radius.ipv6Attr(RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS, HOST6)]
            });
            const pap6Resp = await sendUdp(start.data.authPort6, pap6Req.packet, 'udp6', HOST6);
            assert.equal(pap6Resp.code, RADIUS_CODES.ACCESS_ACCEPT);
            assert.equal(Radius.getIpv6Prefix(pap6Resp, RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX), '2001:db8:100::/64');
            verifyResponseAuthenticator(pap6Resp, pap6Req.requestAuthenticator, secret);

            const acct6SessionId = 'sess-v6-1001';
            const acct6Req = Radius.buildAccountingLikeRequestPacket(
                RADIUS_CODES.ACCOUNTING_REQUEST,
                42,
                [
                    Radius.integerAttr(RADIUS_ATTRIBUTES.ACCT_STATUS_TYPE, RADIUS_ACCT_STATUS_TYPES.START),
                    Radius.stringAttr(RADIUS_ATTRIBUTES.USER_NAME, 'demo'),
                    Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, acct6SessionId),
                    Radius.ipv6Attr(RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS, HOST6),
                    Radius.integerAttr(RADIUS_ATTRIBUTES.NAS_PORT, 10),
                    Radius.ipv6PrefixAttr(RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX, '2001:db8:100::/64')
                ],
                secret
            );
            const acct6Parsed = Radius.parsePacket(acct6Req);
            const acct6Resp = await sendUdp(start.data.accountingPort6, acct6Req, 'udp6', HOST6);
            assert.equal(acct6Resp.code, RADIUS_CODES.ACCOUNTING_RESPONSE);
            verifyResponseAuthenticator(acct6Resp, acct6Parsed.authenticator, secret);

            const sessions6 = await worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.GET_SESSION_LIST, null);
            assert.equal(sessions6.data.length, 1);
            assert.equal(sessions6.data[0].nasIpv6Address, HOST6);
            assert.equal(sessions6.data[0].framedIpv6Prefix, '2001:db8:100::/64');

            const disconnect6Req = Radius.buildAccountingLikeRequestPacket(
                RADIUS_CODES.DISCONNECT_REQUEST,
                43,
                [Radius.stringAttr(RADIUS_ATTRIBUTES.ACCT_SESSION_ID, acct6SessionId)],
                secret
            );
            const disconnect6Parsed = Radius.parsePacket(disconnect6Req);
            const disconnect6Resp = await sendUdp(start.data.coaPort6, disconnect6Req, 'udp6', HOST6);
            assert.equal(disconnect6Resp.code, RADIUS_CODES.DISCONNECT_ACK);
            verifyResponseAuthenticator(disconnect6Resp, disconnect6Parsed.authenticator, secret);
        } else {
            console.log('IPv6 loopback unavailable; skipped IPv6 UDP checks');
        }

        await worker.sendRequest(RadiusConst.RADIUS_REQ_TYPES.STOP_RADIUS, null);
    } finally {
        await worker.terminate();
    }

    console.log('radius_protocol tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
