# gRPC 服务器

gRPC 模块提供一个**由 .proto 驱动的通用 gRPC 工具**：像 SNMP 编译 MIB、NETCONF 加载 YANG 一样，先编译 `.proto` 文件，然后所有操作都基于编译结果统一完成，不需要为每个厂商写代码。

- **上报（设备 → NetNexus）**：NetNexus 作为 gRPC 服务器托管 proto 里的任意 `service`，接收设备通过 Telemetry Dial-out 推送的数据，按 proto 解码并展示。
- **下发（NetNexus → 设备）**：
    - 在设备发起的双向流上，服务端主动向该流回写消息；
    - NetNexus 作为 gRPC 客户端调用设备上的任意方法（如 gNMI `Get` / `Set` / `Subscribe`）。

## 已实现能力

- 运行时编译任意 `.proto` 文件（proto2/proto3、import、嵌套消息、map、oneof、枚举），无需预生成代码。
- 源码仓库 `resources/grpc/protos/` 提供华为 Telemetry gRPC Dial-out、Cisco IOS-XR MDT Dial-out、OpenConfig gNMI 三套 proto 模板（仅随源码仓库提供、供测试与 mock 使用，不打包进安装包；页面通过“导入文件”加载）。
- 服务/方法/消息/枚举树浏览，查看字段编号、类型、修饰、注释。
- 通用 gRPC 服务器：勾选任意 service 托管，四种调用类型（Unary、Server Stream、Client Stream、Bidi Stream）全部支持。
- 嵌套自动解码：`bytes` 字段自动尝试 JSON 文本、Telemetry `proto_path` / `encoding_path` 定位的业务消息、以及名为 `Telemetry` 的头消息；也可用解码规则显式指定消息类型、`@proto_path` 或 `@json`。
- Unary / Client Stream 方法按 JSON 模板自动回复。
- 活动流列表；对 Bidi / Server Stream 流手动下发消息或关闭流。
- 通用 gRPC 客户端：选择方法、按消息定义生成请求模板、设置 metadata、TLS、超时；流式调用可多次发送、结束发送、取消。
- 独立消息监控窗口：按角色/方向/关键字过滤，查看解码 JSON、警告、原始字节和请求 metadata。
- 服务端与客户端 TLS（证书、私钥、CA、Server Name 覆盖）。

## 工作原理

```
.proto 文件 ──编译(protobufjs)──▶ 反射目录 (service / method / message)
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        通用服务器               解码 / 编码            通用客户端
   按 service 动态注册        toObject + 解码规则     按 method 动态发起
   handler，收 → 记录        bytes 按类型再解一层     unary / stream 调用
   Bidi 流可回写下发          JSON 文本 → 对象
```

每条收发消息都会记录：时间、角色（服务端/客户端）、方向、对端、方法、消息类型、解码结果、警告、原始 hex。

## 页面

### Proto编译

与 SNMP 一致，gRPC 也运行在独立协议进程中，由用户显式控制：页面右上角 `启动进程` / `停止进程`。进程未启动时页面保留布局、禁用需要进程的操作；启动后自动从缓存恢复上次的编译结果。`停止进程` 会先停止 gRPC 服务器、取消进行中的客户端调用，再结束进程；应用退出时随其他协议一起关闭。

与 SNMP 的 MIB 编译保持一致：导入源文件 → 编译 → 结果落盘缓存 → 可保存为工程随时恢复。

按钮说明：

| 按钮 | 功能 |
| --- | --- |
| 导入文件 | 选择一个或多个 `.proto` 文件加入待编译列表。 |
| 搜索目录 | 添加 `import` 查找目录。import 先在文件所在目录查找，再依次查找搜索目录和内置目录。 |
| 编译 | 编译待编译列表；源文件与搜索目录未变化时直接命中缓存（状态栏显示“缓存命中”）。 |
| 重新编译 | 忽略缓存强制重新编译。 |
| 保存工程 | 把当前用到的 `.proto` 源文件（保留相对目录结构）、编译缓存和清单保存为工程。 |
| 导入工程 | 打开工程列表：导入、导出到任意目录、删除，或“从目录导入”外部工程目录。 |
| 清空 | 清空文件列表、编译结果和缓存（需先停止服务器）。 |

