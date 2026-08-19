const assert = require('node:assert/strict');

const { createIpv6OnlyDgramModule, socketType } = require('../../electron/utils/ipv6OnlyDgram');

function createFakeDgram() {
    const sockets = [];
    return {
        sockets,
        createSocket(options) {
            const socket = {
                options,
                bindCalls: [],
                bind(...args) {
                    this.bindCalls.push(args);
                    return this;
                }
            };
            sockets.push(socket);
            return socket;
        }
    };
}

function main() {
    assert.equal(socketType('udp6'), 'udp6');
    assert.equal(socketType({ type: 'udp4', reuseAddr: true }), 'udp4');

    const fakeDgram = createFakeDgram();
    const ipv6OnlyDgram = createIpv6OnlyDgramModule(fakeDgram);
    const callback = () => {};

    const udp4 = ipv6OnlyDgram.createSocket('udp4');
    udp4.bind(161, '0.0.0.0', callback);
    assert.deepEqual(udp4.bindCalls, [[161, '0.0.0.0', callback]]);

    const udp6 = ipv6OnlyDgram.createSocket('udp6');
    udp6.bind(161, '::', callback);
    assert.deepEqual(udp6.options, { type: 'udp6', ipv6Only: true });
    assert.deepEqual(udp6.bindCalls, [[161, '::', callback]]);

    const objectUdp6 = ipv6OnlyDgram.createSocket({ type: 'udp6', reuseAddr: true });
    objectUdp6.bind({ port: 162, address: '::', ipv6Only: false }, callback);
    assert.deepEqual(objectUdp6.options, { type: 'udp6', reuseAddr: true, ipv6Only: true });
    assert.deepEqual(objectUdp6.bindCalls, [[{ port: 162, address: '::', ipv6Only: false }, callback]]);

    console.log('IPv6-only datagram adapter tests passed');
}

if (require.main === module) main();

module.exports = main;
