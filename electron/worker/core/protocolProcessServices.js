const PROTOCOL_PROCESS_SERVICES = Object.freeze({
    BGP: 'netnexus.protocol.bgp',
    BMP: 'netnexus.protocol.bmp',
    RPKI: 'netnexus.protocol.rpki',
    FTP: 'netnexus.protocol.ftp',
    SNMP: 'netnexus.protocol.snmp',
    DHCP: 'netnexus.protocol.dhcp',
    NTP: 'netnexus.protocol.ntp',
    RADIUS: 'netnexus.protocol.radius',
    TFTP: 'netnexus.protocol.tftp',
    SYSLOG: 'netnexus.protocol.syslog',
    YANG: 'netnexus.protocol.yang',
    NETCONF: 'netnexus.protocol.yang'
});

const PROTOCOL_PROCESS_DISPLAY_NAMES = Object.freeze({
    [PROTOCOL_PROCESS_SERVICES.BGP]: 'BGP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.BMP]: 'BMP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.RPKI]: 'RPKI 协议进程',
    [PROTOCOL_PROCESS_SERVICES.FTP]: 'FTP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.SNMP]: 'SNMP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.DHCP]: 'DHCP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.NTP]: 'NTP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.RADIUS]: 'RADIUS 协议进程',
    [PROTOCOL_PROCESS_SERVICES.TFTP]: 'TFTP 协议进程',
    [PROTOCOL_PROCESS_SERVICES.SYSLOG]: 'Syslog 协议进程',
    [PROTOCOL_PROCESS_SERVICES.YANG]: 'YANG 协议进程'
});

const PROTOCOL_PROCESS_TIMEOUTS = Object.freeze({
    STOP: 30000,
    BMP_STOP: 5 * 60 * 1000
});

function getProtocolProcessDisplayName(serviceName) {
    return PROTOCOL_PROCESS_DISPLAY_NAMES[String(serviceName || '')] || '';
}

module.exports = {
    PROTOCOL_PROCESS_SERVICES,
    PROTOCOL_PROCESS_DISPLAY_NAMES,
    PROTOCOL_PROCESS_TIMEOUTS,
    getProtocolProcessDisplayName
};
