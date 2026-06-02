import { createRouter, createWebHashHistory } from 'vue-router';
import Main from '../view/Main.vue';
import ToolMain from '../view/tools/ToolMain.vue';
import StringGenerator from '../view/tools/StringGenerator.vue';
import PacketParser from '../view/tools/PacketParser.vue';
import Formatter from '../view/tools/Formatter.vue';
import PacketCapture from '../view/tools/PacketCapture.vue';
import PortMonitor from '../view/tools/PortMonitor.vue';
import NetworkInfo from '../view/tools/NetworkInfo.vue';
import TcpAoMac from '../view/tools/TcpAoMac.vue';
import BgpMain from '../view/bgp/BgpMain.vue';
import BgpConfig from '../view/bgp/BgpConfig.vue';
import BgpPeerConfig from '../view/bgp/BgpPeerConfig.vue';
import RouteIpv4 from '../view/bgp/RouteIpv4.vue';
import RouteIpv6 from '../view/bgp/RouteIpv6.vue';
import RouteMvpn from '../view/bgp/RouteMvpn.vue';
import RouteIpv4Qp from '../view/bgp/RouteIpv4Qp.vue';
import RouteIpv6Qp from '../view/bgp/RouteIpv6Qp.vue';
import BmpMain from '../view/bmp/BmpMain.vue';
import BmpConfig from '../view/bmp/BmpConfig.vue';
import BgpSession from '../view/bmp/BgpSession.vue';
import BgpLocRib from '../view/bmp/BgpLocRib.vue';
import BgpSessionStatisReport from '../view/bmp/BgpSessionStatisReport.vue';
import BgpLocRibStatisReport from '../view/bmp/BgpLocRibStatisReport.vue';
import RpkiMain from '../view/rpki/RpkiMain.vue';
import RpkiConfig from '../view/rpki/RpkiConfig.vue';
import RpkiRoaConfig from '../view/rpki/RpkiRoaConfig.vue';
import RpkiRouterKeyConfig from '../view/rpki/RpkiRouterKeyConfig.vue';
import RpkiAspaConfig from '../view/rpki/RpkiAspaConfig.vue';
import FtpMain from '../view/ftp/FtpMain.vue';
import FtpConfig from '../view/ftp/FtpConfig.vue';
import SnmpMain from '../view/snmp/SnmpMain.vue';
import SnmpConfig from '../view/snmp/SnmpConfig.vue';
import SnmpTrap from '../view/snmp/SnmpTrap.vue';
import DhcpMain from '../view/dhcp/DhcpMain.vue';
import DhcpConfig from '../view/dhcp/DhcpConfig.vue';
import DhcpLeaseList from '../view/dhcp/DhcpLeaseList.vue';
import NtpMain from '../view/ntp/NtpMain.vue';
import NtpConfig from '../view/ntp/NtpConfig.vue';
import NtpRequestLog from '../view/ntp/NtpRequestLog.vue';
import store from '../store';

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
                children: [
                    {
                        path: '/',
                        redirect: '/tools/string-generator'
                    },
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
                        path: 'formatter',
                        name: 'Formatter',
                        component: Formatter,
                        meta: { keepAlive: true }
                    },
                    {
                        path: 'packet-capture',
                        name: 'PacketCapture',
                        component: PacketCapture,
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
                    }
                ]
            },
            {
                path: '/bgp',
                component: BgpMain,
                name: 'BgpMain',
                meta: { keepAlive: true },
                children: [
                    {
                        path: '/',
                        redirect: '/bgp/bgp-config'
                    },
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
                children: [
                    {
                        path: '/',
                        redirect: '/bmp/bmp-config'
                    },
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
                children: [
                    {
                        path: '/',
                        redirect: '/rpki/rpki-config'
                    },
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
                children: [
                    {
                        path: '/',
                        redirect: '/ftp/ftp-config'
                    },
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
                children: [
                    {
                        path: '/',
                        redirect: '/snmp/snmp-config'
                    },
                    {
                        path: 'snmp-config',
                        name: 'SnmpConfig',
                        component: SnmpConfig,
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
                children: [
                    {
                        path: '/',
                        redirect: '/dhcp/dhcp-config'
                    },
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
                children: [
                    {
                        path: '/',
                        redirect: '/ntp/ntp-config'
                    },
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
