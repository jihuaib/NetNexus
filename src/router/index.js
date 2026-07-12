import { createRouter, createWebHashHistory } from 'vue-router';
import store from '../store';

const Main = () => import('../view/Main.vue');
const ToolMain = () => import('../view/tools/ToolMain.vue');
const StringGenerator = () => import('../view/tools/StringGenerator.vue');
const PacketParser = () => import('../view/tools/PacketParser.vue');
const PortMonitor = () => import('../view/tools/PortMonitor.vue');
const NetworkInfo = () => import('../view/tools/NetworkInfo.vue');
const TcpAoMac = () => import('../view/tools/TcpAoMac.vue');
const HttpApiTester = () => import('../view/tools/HttpApiTester.vue');
const TcpTool = () => import('../view/tools/TcpTool.vue');
const UdpTool = () => import('../view/tools/UdpTool.vue');
const BgpMain = () => import('../view/bgp/BgpMain.vue');
const BgpConfig = () => import('../view/bgp/BgpConfig.vue');
const BgpPeerConfig = () => import('../view/bgp/BgpPeerConfig.vue');
const RouteIpv4 = () => import('../view/bgp/RouteIpv4.vue');
const RouteIpv6 = () => import('../view/bgp/RouteIpv6.vue');
const RouteMvpn = () => import('../view/bgp/RouteMvpn.vue');
const RouteIpv4Qp = () => import('../view/bgp/RouteIpv4Qp.vue');
const RouteIpv6Qp = () => import('../view/bgp/RouteIpv6Qp.vue');
const BmpMain = () => import('../view/bmp/BmpMain.vue');
const BmpConfig = () => import('../view/bmp/BmpConfig.vue');
const BgpSession = () => import('../view/bmp/BgpSession.vue');
const BgpLocRib = () => import('../view/bmp/BgpLocRib.vue');
const BgpSessionStatisReport = () => import('../view/bmp/BgpSessionStatisReport.vue');
const BgpLocRibStatisReport = () => import('../view/bmp/BgpLocRibStatisReport.vue');
const RpkiMain = () => import('../view/rpki/RpkiMain.vue');
const RpkiConfig = () => import('../view/rpki/RpkiConfig.vue');
const RpkiRoaConfig = () => import('../view/rpki/RpkiRoaConfig.vue');
const RpkiRouterKeyConfig = () => import('../view/rpki/RpkiRouterKeyConfig.vue');
const RpkiAspaConfig = () => import('../view/rpki/RpkiAspaConfig.vue');
const FtpMain = () => import('../view/ftp/FtpMain.vue');
const FtpConfig = () => import('../view/ftp/FtpConfig.vue');
const SnmpMain = () => import('../view/snmp/SnmpMain.vue');
const SnmpConfig = () => import('../view/snmp/SnmpConfig.vue');
const SnmpMib = () => import('../view/snmp/SnmpMib.vue');
const SnmpTrap = () => import('../view/snmp/SnmpTrap.vue');
const DhcpMain = () => import('../view/dhcp/DhcpMain.vue');
const DhcpConfig = () => import('../view/dhcp/DhcpConfig.vue');
const DhcpLeaseList = () => import('../view/dhcp/DhcpLeaseList.vue');
const NtpMain = () => import('../view/ntp/NtpMain.vue');
const NtpConfig = () => import('../view/ntp/NtpConfig.vue');
const NtpRequestLog = () => import('../view/ntp/NtpRequestLog.vue');
const RadiusMain = () => import('../view/radius/RadiusMain.vue');
const RadiusConfig = () => import('../view/radius/RadiusConfig.vue');
const RadiusRequestLog = () => import('../view/radius/RadiusRequestLog.vue');
const RadiusSession = () => import('../view/radius/RadiusSession.vue');
const TftpMain = () => import('../view/tftp/TftpMain.vue');
const TftpConfig = () => import('../view/tftp/TftpConfig.vue');
const TftpTransferLog = () => import('../view/tftp/TftpTransferLog.vue');
const SyslogMain = () => import('../view/syslog/SyslogMain.vue');
const SyslogConfig = () => import('../view/syslog/SyslogConfig.vue');
const SyslogMessageLog = () => import('../view/syslog/SyslogMessageLog.vue');

