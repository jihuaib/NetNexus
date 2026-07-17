# BMP SQLite 数据库说明

本文档说明 NetNexus BMP SQLite schema v9 的定位、固定路由分区、全局路由对象、引用计数、scope 计数，以及启动、写入、查询、清理和崩溃恢复行为。

实现依据：

- Schema、事务、查询和清理：`electron/worker/bmp/bmpPersistenceStore.js`
- 固定分区清单和安全路由：`electron/worker/bmp/bmpRoutePartitionManifest.js`
- 稳定 source、scope、route ID：`electron/utils/bmpPersistentRouteKey.js`
- Mutation 构造：`electron/worker/bmp/bmpPersistenceMutation.js`
- 异步批量写入：`electron/worker/bmp/bmpPersistenceClient.js`
- BMP 生命周期：`electron/worker/bmp/bmpSession.js`
- Worker 启停和定时清理：`electron/worker/bmp/bmpWorker.js`

## 1. 数据库定位

SQLite 是 BMP RIB 的权威数据源，不是可选的历史副本。

- 完整 current RIB、路由事件和 Statistics Report 保存在 SQLite。
- 内存只保留在线连接、协议解析上下文、scope 元数据、少量摘要和页面增量状态。
- BGP Session、Loc-RIB Instance 和路由页面可在 BMP Worker 重启后从 SQLite 恢复。
- 数据库无法打开或 Writer 失败时，BMP 会 fail-closed，暂停继续接收数据，避免内存状态领先于数据库。

数据库基本信息：

| 项目 | schema v9 的值 |
| --- | --- |
| 数据库文件 | 通常为 Electron `userData/bmp/bmp.sqlite3` |
| Schema version | `9`，保存在 `PRAGMA user_version` |
| 稳定键 schema version | `1` |
| 稳定键算法 | SHA-256 |
| Journal 模式 | WAL |
| 外键 | `foreign_keys = ON` |
| 同步级别 | `synchronous = NORMAL` |
| Busy timeout | 5000 ms |
| 临时存储 | MEMORY |
| WAL 自动 checkpoint | 2000 页 |

WAL 模式运行时，数据库目录还可能存在：

- `bmp.sqlite3-wal`：尚未 checkpoint 回主文件的已提交 WAL 页面。
- `bmp.sqlite3-shm`：WAL 共享内存索引。

## 2. Schema v9 的核心变化

v9 不再把所有 current route 放在一张 `bmp_current_routes` 大表中。新的结构有四个重点：

1. current route 固定拆成 `2 × 18 = 36` 张物理分区表。
2. Route identity/NLRI、扩展展示 payload 和 path attributes 分开全局去重，分区表只保留当前路径状态和外键。
3. `current_ref_count`、`event_ref_count` 和 scope route counters 由 SQLite trigger 在事务内维护。
4. v9 只支持空库初始化，不包含 v8 或更早版本的数据迁移和兼容表。

这种设计把高频的 scope 内分页、upsert、withdraw 和 epoch 清理限制在一张较小的分区表中，同时避免把较大的 NLRI JSON、route JSON 和 attribute JSON 复制到每个 scope。

## 3. 数据库对象总览

### 3.1 全局业务表

| 表 | 主要职责 |
| --- | --- |
| `bmp_sources` | BMP 上报设备的稳定身份 |
| `bmp_connections` | 每次 TCP/BMP 连接历史 |
| `bmp_rib_scopes` | Peer/Loc-RIB 的 AFI、SAFI、RIB 生命周期和分区归属 |
| `bmp_scope_route_counts` | 按 scope、connection、epoch、显式状态维护 current route 数量 |
| `bmp_route_attributes` | 全局去重的 BGP Path Attributes |
| `bmp_route_identities` | 全局去重的 canonical NLRI identity |
| `bmp_route_payloads` | 全局去重的 route 扩展展示字段 JSON；普通路由可以共享 `{}` |
| `bmp_ingest_batches` | 批量写入幂等记录 |
| `bmp_route_events` | 带固定分区归属的连接、scope、路由和统计事件流水 |
| `bmp_statistics_samples` | Statistics Report 历史样本 |
| `bmp_statistics_latest` | 每个逻辑 Statistics Report 的最新样本投影 |

### 3.2 Current-route 分区

`bmpRoutePartitionManifest.js` 固定声明 36 张 current-route 表：

```text
bmp_current_routes_{peer|loc_rib}_{family_token}
```

每个分区使用相同字段、索引和 trigger，仅 `partition_id`、`scope_kind` 和允许的 AFI/SAFI 不同。

### 3.3 统一视图

`bmp_current_routes_all` 是 36 张分区的只读 `UNION ALL` 视图。视图会关联：

- 当前路径分区行；
- `bmp_route_identities`；
- `bmp_route_payloads`。

视图恢复出与逻辑 current route 接近的展开字段，供跨分区查询、运维检查和通用代码使用。属性 JSON 仍需通过 `attr_id` 关联 `bmp_route_attributes`。

