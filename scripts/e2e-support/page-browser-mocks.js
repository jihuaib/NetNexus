const { buildFeaturePageBrowserMockScript } = require('./common');
const { bgpPageApiScript } = require('./bgp');
const { dhcpPageApiScript } = require('./dhcp');
const { ftpPageApiScript } = require('./ftp');
const { nativePageApiScript } = require('./native');
const { ntpPageApiScript } = require('./ntp');
const { rpkiPageApiScript } = require('./rpki');
const { snmpPageApiScript } = require('./snmp');
const { syslogPageApiScript } = require('./syslog');
const { tftpPageApiScript } = require('./tftp');
const { toolsPageApiScript } = require('./tools');

const featurePageBrowserMockScript = buildFeaturePageBrowserMockScript([
    toolsPageApiScript,
    nativePageApiScript,
    rpkiPageApiScript,
    ftpPageApiScript,
    dhcpPageApiScript,
    snmpPageApiScript,
    ntpPageApiScript,
    tftpPageApiScript,
    syslogPageApiScript,
    bgpPageApiScript
]);

module.exports = {
    featurePageBrowserMockScript
};
