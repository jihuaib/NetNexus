# NETCONF / YANG 工作台

NETCONF / YANG 工作台用于连接支持 NETCONF over SSH 的网络设备，读取设备模型清单，下载或导入 YANG 文件，编译本地模型并浏览 Schema，最后基于设备 Capability 执行常用 NETCONF 操作。

这里的“YANG 操作”覆盖模型的发现、下载、导入、解析、依赖检查、编译、源码查看、Schema 浏览和诊断；设备配置的读取与修改由 NETCONF RPC 完成。

## 已实现能力

- 保存多个 NETCONF 连接 Profile。
- 使用密码或 SSH 私钥认证，连接 SSH `netconf` subsystem。
- NETCONF 1.0 `]]>]]>` framing 与 NETCONF 1.1 chunked framing。
- `hello` 交换、Capability 展示、Session ID 和会话状态管理。
- Keepalive、超时控制、主动断开和可选自动重连。
- 从 RFC 8525、RFC 7895、RFC 6022 或服务端 `hello` Capability 发现模型。
- 通过 RFC 6022 `get-schema` 下载 YANG 源文件。
- 从本机导入一个或多个 `.yang` 文件，或递归导入目录。
- 使用内容哈希去重并保存 YANG 模型、元数据、工作区和编译缓存。
- 解析 module/submodule、revision、namespace、feature、deviation、import 和 include。
- 分析 import/include 依赖闭包，并报告缺失依赖和 revision 不匹配。
- 后台调用内置 `netnexus-libyang-schema`（基于 libyang）完成权威编译与 effective Schema 导出，并提供缓存、Schema 树懒加载、源码查看和诊断定位。
- 启动时检查 libyang 运行时和版本；运行时缺失、损坏或不兼容时阻止编译，绝不回退到简化解析器并报告成功。
- 执行读取、配置、锁、校验、提交等结构化 NETCONF RPC，或直接发送原始 RPC XML。
- 展示 `rpc-reply`、`rpc-error`、message-id、耗时和原始请求。
- 支持 RFC 5277 旧订阅，以及 RFC 8639/8640 动态订阅的建立、修改和删除；同一 Session 可承载多个现代订阅。
- 支持 RFC 8641 YANG-Push periodic/on-change、完整 `push-update`、YANG Patch `push-change-update` 和重同步。
- 独立采集、筛选、分组、查看和导出异步 Notification，并按现代通知内的订阅 ID 精确关联。

## 页面

| 页面 | 用途 |
| --- | --- |
| 连接设置 | 新建、编辑、测试和删除连接 Profile；连接或断开 NETCONF 会话；查看服务端 Capability。 |
| 模型列表 | 读取设备模型清单、下载模型、导入本地文件或目录、筛选模型、编译所选模型、查看源码和底部编译日志。 |
| Schema 工作区 | 浏览模型列表生成的 Schema；左键仅选择节点，节点属性通过右键菜单在弹窗中查看，所选 NETCONF 操作直接在右侧 Browser 工作区执行；通知记录在独立抽屉中查看。 |

## 使用本地 NETCONF Mock 完整联调

项目提供独立的 NETCONF-over-SSH Mock Server。它不是浏览器接口桩，而是使用真实 SSH 密码认证、SSH `netconf` subsystem、NETCONF `hello` 交换和 NETCONF 1.0/1.1 framing，因此可以在没有网络设备时验证从连接到配置提交的完整链路。

先在两个终端中分别启动 Mock 设备和 NetNexus：

```bash
# 终端 1：启动 Mock 设备
npm run mock:netconf

# 终端 2：启动 NetNexus
npm run dev
```

Mock 启动后会打印监听地址、SSH Host Key 指纹和 Profile 参数。默认参数如下：

| Profile 字段 | 默认值 |
| --- | --- |
| Profile 名称 | `本地 NETCONF Mock` |
| 设备地址 | `127.0.0.1` |
| 端口 | `8830` |
| 认证方式 | 密码 |
| 用户名 | `netconf` |
| 密码 | `netconf` |
| Host Key 指纹 | 可复制启动日志中的 `SHA256:` 指纹；首次连接也可以留空 |
| 自动重连 | 关闭 |

