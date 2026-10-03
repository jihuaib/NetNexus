const assert = require('node:assert/strict');
const http = require('node:http');
const ExternalApiServer = require('../../electron/app/externalApiServer');
const createBmpApiRoutes = require('../../electron/app/bmpApiRoutes');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const { parseBgpLsNlri } = require('../../electron/utils/bgpAddressFamily/bgpLs');
const { canonicalizeRouteIdentity, formatRouteLookupKey } = require('../../electron/utils/bmpPersistentRouteKey');
const { successResponse } = require('../../electron/utils/responseUtils');

function u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value);
    return buffer;
}
function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}
function largeRouteKey() {
    const node = tlv(
        256,
        Buffer.concat([tlv(512, Buffer.from('0000fde8', 'hex')), tlv(515, Buffer.from('c0000201', 'hex'))])
    );
    const body = Buffer.concat([Buffer.from([3]), Buffer.alloc(8), node, tlv(65000, Buffer.alloc(40000, 0x5a))]);
    const wire = Buffer.concat([u16(1), u16(body.length), body]);
    const parsed = parseBgpLsNlri(wire, 0);
    assert.equal(parsed.route.valid, true, JSON.stringify(parsed.route.errors));
    assert.equal(parsed.position, wire.length);
    const identity = canonicalizeRouteIdentity({ afi: 16388, safi: 71, nlri: parsed.route });
    const key = formatRouteLookupKey(identity);
    assert.ok(Buffer.byteLength(key) > 64 * 1024);
    assert.ok(key.length < 256 * 1024);
    return key;
}

function request(port, pathname, body, contentLength) {
    const text = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': contentLength ?? Buffer.byteLength(text),
                    Connection: 'close'
                }
            },
            res => {
                let response = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    response += chunk;
                });
                res.on('error', reject);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(response) }));
            }
        );
        req.setTimeout(5000, () => req.destroy(new Error('HTTP route key test timed out')));
        req.on('error', reject);
        req.end(text);
    });
}

async function main() {
    const routeKey = largeRouteKey();
    const calls = [];
    const accept = async payload => {
        calls.push(payload);
        assert.equal(payload.routeKey, routeKey);
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'routeId'), false);
        return successResponse({ acceptedKey: payload.routeKey });
    };
    // The persistence endpoint already has an optional internal routeId filter;
    // it does not participate in the public route detail lookup contract.
    const bmpApp = {
        getBmpRunning: () => true,
        queryBgpRouteDetail: accept,
        queryBgpInstanceRouteDetail: accept,
        queryPersistedRoutes: async payload => {
            calls.push(payload);
            assert.equal(payload.routeKey, routeKey);
            return successResponse({ acceptedKey: payload.routeKey });
        }
    };
    const routes = createBmpApiRoutes(bmpApp);
    const allowed = [
        '/api/v1/bmp/routes/detail',
        '/api/v1/bmp/instances/routes/detail',
        '/api/v1/bmp/persistence/routes'
    ];
    assert.deepEqual(
        routes
            .filter(route => route.maxBodyBytes !== undefined)
            .map(route => route.path)
            .sort(),
        allowed.slice().sort()
    );
    assert.ok(routes.filter(route => allowed.includes(route.path)).every(route => route.maxBodyBytes === 512 * 1024));
    let ordinaryCalls = 0;
    const server = new ExternalApiServer();
    server.setRoutes([
        ...routes,
        {
            method: 'POST',
            path: '/ordinary-query',
            handler: async () => {
                ordinaryCalls += 1;
                return successResponse(null);
            }
        }
    ]);
    // Port zero binds a private ephemeral loopback port; no remote service or DB.
    server.settings = { ...server.settings, host: '127.0.0.1', port: 0 };
    await server.start();
    const port = server.server.address().port;
    const client = { localIp: '127.0.0.1', localPort: 11019, remoteIp: '192.0.2.1', remotePort: 50000 };
    const af = getAddrFamilyType(16388, 71);
    const payloads = [
        {
            client,
            session: { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65000 },
            af,
            ribType: 2,
            routeKey
        },
        { client, instance: { instanceType: 3, instanceRd: '0:0', addrFamilyType: af }, routeKey },
        { sourceId: 'a'.repeat(64), scopeId: 'b'.repeat(64), routeKey }
    ];
    try {
        for (const [index, pathname] of allowed.entries()) {
            const result = await request(port, pathname, payloads[index]);
            assert.equal(result.statusCode, 200, pathname);
            assert.equal(result.body.data.acceptedKey, routeKey);
        }
        assert.equal(calls.length, allowed.length);
        const ordinary = await request(port, '/ordinary-query', payloads[0]);
        assert.equal(ordinary.statusCode, 413, 'ordinary API retains its original 64 KiB body limit');
        assert.equal(ordinaryCalls, 0);
        for (const pathname of allowed) {
            const oversized = await request(port, pathname, {}, 512 * 1024 + 1);
            assert.equal(oversized.statusCode, 413);
            assert.equal(oversized.body.code, 'REQUEST_TOO_LARGE');
        }
        assert.equal(calls.length, allowed.length, 'oversized BMP requests must not reach a persistence query');
        for (const limit of [0, -1, 1.5, Infinity, 512 * 1024 + 1]) {
            await assert.rejects(server.readJsonBody({}, limit), { code: 'INVALID_BODY_LIMIT' });
        }
    } finally {
        await server.stop();
    }
    console.log('BMP real HTTP complete routeKey body-limit tests passed');
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