SQLite 还会自动创建 `sqlite_sequence`，用于记录 `bmp_route_events.event_id` 和 `bmp_statistics_samples.sample_id` 的 AUTOINCREMENT 进度。不要手工修改该表。

## 4. 固定分区清单

### 4.1 Scope kind

物理分区只接受两个 `scope_kind`：

| scope_kind | Owner | BMP peer type | 表名 token |
| --- | --- | --- | --- |
| `peer` | `BmpBgpSession` | Global、L3VPN、Local，即 0、1、2 | `peer` |
| `loc-rib` | `BmpBgpInstance` | Local RIB，即 3 | `loc_rib` |

`bmp_rib_scopes.scope_kind` 有 `CHECK(scope_kind IN ('peer', 'loc-rib'))`。`session`、`instance`、`loc_rib` 等文本不是数据库合法值。

### 4.2 地址族和 partition ID

| `familyId` | family key | token | AFI | SAFI | peer partition | loc-rib partition |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | `ipv4-unicast` | `ipv4_unicast` | 1 | 1 | 101 | 201 |
| 2 | `ipv6-unicast` | `ipv6_unicast` | 2 | 1 | 102 | 202 |
| 3 | `ipv4-multicast` | `ipv4_multicast` | 1 | 2 | 103 | 203 |
| 4 | `ipv6-multicast` | `ipv6_multicast` | 2 | 2 | 104 | 204 |
| 5 | `ipv4-labeled-unicast` | `ipv4_labeled_unicast` | 1 | 4 | 105 | 205 |
| 6 | `ipv6-labeled-unicast` | `ipv6_labeled_unicast` | 2 | 4 | 106 | 206 |
| 7 | `ipv4-mvpn` | `ipv4_mvpn` | 1 | 5 | 107 | 207 |
| 8 | `ipv6-mvpn` | `ipv6_mvpn` | 2 | 5 | 108 | 208 |
| 9 | `l2vpn-evpn` | `l2vpn_evpn` | 25 | 70 | 109 | 209 |
| 10 | `vpnv4` | `vpnv4` | 1 | 128 | 110 | 210 |
| 11 | `vpnv6` | `vpnv6` | 2 | 128 | 111 | 211 |
| 12 | `ipv4-flowspec` | `ipv4_flowspec` | 1 | 133 | 112 | 212 |
| 13 | `ipv6-flowspec` | `ipv6_flowspec` | 2 | 133 | 113 | 213 |
| 14 | `ipv4-qp` | `ipv4_qp` | 1 | 241 | 114 | 214 |
| 15 | `ipv6-qp` | `ipv6_qp` | 2 | 241 | 115 | 215 |
| 16 | `bgp-ls` | `bgp_ls` | 16388 | 71 | 116 | 216 |
| 17 | `bgp-ls-vpn` | `bgp_ls_vpn` | 16388 | 72 | 117 | 217 |
| 18 | `other` | `other` | 任意其他合法值 | 任意其他合法值 | 118 | 218 |

例如：

- Peer IPv4 Unicast：`bmp_current_routes_peer_ipv4_unicast`
- Loc-RIB EVPN：`bmp_current_routes_loc_rib_l2vpn_evpn`
- Peer 未知地址族：`bmp_current_routes_peer_other`

`familyId` 是 manifest 中显式固定且全局唯一的稳定编号，不依赖数组顺序。当前 `partition_id` 按 `100 + familyId`（peer）或 `200 + familyId`（loc-rib）生成，并同时持久化在 scope、current route 和带 scope 的 event 中。已发布的 `familyId` 不得重编号或复用；不要从数组位置或外部输入自行推导分区，应始终使用 manifest。

### 4.3 `other` 分区

AFI 必须是 0 到 65535 的整数，SAFI 必须是 0 到 255 的整数。

- 格式合法但不属于前述 17 组的组合进入对应 owner 的 `other` 分区。
- 缺失、负数、小数或越界值直接拒绝，不会进入 `other`。
- `other` 行仍通过 `bmp_route_identities` 保存实际 AFI 和 SAFI。

### 4.4 安全路由

分区表名不能由 API 参数直接拼接。写入过程必须：

1. 验证 `scope_kind`、AFI 和 SAFI。
2. 通过固定 manifest 解析 descriptor。
3. 将 descriptor 的 `partition_id` 保存到 `bmp_rib_scopes`。
4. 只使用 descriptor 中预先校验的表名准备 SQL。
5. 校验 route 的 AFI/SAFI 与 scope 完全一致。

数据库内还有连续的校验链：

