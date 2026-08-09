# NetNexus

[![Vue.js](https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vue.js)](https://vuejs.org/)
[![Electron](https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron)](https://electronjs.org/)
[![NetNexus UI](https://img.shields.io/badge/UI-NetNexus-FF7A1A?style=flat-square)](https://github.com/jihuaib/NetNexusUI)
[![Documentation](https://img.shields.io/badge/docs-online-FF7A1A?style=flat-square)](https://jihuaib.github.io/NetNexus/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

NetNexus 是一个基于 Vue 3、自研 NetNexus UI 和 Electron 的本地网络工具集，面向协议联调、路由分析、轻量服务器和本机开发调试场景。

[在线文档](https://jihuaib.github.io/NetNexus/) · [PDF 手册](https://jihuaib.github.io/NetNexus/netnexus-docs.pdf) · [版本下载](https://github.com/jihuaib/NetNexus/releases)

## 功能简介

- **路由与安全**：BGP 模拟器、BMP v3/v4 监控与五阶段路由分析、RPKI-RTR、ROA、Router Key 和 ASPA。
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

## License

NetNexus 基于 [MIT License](LICENSE) 发布。生产依赖的第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
