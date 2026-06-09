# NetNexus

[![Vue.js](https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vue.js)](https://vuejs.org/)
[![Electron](https://img.shields.io/badge/Electron-15+-47848F?style=flat-square&logo=electron)](https://electronjs.org/)
[![Ant Design Vue](https://img.shields.io/badge/Ant%20Design%20Vue-4.x-1890FF?style=flat-square&logo=ant-design)](https://antdv.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/jihuaib/NetNexus?style=flat-square)](https://github.com/jihuaib/NetNexus/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/jihuaib/NetNexus?style=flat-square)](https://github.com/jihuaib/NetNexus/issues)

**NetNexus** - 一个基于 **Vue3** + **Ant Design Vue** + **Electron** 开发的专业**网络和开发辅助工具集**。

> 🚀 **专业的网络协议工具** | 🛠️ **开发者必备工具** | 🌐 **BGP/BMP/RPKI 全方位支持** | 📦 **跨平台桌面应用**

## 🏷️ 标签关键词

`Vue3` `Electron` `网络工具` `BGP模拟器` `BMP监控器` `RPKI验证器` `报文解析器` `字符串生成器` `网络协议` `路由器工具` `开发工具` `桌面应用` `跨平台` `网络开发` `协议分析` `网络运维` `BGP` `BMP` `RPKI` `Router` `Network Tools` `Developer Tools`

## 功能特性

### 🌐 网络协议工具

#### [BGP 模拟器](docs/BGP_SIMULATOR.md)
专业的 BGP 协议模拟工具，支持多对等体配置、路由传播模拟和可视化监控。

#### [BMP 监控器](docs/BMP_MONITOR.md)
BGP 监控协议工具，提供实时路由监控、数据分析和统计报告功能。

#### [RPKI 验证器](docs/RPKI_VALIDATOR.md)
路由源验证工具，支持 ROA 记录管理和路由合法性验证。

#### [SNMP 管理器](docs/SNMP_MANAGER.md)
专业的 SNMP 网络管理工具，支持设备监控、数据收集和 Trap 消息处理。

#### [FTP 服务器](docs/FTP_SERVER.md)
内置的 FTP 服务器，提供完整的文件传输服务和多用户管理功能。

#### [DHCP 服务器](docs/DHCP_SERVER.md)
内置的 DHCPv4 / DHCPv6 服务器，支持地址池分配、租约查看、租约释放和测试脚本验证。

#### [NTP 服务器](docs/NTP_SERVER.md)
内置的 NTP 时间服务器，支持标准时间响应、时间偏移模拟和请求日志查看。

#### [设置](docs/SETTINGS.md)
应用设置和配置管理，包括通用设置、工具配置、服务器部署和自动更新等。

### 🛠️开发工具集

#### [工具集合](docs/TOOLS.md)
包含报文解析器、字符串生成器、端口监控器、网络信息管理、TCP-AO MAC 计算等多种实用工具。

**核心工具**:
- **报文解析器**: 网络协议报文分析和解析
- **字符串生成器**: 多种模式的字符串生成工具
- **端口监控器**: 系统端口和网络连接实时监控
- **网络信息**: 网络接口管理和 IP 地址配置
- **TCP-AO MAC**: TCP-AO 报文认证码计算

### 🚀 未来计划

- JSON 解析工具
- 网络连接测试工具
- 编码/解码转换工具
- IP 地址计算工具
- DNS 查询与解析工具
- SSL 证书检查工具
- 更多网络协议模拟器

## 技术栈

- **前端框架**: Vue 3 + Composition API
- **UI 组件库**: Ant Design Vue 4.x
- **桌面应用**: Electron 15+
- **构建工具**: Vite
- **状态管理**: Vuex 4
- **路由**: Vue Router 4

## 开发环境要求

- Node.js 16.20.2 或更高版本
- npm 8.19.4 或更高版本
- python 3.8
- 支持的操作系统: Windows 7+, macOS 11+, Linux

## 安装与运行

1. 克隆项目

```bash
git clone https://github.com/jihuaib/NetNexus.git
cd NetNexus
```

2. 安装依赖

```bash
npm install
```

3. 开发模式运行

```bash
# 启动开发环境
npm run dev
```

4. 打包应用

```bash
# 打包应用
npm run dist

# 打包并发布
npm run release
```

## 使用指南

NetNexus 提供直观的图形界面和简单的操作流程，每个功能模块都有详细的使用指南：

- **[BGP 模拟器使用指南](docs/BGP_SIMULATOR.md#使用指南)** - 详细的 BGP 配置和使用说明
- **[BMP 监控器使用指南](docs/BMP_MONITOR.md#使用指南)** - BMP 监控配置和数据分析方法
- **[RPKI 验证器使用指南](docs/RPKI_VALIDATOR.md#使用指南)** - RPKI 配置和路由验证流程
- **[SNMP 管理器使用指南](docs/SNMP_MANAGER.md#使用指南)** - SNMP 设备监控和管理方法
- **[FTP 服务器使用指南](docs/FTP_SERVER.md#使用指南)** - FTP 服务器配置和用户管理
- **[DHCP 服务器使用指南](docs/DHCP_SERVER.md#使用指南)** - DHCPv4 / DHCPv6 配置、租约管理和测试方法
- **[NTP 服务器使用指南](docs/NTP_SERVER.md#使用指南)** - NTP 时间服务配置和测试方法
- **[工具集合使用指南](docs/TOOLS.md#使用指南)** - 各种开发和网络工具的使用方法

### 快速开始

1. **下载安装** - 从 [Releases](https://github.com/jihuaib/NetNexus/releases) 页面下载最新版本
2. **选择功能** - 在主界面选择需要使用的功能模块
3. **查看文档** - 点击上述链接查看对应功能的详细使用指南
4. **开始使用** - 按照指南进行配置和操作

## 项目结构

```
NetNexus/
├── docs/                   # 📚 项目文档
│   ├── BGP_SIMULATOR.md    # BGP 模拟器详细文档
│   ├── BMP_MONITOR.md      # BMP 监控器详细文档
│   ├── RPKI_VALIDATOR.md   # RPKI 验证器详细文档
│   ├── SNMP_MANAGER.md     # SNMP 管理器详细文档
│   ├── FTP_SERVER.md       # FTP 服务器详细文档
│   ├── DHCP_SERVER.md      # DHCP 服务器详细文档
│   ├── NTP_SERVER.md       # NTP 服务器详细文档
│   ├── TOOLS.md            # 工具集合详细文档
│   ├── SETTINGS.md         # 设置功能详细文档
│   └── images/             # 功能截图和示意图
│       ├── bgp/            # BGP 相关图片
│       ├── bmp/            # BMP 相关图片
│       ├── rpki/           # RPKI 相关图片
│       ├── snmp/           # SNMP 相关图片
│       ├── ftp/            # FTP 相关图片
│       ├── tools/          # 工具相关图片
│       └── setting/        # 设置相关图片
├── electron/               # ⚡ Electron 主进程代码
│   ├── app/                # 应用核心模块
│   │   ├── bgpApp.js       # BGP 应用控制器
│   │   ├── bmpApp.js       # BMP 应用控制器
│   │   ├── rpkiApp.js      # RPKI 应用控制器
│   │   ├── snmpApp.js      # SNMP 应用控制器
│   │   ├── ftpApp.js       # FTP 应用控制器
│   │   ├── dhcpApp.js      # DHCP 应用控制器
│   │   ├── ntpApp.js       # NTP 应用控制器
│   │   ├── systemApp.js    # 系统功能控制器
│   │   ├── nativeApp.js    # 原生功能控制器
│   │   └── updater.js      # 自动更新模块
│   ├── worker/             # Worker 进程模块
│   │   ├── bgpWorker.js    # BGP 协议处理
│   │   ├── bmpWorker.js    # BMP 协议处理
│   │   ├── rpkiWorker.js   # RPKI 协议处理
│   │   ├── snmpWorker.js   # SNMP 协议处理
│   │   ├── ftpWorker.js    # FTP 服务器处理
│   │   ├── dhcpWorker.js   # DHCPv4 服务器处理
│   │   ├── dhcp6Worker.js  # DHCPv6 服务器处理
│   │   └── ntpWorker.js    # NTP 服务器处理
│   ├── utils/              # 工具函数库
│   │   ├── bgpUtils.js     # BGP 工具函数
│   │   ├── bmpUtils.js     # BMP 工具函数
│   │   └── routeViewsUtils.js  # RouteViews 数据处理
│   ├── pktParser/          # 报文解析器
│   │   ├── bgpParser.js    # BGP 报文解析
│   │   ├── bmpParser.js    # BMP 报文解析
│   │   └── commonParser.js # 通用协议解析
│   ├── const/              # 常量定义
│   ├── main.js             # 主进程入口
│   ├── preload.js          # 预加载脚本(渲染进程 API 桥接)
│   └── splash.html         # 启动画面
├── src/                    # 🎨 Vue 应用源代码
│   ├── assets/             # 静态资源
│   │   ├── images/         # 图片资源
│   │   └── styles/         # 全局样式
│   ├── components/         # 公共组件
│   │   ├── SettingsDialog.vue      # 设置对话框
│   │   ├── CustomPktDrawer.vue     # 自定义报文抽屉
│   │   ├── RouteViewsImportModal.vue  # RouteViews 导入
│   │   └── UpdateNotification.vue  # 更新通知
│   ├── const/              # 常量定义
│   │   ├── bgpConst.js     # BGP 常量
│   │   ├── bmpConst.js     # BMP 常量
│   │   ├── dhcpConst.js    # DHCP 常量
│   │   └── toolsConst.js   # 工具常量
│   ├── router/             # 路由配置
│   │   └── index.js        # 路由定义
│   ├── store/              # Vuex 状态管理
│   │   └── index.js        # 状态管理配置
│   ├── utils/              # 工具函数
│   │   ├── eventBus.js     # 事件总线
│   │   ├── validationCommon.js  # 表单验证
│   │   └── modalResizeHandler.js  # 模态框响应式处理
│   ├── view/               # 视图组件
│   │   ├── Main.vue        # 主布局组件
│   │   ├── bgp/            # BGP 模拟器视图
│   │   │   ├── BgpConfig.vue       # BGP 配置
│   │   │   ├── BgpPeerConfig.vue   # 对等体配置
│   │   │   ├── RouteIpv4.vue       # IPv4 路由管理
│   │   │   ├── RouteIpv6.vue       # IPv6 路由管理
│   │   │   └── RouteMvpn.vue       # MVPN 路由管理
│   │   ├── bmp/            # BMP 监控器视图
│   │   │   ├── BmpConfig.vue       # BMP 配置
│   │   │   ├── BgpSession.vue      # BGP 会话监控
│   │   │   ├── BgpLocRib.vue       # Loc-RIB 监控
│   │   │   └── BgpSessionStatisReport.vue  # 统计报告
│   │   ├── rpki/           # RPKI 验证器视图
│   │   ├── snmp/           # SNMP 管理器视图
│   │   ├── ftp/            # FTP 服务器视图
│   │   ├── dhcp/           # DHCP 服务器视图
│   │   ├── tools/          # 工具集合视图
│   │   │   ├── StringGenerator.vue  # 字符串生成器
│   │   │   ├── PacketParser.vue     # 报文解析器
│   │   │   ├── PortMonitor.vue      # 端口监控器
│   │   │   ├── NetworkInfo.vue      # 网络信息
│   │   │   └── TcpAoMac.vue         # TCP-AO MAC
│   │   └── settings/       # 设置视图
│   │       ├── GeneralSettings.vue      # 通用设置
│   │       ├── ToolsSettings.vue        # 工具设置
│   │       ├── UpdateSettings.vue       # 更新设置
│   │       └── ServerDeployment.vue     # 服务器部署
│   ├── App.vue             # 应用根组件
│   └── main.js             # 渲染进程入口
├── scripts/                # 🔧 构建和部署脚本
│   └── tcp-md5-helper/     # TCP MD5 代理程序源码
├── bgpdata/                # 📊 BGP 数据存储
│   └── routeviews/         # RouteViews 路由数据
├── web/                    # 🌐 项目网站
│   └── index.html          # 网站首页
├── dist/                   # 📦 构建输出目录
├── index.html              # HTML 入口文件
├── vite.config.js          # Vite 构建配置
├── package.json            # 项目配置和依赖
├── release.js              # 发布脚本
└── README.md               # 项目说明文档
```

## 贡献指南

1. Fork 本仓库并创建您的分支
2. 安装开发依赖并进行本地测试
3. 提交更改并创建 Pull Request
4. 在 PR 中详细描述您的更改

### 代码风格

- 遵循项目的 ESLint 和 Prettier 配置
- 组件使用 Vue 3 Composition API
- 保持代码简洁和可读性

## 📚 文档导航

### 功能文档
- 🌐 **[BGP 模拟器](docs/BGP_SIMULATOR.md)** - 完整的 BGP 协议模拟和路由管理
- 📡 **[BMP 监控器](docs/BMP_MONITOR.md)** - BGP 路由监控和数据分析
- 🔐 **[RPKI 验证器](docs/RPKI_VALIDATOR.md)** - 路由源验证和安全检查
- 🌐 **[SNMP 管理器](docs/SNMP_MANAGER.md)** - 网络设备监控和管理
- 📁 **[FTP 服务器](docs/FTP_SERVER.md)** - 文件传输服务和用户管理
- 🛠️ **[工具集合](docs/TOOLS.md)** - 开发和网络实用工具
- ⚙️ **[设置](docs/SETTINGS.md)** - 应用设置和配置管理

### 开发文档
- 📦 **[安装与运行](#安装与运行)** - 环境配置和项目启动
- 🏗️ **[项目结构](#项目结构)** - 代码组织和目录说明
- 🤝 **[贡献指南](#贡献指南)** - 参与项目开发的指南

## 常见问题

- **Q: 如何添加新工具?**
  A: 在 `src/view/tools` 中创建新的工具组件，并在路由配置中添加入口。

- **Q: 打包后应用无法启动怎么办?**
  A: 检查日志文件，确保所有依赖正确安装，并尝试重新运行 `npm install` 后再次打包。

## 相关项目和资源

### 🔗 相关链接

- [Vue.js 官方文档](https://vuejs.org/)
- [Electron 官方文档](https://electronjs.org/)
- [Ant Design Vue 组件库](https://antdv.com/)
- [BGP 协议规范](https://tools.ietf.org/html/rfc4271)
- [BMP 协议规范](https://tools.ietf.org/html/rfc7854)
- [RPKI 相关规范](https://tools.ietf.org/html/rfc6480)

### 📋 更新日志

查看 [Releases](https://github.com/jihuaib/NetNexus/releases) 页面了解最新版本更新内容。

### 🤝 贡献者

感谢所有为项目贡献代码的开发者！

### 📝 开发计划

- [ ] 添加更多网络协议支持
- [ ] 增强用户界面和用户体验
- [ ] 添加自动化测试
- [ ] 支持插件系统
- [ ] 添加数据导入导出功能

## 🏷️ 项目标签

**技术栈**: `Vue3` `Electron` `JavaScript` `Ant-Design-Vue` `Vite` `Node.js`

**应用领域**: `网络工程` `系统管理` `协议分析` `网络运维` `开发工具` `网络安全`

**支持协议**: `BGP` `BMP` `RPKI` `TCP/IP` `网络报文分析`

**目标用户**: `网络工程师` `系统管理员` `网络开发者` `学生` `研究人员` `运维人员`

## License

MIT © 2026 huaibin ji

---

⭐ 如果这个项目对你有帮助，请给我们一个 Star！

🐛 发现问题？[提交 Issue](https://github.com/jihuaib/NetNexus/issues/new/choose)

💡 有新想法？[提交功能请求](https://github.com/jihuaib/NetNexus/issues/new/choose)

🚀 想要贡献代码？[查看贡献指南](#贡献指南)
