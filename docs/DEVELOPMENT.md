# 开发与运行

本文说明 NetNexus 源码运行、NetNexus UI 本地联调、常用验证脚本和文档维护方式。功能使用说明请通过左侧导航进入对应模块。

## 环境准备

NetNexus 应用构建与 CI 固定使用 Node.js `16.20.2`，桌面运行时锁定 Electron `22.3.27`，以继续兼容 Windows 7/8/8.1。文档站使用独立依赖和隔离的 Node.js 22 运行时，不会加入应用的根依赖，也不会改变普通 `npm install`、`npm ci`、构建或测试流程。Electron 22 已结束上游安全维护；升级到 Electron 23 或更高版本会取消 Windows 7/8/8.1 兼容性，除非项目明确调整系统支持范围，否则不得升级该运行时主版本。

根据要验证的功能，还可能需要：

- Docker：运行 FRR BGP/BMP 互操作测试。
- CMake 和 C/C++ 工具链：首次构建当前平台的 libyang 运行时。
- Ubuntu 24.04+ 的 x64 或 arm64 原生环境：构建对应架构的 Linux 安装包和 TCP 认证 helper。
- Linux kernel 6.7+ 且 `CONFIG_TCP_AO=y`：运行 BMP 或 RPKI-RTR TCP-AO。
- 内核启用 TCP MD5 Signature Option：运行 BMP 或 RPKI-RTR TCP MD5。
- X11 或 Wayland 桌面会话：启动 Electron 界面。
- 对应系统权限：DHCP、TFTP、NTP 等标准低位端口可能需要管理员或 root 权限。

## 安装和启动

Ubuntu 24.04 源码开发先安装 Electron 桌面运行库和原生构建工具：

```bash
sudo apt update
sudo apt install -y build-essential python3 cmake linux-libc-dev patchelf \
  libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libxtst6 \
  libcap2-bin libnotify4 libayatana-appindicator3-1 \
  fonts-noto-cjk
```

```bash
npm install

# Ubuntu 源码开发：Electron 每次安装/升级后配置 Chromium SUID sandbox
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox

# 允许普通用户监听 BGP 179 等低位端口
electron_path="$(realpath node_modules/electron/dist/electron)"
patchelf --force-rpath --set-rpath "$(dirname "$electron_path")" "$electron_path"
sudo setcap 'cap_net_bind_service=ep' "$electron_path"
getcap "$electron_path"

npm run dev
```

不要用 `--no-sandbox` 绕过此检查，也不要使用 root 启动应用。`patchelf` 的绝对 RPATH 是 Linux secure-exec 加载同目录 `libffmpeg.so` 所必需的；不要只执行 `setcap`。重新执行 `npm install`/`npm ci` 或升级 Electron 后，应再次配置 sandbox、RPATH 和 `CAP_NET_BIND_SERVICE`。正式 `.deb` 会在构建阶段写入 `/opt/NetNexus` RPATH，并在安装/升级时自动配置和验证运行权限。

在 Linux 上，`npm run dev` 会在 Electron 启动前检查当前架构的 `tcp-auth-helper`；首次运行、源码更新或验证失败时会自动原生重建。为此需要预先安装 `build-essential` 和 `linux-libc-dev`。非 Linux 平台会跳过该检查。