进入“NETCONF/YANG → 连接设置”新建普通 Profile，填入上表参数，然后依次点击“测试连接 → 保存 → 连接”。这个 Profile 与真实设备 Profile 使用相同的连接流程，不需要开启页面专用的 Mock 模式。

连接成功后，可以按以下顺序验证完整流程：

1. 进入“模型列表”，点击“读取设备列表”，确认发现 `netnexus-mock-device`、`netnexus-mock-types` 和 `netnexus-mock-invalid`。
2. 选择并下载前两个有效模型。`netnexus-mock-device` 会通过 `import` 引用 `netnexus-mock-types`，可用于验证 `get-schema` 和依赖处理。
3. 在模型列表中选择下载后的有效模型并执行“编译所选”，确认编译日志逐文件显示“编译成功”，然后进入 Schema 工作区浏览 `system`、`interfaces` 和 `state` 节点。
4. 在 Schema 树中右键 `system` 或其他数据节点，执行 `get` 或 `get-config`，确认初始 hostname 为 `netnexus-mock`。
5. 右键 config 数据节点选择 `edit-config`，目标 datastore 设为 `candidate`，`default-operation` 设为 `merge`，在“config XML”中粘贴下面的内容并执行：

```xml
<system xmlns="urn:netnexus:params:xml:ns:yang:mock-device">
  <hostname>netnexus-lab-router</hostname>
  <location>local-integration-test</location>
</system>
<interfaces xmlns="urn:netnexus:params:xml:ns:yang:mock-device">
  <interface>
    <name>eth0</name>
    <description>Updated from NetNexus</description>
    <enabled>true</enabled>
    <mtu>9000</mtu>
  </interface>
</interfaces>
```

6. 对 `candidate` 执行 `validate`，再执行 `commit`。最后对 `running` 执行 `get-config`，确认 hostname、location、接口描述和 MTU 已更新。
7. 展开 Schema 中的 `mock-event` notification，右键选择“建立动态订阅（RFC 8639）”并执行 `establish-subscription`。随后在 Mock 终端输入 `/notify hello`，通知抽屉会显示完整 `<notification>`、Generated/Received 时间和订阅 ID；可直接从抽屉打开修改或删除操作，删除不会断开 Session。
8. 右键 `state` 等数据节点选择“订阅当前节点（YANG-Push）”，可验证 periodic 快照；在右侧参数树将更新策略改为 on-change 后，修改 Mock datastore 会收到 `push-change-update`，通知抽屉还可执行完整重同步。
9. 需要验证旧设备时，可在独立 Session 上选择“订阅此通知（RFC 5277）”。旧订阅没有单独删除 RPC，结束时会明确提示并断开它绑定的 Session。RFC 5277 与现代订阅不会在同一 Session 混用。
10. 还可以继续验证 `copy-config`、`delete-config`、`lock`、`unlock`、`discard-changes`、原始 RPC 和 Mock 模型中定义的 `reboot` RPC。服务端收到的 RPC 及 datastore revision 会实时输出到启动 Mock 的终端。

要验证失败流程，可下载 `netnexus-mock-invalid`，并与两个有效模型一起执行编译。该文件的元数据和下载流程均有效，但故意引用了不存在的 YANG 类型，因此编译日志会分别显示 `netnexus-mock-device`、`netnexus-mock-types` 成功，只有 `netnexus-mock-invalid` 失败，同时保留具体 libyang 诊断。整批结果会标记为“部分编译成功”，Schema 工作区仍会载入两个有效模型，并明确提示当前 Schema 仅部分可用。

Mock datastore 只保存在当前进程内存中，重启服务会恢复初始配置。在 Mock 终端中可使用 `/status`、`/show running`、`/show candidate`、`/reset`、`/notify <message>`、`/subscriptions`、`/lifecycle started|modified|terminated <id> [reason]`、`/terminate <id> [reason]` 和 `/quit` 辅助观察或注入状态。查看完整启动参数：

