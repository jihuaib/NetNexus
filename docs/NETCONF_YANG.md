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

## 页面

| 页面 | 用途 |
| --- | --- |
| 连接设置 | 新建、编辑、测试和删除连接 Profile；连接或断开 NETCONF 会话；查看服务端 Capability。 |
| 模型列表 | 读取设备模型清单、下载模型、导入本地文件或目录、筛选模型、编译所选模型、查看源码和编译诊断。 |
| Schema 工作区 | 浏览模型列表生成的 Schema；左键仅选择节点，节点属性通过右键菜单在弹窗中查看，所选 NETCONF 操作直接在右侧 Browser 工作区执行。 |

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

1. 进入“模型列表”，点击“读取设备列表”，确认发现 `netnexus-mock-device` 和 `netnexus-mock-types`。
2. 选择并下载这两个模型。`netnexus-mock-device` 会通过 `import` 引用 `netnexus-mock-types`，可用于验证 `get-schema` 和依赖处理。
3. 在模型列表中选择下载后的模型并执行“编译所选”，确认 libyang 编译成功，然后进入 Schema 工作区浏览 `system`、`interfaces` 和 `state` 节点。
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
7. 还可以继续验证 `copy-config`、`delete-config`、`lock`、`unlock`、`discard-changes`、原始 RPC、通知和 Mock 模型中定义的 `reboot` RPC。服务端收到的 RPC 及 datastore revision 会实时输出到启动 Mock 的终端。

Mock datastore 只保存在当前进程内存中，重启服务会恢复初始配置。在 Mock 终端中可使用 `/status`、`/show running`、`/show candidate`、`/reset`、`/notify <message>` 和 `/quit` 辅助观察或重置状态。查看完整启动参数：

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

YANG 的 import/include 依赖必须同时存在于本地仓库。建议下载同一个 module-set 中的依赖模块和 submodule；编译诊断出现 `missing import` 或 `missing include` 时，补充下载或导入对应文件后重新编译。

### 3. 导入和编译

没有真实设备时，可以直接使用“导入文件”或“导入目录”。目录导入会递归扫描 `.yang` 文件。仓库按 SHA256 内容哈希保存 Blob，相同内容不会重复写入；同名不同 revision 可以共存。

模型编译只从“模型列表 → 编译所选”发起，避免无意中编译整个本地仓库。所选模型能够解析到的 import/include 依赖会自动加入编译集合。编译在 Worker 中运行，不阻塞页面，进度会显示依赖准备、libyang 编译、Schema 索引和缓存阶段。

“模型列表 → 编译诊断”显示最近一次有效编译上下文的错误、警告和信息。诊断弹窗会使用当前 `compileId` 读取结果；导入、下载或修改模型使上下文失效后，不会继续展示旧诊断。能够匹配到本地模块的诊断可以直接打开对应源码。

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

维护者在当前平台构建和验证运行时：

```bash
# macOS / Linux
npm run libyang:build:unix
npm run libyang:verify

# Windows PowerShell
npm run libyang:build:windows
npm run libyang:verify
```

应用打包前会强制验证平台、架构、执行权限和版本，验证失败则终止打包，避免生成不带权威编译器的安装包。

源码开发或运行时联调可以同时覆盖内置 `yanglint` 和 Schema helper；两者的 libyang 版本必须完全一致，helper 合同必须为版本 1：

```bash
NETNEXUS_YANGLINT_PATH=/absolute/path/to/yanglint \
NETNEXUS_LIBYANG_SCHEMA_PATH=/absolute/path/to/netnexus-libyang-schema \
npm run dev
```

这些环境变量仅用于开发覆盖和故障定位，不是普通用户的安装步骤。libyang/helper 的 stdout/stderr 会转换成模型列表中的编译诊断。

### 4. 浏览 Schema 和执行 RPC

编译成功后，Schema 工作区支持：

- 按模块展开 libyang effective schema 根节点和子节点。
- 左键单击节点仅更新当前选择，不自动打开属性弹窗。
- 通过节点右键菜单的“查看节点属性”，在弹窗中查看路径、keyword、数据类型、config、mandatory、default、units、status 和描述。
- 右键当前设备或 Schema 节点选择操作，直接在右侧操作区编辑参数、执行 RPC 并查看结果。

原始 YANG 源码统一在“模型列表”的对应模型行中查看，Schema 工作区不再提供重复入口。

设备会话状态和完整 Capability 列表统一在“连接设置”中查看；Schema 工作区不再重复显示设备状态条或 Capability 入口。

Schema 树顶部始终提供“当前设备”入口，即使尚未编译模型也能右键执行全量和 datastore 操作；右键普通 Schema 节点则会预填 subtree/config XML 草稿。`delete-config` 等 datastore 操作仍明确作用于整个配置存储：

| 操作 | 说明 | 典型 Capability |
| --- | --- | --- |
| `get` | 读取配置和状态数据，支持 subtree 或 XPath filter。 | XPath filter 需要 `:xpath`。 |
| `get-config` | 从 running、candidate 或 startup 读取配置。 | datastore 必须由服务端声明。 |
| `edit-config` | 发送配置 XML，支持 default/test/error-option；自动草稿必须补全 list key 和必填值后才能执行。 | candidate、writable-running、validate 等。 |
| `copy-config` | 在 datastore 之间复制配置。 | 取决于源和目标 datastore。 |
| `delete-config` | 删除整个 startup datastore，不用于删除 Schema 节点或 candidate。 | `:startup`。 |
| `lock` / `unlock` | 锁定或解锁指定 datastore。 | NETCONF base。 |
| `validate` | 让设备校验 datastore。 | `:validate`。 |
| `commit` | 将 candidate 提交到 running，可选 confirmed commit。 | `:candidate`、`:confirmed-commit`。 |
| `discard-changes` | 放弃 candidate 中尚未提交的修改。 | `:candidate`。 |
| 原始 RPC | 发送完整 `<rpc>` XML，用于厂商 RPC、action 或尚未做成表单的操作。 | 由 RPC 本身决定。 |

页面会依据节点的 `config` 属性和服务端 Capability 禁用明显不可用的结构化操作。Schema 工作区右侧采用 NETCONF Browser 风格布局：上方是 Request 区，可在操作参数与 RPC XML 之间切换；下方是 RPC Reply 响应区，状态、耗时和 message-id 与响应一起显示。请求和响应 XML 默认以格式化后的缩进结构展示，并可切换到“原文”查看设备实际收发内容；格式化只影响显示，不改变实际发送的 XML。

RPC 等待回复期间会锁定操作切换和工作区清空，避免重复下发或丢失结果。高风险操作二次确认仍使用弹窗。原始 RPC 不做 Capability 推断，执行前需要自行确认命名空间、目标 datastore 和操作风险。旧的 `/yang/yang-operations` 地址会自动跳转到 Schema 工作区。

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