- Scope insert/update trigger 验证 `(partition_id, scope_kind, afi, safi)` 必须与 manifest 中的某个 descriptor 匹配：known-family 必须精确匹配，`other` 必须排除 17 个已知组合；AFI/SAFI 的类型和取值范围由进入数据库前的 manifest resolver 校验。
- 每张分区表的 `partition_id` 有固定值 `CHECK`，并通过 `(scope_id, partition_id)` 复合外键指向 `bmp_rib_scopes`。
- 分区 insert trigger 同时关联 scope 和 route identity，验证 scope 的 partition、kind、AFI/SAFI、identity 的 AFI/SAFI 与目标分区一致。
- 分区行一旦建立，`scope_id`、`partition_id` 和 `route_pk` 不可更新，避免绕过上述校验把路径移动到另一个 scope、分区或 identity。

## 5. 表关联图

```text
bmp_sources
  ├── 1:N ── bmp_connections
  ├── 1:N ── bmp_rib_scopes
  ├── 1:N ── bmp_route_events
  ├── 1:N ── bmp_statistics_samples
  └── 1:N ── bmp_statistics_latest

bmp_connections
  ├── 1:N ── bmp_rib_scopes.last_connection_id
  ├── 1:N ── 36 张 current-route 分区.connection_id
  ├── 1:N ── bmp_scope_route_counts.connection_id
  ├── 1:N ── bmp_route_events.connection_id
  └── 1:N ── bmp_statistics_samples.connection_id

bmp_rib_scopes
  ├── 1:N ── 所属的一张 current-route 分区
  ├── 1:N ── bmp_scope_route_counts
  ├── 1:N ── bmp_route_events.(scope_id, partition_id)，复合引用可整体为空
  └── 1:N ── bmp_statistics_samples.scope_id，可为空

bmp_route_identities
  ├── 1:N ── current-route 分区.route_pk
  └── 1:N ── bmp_route_events.route_pk

bmp_route_payloads
  ├── 1:N ── current-route 分区.payload_id
  └── 1:N ── bmp_route_events.payload_id

bmp_route_attributes
  ├── 1:N ── current-route 分区.attr_id，可为空
  └── 1:N ── bmp_route_events.attr_id，可为空

bmp_statistics_samples
  └── 1:0..1 ── bmp_statistics_latest.sample_id
```

`bmp_ingest_batches.batch_id` 与 `bmp_route_events.batch_id` 是逻辑关联，没有外键。分区表的 `last_event_id` 也是用于排序和版本保护的逻辑引用，不声明指向 event 的外键。

## 6. Source、connection 和 scope

### 6.1 `bmp_sources`

一行代表一个稳定 BMP 上报源。主要字段：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `source_id` | TEXT PK | 规范化 source identity 的 SHA-256 十六进制值 |
| `source_key_json` | TEXT NOT NULL | 键版本、算法和 keyHex |
| `source_identity_json` | TEXT NOT NULL | 生成 source ID 的规范化身份 |
| `remote_ip` | TEXT NULL | 最近已知的 BMP 发起端地址 |
| `sys_name`、`sys_desc` | TEXT NULL | BMP Initiation 元数据 |
| `first_seen_ms`、`last_seen_ms` | INTEGER NOT NULL | 首次和最近观察时间 |
| `metadata_json` | TEXT NULL | BMP version、v4 TLV draft 等扩展元数据 |

设备重连时复用稳定 `source_id`，但会创建新的 connection。

### 6.2 `bmp_connections`

一行代表一次 TCP/BMP 连接。主要字段包括 `connection_id`、`source_id`、单调的 `connection_generation`、本地/远端地址和端口、打开/关闭时间、关闭原因及 `connection_state`。

`idx_bmp_connections_source_time(source_id, opened_at_ms DESC)` 用于查某 source 的连接历史。

### 6.3 `bmp_rib_scopes`

一个 scope 表示一个明确路由空间：

```text
source
  + peer 或 loc-rib 身份
  + AFI
  + SAFI
  + RIB stage
```

主要字段：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `scope_id` | TEXT PK | 规范化 scope identity 的 SHA-256 |
| `source_id` | TEXT NOT NULL，FK | 所属 source |
| `partition_id` | INTEGER NOT NULL | manifest 中的固定物理分区 ID |
| `scope_key_json`、`scope_identity_json` | TEXT NOT NULL | 稳定键信息和完整 canonical identity |
| `scope_kind` | TEXT NOT NULL，CHECK | 仅 `peer` 或 `loc-rib` |
| `owner_key` | TEXT NULL | 聚合为 Session 或标识 Loc-RIB owner 的业务键 |
| `peer_type`、`peer_rd`、`peer_ip`、`peer_as` | TEXT NULL | Peer/Instance 身份和展示信息 |
| `vrf_name` | TEXT NULL | VRF/Table Name |
| `afi`、`safi` | INTEGER NOT NULL | 地址族 |
| `rib_type` | TEXT NOT NULL | Peer RIB stage，或 `loc-rib` |
| `current_epoch` | INTEGER NOT NULL | 当前全量刷新代次 |
| `eor_epoch` | INTEGER NULL | 最近完成 EOR 的 epoch |
| `scope_state` | TEXT NOT NULL | `syncing`、`ready`、`stale` 或 `down` |
| `stale_reason`、`stale_since_ms` | 可空 | stale/down 原因和起始时间 |
| `refresh_started_ms` | INTEGER NULL | 当前刷新开始时间 |
| `cleanup_pending_epoch` | INTEGER NULL | 等待清理旧路径的 epoch |
| `last_connection_id` | TEXT NULL，FK | 当前接管 scope 的连接 |
| `created_at_ms`、`updated_at_ms` | INTEGER NOT NULL | 创建和更新时间 |

