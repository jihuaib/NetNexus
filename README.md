# NetNexus

[![Vue.js](https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vue.js)](https://vuejs.org/)
[![Electron](https://img.shields.io/badge/Electron-15+-47848F?style=flat-square&logo=electron)](https://electronjs.org/)
[![NetNexus UI](https://img.shields.io/badge/UI-NetNexus-FF7A1A?style=flat-square)](src/ui)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

NetNexus 是一个基于 Vue 3、自研 NetNexus UI 和 Electron 的本地网络工具集。项目当前重点是协议联调、报文解析、轻量服务器和本机调试工具。

## 当前功能

### 协议工具

- [BGP 模拟器](docs/BGP_SIMULATOR.md)：BGP 服务端、对等体配置、IPv4/IPv6 单播路由、MVPN 路由、IPv4/IPv6 QP 路由、RouteViews 导入和路由查看。
- [BMP 监控器](docs/BMP_MONITOR.md)：BMP v3/v4 接收、客户端列表、BGP session、Loc-RIB、路由列表、路由详情、统计报告和只读 HTTP API。
- [RPKI RTR 服务](docs/RPKI_VALIDATOR.md)：RPKI-RTR 服务端、ROA、Router Key、ASPA 数据管理和 JSON 导入。
- [SNMP 工具](docs/SNMP_MANAGER.md)：Trap 接收、Trap 历史、MIB 导入/编译、OID 树、OID 解析和基础 SNMP 查询操作。
- [FTP 服务器](docs/FTP_SERVER.md)：本地 FTP 服务、用户目录配置、客户端连接列表。
- [DHCP 服务器](docs/DHCP_SERVER.md)：DHCPv4/DHCPv6 地址分配、租约列表和测试脚本。
- [NTP 服务器](docs/NTP_SERVER.md)：本地 NTP 响应、时间参数配置和请求日志。
- [RADIUS 服务器](docs/RADIUS_SERVER.md)：RADIUS 认证、计费、动态授权、请求日志和会话状态。
- [TFTP 服务器](docs/TFTP_SERVER.md)：TFTP 上传/下载、选项协商和传输日志。
- [Syslog 服务器](docs/SYSLOG_SERVER.md)：UDP/TCP Syslog 接收、RFC3164/RFC5424 解析、消息日志和详情查看。

### 开发和系统工具

- [工具集合](docs/TOOLS.md)：字符串生成、报文解析、端口监控、网络信息、HTTP API 测试、TCP-AO MAC 计算、TCP/UDP 收发工具。
- [设置](docs/SETTINGS.md)：日志级别、工具历史数量、FTP 用户数量、外部 HTTP API、TCP MD5 代理部署和更新设置。
- [外部 API](docs/API.md)：当前只注册 BMP 查询接口，API 服务不负责启动 BMP。

## 安装与运行

```bash
npm install
npm run dev
```

常用脚本：

```bash
npm run build
npm run pack:mac:arm64
npm run lint
npm test
npm run test:e2e:frr
npm run frr:bmp:lab -- --help
npm run mock:bmp
npm run docs:screenshots
npm run docs:pdf
```

说明：

- `npm run mock:bmp` 会向本机 BMP 服务发送模拟数据，用于查看 BMP 页面布局和接口返回。
- `npm run test:e2e:frr` 会通过 Docker 启动两台固定为 `FRR 10.5.4` 的路由器，使用真实 BMPv3 客户端验证 Initiation、Peer Up/Down、pre/post-policy Route Monitoring、Loc-RIB、Statistics 和 SQLite 查询链路。测试覆盖 FRR BMP Route Monitoring 支持的 7 个地址族：IPv4/IPv6 Unicast、IPv4/IPv6 Multicast、VPNv4、VPNv6 和 L2VPN EVPN；默认在 5 个可伸缩地址族各生成 1024 条路由，Multicast 每族生成一条 default，共 5122 条源路由、15366 条三视图持久化路由。可通过 `FRR_BMP_ROUTES_PER_FAMILY` 调整每个可伸缩地址族的路由量；Labeled Unicast 和 Flowspec 不属于 FRR BMP Route Monitoring 支持范围，继续由 mock/解析器测试覆盖。运行前需要启动 Docker。
- `npm run docs:screenshots` 会打开本地页面并更新 `docs/images` 下的文档截图，需要先启动 `npm start` 或设置 `NETNEXUS_DOCS_URL`；截图视口默认不小于 `1920x1200`，可用 `NETNEXUS_DOCS_WINDOW_WIDTH`、`NETNEXUS_DOCS_WINDOW_HEIGHT` 覆盖。脚本会自动启动 BGP、BMP、RPKI、FTP、DHCP、SNMP、NTP、RADIUS、TFTP、Syslog 和 TCP/UDP 工具 mock 服务，并注入演示数据。
- `npm run docs:pdf` 会合并 `docs` 目录下的功能文档，生成带目录且展开全部截图的 `output/pdf/netnexus-docs.pdf`。README 和外部 API 参考不进入功能 PDF。
- 标准端口如 `67`、`69`、`123` 在部分系统上需要管理员/root 权限，联调时可以改用高位端口。

### 本地 FRR BMP 手工联调

FRR 是 BMP 客户端，会主动连接 NetNexus 的 BMP 服务端。可以先创建并配置好常驻 FRR 环境，再启动本地 NetNexus：

```bash
# 终端 1：启动两台 FRR，建立双栈 BGP、注入路由并在后台常驻
npm run frr:bmp:lab -- start --port 1790 --routes 1024

# 终端 2：启动 NetNexus
npm run dev
```

进入 NetNexus 的“BMP → BMP配置”，将“服务端端口”设为 `1790`，不启用认证，然后点击“启动服务器”。FRR 在 NetNexus 启动前连接失败不会退出，而会持续重试；连接成功后可在“BGP会话”“BGP Loc-RIB”及对应统计页面查看数据。

`--routes`（也可写成 `--routes-per-family`）表示 5 个可扩展地址族中每个地址族的路由数；IPv4/IPv6 Multicast 各固定生成一条 default。默认值 `1024` 会产生 5122 条源路由，以及 15366 条 pre-policy、post-policy、Loc-RIB 三视图路由。其他管理命令：

```bash
# 查看双栈 BGP、BMP 连接和路由量状态
npm run frr:bmp:lab -- status

# 调整端口或路由量后重建已有环境
npm run frr:bmp:lab -- start --port 1790 --routes 2048 --replace

# 联调完成后删除本工作区创建的 FRR 容器和 Docker 网络
npm run frr:bmp:lab -- stop
```

运行前需要启动 Docker。`status` 和 `stop` 只匹配当前工作区专属的 Docker label，不会清理自动 E2E 或其他 FRR 容器。

## 技术栈

- Vue 3
- Vue Router 4
- Vuex 4
- NetNexus UI（项目内自研组件库）
- Electron 15
- Vite
- Node.js worker_threads

## 项目结构

```text
NetNexus/
├── docs/                 # 功能文档和截图
├── electron/             # Electron 主进程、协议 worker、工具函数
│   ├── app/              # IPC 应用控制器
│   ├── worker/           # 按协议模块划分的 worker、会话模型和公共 worker 基础设施
│   ├── const/            # 主进程常量
│   ├── utils/            # 协议和存储工具
│   └── main.js           # Electron 入口
├── scripts/              # 构建、发布、测试辅助脚本
├── src/                  # Vue 渲染进程
│   ├── router/           # 页面路由
│   ├── store/            # keep-alive 等状态
│   └── view/             # 页面组件
├── test/ci/              # Node CI 测试脚本
├── test/integration/     # 依赖真实协议实现的互操作 E2E
├── package.json
└── vite.config.js
```

## 文档

- [BGP 模拟器](docs/BGP_SIMULATOR.md)
- [BMP 监控器](docs/BMP_MONITOR.md)
- [BMP SQLite 数据库说明](docs/BMP_SQLITE_DATABASE.md)
- [RPKI RTR 服务](docs/RPKI_VALIDATOR.md)
- [SNMP 工具](docs/SNMP_MANAGER.md)
- [FTP 服务器](docs/FTP_SERVER.md)
- [DHCP 服务器](docs/DHCP_SERVER.md)
- [NTP 服务器](docs/NTP_SERVER.md)
- [RADIUS 服务器](docs/RADIUS_SERVER.md)
- [TFTP 服务器](docs/TFTP_SERVER.md)
- [Syslog 服务器](docs/SYSLOG_SERVER.md)
- [工具集合](docs/TOOLS.md)
- [设置](docs/SETTINGS.md)
- [外部 API](docs/API.md)

## 开发说明

- 新页面路由采用动态导入，避免启动时一次性加载所有页面组件。
- 设置页日志级别只在当前运行期生效，重启后默认恢复 `off`。
- BMP 路由详情不保存 BGP 原始报文摘要，路由 NLRI 解析结果通过 `nlriDetail` 查看。
- 外部 HTTP API 只监听 `127.0.0.1`，当前仅暴露 BMP 只读查询接口。

## License

NetNexus is licensed under the [MIT License](LICENSE).

Production third-party dependency notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
