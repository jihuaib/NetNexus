import { defineConfig } from 'vitepress';

const repositoryUrl = 'https://github.com/jihuaib/NetNexus';

export default defineConfig({
    lang: 'zh-CN',
    title: 'NetNexus 文档',
    titleTemplate: ':title | NetNexus',
    description: 'NetNexus 网络协议工具集的功能、开发与 API 文档。',
    base: '/NetNexus/',
    lastUpdated: true,
    sitemap: {
        hostname: 'https://jihuaib.github.io/NetNexus/'
    },
    head: [['meta', { name: 'theme-color', content: '#ea6a13' }]],
    themeConfig: {
        siteTitle: 'NetNexus',
        nav: [
            { text: '首页', link: '/' },
            { text: '功能文档', link: '/BGP_SIMULATOR' },
            { text: '开发指南', link: '/DEVELOPMENT' },
            {
                text: '参考',
                items: [
                    { text: '外部 API', link: '/API' },
                    { text: 'BMP SQLite 数据库', link: '/BMP_SQLITE_DATABASE' },
                    { text: 'Huawei BMP E2E', link: '/HUAWEI_BMP_E2E' }
                ]
            },
            { text: 'PDF 手册', link: '/NetNexus/netnexus-docs.pdf', target: '_blank' },
            { text: 'GitHub', link: repositoryUrl }
        ],
        sidebar: [
            {
                text: '开始',
                items: [
                    { text: '文档首页', link: '/' },
                    { text: '开发与运行', link: '/DEVELOPMENT' },
                    { text: '设置', link: '/SETTINGS' }
                ]
            },
            {
                text: '路由与管理协议',
                items: [
                    { text: 'BGP 模拟器', link: '/BGP_SIMULATOR' },
                    { text: 'BMP 监控器', link: '/BMP_MONITOR' },
                    { text: 'RPKI RTR 服务', link: '/RPKI_VALIDATOR' },
                    { text: 'SNMP 工具', link: '/SNMP_MANAGER' },
                    { text: 'NETCONF / YANG', link: '/NETCONF_YANG' }
                ]
            },
            {
                text: '本地服务器',
                collapsed: true,
                items: [
                    { text: 'FTP 服务器', link: '/FTP_SERVER' },
                    { text: 'DHCP 服务器', link: '/DHCP_SERVER' },
                    { text: 'NTP 服务器', link: '/NTP_SERVER' },
                    { text: 'RADIUS 服务器', link: '/RADIUS_SERVER' },
                    { text: 'TFTP 服务器', link: '/TFTP_SERVER' },
                    { text: 'Syslog 服务器', link: '/SYSLOG_SERVER' }
                ]
            },
            {
                text: '工具',
                items: [{ text: '工具集合', link: '/TOOLS' }]
            },
            {
                text: '参考',
                collapsed: true,
                items: [
                    { text: '外部 API', link: '/API' },
                    { text: 'BMP SQLite 数据库', link: '/BMP_SQLITE_DATABASE' },
                    { text: 'Huawei BMP 真机 E2E', link: '/HUAWEI_BMP_E2E' }
                ]
            }
        ],
        search: {
            provider: 'local'
        },
        socialLinks: [{ icon: 'github', link: repositoryUrl }],
        editLink: {
            pattern: `${repositoryUrl}/edit/master/docs/:path`,
            text: '在 GitHub 上编辑此页'
        },
        outline: {
            level: [2, 3],
            label: '本页内容'
        },
        docFooter: {
            prev: '上一篇',
            next: '下一篇'
        },
        lastUpdated: {
            text: '最后更新于',
            formatOptions: {
                dateStyle: 'medium',
                timeStyle: 'short'
            }
        },
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '文档导航',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        footer: {
            message: '基于 MIT License 发布',
            copyright: 'Copyright © 2026 NetNexus'
        }
    }
});