`UNIQUE(scope_id, partition_id)` 为分区表的复合外键提供目标。Scope 的 insert/update trigger 还会根据固定 manifest 验证 `partition_id`、`scope_kind`、AFI 和 SAFI 的组合；一个 scope 的 `partition_id` 在其生命周期内必须稳定。

## 7. 全局路由对象

### 7.1 `bmp_route_identities`

该表保存“这是什么路由”，跨 source、scope 和 RIB stage 全局复用。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `route_pk` | INTEGER PK | 数据库内部短键，供分区和 event 引用 |
| `route_id` | TEXT NOT NULL UNIQUE | Canonical route identity 的稳定 SHA-256 ID |
| `route_key_json` | TEXT NOT NULL | 稳定键版本、算法和 keyHex |
| `route_identity_json` | TEXT NOT NULL | 完整 canonical route identity |
| `route_key_version` | INTEGER NOT NULL | Route key schema version |
| `legacy_route_key` | TEXT NULL | 兼容页面/API 的旧 route key |
| `afi`、`safi` | INTEGER NOT NULL | 地址族，也是分区验证依据 |
| `path_id` | INTEGER NOT NULL | ADD-PATH Path Identifier |
| `rd` | TEXT NULL | VPN、EVPN、BGP-LS VPN 等 RD |
| `prefix`、`prefix_length` | 可空 | 可索引普通前缀；复杂 NLRI 可以为空 |
| `nlri_kind` | TEXT NULL | `ip-prefix`、`vpn-prefix`、`evpn`、`raw-nlri` 等 |
| `nlri_json` | TEXT NOT NULL | 完整解析后的 NLRI |
| `first_seen_ms`、`last_seen_ms` | INTEGER NOT NULL | 生命周期时间 |
| `current_ref_count` | INTEGER NOT NULL | 36 张 current 分区中的引用数 |
| `event_ref_count` | INTEGER NOT NULL | event 中的引用数 |

同一个 `route_id` 在多个 peer、RIB stage 或 Loc-RIB 中出现时只保存一份 identity/NLRI JSON。

索引：

- `(afi, safi, prefix, prefix_length, route_pk)`：前缀查询。
- `(prefix, prefix_length, route_pk)`：已定向到 scope/分区后的精确前缀反查。
- `(legacy_route_key, route_pk)`：旧 route key 查询。
- `(current_ref_count, event_ref_count, last_seen_ms, route_pk)`：无引用对象清理。

### 7.2 `bmp_route_payloads`

该表不是完整 route snapshot，只保存不属于 identity/NLRI、Path Attributes 或 current-state 的扩展展示字段。写入前会删除 route key、AFI/SAFI、prefix、RD、path ID、`nlriDetail` 等 identity 字段，删除可从 `bmp_route_attributes` 取得的属性字段，删除 route state、epoch 和 stale 时间等 current-state 字段，并省略空值、空集合及可重建的默认值。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `payload_id` | INTEGER PK | 数据库内部短键 |
| `payload_hash` | BLOB NOT NULL UNIQUE | `route_json` 的内容哈希 |
| `route_json` | TEXT NOT NULL | 仅含扩展展示字段的 JSON object；允许为 `{}` |
| `first_seen_ms`、`last_seen_ms` | INTEGER NOT NULL | 首次和最近使用时间 |
| `current_ref_count`、`event_ref_count` | INTEGER NOT NULL | current/event 引用数 |

内容相同的 payload 在不同 route identity、scope、刷新和 event 之间共享一行。普通 IP prefix 路由如果没有额外展示字段，payload 就是 `{}`；所有这类 current row 和 route event 可以引用同一个 `payload_id`。

### 7.3 `bmp_route_attributes`

该表保存 canonicalized BGP Path Attributes。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `attr_id` | TEXT PK | Canonical attribute JSON 的 SHA-256 ID |
| `attr_json` | TEXT NOT NULL | 去重后的属性 JSON |
| `first_seen_ms`、`last_seen_ms` | INTEGER NOT NULL | 首次和最近使用时间 |
| `current_ref_count`、`event_ref_count` | INTEGER NOT NULL | current/event 引用数 |

Identity、payload 和 attributes 分离后，route 更新属性时无需复制 NLRI；同一组属性也不会在数百万条 route 中重复保存。

读取 current route 或 route event 时，应用按以下来源重建 route 投影：

