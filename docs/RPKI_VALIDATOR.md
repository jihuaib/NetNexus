# RPKI RTR 服务

RPKI 模块当前实现的是本地 RPKI-RTR cache/server，用于向路由器提供 ROA、Router Key 和 ASPA 数据。它不是完整的 RPKI 仓库同步器，也不会自动从 Trust Anchor 拉取证书链、Manifest、CRL 或 ROA 对象。

## 已实现能力

- RPKI-RTR 服务端启动和停止。
- 协议版本上限可配置：v0、v1、v2。
- ROA 记录增删、分页查询、JSON 导入。
- Router Key 记录增删和查询。
- ASPA 记录增删、分页查询、JSON 导入。
- ASPA 编码格式可选：
  - `latest`：当前 8210bis 风格。
  - `legacy`：兼容 draft-10 风格，含 AFI Flags 和 Provider AS Count。
- Serial Query / Reset Query 响应。
- 运行时 client 列表。
- 可选 TCP MD5 代理配置。

## 页面

### RPKI 配置

配置 RPKI-RTR 服务端口、最高协议版本、ASPA 编码格式和可选 MD5 认证参数。

![RPKI 配置和客户端](images/rpki/rpki-config-and-client.png)

按钮说明：

| 按钮 | 功能 |
| --- | --- |
| 启动服务 / 已启动 | 按端口、协议版本、ASPA 编码和 MD5 参数启动 RPKI-RTR 服务。 |
| 停止服务 | 停止 RPKI-RTR 服务并断开客户端连接。 |

说明：

- v0 只发送 ROA。
- v1 支持 Router Key。
- v2 支持 ASPA。
- MD5 认证依赖服务器部署页面中的 TCP MD5 代理能力。

### ROA

ROA 页面用于维护本地 ROA 数据。

![RPKI ROA 记录](images/rpki/rpki-roa.png)

按钮说明：

| 按钮 | 功能 |
| --- | --- |
| 新增 | 新增一条 ROA/VRP 记录。 |
| 删除 | 删除选中的 ROA 记录。 |
| 删除全部 | 清空当前本地 ROA 数据。 |
| JSON导入 | 从 JSON 文件导入 ROA/VRP 数据。 |
| 查询 | 按 IP 类型、Prefix、Max Length 或 ASN 过滤列表。 |
| 重置 | 清空过滤条件并重新加载列表。 |

支持：

- 新增 ROA。
- 删除 ROA。
- 删除全部 ROA。
- JSON 导入。
- 按 IP 类型、Prefix/Prefix Mask、ASN 查询。
- 分页加载。

JSON 导入支持常见 ROA/VRP 结构：

- 根数组。
- `roas`。
- `vrps`。
- SLURM `prefixAssertions`。

字段兼容：

- ASN：`asn`、`ASN`。
- Prefix：`prefix`、`IP Prefix`。
- Max Length：`maxLength`、`max_length`、`maxPrefixLength`。

导入时会跳过重复 ROA，并将主机地址归一化为网络地址。ROA 数据以 JSONL 文件保存，查询时使用运行时索引加速。

### Router Key

Router Key 页面用于维护 RPKI-RTR v1+ 的 Router Key PDU 数据。

![RPKI Router Key 记录](images/rpki/rpki-router-key.png)

按钮说明：

| 按钮 | 功能 |
| --- | --- |
| 新增 | 新增一条 Router Key 记录。 |
| 删除 | 删除选中的 Router Key 记录。 |
| 查询 | 按 ASN 或 SKI 条件过滤列表。 |
| 重置 | 清空过滤条件并重新加载列表。 |

支持字段：

- ASN。
- Subject Key Identifier。
- Subject Public Key Info。

### ASPA

ASPA 页面用于维护 RPKI-RTR v2 的 ASPA PDU 数据。

![RPKI ASPA 记录](images/rpki/rpki-aspa.png)

按钮说明：

| 按钮 | 功能 |
| --- | --- |
| 新增 | 新增一条 ASPA 记录。 |
| 删除 | 删除选中的 ASPA 记录。 |
| 删除全部 | 清空当前本地 ASPA 数据。 |
| JSON导入 | 从 JSON 文件导入 ASPA 数据。 |
| 查询 | 按 Customer ASN 过滤列表。 |
| 重置 | 清空过滤条件并重新加载列表。 |

支持：

- 新增 ASPA。
- 删除 ASPA。
- 删除全部 ASPA。
- JSON 导入。
- 按 Customer ASN 查询。
- 分页加载。
- 单条记录包含多个 Provider AS。

性能相关：

- Provider AS 列表会保留用户输入顺序和重复项。
- 一条 ASPA 记录包含大量 Provider AS 时，发送和日志量都会随 Provider 数增长。
- 如果只是日常调试，不建议在 debug/info 日志下反复发送超大 ASPA 记录。

## 使用步骤

1. 进入 `RPKI`。
2. 在 `RPKI配置` 中设置端口和最高协议版本。
3. 选择 ASPA 编码格式。
4. 在 ROA、Router Key、ASPA 页面维护数据。
5. 启动 RPKI 服务。
6. 路由器通过 RPKI-RTR 连接本机服务。

## 注意事项

- 当前数据来源是用户手工维护或 JSON 导入，不会自动同步公网 RPKI repository。
- 启动服务后新增或删除 ROA/Router Key/ASPA，会向已连接 client 发送相应更新。
- 标准或低位端口在部分系统上可能需要管理员/root 权限。
- 重启应用后，RPKI 服务不会自动恢复启动，需要手动启动。