```bash
npm run mock:netconf -- --help

# 自定义端口和账号
npm run mock:netconf -- --port 18830 --username demo --password secret
```

Mock 默认只监听 `127.0.0.1`。默认账号、密码以及仓库中的固定 SSH Host Key 都是公开的测试材料，不应部署到生产环境或不可信网络；固定 Key 仅用于让本地 Profile 在多次启动之间保持同一个指纹。

## 快速开始

### 1. 创建连接

进入“NETCONF/YANG → 连接设置”，新建 Profile 并填写：

- Profile 名称。
- 设备 IP 地址或主机名，NETCONF SSH 默认端口为 `830`。
- 用户名。
- 密码，或者本机 SSH 私钥路径与私钥口令。
- 可选的 SSH Host Key SHA256 指纹。
- 连接超时、Keepalive 周期和自动重连开关。

先点击“测试连接”。测试会完成 SSH 建连、打开 `netconf` subsystem 和 NETCONF `hello` 交换，但不会保留会话。测试通过后保存 Profile，再点击“连接”。

设备侧需要启用 NETCONF over SSH，并允许该用户打开 `netconf` subsystem。普通 SSH Shell 登录成功不代表 NETCONF subsystem 一定可用。

### 2. 读取和下载设备模型

连接成功后进入“模型列表”，点击“读取设备列表”。发现过程按以下顺序回退：

1. RFC 8525 `ietf-yang-library`。
2. RFC 7895 `modules-state`。
3. RFC 6022 `ietf-netconf-monitoring/schemas`。
4. 从服务端 `hello` Capability 中提取 `module`、`revision`、`features` 和 `deviations`。

选择模型后点击“下载所选”。下载通过设备的 `get-schema` RPC 完成，成功内容会直接导入本地 YANG 仓库。设备必须声明并实际实现 `ietf-netconf-monitoring:get-schema`；仅在 Capability 中列出模块但不支持 `get-schema` 时，需要从厂商软件包手工导入文件。

部分华为设备允许初始密码账号建立 SSH/NETCONF 会话和读取模型清单，但会拒绝 `get-schema`，返回 `No permission ... due to the initial password`。遇到该错误时，应先通过 STelnet 或 Console 完成首次密码修改，再更新连接 Profile 中的密码并重试。下载器会把它视为会话级错误并立即停止后续请求；此前已经成功获取的源码仍会写入本地仓库并显示为“部分完成”，如果错误发生在第一个模型，则设备实际没有返回任何可保存的 YANG 内容。

YANG 的 import/include 依赖必须同时存在于本地仓库。建议下载同一个 module-set 中的依赖模块和 submodule；编译诊断出现 `missing import` 或 `missing include` 时，补充下载或导入对应文件后重新编译。

### 3. 导入和编译

没有真实设备时，可以直接使用“导入文件”或“导入目录”。目录导入会递归扫描 `.yang` 文件。仓库按 SHA256 内容哈希保存 Blob，相同内容不会重复写入；同名不同 revision 可以共存。

模型编译只从“模型列表 → 编译所选”发起，避免无意中编译整个本地仓库。所选模型能够解析到的 import/include 依赖会自动加入编译集合。编译在 Worker 中运行，不阻塞页面，进度会显示依赖准备、libyang 编译、Schema 索引和缓存阶段。

模型列表底部的编译日志显示最近一次编译的逐文件状态、错误、警告和信息；导入、下载或修改模型使上下文失效后，不会继续展示旧诊断。需要查看源码时，使用模型表格对应行的“源码”按钮。

libyang 是唯一权威编译引擎：