页面分为两栏：

- **文件**：逐文件显示状态（待编译 / 已编译 / 失败 / import 依赖 / 搜索目录），失败时给出文件与行号。
- **定义树**：`包 → 服务 / 消息 / 枚举 → 方法 / 字段 / 枚举值`。树节点由协议进程按需返回，渲染层只保留展开路径上的节点，折叠后释放子节点；顶部可按全名定位（如 `gnmi.gNMI.Get`）。

树节点右键菜单（与 MIB 工作区一致）：

| 菜单 | 功能 |
| --- | --- |
| 查看节点属性 | 弹窗显示服务的方法表、消息的字段表（类型可点击跳转）、枚举值表、字段/枚举值详情。 |
| 复制全名 / 复制调用路径 | 复制 `pkg.Service.Method` 全名，方法节点可复制 `/pkg.Service/Method` 调用路径。 |
| 定位请求消息 / 定位响应消息 | 方法节点跳转到对应消息。 |
| 生成 JSON 模板 | 消息节点按字段定义生成 JSON 骨架，可复制到服务器回复模板或客户端请求中。 |

#### 编译缓存与工程

| 位置 | 内容 |
| --- | --- |
| `userData/grpc-proto-cache.json` | 最近一次编译的快照（protobufjs JSON 描述 + 目录），记录源文件签名（路径、大小、修改时间）；应用重启时文件未变化则直接恢复，不重新解析。 |
| `userData/grpc-proto-projects/<工程名>/` | `manifest.json`（文件清单、服务列表、汇总）、`protos/`（全部源文件，保留相对目录结构）、`proto-cache.json`（工程内缓存）。 |

工程目录是自包含的：原始源文件删除后仍可导入；`导出` 会把整个工程目录复制到所选位置，可在另一台机器上通过“从目录导入”恢复。

### gRPC工作区

服务器与客户端合并在一个三栏工作区里，交互方式对齐 Postman / BloomRPC / Kreya 等 gRPC 工具：**顶部 URL 栏 → 左树选方法 → 中间编请求（Tab）→ 右侧看响应（Tab）**。所有连接参数都内嵌在面板 Tab 中，不再使用下拉菜单和弹窗。

```
┌ 模式 (客户端|服务器) │ grpc:// host:port │ UNARY /pkg.Service/Method │ [调用] [监控窗口] ┐
├──────────────┬──────────────────────────────┬────────────────────────────────────────────┤
│ 方法 | 历史    │ 消息 | Metadata | TLS | 设置    │ 响应 | Metadata | Trailers | 信息            │
│ （服务器模式：  │ （服务器：活动流 | 回复模板 |     │ 状态栏：OK (0) · 耗时 · ↑请求 ↓响应           │
│  勾选托管服务） │   解码规则 | TLS）             │ 时间线：按时间顺序，最新在底部，可展开 JSON / hex │
└──────────────┴──────────────────────────────┴────────────────────────────────────────────┘
```

**客户端（下发）模式**

| 位置 | 说明 |
| --- | --- |
| URL 栏 | `grpc://` / `grpcs://`（随 TLS 开关变化）+ 目标 `host:port` + 当前方法的调用类型与路径（如 `/gnmi.gNMI/Get`）；回车或点 `调用` 发起请求。流式调用进行中时按钮变为 `发送 / 结束发送 / 取消`。 |
| 左栏 · 方法 | 点击方法即选中；首次打开自动按请求消息生成 JSON 模板，之后每个方法记住自己上次编辑的请求内容（随客户端配置持久化）。右键：调用、查看属性、复制全名 / 调用路径、重新生成模板。 |
| 左栏 · 历史 | 本次进程内的调用记录（方法、状态码、目标、时间）；点击一条记录切换到该方法并在右栏显示其请求/响应。 |
| 中栏 · 消息 | 请求 JSON 编辑器；`生成模板` / `格式化`。 |
| 中栏 · Metadata | 键值表，每行可勾选启用；`-bin` 结尾的 key 按 base64 解码。 |
| 中栏 · TLS | CA / 客户端证书 / 私钥 / Server Name。 |
| 中栏 · 设置 | 超时（deadline）与解码规则（与服务器模式共用）。 |
| 右栏 · 响应 | 状态栏显示 gRPC 状态码（`OK (0)` / `UNAVAILABLE (14)` …）、耗时、请求/响应计数与错误详情；时间线按 接收/发送 过滤，`全部展开`；调用完成后最新响应自动展开，展开项可 `复制 JSON` 或 `作为请求` 回填到编辑器。 |
| 右栏 · Metadata / Trailers / 信息 | 响应 metadata、trailers 的键值表；信息 Tab 汇总方法、目标、状态、起止时间、耗时、消息类型。 |

