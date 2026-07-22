# Huawei BMP 真机 E2E 测试

本套件通过 Telnet 驱动两台 Huawei VRP 设备，接收设备真实上报的 BMPv4 流量，查询实际的 BMP worker
和 SQLite 持久化层，并使用 Playwright 验证 Vue 页面。

## 安全机制

- 认证信息仅通过环境变量传入，绝不会写入仓库。
- 首次运行前必须采集基线。基线包含设备配置，保存在已被 Git 忽略的 `.huawei-bmp-e2e` 目录中，
  与 Playwright 的临时输出相互独立。
- 每个场景都使用 `commit trial`，创建 trial 的 Telnet 会话会在 `finally` 中执行 `abort trial`。
- 每个场景结束后，套件都会比较两台设备与基线；需要额外回滚时，会使用已记录的 commit ID。
- Playwright 使用单 worker 顺序运行。某个场景失败后会记录问题，并继续执行下一个独立场景。
- 发现解析器或 UI 问题时，测试不会自动修改产品代码。

## 环境变量

PowerShell 示例：

```powershell
$env:NETNEXUS_HUAWEI_TARGETS='192.168.93.11,192.168.93.22'
$env:NETNEXUS_HUAWEI_USERNAME='<username>'
$env:NETNEXUS_HUAWEI_PASSWORD='<password>'
$env:NETNEXUS_HUAWEI_LOCAL_ADDRESS='192.168.93.2'
$env:NETNEXUS_BMP_COLLECTOR_HOST='192.168.93.2'
$env:NETNEXUS_BMP_COLLECTOR_PORT='11019'
$env:NETNEXUS_HUAWEI_ARTIFACT_DIR='.huawei-bmp-e2e/my-run'
```

设备顺序不能交换。设备 1 和设备 2 分别使用
`scripts/e2e-support/huawei-bmp-scenarios.js` 中对应的拓扑配置。

## 首次运行

应用任何测试配置之前，先采集一次基线：

```powershell
node scripts/huawei-bmp-baseline.js
```

除非设置 `NETNEXUS_HUAWEI_BASELINE_REPLACE=1`，否则该命令不会覆盖已有基线。

运行完整的可复用测试套件；需要观察页面时可启用可见浏览器：

```powershell
npm run test:e2e:huawei-bmp -- --headed
```

该单一入口会按顺序执行以下阶段：

- 修改任何设备配置前先核验基线；
- 验证路由生命周期、属性修改、老化、BMP 端口迁移和 collector 重启；
- 多轮验证 VPN/私网初始 dump，并保存原始 BMP 报文；
- 对 Loc-RIB 的 `all`、`all path-marking`、`add-path` 和 `add-path path-marking` 进行原始报文验证；
- 执行全部 6 个地址族页面场景和全部 4 个 Loc-RIB mode 页面场景；
- 即使前面的阶段失败，最后也会无条件恢复并核验设备基线。

VPN 重复测试默认执行 5 轮，每轮 60 秒。可通过 `NETNEXUS_HUAWEI_FLAKE_ITERATIONS` 和
`NETNEXUS_HUAWEI_FLAKE_DURATION_MS` 覆盖默认值。某个阶段失败后会记录结果，但后续独立阶段仍会继续。
最终结果和每个阶段的退出状态会写入 `full-suite-summary.json`。

`add-path` 场景会在 GE0/7/1 上建立第二条 eBGP 邻接，对两条路径应用相同的 import 属性，并启用双路径
选路和通告。断言要求同一个远端前缀在 BMP Loc-RIB 中同时出现 Path ID `0` 和 `1`；
`path-marking` 场景还要求成功解码 Path Marking TLV。每种 mode 都是独立 trial，执行下一种 mode 前会
恢复已保存的设备基线。

只核验最终设备状态、不修改配置：

```powershell
$env:NETNEXUS_HUAWEI_VERIFY_ONLY='1'
node scripts/huawei-bmp-restore.js
```

如果进程在 `commit trial` 后被终止，并且创建 trial 的 Telnet 会话已经断开，不要从其他会话确认 trial。
等待 VRP trial 定时器自动恢复：

```powershell
node scripts/huawei-bmp-wait-trial-restore.js
```

## 主要场景

