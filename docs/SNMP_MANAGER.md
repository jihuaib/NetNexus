# SNMP 工具

SNMP 模块当前包含 Trap 接收、Trap 历史、MIB 管理和基础 SNMP 查询能力。它不是完整的网络监控平台，不包含定时轮询、趋势图、告警规则、拓扑发现或报表系统。

## 已实现能力

- SNMP Trap 服务启动和停止。
- Trap 历史列表和详情。
- SNMP v1 / v2c / v3 参数配置。
- MIB 文件或目录导入。
- MIB 后台编译和缓存。
- OID 树查看。
- OID 解析。
- MIB 工程保存和导入。
- GET、GET-NEXT、WALK、SET 等基础查询操作。

## 页面

### SNMP 配置

配置 Trap 服务和查询目标。

![SNMP 配置界面](images/snmp/snmp-config.png)

主要字段：

- 查询目标地址。
- 查询端口。
- Trap 端口。
- SNMP 版本。
- v1/v2c Community。
- v3 用户名、安全级别、认证协议、认证密码、加密协议、加密密码。

配置页可以启动或停止 Trap 服务，并展示当前运行状态。

### Trap 监控

Trap 页面展示当前收到的 Trap 历史。

![SNMP Trap 监控](images/snmp/snmp-trap.png)

支持：

- Trap 列表。
- Trap 详情。
- Trap 历史清空。
- Trap 来源、版本、OID、变量绑定等信息展示。

### MIB 管理

MIB 页面用于导入、编译和浏览 MIB。

![SNMP MIB 管理](images/snmp/snmp-mib.png)

支持：

- 导入单个或多个 MIB 文件。
- 导入目录。
- 重新编译。
- 保存 MIB 工程。
- 导入 MIB 工程。
- 清空当前 MIB。
- OID 树查看。
- OID 解析。
- 节点详情展示。
- 文件编译状态展示。

## 基础查询

配置查询目标后，可以基于 MIB 节点或 OID 执行基础 SNMP 查询。当前能力以手工查询为主，不提供后台定时采集。

支持的操作以页面和当前 `net-snmp` 实现为准：

- GET。
- GET-NEXT。
- WALK。
- SET。

## 注意事项

- Trap 默认端口 `162` 在部分系统上需要管理员/root 权限，可改用高位端口测试。
- SNMPv3 的认证和加密参数必须与目标设备配置一致。
- MIB 编译结果依赖文件依赖关系；缺少依赖 MIB 时，部分对象可能无法解析。
- 当前 Trap 历史保存在运行内存中，应用重启后不会恢复。

## 常见问题

**Q: Trap 收不到怎么办？**  
A: 检查 Trap 端口、防火墙、设备 Trap 目标地址、Community 或 SNMPv3 用户参数。

**Q: MIB 导入失败怎么办？**  
A: 检查是否缺少依赖 MIB，或者使用目录导入把相关 MIB 一起导入。

**Q: 是否支持完整设备监控？**  
A: 当前不支持定时轮询、趋势图和告警规则。可以手工执行基础查询。
