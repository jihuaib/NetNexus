const { buildFeaturePageBrowserMockScript } = require('./common');
const { bgpPageApiScript } = require('./bgp');
const { dhcpPageApiScript } = require('./dhcp');
const { ftpPageApiScript } = require('./ftp');
const { grpcPageApiScript } = require('./grpc');
const { nativePageApiScript } = require('./native');
const { ntpPageApiScript } = require('./ntp');
const { radiusPageApiScript } = require('./radius');
const { rpkiPageApiScript } = require('./rpki');
const { snmpPageApiScript } = require('./snmp');
const { syslogPageApiScript } = require('./syslog');
const { tftpPageApiScript } = require('./tftp');
const { toolsPageApiScript } = require('./tools');
const { yangPageApiScript } = require('./yang');

const featurePageBrowserMockScript = buildFeaturePageBrowserMockScript([
    toolsPageApiScript,
    nativePageApiScript,
    rpkiPageApiScript,
    ftpPageApiScript,
    grpcPageApiScript,
    dhcpPageApiScript,
    snmpPageApiScript,
    ntpPageApiScript,
    radiusPageApiScript,
    tftpPageApiScript,
    syslogPageApiScript,
    bgpPageApiScript,
    yangPageApiScript
]);

module.exports = {
    featurePageBrowserMockScript
};