- YANG 1.0/1.1 的语法和语义是否合法，以 libyang 结果为准。
- typedef、uses/refine、augment、deviation、feature、XPath must/when 和跨模块约束由 libyang 校验。
- 只有固定合同版本的 `netnexus-libyang-schema` 成功完成 libyang 编译并返回通过结构校验的 effective Schema 时，模块和工作区才会标记为“已编译”。
- JavaScript 解析仅用于导入时提取模块元数据、准备 import/include 依赖和界面索引，不构成编译成功，也不作为 libyang 不可用时的回退路径。
- 编译缓存同时绑定模型内容、feature/deviation 选项、libyang 版本、helper 合同和可执行文件身份；使用外部 deviation 文件或搜索目录时禁用结果缓存，避免外部依赖变化后复用旧树。

Schema 工作区中的树直接来自 libyang 编译后的 effective schema。`uses`、`augment`、`deviation`、feature 选择以及继承后的 `config`、`mandatory`、`type`、`default` 等语义均由 libyang 解析；JavaScript 不再生成或回退到另一棵 Schema 树。运行时缺失、编译失败或导出结果无效时不会显示非权威预览。

当前导出合同的范围是 core effective schema：datastore 数据节点，以及 RPC、action、notification、input 和 output。libyang 仍会编译并校验内置扩展插件，但由 `yang-data`、`structure`、schema-mount 等扩展产生的独立扩展树暂不并入普通 Schema 树；运行时能力中会明确返回 `extensionSchemaExport: false`。

正式安装包应携带当前平台对应的 libyang/`yanglint` 运行时和 `netnexus-libyang-schema` effective-schema 导出工具。“设置 → 运行时诊断”会展示实际使用的引擎、版本和路径；任一内置程序缺失、损坏或与当前系统架构不兼容时，模型列表中的编译按钮会停用并给出修复提示。

打包运行时按平台和 CPU 架构隔离在应用资源目录的 `libyang/<platform>-<arch>/` 下，包括 `bin/yanglint`、`bin/netnexus-libyang-schema` 和配套的 libyang 内置模块。两个程序均静态链接同一个固定版本的 libyang；Worker 使用 Schema 导出工具一次完成权威编译和结构化 JSON 导出。

正常执行 `npm install` 或 `npm ci` 时，安装生命周期会自动确保当前平台和 CPU 架构对应的 bundled libyang 运行时可用。已有运行时通过完整性、版本和构建输入指纹校验时会直接复用，不会重复编译；运行时缺失或构建输入已变化时会自动重新编译，并在完成后再次验证。

自动构建需要网络访问以取得锁定版本的上游源码，并要求本机具备以下工具：

- macOS / Linux：Git、CMake 和可用的 C 编译工具链。
- Windows：仅支持 x64 构建，需要 Git、CMake 3.22 或更高版本、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”工作负载、Windows SDK、vcpkg 和网络访问。vcpkg 由用户安装：可以在 Visual Studio Installer 中选择 vcpkg 组件，也可以使用官方 Git checkout 并自行运行 `bootstrap-vcpkg.bat`。

构建流程依次查找 `VCPKG_ROOT`、`VCPKG_INSTALLATION_ROOT`、`PATH` 和 Visual Studio 2022 自带的 vcpkg；自定义安装建议设置 `VCPKG_ROOT`。项目只校验已有的 `vcpkg.exe` 和 CMake toolchain，不会克隆、安装或 bootstrap vcpkg。构建时仍会执行 manifest mode 的 `vcpkg install`，把锁定版本的 dirent 和 pthreads 构建到临时目录；Git checkout 缺少固定 baseline 对象时只补取对应的 registry 对象，Visual Studio 版本则使用远程 built-in registry。

如果上游源码、registry 或依赖下载失败，请在修复网络或代理配置后重新执行 `npm install`，也可以单独重试 `npm run libyang:build:windows`。Git 操作遵循 Git 代理配置，下载过程遵循标准的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

维护者需要无条件重新构建当前平台运行时时，可以执行：

```bash
npm run libyang:build
npm run libyang:verify
```

平台专用命令仍可用于调试构建脚本：

```bash
npm run libyang:build:unix
npm run libyang:build:windows
```

