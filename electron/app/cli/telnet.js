const TELNET = {
    IAC: 255,
    DO: 253,
    DONT: 254,
    WILL: 251,
    WONT: 252,
    SB: 250,
    SE: 240,
    ECHO: 1,
    SUPPRESS_GO_AHEAD: 3
};

function negotiationBuffer() {
    return Buffer.from([TELNET.IAC, TELNET.WILL, TELNET.ECHO, TELNET.IAC, TELNET.WILL, TELNET.SUPPRESS_GO_AHEAD]);
}

function toTelnetNewlines(text) {
    return String(text).replace(/(?<!\r)\n/gu, '\r\n');
}

module.exports = {
    TELNET,
    negotiationBuffer,
    toTelnetNewlines
};