1. `bmp_route_identities` 的 AFI/SAFI、prefix、RD、path ID 和 `nlri_json` 构造 identity/NLRI 基础字段及默认展示值，`nlri_json` 恢复为 `nlriDetail`。
2. `bmp_route_payloads.route_json` 叠加少量扩展展示字段；`{}` 不影响基础投影。
3. `bmp_route_attributes.attr_json` 叠加 canonical BGP Path Attributes，再由 current/event 行的 `attr_id` 恢复 `attrId`。
4. Current-route 查询再从物理分区、scope 和 connection 补充 `routeState`、epoch、stale 原因和观察时间；event 查询则在 route 投影之外返回事件元数据。

### 7.4 引用计数

三张全局对象表都分别维护：

- `current_ref_count`：当前 36 张分区的引用数。
- `event_ref_count`：`bmp_route_events` 的引用数。

计数由 trigger 维护：

| 动作 | 自动变化 |
| --- | --- |
| 分区 INSERT | identity、payload，以及非空 attribute 的 current 引用 `+1` |
| 分区 DELETE | 对应 current 引用 `-1` |
| 分区 `payload_id` / `attr_id` UPDATE | 变化时旧引用 `-1`、新引用 `+1`；`route_pk` 不允许更新 |
| Event INSERT | 对应 event 引用 `+1` |
| Event DELETE | 对应 event 引用 `-1` |

引用字段比较使用 SQLite 的 NULL-safe `IS NOT`：可空的 `attr_id` 从 `NULL` 变为非空、从非空变为 `NULL`，或在两个 ID 之间切换时，计数都能正确更新；值未变化时不会重复增减。

只有 `current_ref_count = 0` 且 `event_ref_count = 0`，并超过保留时间的对象才可被 GC。应用代码不应手工修正这些计数。

## 8. Current-route 分区表

36 张表使用同一结构：

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `path_pk` | INTEGER PK | 当前路径行的短主键 |
| `partition_id` | INTEGER NOT NULL，CHECK | 该表固定 partition ID |
| `scope_id` | TEXT NOT NULL，复合 FK | 所属 scope |
| `route_pk` | INTEGER NOT NULL，FK | 指向全局 route identity |
| `payload_id` | INTEGER NOT NULL，FK | 指向全局 route payload |
| `attr_id` | TEXT NULL，FK | 指向全局 Path Attributes |
| `connection_id` | TEXT NOT NULL，FK | 当前版本来自哪次连接 |
| `rib_epoch` | INTEGER NOT NULL | 当前版本所属刷新 epoch |
| `explicit_state` | TEXT NOT NULL | 默认 `active` |
| `first_seen_ms`、`last_seen_ms` | INTEGER NOT NULL | 该 scope/path 首次和最近出现时间 |
| `source_timestamp_ms` | INTEGER NULL | 最近 BMP source timestamp |
| `last_event_id` | INTEGER NOT NULL | 最新事件序号，用于版本保护和排序 |

业务唯一约束为：

```text
UNIQUE(scope_id, route_pk)
```

同一个 canonical route 可以出现在多个 scope；同一 scope 内只保留一个 current 版本。

每张分区有六个二级索引：

| 索引后缀 | 字段 | 用途 |
| --- | --- | --- |
| `scope_first_seen` | `(scope_id, first_seen_ms, path_pk)` | Scope 页面稳定分页 |
| `scope_epoch` | `(scope_id, connection_id, rib_epoch, path_pk)` | 接管、epoch 和 stale 清理 |
| `route` | `(route_pk, scope_id)` | 跨 scope 定位同一路由 |
| `attr` | `(attr_id)` | 属性关联和诊断 |
| `payload` | `(payload_id)` | Payload 引用定位、删除诊断和引用完整性检查 |
| `connection` | `(connection_id, scope_id)` | 按连接清理或定位其 current route |

分区 trigger 负责三类不变量：insert 时校验 scope、partition 和 family；update 时禁止改变 `scope_id`、`partition_id`、`route_pk`；insert/delete/update 时事务内维护 scope counter 和全局对象的 current ref count。

### 8.1 为什么分区表保持窄行

分区行不再保存 `route_identity_json`、`nlri_json`、`route_json` 或 `attr_json`。这样可以：

- 提高 B-tree 页扇出和缓存命中率；
- 缩小高频索引；
- 降低 upsert、withdraw 和 sweep 的写放大；
- 让全局重复对象只存一份。

## 9. Scope route counters

`bmp_scope_route_counts` 的主键是：

```text
(scope_id, connection_id, rib_epoch, explicit_state)
```

字段 `route_count` 表示 36 张 current 分区中属于该组合的物理行数。分区 insert/delete/update trigger 会同步增减计数，并删除降到 0 的 counter 行。

该表用于避免拓扑恢复、Session/Instance 摘要和普通 scope 页面每次都扫描 route 分区。

有效状态仍由 scope 和路径组合计算：

```text
explicit_state = 'stale'
或 scope_state IN ('stale', 'down')
或 connection_id != last_connection_id
或 rib_epoch < current_epoch
    => stale

否则 => active
```

因此摘要可以从 counter 分组求得：