只有明确不需要任何 YANG 功能的任务才可以设置 `NETNEXUS_SKIP_LIBYANG_BUILD=1` 跳过安装阶段构建。这个开关不会关闭运行时验证；缺少或使用了无效运行时后，应用打包和 YANG 编译仍会失败。`npm install --ignore-scripts` 与 `npm ci --ignore-scripts` 同样会绕过自动构建，不适用于打包或 YANG 测试。

应用打包前会强制验证平台、架构、执行权限和版本，验证失败则终止打包，避免生成不带权威编译器的安装包。

源码开发或运行时联调可以同时覆盖内置 `yanglint` 和 Schema helper；两者的 libyang 版本必须完全一致，helper 合同必须为版本 1：

```bash
NETNEXUS_YANGLINT_PATH=/absolute/path/to/yanglint \
NETNEXUS_LIBYANG_SCHEMA_PATH=/absolute/path/to/netnexus-libyang-schema \
npm run dev
```

这些环境变量仅用于开发覆盖和故障定位，不是普通用户的安装步骤。libyang/helper 的 stdout/stderr 会转换成模型列表底部的编译日志。

### 4. 浏览 Schema 和执行 RPC

编译成功后，Schema 工作区支持：

- 按模块展开 libyang effective schema 根节点和子节点。
- 左键单击节点仅更新当前选择，不自动打开属性弹窗。
- 通过节点右键菜单的“查看节点属性”，在弹窗中查看路径、keyword、数据类型、config、mandatory、default、units、status 和描述。
- 右键 Schema 数据节点、RPC/action 或 notification 选择对应操作，直接在右侧操作区编辑参数、执行 RPC 并查看结果。

原始 YANG 源码统一在“模型列表”的对应模型行中查看，Schema 工作区不再提供重复入口。

设备会话状态和完整 Capability 列表统一在“连接设置”中查看；Schema 工作区不再重复显示设备状态条或 Capability 入口。

Schema 数据节点的右键操作会预填 subtree/config XML 草稿。树顶部不再放置虚拟的“设备级操作”节点；Candidate 和配置存储操作保留在普通 Schema 节点的右键菜单中，并明确标注它们作用于整个 datastore：

| 操作 | 说明 | 典型 Capability |
| --- | --- | --- |
| `get` | 读取配置和状态数据，支持 subtree 或 XPath filter。 | XPath filter 需要 `:xpath`。 |
| `get-config` | 从 running、candidate 或 startup 读取配置。 | datastore 必须由服务端声明。 |
| `edit-config` | 发送配置 XML，支持 default/test/error-option；自动草稿必须补全 list key 和必填值后才能执行。 | candidate、writable-running、validate 等。 |
| `validate` | 校验 running、candidate 或 startup 配置。 | `:validate` 及对应 datastore。 |
| `commit` / `discard-changes` | 提交 Candidate、执行 confirmed commit/取消，或放弃全部未提交修改。 | `:candidate`；confirmed 操作还需 `:confirmed-commit`。 |
| `copy-config` / `delete-config` | 复制整个配置存储、保存 Running 到 Startup，或删除整个 Startup。 | 目标 datastore 必须由服务端声明。 |
| `lock` / `unlock` | 锁定或解锁 running、candidate、startup。 | 对应 datastore 必须可用。 |
| `create-subscription` | 在当前 Session 上建立 RFC 5277 订阅，可配置 stream、subtree/XPath filter 和 replay 时间。 | `:notification`；并发执行其他 RPC 通常需要 `:interleave`。 |
| `establish-subscription` | 建立 RFC 8639 event-stream 动态订阅，或 RFC 8641 periodic/on-change YANG-Push；支持过滤器引用、replay/stop-time、DSCP/QoS、encoding 和单 Session 多订阅。 | YANG Library 中的 `ietf-subscribed-notifications`；可选参数按 `replay`、`dscp`、`qos`、`encode-*` feature 门禁；YANG-Push 还需 `ietf-yang-push`。 |
| `modify-subscription` | 按设备订阅 ID 修改过滤器、stop-time 或允许变化的 YANG-Push 策略。 | 必须在建立订阅的同一 Session 执行。 |
| `delete-subscription` | 删除一个动态订阅但保持 NETCONF Session。 | RFC 8639 动态订阅。 |
| `resync-subscription` | 请求 active on-change 订阅发送完整 `push-update`。 | `ietf-yang-push` 的 `on-change` feature。 |
| 原始 RPC | 发送完整 `<rpc>` XML，用于厂商 RPC、action 或尚未做成表单的操作。 | 由 RPC 本身决定。 |