**服务器（上报）模式**

| 位置 | 说明 |
| --- | --- |
| URL 栏 | 监听地址 / 端口 + 运行状态（监听中的端口与托管服务数），`启动 / 停止服务器`。 |
| 左栏 | 勾选要托管的服务（可多选），标题显示 `已勾选/总数`。 |
| 中栏 · 活动流 | 设备 / 活动流列表（对端、方法、收发计数）；选中一条流后在下方编辑 JSON `下发`，或 `关闭流`。 |
| 中栏 · 回复模板 | 为 Unary / Client Stream 方法配置回复 JSON，`保存` 后立即持久化。 |
| 中栏 · 解码规则 / TLS | 解码规则表；服务器证书、CA、客户端证书校验、最大消息长度。服务器运行时只读。 |
| 右栏 · 消息 | 选中流的消息时间线（状态栏显示该流的对端与方法，`显示全部` 取消筛选）；未选中时显示服务端全部消息。 |
| 右栏 · 流信息 | 选中流的对端、方法、类型、起始时间、收发计数与请求 Metadata。 |

### 独立消息监控窗口

展示服务端与客户端的全部收发消息，支持按角色、方向、关键字过滤；详情包含解码 JSON（嵌套解码的字段以 `{"$type": ..., "$length": ..., "value": ...}` 表示）、解码警告、原始字节 hex 与请求 metadata。

## 自动解码规则

收到的每条消息先按方法的请求/响应类型解码；对其中的 `bytes` 字段，没有显式规则时按以下顺序自动尝试：

1. 内容以 `{` 或 `[` 开头且是合法 JSON → 解析为对象（华为 JSON 编码、gNMI `json_val`）。
2. 当前或上层消息带 `proto_path`（华为）/ `encoding_path`（Cisco）字段，且能在编译结果中定位到消息类型 → 按该类型解码（需已导入对应业务 proto）。
3. 最外层（尚无 `proto_path` 上下文）的 `data` / `payload` 字段，且编译结果里存在名为 `Telemetry` 的消息 → 按该消息解码。

解码成功的字段显示为 `{"$type": 类型, "$length": 字节数, "$auto": true, "value": {...}}`；全部失败则保留 hex。`string` 字段只有配置 `@json` 规则时才会解析。仍显示为 hex 的常见原因：设备型号对应的业务 proto 没有导入（第 2 步无法定位类型），此时详情里的警告会给出 `proto_path`。

## JSON 取值约定

| proto 类型 | JSON 表示 |
| --- | --- |
| `int64` / `uint64` 等 64 位整数 | 字符串，如 `"1700000000000"`；输入时也接受数字 |
| `bytes` | 输入：base64 或 `0x` 开头的十六进制；输出：hex（命中解码规则时为解码后的对象） |
| `enum` | 枚举名（也接受数值） |
| `oneof` | 只填其中一个成员；解码结果会额外给出 oneof 名 → 生效成员名 |
| `map` | JSON 对象 |

## 使用步骤（华为 Telemetry Dial-out）

