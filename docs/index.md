---
layout: home
title: NetNexus
titleTemplate: false

hero:
    name: NetNexus
    text: 本地网络协议与开发工具集
    tagline: 在一个桌面应用中完成协议联调、路由分析、轻量服务和本机调试。
    actions:
        - theme: brand
          text: 浏览功能文档
          link: /BGP_SIMULATOR
        - theme: alt
          text: 开发与运行
          link: /DEVELOPMENT

features:
    - icon: ⇄
      title: BGP 与 BMP
      details: 模拟 BGP 对等体和多地址族路由，接收 BMP 数据并分析会话、Loc-RIB、五阶段路由与历史事件。
      link: /BMP_MONITOR
      linkText: 查看 BMP 文档
    - icon: ✓
      title: RPKI 与 SNMP
      details: 提供本地 RPKI-RTR 服务、百万级 ROA/ASPA 导入，以及 SNMP Trap、MIB 和基础查询工具。
      link: /RPKI_VALIDATOR
      linkText: 查看 RPKI 文档
    - icon: ⎇
      title: NETCONF / YANG
      details: 连接 NETCONF 设备，发现、下载和编译 YANG 模型，并执行常用配置与订阅操作。
      link: /NETCONF_YANG
      linkText: 查看工作台文档
    - icon: ◫
      title: 本地协议服务器
      details: 集成 FTP、DHCP、NTP、RADIUS、TFTP 和 Syslog 服务，适合实验室和协议验证。
      link: /FTP_SERVER
      linkText: 查看服务器文档
    - icon: ◇
      title: 开发工具
      details: 包含报文解析、字符串生成、端口监控、网络信息、HTTP API 测试和 TCP/UDP 收发工具。
      link: /TOOLS
      linkText: 查看工具文档
    - icon: '{ }'
      title: API 与数据参考
      details: 提供 BMP 只读 HTTP API，以及 SQLite Schema、查询链路、生命周期和运维说明。
      link: /API
      linkText: 查看 API 文档
---

## 统一、清晰的桌面体验

NetNexus 将常用协议实验、数据查看和开发工具集中在同一个桌面界面中。文档中的页面截图由项目脚本基于当前实现生成。

![NetNexus 扁平化启动界面](images/startup/startup-banner.png)

## 从哪里开始

- 想快速运行源码，请看[开发与运行](DEVELOPMENT.md)。
- 想生成或查看 BGP 路由，请看[BGP 模拟器](BGP_SIMULATOR.md)。
- 想分析设备上报的 BMP 数据，请看[BMP 监控器](BMP_MONITOR.md)。
- 想通过本地 HTTP 接口读取 BMP 数据，请看[外部 API](API.md)。