- `total`：该 scope 所有 counter 的总和。
- `active`：显式 active、属于当前 connection 且 epoch 不旧的 counter 总和，并受 scope state 约束。
- `stale`：`total - active`。

Peer Down 或新 epoch 开始时仍只需更新 scope，不需要逐条改写 route。

## 10. Route events 和批次

### 10.1 `bmp_route_events`

Event 表继续保持全局时间线，但不再重复保存 route JSON、AFI、SAFI、prefix 和 legacy key，而是引用全局 route 对象。

| 字段 | 类型和约束 | 说明 |
| --- | --- | --- |
| `event_id` | INTEGER PK AUTOINCREMENT | 全库递增事件 ID |
| `batch_id` | TEXT NOT NULL | 所属 ingest batch，逻辑关联 |
| `source_id`、`connection_id` | TEXT NOT NULL，FK | 来源设备和连接 |
| `source_sequence` | INTEGER NOT NULL | 连接内 mutation 序号 |
| `scope_id` | TEXT NULL，复合 FK | 可选 scope；与 `partition_id` 同空或同非空 |
| `partition_id` | INTEGER NULL，复合 FK | Event 所属固定分区；与 `scope_id` 共同引用 `bmp_rib_scopes` |
| `route_pk` | INTEGER NULL，FK | 可选 route identity |
| `payload_id` | INTEGER NULL，FK | 可选 route payload |
| `event_type` | TEXT NOT NULL | 事件最终分类 |
| `observed_at_ms` | INTEGER NOT NULL | Collector 观察时间 |
| `source_timestamp_ms` | INTEGER NULL | BMP 原始时间戳 |
| `rib_epoch` | INTEGER NULL | 对应 RIB epoch |
| `attr_id` | TEXT NULL，FK | 可选 Path Attributes |
| `reason` | TEXT NULL | stale、close、purge 等原因 |

`scope_id` 和 `partition_id` 受 CHECK 约束，必须同时为 `NULL` 或同时非空；非空时通过 `(scope_id, partition_id)` 复合外键保证事件分区与 scope 分区一致。Route event 必须同时有 `route_pk` 和 `payload_id`；非 route event 两者同时为空。`UNIQUE(connection_id, source_sequence)` 保证重放幂等。

Event 创建后，`scope_id`、`partition_id`、`route_pk`、`payload_id` 和 `attr_id` 不可更新，确保分区归属、event ref count 与不可变的历史记录保持一致；需要不同引用时应写入新事件。

`idx_bmp_route_events_partition_time(partition_id, observed_at_ms DESC, event_id DESC)` 支持按分区和时间倒序读取历史。事件查询带 `scopeKind`、AFI 或 SAFI 条件时，会先通过固定 manifest 解析候选 `partition_id`，添加 `e.partition_id IN (...)` 进行剪枝，再用 scope/identity 的 AFI/SAFI 条件做最终精确过滤。AFI/SAFI 均给出时，已知 family 在指定 owner 下缩小到一个分区，未指定 owner 时缩小到 peer 和 loc-rib 两个分区；未知组合则命中相应 `other` 分区。

常见 `event_type`：

- 连接/source：`connection_open`、`source_update`、`connection_close`
- Scope：`scope_open`、`scope_stale`、`scope_eor`、`scope_timeout`
- Route：`announce`、`replace`、`refresh`、`upsert-noop`、`withdraw`、`withdraw-noop`、`purge`
- Statistics：`statistics`

### 10.2 `bmp_ingest_batches`

`bmp_ingest_batches(batch_id, created_at_ms, mutation_count)` 保存 Writer 批次幂等记录。同一个 `batch_id` 重试时整批不会重复执行。

一批中的 source、connection、scope、全局路由对象、event、current projection、counter 和 statistics 修改在一个 SQLite transaction 中提交。

## 11. Statistics tables

`bmp_statistics_samples` 保存历史样本，字段包括 source、connection、可选 scope、`report_kind`、`report_key`、观察时间、source timestamp 和完整 `statistics_json`。

`bmp_statistics_latest` 的主键是：

```text
(source_id, report_kind, report_key)
```

它引用每个逻辑 Session/Instance 报告的最新 sample。统计页面读取该小投影，不需要扫描全部历史样本。

`report_kind` 只允许 `session` 或 `instance`。

## 12. 写入链路

```text
BMP 报文
   │
   ▼
BmpSession 构造 mutation
   │
   ▼
BmpPersistenceClient 有界队列
   │
   ▼
SQLite Writer transaction
   ├─ ingest batch 幂等
   ├─ source / connection upsert
   ├─ 解析 manifest 并 upsert scope.partition_id
   ├─ 拆分并 upsert 全局 route 对象
   │    ├─ identity + nlri_json
   │    ├─ 扩展展示 payload（普通路由可为 {}）
   │    └─ path attributes
   ├─ insert event；带 scope 的事件同时写入 partition_id，trigger 更新 event_ref_count
   ├─ upsert/delete 一张 current-route 分区
   │    ├─ trigger 校验 family
   │    ├─ trigger 更新 scope counters
   │    └─ trigger 更新 current_ref_count
   └─ statistics sample/latest（如有）
```

