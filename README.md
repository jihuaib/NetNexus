# NetNexus

[![Vue.js](https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vue.js)](https://vuejs.org/)
[![Electron](https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron)](https://electronjs.org/)
[![NetNexus UI](https://img.shields.io/badge/UI-NetNexus-FF7A1A?style=flat-square)](https://github.com/jihuaib/NetNexusUI)
[![Documentation](https://img.shields.io/badge/docs-online-FF7A1A?style=flat-square)](https://jihuaib.github.io/NetNexus/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

NetNexus 是一个基于 Vue 3、自研 NetNexus UI 和 Electron 的本地网络工具集，面向协议联调、路由分析、轻量服务器和本机开发调试场景。

[在线文档](https://jihuaib.github.io/NetNexus/) · [版本下载](https://github.com/jihuaib/NetNexus/releases)

## 功能简介

- **路由与安全**：BGP 模拟器、BMP v3/v4 监控与五阶段路由分析、RPKI-RTR、ROA、Router Key 和 ASPA；BMP、RPKI-RTR 可使用 TCP-AO 强制认证。
- **网络管理**：SNMP Trap/MIB/查询，以及 NETCONF over SSH、YANG 模型发现、编译、Schema 浏览和 RPC 操作。
- **本地协议服务**：FTP、DHCPv4/v6、NTP、RADIUS、TFTP 和 Syslog，覆盖配置、运行状态、请求或会话记录。
- **开发工具**：字符串生成、报文解析、端口监控、网络信息、HTTP API 测试、TCP-AO MAC 和 TCP/UDP 收发。
- **数据与集成**：BMP SQLite 持久化、路由事件历史、统计报告和本机只读 HTTP API。

完整功能说明、页面截图、API 和本地联调指南请查看[在线文档](https://jihuaib.github.io/NetNexus/)。

## 快速开始

```bash
npm install
npm run dev
```

应用构建、测试、NetNexus UI 本地联调和文档维护说明见[开发与运行](https://jihuaib.github.io/NetNexus/DEVELOPMENT.html)。

### Ubuntu 与 BMP / RPKI TCP-AO

Linux 安装包面向 Ubuntu 24.04+，提供 x64 和 arm64 的原生 `.deb`。BMP、RPKI-RTR 的 TCP-AO 认证还要求 Linux kernel 6.7+ 且内核启用 `CONFIG_TCP_AO=y`。两项服务共享“设置 → TCP-AO”中的 Profile 和轮换密钥；启用后只建立通过内核双向认证的连接，不会回退到普通 TCP。

```bash
# 必须在对应架构的 Ubuntu 主机上原生打包，不能交叉打包
npm run dist:linux:x64
npm run dist:linux:arm64

# 安装对应架构的 .deb；APT 会自动安装中文字体和桌面运行库
sudo apt install ./release/NetNexus-*-linux-*.deb
```

项目仅发布 `.deb`；通过 `sudo apt install` 安装时，APT 会自动安装 `fonts-noto-cjk` 和 `libcap2-bin`，安装脚本会把 Electron 的 `chrome-sandbox` 设置为 `root:root 4755`，并授予 NetNexus 监听 BGP 179 等低位端口所需的 `CAP_NET_BIND_SERVICE`，无需用 root 启动应用。NetNexus 是 Electron 桌面应用，运行界面需要有效的 X11 或 Wayland 图形会话；Linux 会自动创建本地凭据密钥文件，X11 转发环境无需额外初始化。当前不支持在无桌面环境的 Linux 后台运行协议服务、再从另一台机器用浏览器打开前端的分离部署方式。安装、内核检查和 TCP-AO 配置方法见[开发与运行](https://jihuaib.github.io/NetNexus/DEVELOPMENT.html#ubuntu-24-04-与-tcp-ao)与[设置](https://jihuaib.github.io/NetNexus/SETTINGS.html#tcp-ao-设置)。

## License

NetNexus 基于 [MIT License](LICENSE) 发布。生产依赖的第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