| Key | 设备侧覆盖 | BMP 覆盖 |
| --- | --- | --- |
| `public-unicast` | GE0/7/1 IPv4 和 IPv6 eBGP | Pre/Post Adj-RIB-In、Pre/Post Adj-RIB-Out、Loc-RIB |
| `ipv4-labeled` | 携带 MPLS 标签的 IPv4 Labeled-Unicast | 设备支持的全部 Adj-RIB 阶段和 Loc-RIB |
| `vpn-and-private` | GE0/7/2 VRF IPv4/IPv6，以及 PE 间 VPNv4/VPNv6 | 私网 RIB-In/Out 和 VPN Loc-RIB |
| `evpn` | 启用 MPLS 的 L3VPN 实例和 EVPN peer | EVPN RIB-In/Out 和 Loc-RIB |
| `evpn-vxlan` | VXLAN VNI、EVPN/NVE 源地址和 VXLAN EVPN peer | EVPN RIB-In/Out 和 Loc-RIB |
| `bgp-ls` | 通过 BGP-LS 导出的 IS-IS 拓扑 | 所有 RIB 阶段中的 Node/Link/Prefix NLRI |

生命周期套件独立覆盖以下时序：collector 先于 BGP 启动、初始路由 dump、修改路由属性、撤销并重新通告、
Peer Down 后路由进入 stale 并清理、Peer Up 后恢复、collector 停止并重启，以及在线迁移 BMP TCP 端口后
恢复原端口。端口迁移过程中，套件会在旧 collector 仍运行时修改设备配置，验证设备发出的 Peer Down，
将修改前的每一个活动路由 key 与离线 stale 视图进行比较（包括 Adj-RIB 和 Loc-RIB），然后验证设备在
备用端口和原端口上都能重新完整 dump。

UI 套件会遍历后端上报的每个非空设备、session、地址族、RIB-stage scope，以及每个非空 Loc-RIB 实例。
设备最长允许 180 秒完成收敛，超时后记录为 setup-error。

Huawei 设备需要配置 `peer ... keep-all-routes`，才能上报有意义的 pre-policy Adj-RIB-In。套件会在所有
支持该命令的地址族视图中启用它。当前 VRP 版本的 IPv4 Labeled-Unicast 视图不提供
`keep-all-routes`，报告会将其归类为设备能力限制。

EVPN 场景会显式配置封装。MPLS 场景在传输接口上启用 MPLS，并配置 `evpn mpls routing-enable`；Huawei
默认通告 MPLS 封装。VXLAN 场景会配置 VNI、彼此独立的 EVPN/NVE 源地址，以及
`peer ... advertise encap-type vxlan`。缺少 MPLS routing-enable，或者未正确配置 VXLAN 源地址和封装时，
设备本地可能存在有效的 Type 5 路由，但双方 peer 仍保持 `PrefRcv 0`。

VPN 抖动诊断会为每轮测试保存原始 BMP 字节流和 SQLite 数据库。已复现的 Pre-RIB-Out 缺失场景中，
Huawei 的异常聚合 UPDATE 实际携带了两个 VPNv4 前缀，但第一个 MP_REACH 的长度为 0，当前解析器随后
发生越界解析错误并丢弃整条 UPDATE。后续 EOR 可以正常解析，因此最初的诊断结果被错误地表现为设备只
发送了 EOR。该问题现归类为 collector 的兼容性/健壮性问题，受初始 dump 时序影响，出现问题的地址族
可能不同。

## 测试结果

测试产物会写入 `NETNEXUS_HUAWEI_ARTIFACT_DIR` 指定的目录：

- `scenario-<key>.json`：单个场景的设备状态、原始报文/API 信息和路由样本。
- `scenario-<key>-ui.json`：通过真实页面验证的每个设备、session、AF、RIB scope。
- `full-suite-summary.json`：完整套件中每个阶段的状态、耗时和退出结果。
- `screenshots/<key>-*.png`：真实 UI 截图证据。
- `huawei-lab-transcript.jsonl`：带时间戳且不包含认证信息的 Huawei CLI 记录。
- `restore-results.json`：最终设备基线比较结果。
- `vpn-flake-*/iteration-*/report.json`：每轮抖动测试的 scope 时序、设备信息和持久化证据。
- `vpn-flake-*/iteration-*/netnexus-bmp-e2e-*/*.bin`：用于独立分析的原始 BMP TCP 字节流。
- `loc-rib-modes-*/<mode>/report.json`：`all`、`add-path`、`path-marking` 的 API 和原始 TLV 证据。
- `scenario-lifecycle-and-mutation.json`：生命周期步骤、全量路由 stale 比较和原始 Peer Down 数量。

结果分类：

- `passed`：预期路由存在，并且设备基线已恢复。
- `code-issue`：设备侧 BMP monitoring 正常，但 worker、API 或 UI 结果缺失或不一致。
- `device limitation`：设备 CLI 不支持测试所需的能力。
- `setup-error`：拓扑、命令、连接、超时或恢复失败。

## 构建和打包运行时检查

```powershell
npm run build
npm run pack
npm run test:packaged:sqlite
```

`pack` 会验证打包内的 libyang helper，并重新构建 Electron 原生依赖。SQLite smoke test 会在打包后的
Electron 运行时中执行，并检查 BMP 持久化 schema。
