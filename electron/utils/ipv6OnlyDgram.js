const dgram = require('node:dgram');

function socketType(options) {
    return typeof options === 'string' ? options : options?.type;
}

function createIpv6OnlyDgramModule(dgramModule = dgram) {
    return {
        createSocket(...args) {
            if (socketType(args[0]) !== 'udp6') {
                return dgramModule.createSocket(...args);
            }
            const options =
                typeof args[0] === 'string' ? { type: args[0], ipv6Only: true } : { ...args[0], ipv6Only: true };
            return dgramModule.createSocket(options, ...args.slice(1));
        }
    };
}

module.exports = {
    createIpv6OnlyDgramModule,
    socketType
};
