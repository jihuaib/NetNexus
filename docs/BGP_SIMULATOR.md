# BGP 模拟器

BGP 模拟器用于在本机启动 BGP 服务，配置对等体并生成测试路由。它适合协议联调、页面验证和实验场景，不等同于生产级 BGP 路由器。

## 已实现能力

- BGP 服务启动和停止。
- Local AS、Router ID、地址族能力配置。
- IPv4 / IPv6 对等体配置。
- 对等体状态查看。
- IPv4 / IPv6 单播路由生成、删除和分页查看。
- IPv4 MVPN 路由生成和删除。
- IPv4 / IPv6 QP 路由生成和删除。
- RouteViews MRT 文件导入。
- 路由详情查看。
- BGP Open 自定义能力和路由自定义属性。

## 页面

### BGP 配置

![BGP 配置界面](images/bgp/bgp-config.png)

主要字段：

- Local AS。
- Router ID。
- 地址族能力。

### 对等体配置

![BGP 对等体信息](images/bgp/bgp-peer.png)

支持配置 IPv4 / IPv6 peer，并查看 peer 状态。实际会话能否建立取决于对端地址、AS、端口、网络连通性和对端策略。

### 路由管理

IPv4 单播路由：

![BGP 路由信息](images/bgp/bgp-route.png)

IPv6 单播路由：

![BGP IPv6 路由信息](images/bgp/bgp-route-ipv6.png)

IPv4 MVPN 路由：

![BGP MVPN 路由信息](images/bgp/bgp-route-mvpn.png)

IPv4 QP 路由：

![BGP IPv4 QP 路由信息](images/bgp/bgp-route-ipv4-qp.png)

IPv6 QP 路由：

![BGP IPv6 QP 路由信息](images/bgp/bgp-route-ipv6-qp.png)

当前路由页面：

- IPv4 单播。
- IPv6 单播。
- IPv4 MVPN。
- IPv4 QP。
- IPv6 QP。

IPv4 / IPv6 单播支持批量生成、删除、分页查看和 RouteViews 导入。

### 自定义属性

Open 消息支持自定义能力字段，路由生成支持自定义路由属性。该能力通过页面按钮打开编辑抽屉。

## 使用步骤

1. 进入 `BGP模拟器`。
2. 在 `BGP配置` 中设置 Local AS、Router ID 和地址族。
3. 启动 BGP 服务。
4. 在对等体页面配置 peer。
5. 在对应路由页面生成或导入路由。
6. 在 peer 和路由列表中观察状态。

## RouteViews 导入

RouteViews 导入用于把本地 MRT 文件转换为 BGP 路由数据。页面会读取项目内置默认文件或用户选择的 MRT 文件。

注意：

- 大文件导入会占用 CPU 和磁盘 IO。
- 导入结果受当前地址族和过滤参数影响。
- 导入不是在线同步，不会自动更新 RouteViews 数据。

## 注意事项

- 当前文档只说明页面可见和代码已实现能力，不承诺完整实现所有 BGP 扩展。
- 低位端口或被占用端口可能导致服务启动失败。
- 大量批量路由生成会增加内存、文件和事件处理压力。
- debug/info 日志会显著放大高频路由操作的 IO 开销。

## 常见问题

**Q: BGP 会话无法建立怎么办？**  
A: 检查本地服务是否启动、peer 地址和 AS 是否匹配、端口是否开放、对端是否允许连接。

**Q: 如何查看生成的路由？**  
A: 进入对应地址族路由页面，使用列表和详情查看。

**Q: 是否支持所有 BGP 地址族？**  
A: 不支持。以当前页面列出的 IPv4/IPv6 单播、IPv4 MVPN、IPv4/IPv6 QP 为准。
