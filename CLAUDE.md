# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码仓库中工作时提供指导。

## 项目概述

NetNexus 是一个基于 Vue 3、Ant Design Vue 和 Electron 构建的本地网络和开发工具集。它提供 BGP、BMP、RPKI、SNMP、FTP、DHCP、NTP、TFTP 等协议工具，以及报文解析器、字符串生成器、端口监控、网络信息、HTTP API 测试、TCP-AO MAC 等开发辅助工具。
本项目需要同时兼容 Windows 和 Linux。
开发环境可能运行在 WSL，但代码必须能在原生 Windows 上正常运行。
项目包含 Electron、Node.js 以及 native 模块。

## 跨平台兼容性（最高优先级）

所有代码修改 **必须同时兼容 Windows、macOS 和 Linux**。

### 通用规则
- 不允许只考虑 Linux 或只考虑 Windows。
- 不允许引入仅在某一平台可用的实现方式。
- 如必须使用平台相关逻辑，必须显式区分并说明原因。

### 路径与文件系统
- 必须使用 `path.join` / `path.resolve` 处理路径。
- 禁止硬编码 `/` 或 `\`。
- 假设文件系统可能大小写不敏感。
- 禁止依赖 `/proc`、`/sys` 等 Linux 特有路径。

### Node.js / Electron
- 仅使用跨平台的 Node.js API。
- 禁止使用 bash / GNU 专属命令。
- 子进程、脚本必须在 Windows 和 Linux 下都可运行。
- 不允许自动升级 Electron 或 Node 版本。

### Native 模块（C / C++）
- 代码必须可在 Windows（MSVC）和 Linux（GCC/Clang）编译。
- 禁止使用平台专属头文件（如 unistd.h）而不做条件判断。
- 平台差异必须使用宏区分（如 `_WIN32`）。


## 开发命令

### 安装配置
```bash
npm install                    # 安装依赖
```

### 开发调试
```bash
npm run dev                   # 启动开发环境（Vite + Electron）
npm start                     # 仅启动 Vite 开发服务器（端口 3000）
```

### 代码质量
```bash
npm run lint                  # 在 src 和 electron 目录运行 ESLint
npm run lint:fix              # 自动修复 ESLint 问题
npm run format                # 使用 Prettier 格式化代码
npm run docs:screenshots      # 从本地页面重新生成 docs/images 截图
```

### 构建打包

**Windows:**
```bash
npm run build                 # 使用 Vite 构建 Vue 应用（输出到 dist/）
npm run pack                  # 打包 Electron 应用（不含安装程序）
npm run dist                  # 构建并创建 Windows 安装程序
npm run release               # 构建并发布 Windows 版本
```

**macOS:**
```bash
npm run make-icns             # 生成 macOS 图标（.icns）
npm run pack:mac              # 打包 macOS x64 应用（不含安装程序）
npm run pack:mac:arm64        # 打包 macOS arm64 应用（不含安装程序）
npm run dist:mac              # 构建 macOS x64 DMG 和 ZIP
npm run dist:mac:arm64        # 构建 macOS arm64 DMG 和 ZIP
npm run dist:mac:universal    # 构建 macOS universal（x64 + arm64）
npm run release:mac           # 构建并发布 macOS x64 版本
npm run release:mac:arm64     # 构建并发布 macOS arm64 版本
npm run release:mac:universal # 构建并发布 macOS universal 版本
```

## 架构设计

### Electron 进程架构

**主进程** (`electron/main.js`):
- 创建带启动画面的 BrowserWindow
- 加载 SystemApp 来协调所有应用模块
- 开发模式：从 `http://127.0.0.1:3000` 加载
- 生产模式：从 `dist/index.html` 加载

**预加载脚本** (`electron/preload.js`):
- 暴露渲染进程和主进程之间的 IPC 通信桥接
- 使用 contextBridge 实现安全的 API 暴露

**应用模块** (`electron/app/`):
- `systemApp.js`: 中央协调器，管理所有应用模块、设置存储（electron-store）和版本兼容性
- `bgpApp.js`: BGP 模拟器管理
- `bmpApp.js`: BMP 监控器管理
- `rpkiApp.js`: RPKI 验证器管理
- `ftpApp.js`: FTP 服务器管理
- `snmpApp.js`: SNMP 管理器
- `toolsApp.js`: 开发工具协调
- `nativeApp.js`: 原生功能（端口监听、进程终止、网络信息和网络地址管理）
- `sshDeployer.js`: 通过 SSH 将 BMP MD5 代理部署到 Linux 服务器
- `updater.js`: 自动更新功能

**工作进程** (`electron/worker/`):
- 按协议/功能域组织：`bgp/`、`bmp/`、`rpki/`、`dhcp/`、`transfer/`、`snmp/`、`services/`、`tools/`
- Workers 在主线程侧使用 `core/workerWithPromise.js` 进行管理，在 worker 侧使用 `core/workerMessageHandler.js` 注册处理器
- 长期运行模式（`createLongRunningWorker()`）：用于协议 worker（BGP、BMP、RPKI、FTP、SNMP、DHCP、NTP、TFTP、Syslog），支持请求-响应和事件推送
- 一次性模式（`runWorkerWithPromise()`）：用于单次任务，执行完毕后自动终止
- 示例：`bgp/bgpSession.js`、`bmp/bmpSession.js`、`rpki/rpkiSession.js`、`transfer/ftpSession.js`、`shared/sshTunnel.js`、`tools/stringGeneratorWorker.js`