`kill-subscription` 属于跨 Session 的 operator 管理操作，标准 NACM 默认会拒绝普通用户。底层 builder、Worker 和 Mock 已支持，但普通订阅抽屉只提供当前 Session 所属订阅的 `delete-subscription`；需要管理员强制终止其他订阅时，可在原始 RPC 中明确发送 `kill-subscription`。设备若声明 RFC 8639 `configured` feature，配置型订阅仍可通过对应 Schema 节点的标准 `edit-config` 管理；Mock 默认不声明该可选 feature。

YANG-Push 修改默认使用“保持当前过滤器/策略”，对应 RFC 8641 的 omission 语义：未出现在 `modify-subscription` 中的参数必须保持不变。标准没有用 omission 清除既有过滤器或 stop-time 的语义，需要清除时应删除并重新建立订阅；event-stream 修改受 mandatory target choice 约束，必须显式提供一种 stream filter。结构化操作支持内联 subtree/XPath、已配置过滤器引用、默认 XML 命名空间以及厂商派生 datastore identityref；厂商 identityref 的前缀必须同时提供对应 XML namespace binding。

页面会依据节点的 `config` 属性和服务端 Capability 禁用明显不可用的结构化操作。Schema 工作区右侧采用 NETCONF Browser 风格布局：上方是 Request 区，可在操作参数与 RPC XML 之间切换；下方是 RPC Reply 响应区，状态、耗时和 message-id 与响应一起显示。请求和响应 XML 默认以格式化后的缩进结构展示，并可切换到“原文”查看设备实际收发内容；格式化只影响显示，不改变实际发送的 XML。

RPC 等待回复期间会锁定操作切换和工作区清空，避免重复下发或丢失结果。高风险操作二次确认仍使用弹窗。原始 RPC 不做 Capability 推断，执行前需要自行确认命名空间、目标 datastore 和操作风险。旧的 `/yang/yang-operations` 地址会自动跳转到 Schema 工作区。

订阅控制 RPC 的 `<rpc-reply>` 仍保留在当前响应区和执行记录中，之后到达的异步 `<notification>` 不会混入响应。全局通知采集器按 Profile → Session → Subscription 分组，通知抽屉支持未读状态、全文筛选、完整 XML 行号/高亮、复制、删除和 JSON/XML 导出。现代动态订阅可从抽屉打开修改、删除和 on-change 重同步；RFC 5277 没有按订阅 ID 取消订阅的 RPC，因此结束旧订阅仍会断开其 Session。

现代订阅能力由 YANG Library 中的 `ietf-subscribed-notifications@2019-09-09`、`ietf-yang-push@2019-09-09` 及 feature 发现，不使用虚构的 NETCONF capability URI。软件随内置 libyang runtime 固定打包这两个模型及完整 IANA 依赖闭包，并在构建、安装验证和 smoke test 中校验 SHA-256 与实际编译结果。

## 安全设计

- 密码和私钥口令不会回传给渲染页面。
- 勾选“使用系统安全存储保存凭据”后，凭据由 Electron `safeStorage` 加密；系统安全存储不可用时不会降级为明文保存。
- 未勾选保存凭据时，密码只保留在当前主进程内存中，重启后需要重新输入。
- 私钥路径可以持久化，私钥文件在 NETCONF Worker 中按需读取；只接受普通文件，拒绝符号链接和超过 1 MiB 的私钥文件。
- 建议固定设备 SSH Host Key 的 `SHA256:` 指纹。更换设备密钥后，应先通过可信渠道核对新指纹，再更新 Profile。
- 原始 RPC 和所有 XML fragment 会拒绝 `DOCTYPE`/`ENTITY`，并限制消息大小，降低 XML 实体扩展和超大消息风险。
- 模型下载、导入和编译均在 Worker 中执行；任务带有超时保护，应用退出时会关闭 NETCONF 会话和 Worker。

