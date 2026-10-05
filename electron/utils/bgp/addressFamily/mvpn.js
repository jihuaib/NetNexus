const { parseFallbackNlri, formatIpAddressList } = require('./common');

function parseMvpnNlri(buffer, position) {
    return parseFallbackNlri(buffer, position);
}

function parseMvpnNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
}

module.exports = {
    parseMvpnNlri,
    parseMvpnNextHop
};
