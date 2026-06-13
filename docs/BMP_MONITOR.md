# BMP 监控器

BMP 监控器用于接收路由器或测试脚本发送的 BMP 数据，并在本地查看客户端、BGP session、Loc-RIB、路由明细和统计报告。

## 已实现能力

- BMP v3 / v4 报文接收。
- BMPv4 TLV draft-19 / draft-20 可配置。
- Initiation、Termination、Peer Up、Peer Down、Route Monitoring、Statistics Report 处理。
- 客户端连接列表。
- BGP session 列表和 session RIB 路由列表。
- Loc-RIB instance 列表和 Loc-RIB 路由列表。
- 路由状态过滤：active、stale、all。
- 前缀关键字过滤。
- 路由详情查询。
- BGP 原始报文解析摘要按需查询。
- BMPv4 Path Marking TLV 展示。
- 过期路由清理。
- 只读 HTTP API 查询。
- 本地 mock BMP 客户端脚本。

未实现的能力不在本文档中承诺，例如趋势图、告警规则、定时报表、文件导出、历史库查询。

## 页面

### BMP 配置和客户端

配置 BMP 监听端口、BMPv4 TLV draft、Path Marking TLV 类型以及可选 MD5 认证参数。页面下方展示当前 BMP 客户端。

![BMP 配置和客户端信息](images/bmp/bmp-config-and-client-info.png)

注意：

- `draft-20` 的 Route Monitoring `BGP Message TLV` 类型为 `7`。
- `draft-19` 的 Route Monitoring `BGP Message TLV` 类型为 `4`。
- 如果设备或 mock 脚本的 draft 与页面配置不一致，日志可能出现 `does not contain mandatory BGP Message TLV`。

### BGP Session

展示指定 BMP 客户端下的 BGP peer session，以及 session RIB 路由。

![BMP 客户端和 BGP 监控对等体信息](images/bmp/bmp-client-and-bgp-monitor-peer-info.png)

路由列表包含 `pathId`、`rd`、前缀、掩码、下一跳、AS Path、路由状态等字段。IPv4/IPv6 单播没有携带 RD 时，页面和存储按 `0:0` 处理，避免路由 key 歧义。

路由操作：

- 查询路由详情。
- 查询 BGP 原始报文解析摘要。
- 清理 stale 路由。

### Loc-RIB

展示 BMP Local-RIB instance 和 Loc-RIB 路由。

![BMP 监控 BGP 路由](images/bmp/bmp-monitor-bgp-route.png)

Loc-RIB 使用 instance 维度查询，支持路由列表、路由详情和 stale 路由清理。

### 统计报告

统计报告页展示 BMP Statistics Report 当前内存数据：

- session statistics
- Loc-RIB statistics
- BMPv4 TLV 信息
- per-AFI/SAFI 统计项

![BMP BGP 会话统计](images/bmp/bmp-session-statis-report.png)

![BMP Loc-RIB 统计](images/bmp/bmp-loc-rib-statis-report.png)

## 本地 mock 数据

项目提供 mock BMP 客户端，便于不接真实路由器时查看页面布局和 API 返回：

```bash
npm run mock:bmp
```

常用参数：

```bash
node scripts/mockBmpClient.js --host 127.0.0.1 --port 11019 --routes 25 --interval 30 --once
```

使用步骤：

1. 在 BMP 配置页将 `v4 TLV格式` 设为 `draft-20`。
2. 启动 BMP 服务。
3. 运行 `npm run mock:bmp`。
4. 查看 BGP Session、Loc-RIB 和统计报告页面。

## 外部 API

BMP 查询接口由外部 HTTP API 提供。API 是只读的，不负责启动 BMP 服务。使用前需要在设置页启用 HTTP API，并在 BMP 页面启动 BMP。

详见 [外部 API 文档](API.md)。

## 注意事项

- BMP 数据当前保存在 worker 内存和本地运行状态中，不等同于长期历史数据库。
- BMP 客户端断开后，对应连接会从客户端列表移除。
- 打开 debug/info 日志时，高频 BMP Route Monitoring 会产生大量日志，可能影响 CPU 和磁盘 IO。
- MD5 认证依赖服务器部署页面中的 TCP MD5 代理能力。
