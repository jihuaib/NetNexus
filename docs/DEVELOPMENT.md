# 开发与运行

本文说明 NetNexus 源码运行、NetNexus UI 本地联调、常用验证脚本和文档维护方式。功能使用说明请通过左侧导航进入对应模块。

## 环境准备

NetNexus 应用构建与 CI 当前使用 Node.js `16.20.2`。文档站使用独立依赖和隔离的 Node.js 22 运行时，不会加入应用的根依赖，也不会改变普通 `npm install`、`npm ci`、构建或测试流程。

根据要验证的功能，还可能需要：

- Docker：运行 FRR BGP/BMP 互操作测试。
- CMake 和 C/C++ 工具链：首次构建当前平台的 libyang 运行时。
- 对应系统权限：DHCP、TFTP、NTP 等标准低位端口可能需要管理员或 root 权限。

## 安装和启动

```bash
npm install
npm run dev
```

渲染层通过根 `package.json` 中精确锁定的 npm 依赖消费独立的 [NetNexus UI](https://github.com/jihuaib/NetNexusUI)。普通开发、构建、测试和 GitHub Actions 始终使用 lockfile 中的已发布版本。

## 本地联调 NetNexus UI

开发 UI 时不需要反复发布 npm。默认将两个仓库放在同一级目录，并分别完成一次 `npm install`：

```text
code/
├── NetNexus/
└── NetNexusUI/
```

然后在 NetNexus 仓库运行：

```bash
npm run dev:ui
```

该命令直接加载 `../NetNexusUI/src`。修改 UI 组件或主题 CSS 后，Vite 会热更新当前应用；它不会执行 `npm link`，也不会修改 `package.json` 或 `package-lock.json`。

发布 UI 前建议执行：

```bash
cd ../NetNexusUI
npm run verify

cd ../NetNexus
npm run build:ui
```

如果 UI 仓库不在相邻目录，可以显式传入路径：

```bash
npm run dev:ui -- /absolute/path/to/NetNexusUI
npm run build:ui -- /absolute/path/to/NetNexusUI
```

完成本地联调后，再升级 UI 版本并发布一次，最后在 NetNexus 中更新精确依赖版本。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建渲染层生产资源。 |
| `npm run pack:mac:arm64` | 生成 macOS arm64 未安装目录。 |
| `npm run lint` | 检查渲染层和主进程代码。 |
| `npm test` | 运行主 CI 测试集合。 |
| `npm run test:e2e:frr` | 使用 Docker 和真实 FRR 验证 BGP/BMP 互操作。 |
| `npm run mock:netconf` | 启动本地 NETCONF-over-SSH 测试设备。 |
| `npm run mock:bmp` | 向本机 BMP 服务发送模拟数据。 |
| `npm run docs:screenshots` | 按当前页面状态更新功能截图。 |
| `npm run docs:pdf` | 生成 `output/pdf/netnexus-docs.pdf`。 |

## 本地文档站

VitePress 依赖安装在 `docs/node_modules`，不会进入根 `node_modules`。根脚本会在需要时自动安装文档依赖；当前 shell 使用旧版 Node.js 时，会自动通过 npm 启动隔离的 Node.js 22 运行时。

```bash
# 可选：提前安装文档依赖
npm run docs:install

# 启动本地文档站
npm run docs:dev

# 构建并预览生产版本
npm run docs:build
npm run docs:preview
```

文档提交到 `master` 后，GitHub Actions 会构建并发布到 [NetNexus 在线文档](https://jihuaib.github.io/NetNexus/)。仓库的 Pages 发布源需要设置为 `GitHub Actions`。

### 更新截图

`npm run docs:screenshots` 会打开本地页面并更新 `docs/images`，运行前需要先启动 `npm start`，也可以设置 `NETNEXUS_DOCS_URL` 指向已经运行的页面。

常用筛选变量：

```bash
NETNEXUS_DOCS_SCREENSHOT_SCOPE=bmp npm run docs:screenshots
NETNEXUS_DOCS_SCREENSHOT_MATCH=route-history npm run docs:screenshots
```

截图视口默认不小于 `1920x1200`，可通过 `NETNEXUS_DOCS_WINDOW_WIDTH` 和 `NETNEXUS_DOCS_WINDOW_HEIGHT` 覆盖。脚本会启动各协议 mock 服务，并为 BMP 注入路由矩阵、路由追踪和多地址族路由生命周期数据。

### 生成 PDF

```bash
npm run docs:pdf
```

PDF 输出到 `output/pdf/netnexus-docs.pdf`。在线站点和 PDF 共用 `docs` 下的 Markdown 与截图，更新界面后应先重拍对应截图，再重新生成 PDF。

## 本地 NETCONF Mock

不接入真实设备时，可以使用项目自带的 NETCONF-over-SSH Mock 验证真实 SSH、NETCONF framing、YANG 下载和配置操作：

```bash
# 终端 1
npm run mock:netconf

# 终端 2
npm run dev
```

在“NETCONF/YANG → 连接设置”中新建 Profile：

| 字段 | 值 |
| --- | --- |
| Profile 名称 | `本地 NETCONF Mock` |
| 设备地址 | `127.0.0.1` |
| 端口 | `8830` |
| 用户名 | `netconf` |
| 密码 | `netconf` |
| 认证方式 | 密码 |

依次点击“测试连接 → 保存 → 连接”，进入“模型列表”读取设备列表并下载 `netnexus-mock-device` 与 `netnexus-mock-types`。完整 RPC 操作和可直接粘贴的配置 XML 见 [NETCONF / YANG 工作台](NETCONF_YANG.md#使用本地-netconf-mock-完整联调)。Mock 只监听回环地址，固定 SSH Host Key 和默认凭据均仅用于本地测试。

## 本地 FRR BMP 联调

FRR 是 BMP Client，会主动连接 NetNexus BMP Server。运行前需要启动 Docker：

```bash
# 终端 1：启动两台 FRR、建立双栈 BGP 并注入路由
npm run frr:bmp:lab -- start --port 1790 --routes 1024

# 终端 2：启动 NetNexus
npm run dev
```

进入“BMP → BMP配置”，将服务端端口设为 `1790` 并启动服务器。FRR 会持续重试连接；连接成功后，可以从 Client 列表打开独立监控窗口。

`--routes` 表示五个可伸缩地址族中每个地址族的路由数。IPv4/IPv6 Multicast 各固定生成一条 default；默认值 `1024` 会产生 5122 条源路由，以及 15366 条 pre-policy、post-policy、Loc-RIB 三视图路由。

```bash
# 查看环境状态
npm run frr:bmp:lab -- status

# 使用新端口或路由量重建
npm run frr:bmp:lab -- start --port 1790 --routes 2048 --replace

# 删除当前工作区创建的 FRR 容器和网络
npm run frr:bmp:lab -- stop
```

`status` 和 `stop` 只匹配当前工作区专属的 Docker label，不会清理自动 E2E 或其他 FRR 容器。

## 项目结构

```text
NetNexus/
├── docs/                 # VitePress 文档、功能文档和截图
├── electron/             # Electron 主进程、协议 worker 和工具函数
├── output/pdf/           # 生成的 PDF 手册
├── scripts/              # 构建、发布、测试和文档辅助脚本
├── src/                  # Vue 渲染进程
├── test/ci/              # Node CI 测试
├── test/integration/     # 真实协议互操作 E2E
├── package.json
└── vite.config.js
```