默认限制：

| 项目 | 限制 |
| --- | --- |
| 单条 NETCONF 消息 | 32 MiB |
| 单个 `get-schema` YANG 内容 | 8 MiB |
| 原始 RPC XML | 8 MiB |
| 默认连接超时 | 15 秒 |
| 默认 RPC 超时 | 30 秒 |

## 本地数据

YANG 仓库位于 Electron `userData/yang` 下，主要包含：

- 按内容哈希保存的 YANG Blob。
- 模块、工作区和可选设备下载快照的 manifest。
- 编译输入和 Schema/诊断缓存。

“清空 Schema 工作区”用于清除当前编译上下文和 Schema 结果，不等同于删除设备上的配置。重新导入、下载或修改模型后，原编译上下文会失效，需要重新编译。

## 常见问题

**SSH 能登录，但连接测试失败。**  
检查设备是否启用了 NETCONF over SSH、端口是否正确、账号是否具有 NETCONF 权限，以及 SSH 服务是否允许 `netconf` subsystem。部分设备将 NETCONF 放在非 `830` 端口。

**提示 Host Key 指纹不匹配。**  
不要直接删除指纹绕过校验。先从设备控制台或可信管理系统核对当前 SHA256 指纹，确认是计划内换钥后再更新 Profile。

**设备模型列表为空。**  
检查服务端 Capability 是否包含 YANG Library 或 NETCONF Monitoring，并确认账号对 operational/state 数据有读取权限。老设备可能只在 `hello` URI 中暴露少量模块。

**模型能发现但下载失败。**  
设备可能没有实现 `get-schema`、只支持 YIN、返回内容超出限制，或不允许当前用户读取 Schema。可以从设备软件包或厂商仓库获取 `.yang` 文件后使用本地导入。

**编译报告缺少依赖。**  
按诊断中的 module/submodule 名称和 revision 导入依赖。若同名模块有多个 revision，应优先提供 import/include 中通过 `revision-date` 指定的版本。

**页面提示“内置 libyang 运行时不可用”。**  
正式安装环境中这表示运行时文件缺失、损坏、没有执行权限或平台架构不匹配。先在“设置 → 运行时诊断”中查看实际路径并重新检测，随后修复或重新安装 NetNexus。源码开发环境可设置 `NETNEXUS_YANGLINT_PATH` 临时指定兼容的 `yanglint`，重启后点击“重新检测”。编译不会回退到 JavaScript 简化解析器。

**candidate、validate 或 XPath 操作不可选。**  
这是服务端 Capability 门控结果。不要把表单禁用当成客户端故障；可以先查看连接页的 Capability，确认设备是否支持对应能力。

**RPC 返回 `rpc-error`。**  
工作台会保留完整的 error-type、error-tag、error-path、error-message 和原始回复。根据 error-path 检查命名空间和节点路径，根据 error-tag 检查 datastore、锁状态、权限和参数约束。

## 开发测试

NETCONF framing、XML、RPC client、模型发现、仓库和 libyang 编译集成都有独立 CI 测试。浏览器 E2E 的设备与 RPC 控制面使用可变状态 mock，但 Schema 必须由测试前构建的真实 bundled libyang helper 生成，不存在手写成功树；测试覆盖连接、发现、下载、编译器状态门控、Schema 树和 RPC 基本流程：

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/ci/yang_browser_mock_flow.js
```

真实设备联调时，应至少覆盖一次 NETCONF 1.0 设备、一次 NETCONF 1.1 设备，以及一个支持 RFC 8525 YANG Library 和 `get-schema` 的设备。