默认批量和背压参数：

| 参数 | 默认值 |
| --- | ---: |
| Batch size | 2000 mutations |
| Batch bytes | 2 MiB |
| Flush interval | 20 ms |
| High watermark | 64 MiB |
| Low watermark | 32 MiB |
| Stale retention | 24 小时 |
| Refresh timeout | 30 分钟 |
| Event retention | 7 天 |
| 最大数据库逻辑大小 | 20 GiB |

默认未开启 Route Assurance 时，Writer 不构造也不跨 Worker 回传完整 committed route delta；开启分析时在一次 writer fence 后启用 delta，用于衔接初始快照之后的增量变化。

页面列表、分页和详情查询从独立只读连接读取最新已提交的 WAL 快照，不等待持续增长的 Writer 队列。因此高速摄入时页面可能短暂滞后于尚未提交的 batch，但不会读到半个事务。停止、删除、清理和 Route Assurance 初始快照边界仍执行 writer fence。只读连接失败时可回退 Writer；Writer 失败则停止 BMP 摄入。

## 13. Route 生命周期

### 13.1 Announce、replace 和 refresh

1. 解析并校验 scope 的物理 partition。
2. 将 route 拆成 identity/NLRI、扩展展示 payload 和 attributes 后分别 upsert；普通路由 payload 可以复用全局 `{}` 行。
3. 插入 route event。
4. 只有 mutation connection 等于 scope 当前 connection，且 epoch 等于 scope 当前 epoch，才允许更新 current projection。
5. 同一 `(scope_id, route_pk)` 已存在时更新 payload、attribute、时间和 `last_event_id`。
6. 根据是否新增、属性变化或仅刷新，将 event 分类为 `announce`、`replace`、`refresh` 或 `upsert-noop`。

### 13.2 Withdraw

1. Upsert/定位 route identity 和 payload，并写 event。
2. 只有 connection 和 epoch 仍有效时，才从目标分区删除 current row。
3. Trigger 自动减少 scope count 和 current reference counts。
4. 旧 connection 或错误 epoch 不删除 current row，event 分类为 `withdraw-noop`。

### 13.3 EOR 和旧 epoch

同一 BMP 连接内，重复上报某 AF 的 Peer Up（该 AF 的新一轮刷新）会推进该 AF scope 的 `current_epoch` 并进入 `syncing`；分批 Peer Up 中首次出现的新 AF 只打开自身 scope，不影响已经存在的其他 AF。Peer Down 已推进全部已跟踪 scope 的 epoch，因此其后的首个 Peer Up 复用该 epoch，不重复推进。EOR 将精确的 AF/RIB scope 设为 `ready`，记录 `eor_epoch` 并设置 `cleanup_pending_epoch`。

旧 connection/epoch 路径在删除前通过有效状态公式显示为 stale。Sweep 从 scope 对应的单一分区中分批删除旧路径，避免全库大事务。

如果新连接已经用 Peer Up 打开 scope、但一直没有 EOR，refresh timeout 到期后只保留该连接实际重新上报的路径，并删除旧 connection/epoch 路径。若同一设备重连后某个历史 scope 连 Peer Up 都没有再次出现，Collector 在确认该 source 只有一个更高代的在线连接后，也从新连接建立时间开始使用同一 refresh timeout 清空该 scope 的旧路径；scope 仍保持 `down`，不会伪装为在线或 `ready`。同一 source 存在多个并发在线连接时不执行这项整 scope 清理，避免不同 feed 互相删除。

## 14. 定时 sweep 和引用对象 GC

Worker 默认周期性执行小批量 sweep：

1. 找到需要清理的 scope。
2. 根据 scope 的 `partition_id` 只访问对应 current-route 表。
3. 分批删除旧 epoch、旧 connection 或超过 stale 保留期的路径。
4. 分批删除超过事件保留期的 event；event delete trigger 自动减少 event 引用。
5. 清理未被 latest 引用的旧 statistics sample 和旧 ingest batch。
6. 删除 `current_ref_count = 0 AND event_ref_count = 0` 且超过保留期的 identity、payload 和 attributes。

除默认周期 sweep 外，Worker 会为最早的 scope refresh 维护单一 deadline timer；到期清理完成后，按受影响的 `source_id/scope_id` 发送路由刷新事件，使已打开的页面重新查询 SQLite，而不是继续显示清理前的列表缓存。

删除 current row 和 event 后不要绕过 trigger，否则引用计数和 scope counters 会失真。

## 15. 正常停止与崩溃恢复

### 15.1 正常停止

正常停止会：

1. 关闭 BMP socket，不再接收新报文。
2. 写 connection close/scope down 状态。
3. Drain persistence queue。
4. 运行一次 sweep。
5. 执行 passive WAL checkpoint。
6. 关闭 reader 和 writer。

