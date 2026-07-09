const assert = require('assert');
const Module = require('module');
const path = require('path');

const electronMock = {
    app: {
        isPackaged: false
    }
};

const originalLoad = Module._load;
Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') {
        return electronMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

let NativeApp;
try {
    NativeApp = require(path.join(__dirname, '..', '..', 'electron', 'app', 'nativeApp.js'));
} finally {
    Module._load = originalLoad;
}

const nativeApp = new NativeApp({
    handle() {}
});

const getRouteScript = nativeApp.buildWindowsGetRouteScript();
assert.match(getRouteScript, /Get-NetRoute \| Select-Object/u);
assert.doesNotMatch(getRouteScript, /;\s*\|/u);

const jsonRoutes = nativeApp.parseWindowsRouteJson(
    '\uFEFFWARNING: sample warning\r\n' +
        JSON.stringify([
            {
                DestinationPrefix: '0.0.0.0/0',
                NextHop: '192.0.2.1',
                InterfaceAlias: 'Ethernet',
                InterfaceIndex: 12,
                RouteMetric: 25,
                Protocol: 'NetMgmt',
                State: 'Alive',
                AddressFamily: 2
            },
            {
                DestinationPrefix: '2001:db8::/64',
                NextHop: 'fe80::1',
                InterfaceAlias: '以太网',
                InterfaceIndex: 13,
                RouteMetric: 35,
                Protocol: 'Local',
                State: 'Alive',
                AddressFamily: 23
            }
        ])
);
assert.equal(jsonRoutes.length, 2);
assert.equal(jsonRoutes[0].family, 'IPv4');
assert.equal(jsonRoutes[0].destinationPrefix, '0.0.0.0/0');
assert.equal(jsonRoutes[0].gateway, '192.0.2.1');
assert.equal(jsonRoutes[1].family, 'IPv6');
assert.equal(jsonRoutes[1].interfaceName, '以太网');

const warningWithBracketRoutes = nativeApp.parseWindowsRouteJson(
    'WARNING: [NetRoute] sample warning\r\n' +
        JSON.stringify({
            DestinationPrefix: '192.0.2.0/24',
            NextHop: '0.0.0.0',
            InterfaceAlias: 'Ethernet',
            InterfaceIndex: 12,
            AddressFamily: 'IPv4'
        })
);
assert.equal(warningWithBracketRoutes.length, 1);
assert.equal(warningWithBracketRoutes[0].destinationPrefix, '192.0.2.0/24');

const utf16Output = Buffer.from('\uFEFF[{"DestinationPrefix":"::1/128"}]', 'utf16le');
assert.equal(nativeApp.decodeCommandOutput(utf16Output, 'utf8'), '[{"DestinationPrefix":"::1/128"}]');

const routePrintOutput = `
===========================================================================
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.0.2.1    192.0.2.10     25
        127.0.0.0        255.0.0.0         On-link       127.0.0.1    331
Persistent Routes:
  None
===========================================================================
IPv6 Route Table
===========================================================================
Active Routes:
 If Metric Network Destination      Gateway
 13    281 ::/0                     fe80::1
  1    331 ::1/128                  On-link
`;
const routePrintRoutes = nativeApp.parseWindowsRoutePrintOutput(routePrintOutput);
assert.equal(routePrintRoutes.length, 4);
assert.deepEqual(
    routePrintRoutes.map(route => route.destinationPrefix),
    ['0.0.0.0/0', '127.0.0.0/8', '::/0', '::1/128']
);
assert.equal(routePrintRoutes[0].gateway, '192.0.2.1');
assert.equal(routePrintRoutes[1].gateway, 'On-link');
assert.equal(routePrintRoutes[2].interfaceIndex, 13);
assert.equal(routePrintRoutes[2].gateway, 'fe80::1');

const localizedRoutePrintOutput = `
IPv4 路由表
活动路由:
网络目标        网络掩码          网关       接口  跃点数
       10.0.0.0    255.255.255.0       在链路上       10.0.0.10    281
IPv6 路由表
活动路由:
 如果 跃点数 网络目标 网关
 14    281 fe80::/64                在链路上
`;
const localizedRoutes = nativeApp.parseWindowsRoutePrintOutput(localizedRoutePrintOutput);
assert.equal(localizedRoutes.length, 2);
assert.equal(localizedRoutes[0].destinationPrefix, '10.0.0.0/24');
assert.equal(localizedRoutes[0].gateway, '在链路上');
assert.equal(localizedRoutes[1].destinationPrefix, 'fe80::/64');
assert.equal(localizedRoutes[1].gateway, '在链路上');

console.log('Native route parsing tests passed');