const routes = [
    {
        path: '/',
        component: Main,
        name: 'Main',
        meta: { keepAlive: true },
        children: [
            { path: '/', redirect: '/tools' },
            {
                path: '/tools',
                component: ToolMain,
                name: 'ToolMain',
                meta: { keepAlive: true },
                redirect: '/tools/string-generator',
                children: [
                    {
                        path: 'string-generator',
                        name: 'StringGenerator',
                        component: StringGenerator,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'packet-parser',
                        name: 'PacketParser',
                        component: PacketParser,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'port-monitor',
                        name: 'PortMonitor',
                        component: PortMonitor,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'network-info',
                        name: 'NetworkInfo',
                        component: NetworkInfo,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'tcp-ao-mac',
                        name: 'TcpAoMac',
                        component: TcpAoMac,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'http-api-tester',
                        name: 'HttpApiTester',
                        component: HttpApiTester,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'tcp-tool',
                        name: 'TcpTool',
                        component: TcpTool,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'udp-tool',
                        name: 'UdpTool',
                        component: UdpTool,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/bgp',
                component: BgpMain,
                name: 'BgpMain',
                meta: { keepAlive: true },
                redirect: '/bgp/bgp-config',
                children: [
                    {
                        path: 'bgp-config',
                        name: 'BgpConfig',
                        component: BgpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'bgp-peer-config',
                        name: 'BgpPeerConfig',
                        component: BgpPeerConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'route-ipv4',
                        name: 'RouteIpv4',
                        component: RouteIpv4,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'route-ipv6',
                        name: 'RouteIpv6',
                        component: RouteIpv6,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'route-mvpn',
                        name: 'RouteMvpn',
                        component: RouteMvpn,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'route-ipv4-qp',
                        name: 'RouteIpv4Qp',
                        component: RouteIpv4Qp,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'route-ipv6-qp',
                        name: 'RouteIpv6Qp',
                        component: RouteIpv6Qp,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/bmp',
                name: 'BmpMain',
                component: BmpMain,
                meta: { keepAlive: true },
                redirect: '/bmp/bmp-config',
                children: [
                    {
                        path: 'bmp-config',
                        name: 'BmpConfig',
                        component: BmpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'bgp-session',
                        name: 'BgpSession',
                        component: BgpSession,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'bgp-loc-rib',
                        name: 'BgpLocRib',
                        component: BgpLocRib,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'bgp-session-statis-report',
                        name: 'BgpSessionStatisReport',
                        component: BgpSessionStatisReport,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'bgp-loc-rib-statis-report',
                        name: 'BgpLocRibStatisReport',
                        component: BgpLocRibStatisReport,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/rpki',
                name: 'RpkiMain',
                component: RpkiMain,
                meta: { keepAlive: true },
                redirect: '/rpki/rpki-config',
                children: [
                    {
                        path: 'rpki-config',
                        name: 'RpkiConfig',
                        component: RpkiConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'rpki-roa-config',
                        name: 'RpkiRoaConfig',
                        component: RpkiRoaConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'rpki-router-key-config',
                        name: 'RpkiRouterKeyConfig',
                        component: RpkiRouterKeyConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'rpki-aspa-config',
                        name: 'RpkiAspaConfig',
                        component: RpkiAspaConfig,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/ftp',
                name: 'FtpMain',
                component: FtpMain,
                meta: { keepAlive: true },
                redirect: '/ftp/ftp-config',
                children: [
                    {
                        path: 'ftp-config',
                        name: 'FtpConfig',
                        component: FtpConfig,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/snmp',
                name: 'SnmpMain',
                component: SnmpMain,
                meta: { keepAlive: true },
                redirect: '/snmp/snmp-config',
                children: [
                    {
                        path: 'snmp-config',
                        name: 'SnmpConfig',
                        component: SnmpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'snmp-mib',
                        name: 'SnmpMib',
                        component: SnmpMib,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'snmp-trap',
                        name: 'SnmpTrap',
                        component: SnmpTrap,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/dhcp',
                name: 'DhcpMain',
                component: DhcpMain,
                meta: { keepAlive: true },
                redirect: '/dhcp/dhcp-config',
                children: [
                    {
                        path: 'dhcp-config',
                        name: 'DhcpConfig',
                        component: DhcpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'dhcp-lease',
                        name: 'DhcpLeaseList',
                        component: DhcpLeaseList,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/ntp',
                name: 'NtpMain',
                component: NtpMain,
                meta: { keepAlive: true },
                redirect: '/ntp/ntp-config',
                children: [
                    {
                        path: 'ntp-config',
                        name: 'NtpConfig',
                        component: NtpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'ntp-request-log',
                        name: 'NtpRequestLog',
                        component: NtpRequestLog,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/radius',
                name: 'RadiusMain',
                component: RadiusMain,
                meta: { keepAlive: true },
                redirect: '/radius/radius-config',
                children: [
                    {
                        path: 'radius-config',
                        name: 'RadiusConfig',
                        component: RadiusConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'radius-request-log',
                        name: 'RadiusRequestLog',
                        component: RadiusRequestLog,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'radius-session',
                        name: 'RadiusSession',
                        component: RadiusSession,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/tftp',
                name: 'TftpMain',
                component: TftpMain,
                meta: { keepAlive: true },
                redirect: '/tftp/tftp-config',
                children: [
                    {
                        path: 'tftp-config',
                        name: 'TftpConfig',
                        component: TftpConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'tftp-transfer-log',
                        name: 'TftpTransferLog',
                        component: TftpTransferLog,
                        meta: { keepAlive: true }
                    }
                ]
            },
            {
                path: '/syslog',
                name: 'SyslogMain',
                component: SyslogMain,
                meta: { keepAlive: true },
                redirect: '/syslog/syslog-config',
                children: [
                    {
                        path: 'syslog-config',
                        name: 'SyslogConfig',
                        component: SyslogConfig,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'syslog-message-log',
                        name: 'SyslogMessageLog',
                        component: SyslogMessageLog,
                        meta: { keepAlive: true }
                    }
                ]
            }
        ]
    }
];

const router = createRouter({
    history: createWebHashHistory(),
    routes
});

router.beforeEach((to, _from, next) => {
    if (to.name && to.meta && to.meta.keepAlive) {
        store.dispatch('addCachedView', to);
        let matched = to.matched;
        matched.forEach(record => {
            if (record.name && record.meta.keepAlive) {
                store.dispatch('addCachedView', record);
            }
        });
    }
    next();
});

export default router;