渲染层通过根 `package.json` 中精确锁定的 npm 依赖消费独立的 [NetNexus UI](https://github.com/jihuaib/NetNexusUI)。普通开发、构建、测试和 GitHub Actions 始终使用 lockfile 中的已发布版本。

## Ubuntu 24.04+ 与 TCP 认证

Linux 桌面版支持 Ubuntu 24.04+ x64/arm64。使用 BMP 或 RPKI-RTR TCP-AO 前先确认内核版本和配置：

```bash
uname -r
grep '^CONFIG_TCP_AO=y$' "/boot/config-$(uname -r)"

# 仅在发行版通过 /proc/config.gz 暴露配置时使用
zgrep '^CONFIG_TCP_AO=y$' /proc/config.gz
```

必须使用 Linux kernel 6.7+，并看到 `CONFIG_TCP_AO=y`。BMP 与 RPKI-RTR 共用随应用构建的原生 TCP 认证 helper；它同时承载 TCP-AO 和 TCP MD5，启动时会核对认证类型、内核能力、监听端口、地址族、Profile 数量和密钥数量，任一项不匹配都会拒绝启动。认证本身不要求以 root 启动应用；正式 `.deb` 会只为 NetNexus 可执行文件授予 `CAP_NET_BIND_SERVICE`，使普通用户可以监听 BGP 179、NTP 123 等低位端口，不会授予完整 root 权限。

Electron 和 TCP 认证 helper 在同一 Linux 主机运行，因此还需要有效的 X11 或 Wayland 图形会话。Linux 会自动在应用数据目录的 `secure-credentials/master-key-v1` 创建本地主密钥，目录权限为 `0700`、文件权限为 `0600`；TCP 认证（TCP-AO、TCP MD5）和 NETCONF 配置中只保存 AES-256-GCM 密文，不需要额外的桌面密钥服务、DBus 会话或手工解锁。`.deb` 会依赖 `fonts-noto-cjk`，确保最小化系统及 X11 转发会话也能显示中文。纯 SSH/headless 环境中缺少 `$DISPLAY`/`$WAYLAND_DISPLAY` 时，Electron 无法启动。`npm start` 只提供渲染层开发资源，不能替代 Electron 主进程；当前不支持“Linux 后台运行协议服务，另一台机器通过浏览器使用前端”的分离部署。

通过 `ssh -Y` 使用 X11 转发时，直接启动并保存设置即可，不需要额外初始化凭据存储。典型密钥文件路径为 `~/.config/NetNexus/secure-credentials/master-key-v1`；备份凭据配置时应同时备份该文件。

### 原生打包

先在目标架构的 Ubuntu 24.04+ 主机安装依赖：

```bash
sudo apt update
sudo apt install -y build-essential python3 cmake linux-libc-dev patchelf \
  libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libxtst6 \
  libcap2-bin libnotify4 libayatana-appindicator3-1 \
  fonts-noto-cjk
npm ci
```

`npm ci` 和 Linux 打包流程会针对当前 Electron ABI 从源码重建 `better-sqlite3`，并实际执行一次加载、建库和关闭 smoke，因此构建机必须具备 Python 3 与 C/C++ 编译工具链。

然后选择与当前主机一致的命令：

| 原生主机 | 未安装目录 | `.deb` |
| --- | --- | --- |
| x86_64 / x64 | `npm run pack:linux:x64` | `npm run dist:linux:x64 -- --publish never` |
| aarch64 / arm64 | `npm run pack:linux:arm64` | `npm run dist:linux:arm64 -- --publish never` |

Linux 打包会同时构建渲染层、当前架构的 TCP 认证 helper，并验证 libyang 与 helper 的 ELF 架构。项目有意拒绝 x64/arm64 交叉打包；两种架构应分别在原生 runner 上生成。产物位于 `release/`：

```bash
# apt install 会同时解析所需桌面运行库和中文字体
sudo apt install ./release/NetNexus-*-linux-*.deb
```

项目仅发布 `.deb`。必须使用上面的 `sudo apt install` 安装，使 APT 自动安装 `fonts-noto-cjk` 和 `libcap2-bin`、安装脚本将 `chrome-sandbox` 配置为 `root:root 4755`，并为 NetNexus 设置和验证 `CAP_NET_BIND_SERVICE`；安装后仍需从 X11/Wayland 桌面会话启动。BMP、RPKI-RTR 的认证配置见 [TCP-AO 设置](SETTINGS.md#tcp-ao-设置)和 [TCP MD5 设置](SETTINGS.md#tcp-md5-设置)。

如果目标文件系统不支持 file capability，安装会明确失败，不会静默留下一个无法监听 TCP/179 的程序。修复文件系统或容器权限后，执行 `sudo dpkg --configure net-nexus`（依赖尚未完成时可执行 `sudo apt -f install`）重新完成配置；不要改用 root 启动 NetNexus。

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
| `npm run pack:linux:x64` | 在 x64 Linux 主机生成未安装目录。 |
| `npm run pack:linux:arm64` | 在 arm64 Linux 主机生成未安装目录。 |
| `npm run dist:linux:x64` | 在 x64 Linux 主机生成 `.deb`。 |
| `npm run dist:linux:arm64` | 在 arm64 Linux 主机生成 `.deb`。 |
| `npm run lint` | 检查渲染层和主进程代码。 |
| `npm test` | 运行主 CI 测试集合。 |
| `npm run test:e2e:frr` | 使用 Docker 和真实 FRR 验证 BGP/BMP 互操作。 |
| `npm run mock:netconf` | 启动本地 NETCONF-over-SSH 测试设备。 |
| `npm run mock:bmp` | 向本机 BMP 服务发送模拟数据。 |
| `npm run docs:screenshots` | 按当前页面状态更新功能截图。 |

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
├── scripts/              # 构建、发布、测试和文档辅助脚本
├── src/                  # Vue 渲染进程
├── test/ci/              # Node CI 测试
├── test/integration/     # 真实协议互操作 E2E
├── package.json
└── vite.config.js
```