**报文解析器** (`electron/pktParser/`):
- 协议特定的解析器：`bgpPacketParser.js`、`tcpPacketParser.js`、`udpPacketParser.js`、`ipPacketParser.js`、`ethernetPacketParser.js`、`arpPacketParser.js`
- 通过 `parserRegistry.js` 和 `packetParserRegistry.js` 实现注册表模式

### Vue 前端架构

**路由** (`src/router/index.js`):
- 使用 Vue Router 4 和 hash 历史模式
- 每个模块（tools、bgp、bmp、rpki、ftp、snmp、dhcp、ntp、tftp）都有嵌套路由
- 所有路由都设置 `keepAlive: true` 以保持状态

**状态管理** (`src/store/index.js`):
- Vuex 4 store 管理缓存视图以支持 keep-alive 功能
- Actions：`addCachedView`、`delCachedView`、`resetCachedViews`

**视图结构** (`src/view/`):
- 每个协议都有自己的目录，包含配置和数据视图
- `Main.vue`: 根布局组件
- `tools/`: 开发者工具（StringGenerator、PacketParser、PortMonitor、NetworkInfo、HttpApiTester、TcpAoMac）
- `bgp/`: BGP 模拟器视图（配置、对等体信息、IPv4/IPv6/MVPN 路由）
- `bmp/`: BMP 监控器视图（配置、会话、loc-rib、统计）
- `rpki/`: RPKI RTR 视图（配置、ROA、Router Key、ASPA 管理）
- `ftp/`: FTP 服务器视图（配置、客户端管理）
- `snmp/`: SNMP 工具视图（配置、trap 处理、MIB 管理）
- `dhcp/`: DHCP 服务器视图（配置、租约）
- `ntp/`: NTP 服务器视图（配置、请求日志）
- `tftp/`: TFTP 服务器视图（配置、传输日志）
- `settings/`: 应用设置（通用、工具、FTP、HTTP API、服务器部署、更新）

**组件** (`src/components/`):
- `SettingsDialog.vue`: 全局设置对话框
- `UpdateNotification.vue`: 更新通知界面
- `PacketResultViewer.vue`: 报文分析显示
- `CodeEditor.vue`: 代码编辑组件
- `CustomPktDrawer.vue`: 自定义报文抽屉
- `ScrollTextarea.vue`: 可滚动文本区域组件

**常量** (`src/const/` 和 `electron/const/`):
- 前后端之间镜像的协议特定常量
- 文件：`bgpConst.js`、`bmpConst.js`、`rpkiConst.js`、`ftpConst.js`、`snmpConst.js`、`toolsConst.js`

### 数据存储

- **electron-store**: 用于持久化设置和程序数据
- 设置存储在：`Settings Data.json`
- 程序数据存储在：`Program Data.json`
- 位置：`app.getPath('userData')`

### IPC 通信模式

前端通过预加载脚本中暴露的 IPC API 与 Electron 主进程通信。每个应用模块在 SystemApp 构造函数中注册处理程序。

**响应格式**：所有 IPC 处理器统一返回 `{ status: 'success'|'error', msg, data }` 格式（来自 `electron/utils/responseUtils.js` 的 `successResponse` / `errorResponse`）。

**事件推送**：主进程通过 `unified-event` IPC 频道向渲染进程推送异步事件（`eventDispatcher.js`）；渲染进程中的 EventBus 负责接收并分发这些事件。`preload.js` 通过 `commonApi.onUnifiedEvent` 统一订阅此频道。

## 代码风格

- ESLint 配置强制执行 Vue 3 推荐规则和 Prettier 格式化
- Electron 文件使用 CommonJS（`require`），src 文件使用 ES 模块（`import`）
- Vue 组件使用 Composition API
- 使用 `===` 进行相等性检查（ESLint 强制）
- 允许使用 `_` 前缀的未使用变量

## 环境要求

- Node.js 16.20.2+
- npm 8.19.4+
- Python 3.8（用于原生依赖）
- 支持：Windows 7+、macOS 11+、Linux

## 构建配置

- 使用 Vite 进行 Vue 应用打包
- 使用 electron-builder 进行打包
- 禁用 ASAR 以便于调试
- 通过 GitHub releases 自动更新

**Windows:**
- 打包格式：NSIS 安装程序
- 目标架构：x64

**macOS:**
- 打包格式：DMG 和 ZIP
- 目标架构：x64、arm64（Apple Silicon）、universal
- 代码签名：需要 Apple Developer 证书（可选，无证书时自动禁用）
- entitlements：`electron/assets/entitlements.mac.plist`

### macOS 代码签名（可选）

如需进行代码签名和公证，需要配置以下环境变量：

```bash
# Apple Developer 证书
export CSC_LINK="path/to/certificate.p12"
export CSC_KEY_PASSWORD="certificate-password"

# Apple 公证（notarization）
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="your-team-id"
```

不配置这些变量时，构建仍然可以进行，但应用不会被签名。

### macOS 构建补丁

由于 electron-builder 在 `asar: false` 配置下存在符号链接处理问题，项目包含一个自动补丁脚本 `scripts/patch-electron-builder.js`。此补丁会在 `npm install` 后自动应用。

如果遇到 `ENOENT: no such file or directory, ensureSymlink 'Versions/Current/Resources'` 错误，请手动运行：
```bash
node scripts/patch-electron-builder.js
```
