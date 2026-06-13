# 设置

设置页用于管理全局运行选项、工具历史数量、FTP 用户数量、外部 HTTP API、TCP MD5 代理部署和更新行为。

## 通用设置

![设置界面](images/setting/setting.png)

### 日志级别

可选值：

- `off`
- `debug`
- `info`
- `warn`
- `error`

行为：

- 保存后对主进程立即生效。
- 保存后会同步到已经启动的协议 worker。
- 后续新启动的协议服务会继承当前日志级别。
- 日志级别不持久化，应用重启后默认恢复 `off`。

建议：

- 日常使用保持 `off` 或 `warn`。
- 需要定位问题时临时切到 `debug` 或 `info`。
- 高频协议场景下，debug/info 会产生大量文件和控制台日志，可能影响 CPU 和磁盘 IO。

## 工具集合设置

配置工具历史记录数量：

- 字符串生成历史最大条数。
- 报文解析历史最大条数。

当前不提供统一历史导出或备份功能。

## FTP 设置

配置 FTP 用户最大保存数量。超过上限时，新增用户会触发旧数据淘汰逻辑。

## HTTP API 设置

外部 HTTP API 是本机只读服务，当前已注册 BMP 查询接口。

行为：

- 监听地址固定为 `127.0.0.1`。
- 保存启用状态后立即启动或停止 API 服务。
- 端口可配置。
- 最大分页大小可配置。
- API 不负责启动 BMP；BMP 仍需在 BMP 页面启动。

详见 [外部 API 文档](API.md)。

## 服务器部署

服务器部署用于向远端 Linux 主机部署 TCP MD5 代理程序，供 BMP/RPKI 的 MD5 认证场景使用。

配置项：

- Linux 服务器地址。
- SSH 用户名。
- SSH 密码。

页面提供：

- 保存部署配置。
- 测试 SSH 连接。
- 执行部署。
- 查看部署状态。

注意：

- 该能力依赖远端 Linux 环境、SSH 权限、编译工具和网络连通性。
- 部署脚本会在远端执行命令，使用前应确认目标机器用途和权限。
- 不需要 MD5 认证时，可以不使用该页面。

## 应用更新

![更新设置](images/setting/setting-updater.png)

更新页包含：

- 当前版本。
- 检查更新。
- 下载更新。
- 重启并安装。
- 启动时检查更新。
- 自动下载更新。

注意：

- 更新能力只在打包后的应用中有意义。
- 开发模式下可能无法完整执行更新流程。
- 更新源使用 GitHub Releases。

## 截图维护

文档截图可以通过脚本生成：

```bash
npm start
npm run docs:screenshots
```

也可以指定页面地址：

```bash
NETNEXUS_DOCS_URL=http://127.0.0.1:3000 npm run docs:screenshots
```

脚本会把当前页面状态截图写入 `docs/images`。截图视口默认不小于 `1920x1200`，避免宽表格截出横向滚动条；可用 `NETNEXUS_DOCS_WINDOW_WIDTH` 和 `NETNEXUS_DOCS_WINDOW_HEIGHT` 覆盖。BMP 截图会自动启动本地 BMP 服务并注入 mock 路由数据；可用 `NETNEXUS_DOCS_BMP_PORT` 和 `NETNEXUS_DOCS_BMP_ROUTES` 覆盖端口和路由数。