### 15.2 崩溃恢复

数据库重新打开时，遗留 `open` connection 会改为 `closed`，关闭原因为 `collector-restart`；其当前 scope 会进入 `down`。Current rows 不需要批量更新，通过 scope state 自动显示 stale。

## 16. Schema v9 初始化和版本规则

v9 明确不支持旧库迁移。

Writer 只接受以下两种数据库：

1. 已经是完整 schema v9 的数据库。
2. `PRAGMA user_version = 0` 且没有任何非 SQLite 内部对象的空数据库。

其他情况直接失败：

| 情况 | 结果 |
| --- | --- |
| v1 到 v8 | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| `user_version = 0` 但已有业务表、索引、view 或 trigger | `BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE` |
| 高于 v9 | `BMP_PERSISTENCE_SCHEMA_TOO_NEW` |
| Read-only 打开非 v9 | 拒绝读取 |

不能通过手工把旧库 `user_version` 改成 0 来升级，因为初始化还会检查数据库是否为空。

升级到使用 v9 的版本前，如需保留旧库用于审计，应先停止 BMP 并备份整个 SQLite/WAL 文件组；应用使用 v9 时需要创建新的空数据库。旧 current route、event 和 statistics 不会自动导入。

## 17. 运维查询示例

建议停止 BMP 后执行人工一致性检查。运行中检查应使用 read-only 连接或 SQLite 在线备份能力。

### 17.1 Schema 和对象数量

```sql
PRAGMA user_version;
PRAGMA journal_mode;
PRAGMA foreign_key_check;

SELECT type, COUNT(*) AS objects
  FROM sqlite_master
 WHERE name NOT LIKE 'sqlite_%'
 GROUP BY type
 ORDER BY type;
```

### 17.2 各分区路由量

```sql
SELECT partition_id, COUNT(*) AS routes
  FROM bmp_current_routes_all
 GROUP BY partition_id
 ORDER BY partition_id;
```

### 17.3 Scope counters

```sql
SELECT scope_id, connection_id, rib_epoch, explicit_state, route_count
  FROM bmp_scope_route_counts
 ORDER BY scope_id, connection_id, rib_epoch, explicit_state;
```

### 17.4 引用计数诊断

```sql
SELECT 'identity' AS kind, COUNT(*) AS unreferenced
  FROM bmp_route_identities
 WHERE current_ref_count = 0 AND event_ref_count = 0
UNION ALL
SELECT 'payload', COUNT(*)
  FROM bmp_route_payloads
 WHERE current_ref_count = 0 AND event_ref_count = 0
UNION ALL
SELECT 'attribute', COUNT(*)
  FROM bmp_route_attributes
 WHERE current_ref_count = 0 AND event_ref_count = 0;
```

### 17.5 某 scope 的展开路由

```sql
SELECT r.scope_id, r.route_id, r.afi, r.safi, r.prefix, r.prefix_length,
       r.connection_id, r.rib_epoch, r.explicit_state, r.last_seen_ms,
       r.nlri_json, a.attr_json, r.route_json AS extension_payload_json
  FROM bmp_current_routes_all r
  LEFT JOIN bmp_route_attributes a ON a.attr_id = r.attr_id
 WHERE r.scope_id = ?
 ORDER BY r.first_seen_ms, r.path_pk
 LIMIT 100;
```

这里的 `extension_payload_json` 不是完整 route；应用读取会把 identity/NLRI、该 payload、attributes 和 current-state 合并成 route 投影。生产查询已知 scope 时应通过 manifest 直接命中一张物理表；统一 view 更适合诊断和真正的跨分区查询。

## 18. SQL 调试日志

在“设置 → 通用设置”中把日志级别切换为 `debug` 并保存后，BMP SQLite writer、只读 reader 和离线 reader 会输出 SQL 跟踪。切回 `info`、`warn`、`error` 或 `off` 会立即停止跟踪。

SQL 跟踪包括执行方式、耗时、受影响行数或返回行数，以及归一化后的 SQL。BMP 写入频率高，`debug` 会产生大量日志，只应临时启用。

## 19. 运维注意事项

- 不要手工向分区表写入错误的 `partition_id`，也不要绕过 family validation trigger。
- 不要手工修改 scope counters 或任何 ref-count 字段。
- 不要根据外部输入拼接物理表名，表名必须来自固定 manifest。
- 不要只备份 `bmp.sqlite3` 而忽略正在使用的 WAL/SHM。
- 最稳妥的离线备份方式是先停止 BMP，让队列 drain 并 checkpoint，再复制数据库文件。
- 大量删除后文件不会自动缩小；`freelist_count` 表示可复用页，是否执行 `VACUUM` 应由运维窗口和可用磁盘空间决定。
- `bmp_current_routes_all` 是只读统一视图，不应作为写入目标。
- v9 没有旧库兼容层；发现 schema 不匹配时应备份旧库并创建空库，不要直接修改 `user_version` 或表结构。