1. 进入 `gRPC服务器 → Proto编译`，`导入文件` 加入 `huawei-grpc-dialout.proto`、`huawei-telemetry.proto`（仓库 `resources/grpc/protos/` 提供）；如需解码行内容，再加入设备对应的业务 proto（如 `huawei-ifm.proto`），点击 `编译`。
2. 进入 `gRPC工作区`，切到 `服务器` 模式，左树勾选 `huawei_dialout.gRPCDataservice`，启动服务器。`serviceArgs.data` 会自动按 `telemetry.Telemetry` 解码，`row[].content` 自动按 `proto_path` 定位到业务消息；只有默认推断不符合时才需要添加解码规则。
3. 设备侧配置（示例）：

    ```
    telemetry
     destination-group nn
      ipv4-address <NetNexus IP> port 57400 protocol grpc no-tls
     sensor-group ifm
      sensor-path huawei-ifm:ifm/interfaces/interface
     subscription s1
      sensor-group ifm sample-interval 5000
      destination-group nn
      protocol grpc encoding gpb
    ```

4. 中栏出现接入设备后，选中该流，右栏实时显示上报消息（也可打开 `独立监控窗口`）；`data` 字段会展开为 `telemetry.Telemetry`，`data_gpb.row[].content` 按 `proto_path` 展开为业务消息。
5. 需要向设备回写时，在中栏下方编辑 JSON 点击 `下发`。

## 使用步骤（gNMI 下发）

1. `Proto编译` 页导入 `gnmi.proto`、`gnmi_ext.proto` 并编译。
2. `gRPC工作区` 客户端模式：顶栏填设备地址与 Metadata（`username` / `password`），左树点 `gnmi.gNMI.Get` 或 `Set`，`生成模板` 后填写路径与值，点 `调用`。
3. `gnmi.gNMI.Subscribe` 为双向流：发起后可继续 `发送消息`（如 poll），响应持续出现在右栏时间线。

## 本地 mock

```bash
npm run mock:grpc -- --port 57400                       # 华为 dial-out，GPB 编码，每 5 秒上报
node scripts/mockGrpcDialout.js --encoding json         # 华为 dial-out，JSON 编码
node scripts/mockGrpcDialout.js --vendor cisco --count 3 # Cisco MDT，GPB-KV，上报 3 次后结束
```

mock 脚本会在同一条流上打印 NetNexus 下发的消息，可用于验证下发链路。

## 测试

`npm test` 中包含以下 gRPC 用例（也可用 `node test/ci/<文件>` 单独运行）：

| 文件 | 覆盖 |
| --- | --- |
| `test/ci/grpc_proto_registry.js` | 内置模板编译、`@proto_path` / `@json` 嵌套解码、编译错误定位、service definition 往返 |
| `test/ci/grpc_proto_project.js` | 编译缓存命中/失效、定义树按需加载与定位、工程保存/导入/导出/删除 |
| `test/ci/grpc_worker_lifecycle.js` | 协议进程：unary 回复模板、dial-out 双向流上报与解码、服务端下发、客户端结束/取消、停止服务器 |
| `test/ci/grpc_app_runtime.js` | 主进程侧：进程显式启动/停止、未启动时请求被拒绝、进程意外退出后状态复位与事件广播 |
| `test/e2e/grpc.spec.js` | 工作区页面（`npm run test:e2e:browser -- test/e2e/grpc.spec.js`）：选方法自动生成模板、Metadata 编辑、Unary 调用后的状态栏 / 响应 Tab / 历史、Bidi 流的发送 / 结束、服务器模式托管服务、接入流与下发 |
| `test/ci/system_protocol_process_shutdown.js` | 应用退出时 gRPC 协议进程随其他协议一起有序关闭 |

## 注意事项

- 消息记录保存在协议进程内存中（默认最多 1000 条），停止服务器或应用重启后清空；proto 编译结果则通过缓存与工程持久化。
- 同一编译结果中不允许出现同名类型；内置 Cisco 定义使用包名 `cisco_telemetry` 以便与华为的 `telemetry` 包同时编译。
- `@proto_path` 解码依赖 `proto_path` 字段（华为）或 `encoding_path`（Cisco）；找不到对应消息类型时保留原始 hex 并给出警告。
- 设备 dial-out 通常不会主动结束流；关闭流或停止服务器会主动结束连接，设备会按其重连策略重新接入。
