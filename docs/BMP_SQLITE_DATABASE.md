# BMP SQLite 数据库说明

本文档说明 NetNexus 当前 BMP SQLite 数据库的定位、表结构、字段用途、表间关联，以及启动、写入、重连、EOR、过期、清理和崩溃恢复时的自动行为。

实现依据：

- 数据库建表、迁移、查询和清理：electron/worker/bmp/bmpPersistenceStore.js
- 稳定 ID：electron/utils/bmpPersistentRouteKey.js
- mutation 构造：electron/worker/bmp/bmpPersistenceMutation.js
- 异步批量写入：electron/worker/bmp/bmpPersistenceClient.js
- BMP 生命周期：electron/worker/bmp/bmpSession.js
- Worker 启停和定时清理：electron/worker/bmp/bmpWorker.js

## 1. 数据库定位

当前 SQLite 是 BMP RIB 的权威数据源，不再只是内存路由的历史副本。

- 完整路由保存在 SQLite。
- 内存只保留真实在线连接、协议解析上下文、scope 元数据和少量摘要。
- BGP Session、Loc-RIB Instance 和路由页面可在 BMP Worker 重启后从 SQLite 恢复。
- 离线恢复不会创建假的 BmpSession；页面看到的是从数据库重建的离线拓扑。
- 数据库无法打开或 Writer 失败时，BMP 会 fail-closed，停止继续接收数据，避免内存状态领先于数据库。

数据库基本信息：

| 项目 | 当前值 |
| --- | --- |
| 数据库文件 | 通常为 Electron userData 目录下的 bmp/bmp.sqlite3 |
| 数据库 schema version | 8，保存在 PRAGMA user_version |
| 稳定键 schema version | 1 |
| 稳定键算法 | SHA-256 |
| Journal 模式 | WAL |
| 外键 | foreign_keys = ON |
| 同步级别 | synchronous = NORMAL |
| Busy timeout | 5000 ms |
| WAL 自动 checkpoint | 2000 页 |

注意：数据库 schema version 8 和稳定键 schema version 1 是两个不同概念。前者描述表结构，后者描述 source_id、scope_id、route_id 的生成规则。

WAL 模式运行时，数据库目录还可能出现：

- bmp.sqlite3-wal：尚未 checkpoint 回主文件的已提交 WAL 页面。
- bmp.sqlite3-shm：WAL 共享内存索引。

## 2. 表总览

当前有 9 张应用业务表：

| 表 | 主要职责 | 是否自动清理 |
| --- | --- | --- |
| bmp_sources | BMP 设备的稳定身份 | 否 |
| bmp_connections | 每次 TCP/BMP 连接历史 | 否 |
| bmp_rib_scopes | Peer/Loc-RIB 的 AFI、SAFI、RIB 分区及状态 | 否 |
| bmp_route_attributes | 去重后的 BGP Path Attributes | 是，无引用且超过保留期后删除 |
| bmp_route_events | 连接、scope、路由、统计等事件流水 | 是，默认保留 7 天 |
| bmp_current_routes | 当前 RIB 路由投影，页面路由的权威来源 | 是，按 epoch、连接和 stale 保留策略删除 |
| bmp_ingest_batches | 批量写入幂等记录 | 是，默认保留 7 天 |
| bmp_statistics_samples | Statistics Report 历史样本 | 是，默认保留 7 天 |
| bmp_statistics_latest | 每个 source、Session/Instance 的最新 Statistics Report 投影 | 否，随新样本原位更新 |

SQLite 还会自动创建 sqlite_sequence，用于记录 bmp_route_events.event_id 和 bmp_statistics_samples.sample_id 的 AUTOINCREMENT 进度。它是 SQLite 内部表，不是业务数据表，不应手工修改。

数据库没有单独的 bgp_sessions 或 bgp_instances 表：

- Peer scope 按 source_id + owner_key 聚合为页面上的 BGP Session。
- scope_kind = loc-rib 的 scope 重建为页面上的 Loc-RIB Instance。

## 3. 表关联图

    bmp_sources
      ├── 1:N ── bmp_connections
      ├── 1:N ── bmp_rib_scopes
      ├── 1:N ── bmp_route_events
      ├── 1:N ── bmp_statistics_samples
      └── 1:N ── bmp_statistics_latest

    bmp_connections
      ├── 1:N ── bmp_rib_scopes.last_connection_id
      ├── 1:N ── bmp_current_routes.connection_id
      ├── 1:N ── bmp_route_events.connection_id
      └── 1:N ── bmp_statistics_samples.connection_id

    bmp_rib_scopes
      ├── 1:N ── bmp_current_routes
      ├── 1:N ── bmp_route_events.scope_id，可为空
      └── 1:N ── bmp_statistics_samples.scope_id，可为空

    bmp_route_attributes
      ├── 1:N ── bmp_current_routes.attr_id，可为空
      └── 1:N ── bmp_route_events.attr_id，可为空

    bmp_route_events
      └── 1:N ── bmp_current_routes.last_event_id
          业务上通常是一条 event 对应零或一条当前路由，
          但数据库没有给 last_event_id 增加 UNIQUE。

    bmp_statistics_samples
      └── 1:0..1 ── bmp_statistics_latest.sample_id
          latest 只引用每个逻辑报告当前最新的样本。

    bmp_ingest_batches
      ┄┄ 逻辑关联 ┄┄ bmp_route_events.batch_id
          batch_id 没有声明 FOREIGN KEY。

所有数据库外键都没有 ON DELETE CASCADE，使用 SQLite 默认的 NO ACTION。删除仍被子表引用的父记录会失败，正常清理必须由应用按顺序执行。

当前 schema 没有 trigger，也没有 view。文档中所说的“自动行为”全部由应用写入事务、启动恢复逻辑和定时 sweep 实现，不是 SQLite trigger 在后台执行。

## 4. bmp_sources

### 4.1 用途

一行代表一个稳定 BMP 上报源或设备。设备重连时复用同一个 source_id；每次连接历史记录在 bmp_connections。

source_id 当前优先根据 BMP Initiation 的 sysName 加 source address 生成；没有 sysName 时退化为 source address。身份规范化后计算 SHA-256。

因此需要注意：

- 同一 sysName 且地址相同，重连会命中同一 source。
- 同一设备的 sysName 或地址发生变化，可能生成新的 source。
- 两台设备如果使用相同 sysName 且从相同地址上报，当前规则无法区分。

### 4.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| source_id | TEXT PRIMARY KEY | 稳定 source ID，规范化 source identity 的 SHA-256 十六进制值。 |
| source_key_json | TEXT NOT NULL | 保存键版本、算法和 keyHex，用于解释 source_id 如何生成。 |
| source_identity_json | TEXT NOT NULL | 生成 source_id 的规范化身份 JSON。 |
| remote_ip | TEXT NULL | 最近已知 BMP 发起端地址。source upsert 时用新非空值更新。 |
| sys_name | TEXT NULL | BMP Initiation 的 System Name。空字符串不会覆盖已有值。 |
| sys_desc | TEXT NULL | BMP Initiation 的 System Description。空字符串不会覆盖已有值。 |
| first_seen_ms | INTEGER NOT NULL | 第一次观察到该 source 的 Unix epoch 毫秒。upsert 时不覆盖。 |
| last_seen_ms | INTEGER NOT NULL | 最近一次观察时间。upsert 时取原值和新值的最大值。 |
| metadata_json | TEXT NULL | 扩展元数据，目前保存 bmpVersion、bmpV4TlvDraft 等。 |

### 4.3 自动行为

- 每个 mutation 都会确保 source 已 upsert，因此 source 元数据可随 Initiation 和后续消息刷新。
- source_id 不随 TCP 端口变化。
- 当前 sweep 不删除 source，因此它长期保留，供离线拓扑恢复。
- 本表使用 WITHOUT ROWID，没有额外普通索引。

## 5. bmp_connections

### 5.1 用途

保存每次 TCP/BMP 连接。一台稳定 source 可以有多条连接记录，因此 connection_id 不能当作设备身份。

### 5.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| connection_id | TEXT PRIMARY KEY | 单次连接 ID，优先使用 UUID。每次新连接重新生成。 |
| source_id | TEXT NOT NULL，FK | 所属 bmp_sources.source_id。 |
| connection_generation | INTEGER NOT NULL | 连接代次，用于判断新连接是否可以接管旧 scope。通常基于当前毫秒时间并保证单进程单调递增。 |
| local_ip | TEXT NULL | 收集器本地地址。 |
| local_port | INTEGER NULL | 收集器监听端口。 |
| remote_ip | TEXT NULL | BMP 发起端地址。 |
| remote_port | INTEGER NULL | BMP 发起端临时端口。重连时通常会变化。 |
| opened_at_ms | INTEGER NOT NULL | 连接创建时间。 |
| closed_at_ms | INTEGER NULL | 连接关闭时间；open 时为空。 |
| close_reason | TEXT NULL | 关闭原因，例如 bmp-session-close、connection-close、collector-restart。 |
| connection_state | TEXT NOT NULL | 当前使用 open 或 closed。 |

### 5.3 自动行为

- Initiation/首个持久化 mutation 会写入 open 连接。
- 正常 TCP 断开或 BMP Termination 会改为 closed，并记录关闭时间和原因。
- 关闭连接时，该连接当前拥有的 scope 会统一变为 down。
- 如果进程崩溃，下一次打开数据库时会把遗留 open 连接改为 closed，原因写为 collector-restart。
- 当前 sweep 不删除连接历史。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_connections_source_time(source_id, opened_at_ms DESC) | 查某 source 的连接历史。 |

## 6. bmp_rib_scopes

### 6.1 用途

这是拓扑和 RIB 生命周期的核心表。一个 scope 表示一个明确的路由空间：

    source
      + peer 或 loc-rib 身份
      + AFI
      + SAFI
      + RIB stage

Peer scope 的 RIB stage 可以是 Pre Adj-RIB-In、Adj-RIB-In、AS Path、Adj-RIB-Out、Post Adj-RIB-Out；Loc-RIB scope 的 rib_type 为 loc-rib。

scope_id 是稳定 ID，重连后复用。last_connection_id 则指向当前接管该 scope 的最新连接。

### 6.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| scope_id | TEXT PRIMARY KEY | 规范化 scope identity 的 SHA-256。 |
| source_id | TEXT NOT NULL，FK | 所属 bmp_sources.source_id。 |
| scope_key_json | TEXT NOT NULL | 保存 scope 键版本、算法和 keyHex。 |
| scope_identity_json | TEXT NOT NULL | 完整规范化 scope identity。 |
| scope_kind | TEXT NOT NULL | peer 或 loc-rib。 |
| owner_key | TEXT NULL | 将多个 peer scope 聚合成一个 Session，或标识 Loc-RIB owner 的业务键。 |
| peer_type | TEXT NULL | BMP Peer/Instance Type。数据库存 TEXT 以兼容数值或文本。 |
| peer_rd | TEXT NULL | Peer/Instance RD 的展示值。 |
| peer_ip | TEXT NULL | Peer 地址；部分 Loc-RIB 记录可为空。 |
| peer_as | TEXT NULL | Peer AS。使用 TEXT 避免 ASN 精度和格式问题。 |
| vrf_name | TEXT NULL | VRF/Table Name。 |
| afi | INTEGER NOT NULL | Address Family Identifier。 |
| safi | INTEGER NOT NULL | Subsequent Address Family Identifier。 |
| rib_type | TEXT NOT NULL | Peer RIB 类型编号的文本形式，或 loc-rib。 |
| current_epoch | INTEGER NOT NULL DEFAULT 0 | 当前全量刷新代次。新一轮刷新或 stale 生命周期会推进 epoch。 |
| eor_epoch | INTEGER NULL | 最近成功完成 EOR 的 epoch。 |
| scope_state | TEXT NOT NULL DEFAULT syncing | 当前使用 syncing、ready、stale、down。 |
| stale_reason | TEXT NULL | stale/down/timeout 原因。 |
| stale_since_ms | INTEGER NULL | 进入 stale 或 down 的起始时间，用于保留期清理。 |
| refresh_started_ms | INTEGER NULL | 当前 syncing 刷新开始时间，用于 EOR 超时处理。 |
| cleanup_pending_epoch | INTEGER NULL | EOR 或 refresh timeout 后等待清理旧 epoch/旧连接路由的标记。 |
| last_connection_id | TEXT NULL，FK | 当前接管该 scope 的 bmp_connections.connection_id。 |
| created_at_ms | INTEGER NOT NULL | scope 首次创建时间。 |
| updated_at_ms | INTEGER NOT NULL | scope 最近一次有效状态更新时间。 |

### 6.3 状态机

    Peer Up / 新一轮刷新
              │
              ▼
          syncing
           │     │
      收到 EOR   超过 refresh timeout
           │     │
           └──┬──┘
              ▼
            ready

    Peer Down ───────────────► stale
    TCP 断开 / collector 崩溃 ► down
    重连并开始新刷新 ─────────► syncing

状态说明：

| 状态 | 含义 |
| --- | --- |
| syncing | 正在接收一轮新的全量 RIB，旧 connection/epoch 路由会按计算显示为 stale。 |
| ready | 当前 epoch 已收到 EOR，或 refresh timeout 已完成兜底清理。 |
| stale | Peer Down 或刷新替换导致该 scope 的路由暂时过期。 |
| down | BMP TCP 连接已关闭或 collector 上次异常退出。 |

### 6.4 自动行为

- Peer Up 为协商出的 AFI/SAFI/RIB 创建或更新 scope，并进入 syncing。
- 同一 peer 再次 Peer Up 时，旧 scope 先变 stale，epoch 加一，再开始新一轮 syncing。
- 有效 EOR 将 scope 设为 ready，并设置 eor_epoch 和 cleanup_pending_epoch。
- Peer Down 只更新 scope 和 epoch，不逐条 UPDATE 路由。
- TCP 断开将该连接拥有的 scope 设为 down。
- 新连接只能在 connection_generation 更新，或旧连接已 closed 且新连接 open 时接管 scope。
- 延迟到达的旧连接、旧 epoch mutation 不能把新状态回滚。
- 当前 sweep 不删除 scope，所以即使路由已清空，拓扑节点仍可保留。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_scopes_source_af(source_id, afi, safi, rib_type) | 按设备、地址族和 RIB 查 scope。 |
| idx_bmp_scopes_state(scope_state, updated_at_ms) | 按状态扫描。 |
| idx_bmp_scopes_stale_since(scope_state, stale_since_ms, scope_id) | stale/down 保留期清理。 |
| idx_bmp_scopes_connection(last_connection_id, scope_id) | 连接关闭和接管。 |
| idx_bmp_scopes_refresh_since(scope_state, refresh_started_ms, scope_id) | refresh timeout 扫描。 |
| idx_bmp_scopes_cleanup_pending(cleanup_pending_epoch, scope_id) | EOR 后旧 epoch 清理。 |

## 7. bmp_route_attributes

### 7.1 用途

保存去重后的 BGP Path Attributes。相同的 ORIGIN、AS_PATH、NEXT_HOP、MED、LOCAL_PREF、Community、OTC、Prefix-SID 等组合只存一次，路由和事件通过 attr_id 引用。

### 7.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| attr_id | TEXT PRIMARY KEY | 规范化 attr_json 的 SHA-256。 |
| attr_json | TEXT NOT NULL | 完整、规范化的 Path Attributes JSON。 |
| first_seen_ms | INTEGER NOT NULL | 该属性组合第一次出现时间。 |
| last_seen_ms | INTEGER NOT NULL | 最近被使用时间；重复 attr_id upsert 时只推进该时间。 |

### 7.3 自动行为

- 写 route 之前先 canonicalize 属性并计算 attr_id。
- 同一属性组合不会重复保存大 JSON。
- 只有同时不被 bmp_current_routes 和 bmp_route_events 引用，且超过事件保留期后，sweep 才会删除。
- 本表使用 WITHOUT ROWID。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_route_attributes_last_seen(last_seen_ms, attr_id) | 找超过保留期的无引用属性。 |

## 8. bmp_route_events

### 8.1 用途

保存发生过什么，是追加式事件流水。它不只是“路由事件表”，连接、source、scope 和 statistics mutation 也会先写一条 event。

bmp_current_routes 表示现在是什么；bmp_route_events 表示过去发生过什么。

### 8.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| event_id | INTEGER PRIMARY KEY AUTOINCREMENT | 全库递增事件 ID，由 sqlite_sequence 维护。 |
| batch_id | TEXT NOT NULL | 所属 ingest batch。与 bmp_ingest_batches 是逻辑关联，没有 FK。 |
| source_id | TEXT NOT NULL，FK | 所属 bmp_sources.source_id。 |
| connection_id | TEXT NOT NULL，FK | 事件来自哪次连接。 |
| source_sequence | INTEGER NOT NULL | 该连接内的 mutation 序号；正常协议事件为递增正数，人工 purge 使用负数 synthetic sequence。 |
| scope_id | TEXT NULL，FK | 所属 scope。source、connection、statistics 等事件可以为空。 |
| route_id | TEXT NULL | 稳定 route ID。不是 FK，因为 current route 可以被 withdraw/purge 删除。 |
| event_type | TEXT NOT NULL | 事件最终分类。 |
| observed_at_ms | INTEGER NOT NULL | collector 观察或处理该事件的时间。 |
| source_timestamp_ms | INTEGER NULL | BMP 消息携带的原始时间戳。 |
| rib_epoch | INTEGER NULL | 事件对应的 RIB epoch。 |
| attr_id | TEXT NULL，FK | 该事件引用的属性组合。 |
| reason | TEXT NULL | stale、close、purge 等原因。 |
| afi | INTEGER NULL | 冗余 AFI，便于不 join current route 直接查历史。 |
| safi | INTEGER NULL | 冗余 SAFI。 |
| prefix | TEXT NULL | 冗余 prefix，复杂 NLRI 或非路由事件可为空。 |
| legacy_route_key | TEXT NULL | 兼容旧 UI/API 的 route key。 |
| route_json | TEXT NULL | 事件时刻的紧凑 route snapshot，属性主体通过 attr_id 关联。 |

唯一约束：

| 约束 | 作用 |
| --- | --- |
| UNIQUE(connection_id, source_sequence) | 保证同一连接内同一个 mutation 重放时不会重复插入。 |

常见 event_type：

| 类别 | event_type |
| --- | --- |
| 连接/source | connection_open、source_update、connection_close |
| scope | scope_open、scope_stale、scope_eor、scope_timeout |
| 路由写入结果 | announce、replace、refresh、upsert-noop |
| 路由删除结果 | withdraw、withdraw-noop、purge |
| 统计 | statistics |

路由 mutation 初始可叫 upsert、delete 或 withdraw，但落库后会根据是否真正改变 current projection 重新分类。

### 8.3 自动行为

- 每个 mutation 都会插入 event；source、connection、scope、attribute 以及 route/statistics 投影在同一事务中完成。current route 要先取得 event_id，才能写入 last_event_id。
- 旧连接或旧 epoch 的延迟 UPDATE 仍可保留 event，但不能覆盖 current route，最终分类为 upsert-noop。
- 旧连接或错误 epoch 的 Withdraw 不删除 current route，最终分类为 withdraw-noop。
- 默认删除 7 天前且未被 bmp_current_routes.last_event_id 引用的 event。
- 自动 sweep 删除路由时不写 purge event；只有页面人工清理 stale 才写 purge event。
- 崩溃恢复直接修正 connection/scope 状态，不补偿写 event。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_route_events_scope_time(scope_id, observed_at_ms DESC, event_id DESC) | 查某 scope 的时间线。 |
| idx_bmp_route_events_route_time(scope_id, route_id, observed_at_ms DESC, event_id DESC) | 查某 scope 内某路由历史。 |
| idx_bmp_route_events_type_time(event_type, observed_at_ms DESC) | 按事件类型查询。 |
| idx_bmp_route_events_observed(observed_at_ms, event_id) | 保留期清理。 |
| idx_bmp_route_events_attr(attr_id) | 属性引用检查。 |
| idx_bmp_route_events_source_time(source_id, observed_at_ms DESC, event_id DESC) | 查某设备事件。 |
| idx_bmp_route_events_route_global_time(route_id, observed_at_ms DESC, event_id DESC) | 跨 scope 查同一 route_id。 |
| idx_bmp_route_events_legacy_time(legacy_route_key, observed_at_ms DESC, event_id DESC) | 兼容旧 route key 查询。 |
| idx_bmp_route_events_af_prefix_time(afi, safi, prefix, observed_at_ms DESC, event_id DESC) | 按地址族和 prefix 查历史。 |
| idx_bmp_route_events_prefix_time(prefix, observed_at_ms DESC, event_id DESC) | 跨地址族按 prefix 查历史。 |

## 9. bmp_current_routes

### 9.1 用途

这是当前 RIB 投影，也是 Session/Loc-RIB 路由列表、详情和路由摘要的权威来源。

一行表示某个 scope 内某个稳定 route 的当前版本：

    业务主键 = scope_id + route_id

route_id 本身不包含 scope，所以相同 NLRI 可以同时存在于多个 peer、多个 RIB stage 或多个 Loc-RIB。

route_id 由 AFI、SAFI、pathId 和 canonical NLRI 生成。普通前缀、VPN、EVPN、FlowSpec、BGP-LS 等 NLRI 使用各自的规范化身份，Path Attributes 不参与 route_id。

### 9.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| scope_id | TEXT NOT NULL，复合 PK，FK | 所属 bmp_rib_scopes.scope_id。 |
| route_id | TEXT NOT NULL，复合 PK | AFI、SAFI、pathId、canonical NLRI 的 SHA-256。 |
| route_key_json | TEXT NOT NULL | 保存 route key 版本、算法和 keyHex。 |
| route_identity_json | TEXT NOT NULL | 完整规范化 route identity。 |
| route_key_version | INTEGER NOT NULL | 稳定 route key schema version，当前为 1。 |
| legacy_route_key | TEXT NULL | 兼容旧页面/API 的 pathId、RD、prefix、mask 组合键。 |
| afi | INTEGER NOT NULL | AFI。 |
| safi | INTEGER NOT NULL | SAFI。 |
| path_id | INTEGER NOT NULL | ADD-PATH Path Identifier，未启用时为 0。 |
| rd | TEXT NULL | VPN/EVPN 等地址族的 RD。 |
| prefix | TEXT NULL | 普通可索引前缀；复杂 NLRI 可以为空。 |
| prefix_length | INTEGER NULL | 前缀长度；复杂 NLRI 可以为空。 |
| nlri_kind | TEXT NULL | canonical NLRI 类型，例如 ip-prefix、vpn-prefix、evpn、raw-nlri、structured-nlri。 |
| nlri_json | TEXT NOT NULL | 完整解析后的 NLRI JSON。 |
| attr_id | TEXT NULL，FK | 去重 Path Attributes 的 ID。Withdraw 构造的 route 信息可为空。 |
| route_json | TEXT NOT NULL | 不重复保存 Path Attributes 的紧凑 route 主体。查询详情时再 join attr_json。 |
| connection_id | TEXT NOT NULL，FK | 当前版本来自哪次连接。 |
| rib_epoch | INTEGER NOT NULL | 当前版本来自哪个 RIB 刷新 epoch。 |
| explicit_state | TEXT NOT NULL DEFAULT active | 显式状态。当前正常 upsert 固定写 active，实际 stale 主要动态计算。 |
| first_seen_ms | INTEGER NOT NULL | 该 scope/route 投影第一次出现时间。更新时保留。 |
| last_seen_ms | INTEGER NOT NULL | 最近 announce、replace 或 refresh 时间。 |
| source_timestamp_ms | INTEGER NULL | 最近一次 BMP source timestamp。 |
| last_event_id | INTEGER NOT NULL，FK | 生成当前版本的最新 bmp_route_events.event_id。 |

### 9.3 自动写入和删除

Announce/Replace/Refresh：

1. 插入 route event。
2. 只有 mutation 的 connection_id 等于 scope.last_connection_id，且 epoch 等于 scope.current_epoch 时，才允许 upsert current route。
3. 同一个 scope_id + route_id 已存在时更新 NLRI、属性、连接、epoch 和 last_event_id。
4. 旧 connection、旧 epoch 或更旧 event_id 不能覆盖新投影。

Withdraw：

1. 插入 event。
2. 只有 connection 和 epoch 都仍是 scope 当前值时，才删除 current route。

人工 Purge：

1. 只选择有效状态为 stale 的 current route。
2. 删除 current route。
3. 写 purge event 和人工 batch。

### 9.4 active/stale 的真实计算

routeState 不是只看 explicit_state。查询时满足任意条件即为 stale：

    route.explicit_state = 'stale'
    或 scope.scope_state IN ('stale', 'down')
    或 route.connection_id != scope.last_connection_id
    或 route.rib_epoch < scope.current_epoch

    否则为 active

这带来几个重要结果：

- Peer Down 或 TCP 断开只需更新一行 scope，即可让该 scope 下所有路由显示 stale。
- 新连接接管后，旧 connection 路由自动 stale。
- 新 epoch 开始后，尚未重新上报的旧 epoch 路由自动 stale。
- ready 只表示当前 scope 刷新结束；旧 connection/epoch 路由在被 sweep 删除前仍可能存在，但仍是 stale。

### 9.5 索引

| 索引 | 用途 |
| --- | --- |
| idx_bmp_current_routes_prefix(afi, safi, prefix, prefix_length) | 地址族和精确前缀查询。 |
| idx_bmp_current_routes_epoch(scope_id, rib_epoch, last_seen_ms) | epoch 清理。 |
| idx_bmp_current_routes_attr(attr_id) | 属性关联。 |
| idx_bmp_current_routes_last_seen(last_seen_ms DESC, scope_id, route_id) | 最近观察排序和扫描。 |
| idx_bmp_current_routes_last_event(last_event_id) | event 引用保护。 |
| idx_bmp_current_routes_route_id(route_id, scope_id) | 跨 scope 查 route_id。 |
| idx_bmp_current_routes_legacy_key(legacy_route_key, scope_id) | 页面详情兼容查询。 |
| idx_bmp_current_routes_prefix_global(prefix, scope_id, route_id) | 跨地址族/跨 scope 的 prefix 查询。 |
| idx_bmp_current_routes_connection(scope_id, connection_id, rib_epoch, last_seen_ms) | 连接接管和 epoch 清理。 |

## 10. bmp_ingest_batches

### 10.1 用途

保存 persistence Writer 的批次幂等记录。Writer 重试同一个 batch_id 时，整批不会再次执行。

### 10.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| batch_id | TEXT PRIMARY KEY | Writer 生成的批次 ID。 |
| created_at_ms | INTEGER NOT NULL | 批次创建时间。 |
| mutation_count | INTEGER NOT NULL | 批次包含的 mutation 数量。 |

### 10.3 自动行为

- 每批先执行 INSERT OR IGNORE。
- batch_id 已存在时，整批直接返回 duplicate。
- 一批中的 source、connection、scope、attribute、event、route 和 statistics 修改在一个 SQLite 事务中提交；任一步失败会整批回滚。
- 默认删除 7 天前的 batch 记录。
- bmp_route_events.batch_id 没有外键，因此 batch 记录可以先于仍需保留的 event 删除。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_ingest_batches_created(created_at_ms) | 按保留期清理。 |

## 11. bmp_statistics_samples

### 11.1 用途

保存 BMP Statistics Report 历史样本，不参与 current RIB 投影。统计页面通过
`bmp_statistics_latest` 读取每个逻辑报告的最新样本，再叠加当前在线内存数据和连接状态，因此断开或重启后仍可恢复统计页面。

### 11.2 字段

| 字段 | 类型和约束 | 作用及自动行为 |
| --- | --- | --- |
| sample_id | INTEGER PRIMARY KEY AUTOINCREMENT | 样本 ID，由 sqlite_sequence 维护。 |
| source_id | TEXT NOT NULL，FK | 所属 bmp_sources.source_id。 |
| connection_id | TEXT NOT NULL，FK | 来自哪次连接。 |
| scope_id | TEXT NULL，FK | 可选 scope。当前 persistStatistics 使用 connection mutation，生产写入通常为空。 |
| report_kind | TEXT NULL | `session` 或 `instance`；无法识别的损坏/旧样本可为空。 |
| report_key | TEXT NULL | Session 使用 type/RD/IP/AS，Instance 使用 type/RD 形成的稳定逻辑键。 |
| observed_at_ms | INTEGER NOT NULL | collector 收到样本的时间。 |
| source_timestamp_ms | INTEGER NULL | BMP 消息携带的 source timestamp。 |
| statistics_json | TEXT NOT NULL | 完整 Statistics Report JSON。 |

### 11.3 自动行为

- statistics mutation 会同时写一条 bmp_route_events 事件和一条 statistics sample。
- 每次写入会同步更新 `bmp_statistics_latest`；时间相同则以较大的 sample_id 为准。
- 默认删除 7 天前的历史样本；仍被 latest 投影引用的最后一个样本会保留，直到同一逻辑报告出现更新样本。
- 不参与 BGP Session、Loc-RIB Instance 或 routeState 计算。

索引：

| 索引 | 用途 |
| --- | --- |
| idx_bmp_statistics_scope_time(scope_id, observed_at_ms DESC) | 查某 scope 的统计历史。 |
| idx_bmp_statistics_observed(observed_at_ms, sample_id) | 按保留期清理。 |
| idx_bmp_statistics_report_time(source_id, report_kind, report_key, observed_at_ms DESC, sample_id DESC) | 按 source 和逻辑报告定位最新样本。 |

### 11.4 bmp_statistics_latest

这是 Statistics Report 的最新值投影，主键是 `(source_id, report_kind, report_key)`：

| 字段 | 类型和约束 | 作用 |
| --- | --- | --- |
| source_id | TEXT NOT NULL，FK | 所属稳定 BMP source。 |
| report_kind | TEXT NOT NULL | `session` 或 `instance`。 |
| report_key | TEXT NOT NULL | 逻辑报告身份。 |
| sample_id | INTEGER NOT NULL，FK | 指向当前最新的 `bmp_statistics_samples.sample_id`。 |
| observed_at_ms | INTEGER NOT NULL | 用于比较新旧样本和结果排序。 |

统计页面只需读取这张小投影并关联 sample，不会扫描 7 天历史。损坏的 statistics JSON 会被忽略，不影响其他报告。

## 12. 自动写入链路

    BMP 报文
       │
       ▼
    BmpSession 解析协议动作
       │
       ▼
    构造 mutation
       │
       ▼
    BmpPersistenceClient 内存队列
       │
       ├─ 达到 2000 个 mutation
       ├─ 达到 2 MiB
       └─ 或等待 20 ms
       ▼
    独立 SQLite Writer Worker
       │
       ▼
    单个 SQLite transaction
       ├─ bmp_ingest_batches：批次幂等
       ├─ bmp_sources：设备 upsert
       ├─ bmp_connections：连接 upsert/close
       ├─ bmp_rib_scopes：scope upsert/state
       ├─ bmp_route_attributes：属性去重
       ├─ bmp_route_events：追加事件
       ├─ bmp_current_routes：更新当前投影
       └─ bmp_statistics_samples：写统计样本

默认批量和背压参数：

| 参数 | 默认值 | 自动行为 |
| --- | --- | --- |
| batchSize | 2000 mutations | 达到后立即 flush。 |
| batchBytes | 2 MiB | 达到后立即 flush。 |
| flushMs | 20 ms | 未达到阈值时的最大等待时间。 |
| highWatermark | 64 MiB | 队列达到后暂停 BMP socket。 |
| lowWatermark | 32 MiB | 队列下降后恢复 BMP socket。 |
| batchRetryLimit | 3 | 单批失败的最大重试次数。 |
| batchRetryDelay | 25 ms 起 | 指数退避重试。 |

读取页面数据前，Worker 会执行 writer fence，等待查询调用之前已进入队列的 mutation 全部提交，再从独立只读连接查询。只读连接失败时自动退回 Writer 查询；Writer 失败则停止 BMP 摄入。

## 13. 协议动作与表变化

| 协议或系统动作 | 自动修改 |
| --- | --- |
| BMP Initiation | 生成稳定 source_id；upsert bmp_sources；插入 open connection；写 connection_open 和 source_update event。 |
| Peer Up | 创建或更新 scope；开始新 epoch；scope 进入 syncing；记录 refresh_started_ms。 |
| Route Announce | 写 attribute；写 event；upsert current route。 |
| 相同属性重复上报 | event 分类为 refresh；刷新 last_seen_ms。 |
| 属性发生变化 | event 分类为 replace；current route 指向新 attr_id。 |
| Withdraw | 写 event；若 connection/epoch 有效则删除 current route，否则为 withdraw-noop。 |
| EOR | scope 进入 ready；写 eor_epoch；设置 cleanup_pending_epoch；触发快速 sweep。 |
| Peer Down | scope 进入 stale、epoch 前进；current route 保留但动态显示 stale。 |
| TCP 断开/Termination | connection 进入 closed；关联 scope 进入 down；current route 保留并显示 stale。 |
| 人工清理 stale | 删除 current route；写 purge event 和人工 batch。 |
| 正常停止 BMP | 关闭连接、drain 队列、运行 sweep、PASSIVE checkpoint、关闭 reader/writer。 |
| Collector 崩溃后重启 | 遗留 open connection 改 closed；scope 改 down/collector-restart；不补偿写 event。 |

## 14. EOR、epoch 和旧路由清理

epoch 用于区分同一 scope 的多轮全量刷新。

    旧 epoch = 1，已有 100 条路由
              │
              │ Peer Up / 新刷新
              ▼
    current_epoch = 2，scope = syncing
              │
              ├─ 新一轮已重新上报的路由写 rib_epoch = 2，显示 active
              └─ 仍为 rib_epoch = 1 的旧路由显示 stale
              │
              │ EOR
              ▼
    scope = ready，eor_epoch = 2，cleanup_pending_epoch = 2
              │
              │ sweep
              ▼
    删除 rib_epoch < 2 或旧 connection 的 current routes

如果没有收到 EOR：

- scope 默认允许 syncing 10 分钟。
- 超时后 sweep 分批删除旧 connection/epoch 路由。
- 本轮已经重新上报的当前 epoch 路由保留。
- 旧路由清理完后 scope 进入 ready，stale_reason 为 refresh-timeout。
- 当前生产路径由 sweep 直接完成，不一定生成 scope_timeout event。

## 15. 定时 sweep 和保留期

默认每 30 秒运行一次 sweep；EOR 等事件还会在约 250 ms 后请求快速 sweep。

| 数据 | 默认保留或阈值 | 清理行为 |
| --- | --- | --- |
| stale/down current routes | 24 小时 | 删除达到保留期的路由。 |
| 旧 epoch/旧 connection routes | EOR 或 refresh timeout 后 | 分批删除。 |
| route events | 7 天 | 未被 current_routes.last_event_id 引用时删除。 |
| statistics samples | 7 天 | 按 observed_at_ms 删除，但保留 latest 投影仍引用的最后一个样本。 |
| ingest batches | 7 天 | 按 created_at_ms 删除。 |
| 无引用 route attributes | 7 天 | current routes 和 events 都不引用时删除。 |
| syncing refresh timeout | 10 分钟 | 清理旧路由并将 scope 置 ready。 |
| 最大逻辑数据库大小 | 20 GiB | 超限时临时将 stale/history 截止时间缩短到当前时间。 |

sweep 的执行顺序：

1. 删除可安全清理的 current routes。
2. 清除已完成的 cleanup_pending_epoch。
3. 完成 refresh timeout scope。
4. 删除不再被 current route 引用的旧 events。
5. 删除旧 statistics samples。
6. 删除旧 ingest batches。
7. 删除完全无引用的旧 attributes。

sweep 不会：

- 删除 source。
- 删除 connection 历史。
- 删除 scope。
- 给自动 aging 删除的路由写 purge event。
- 执行 VACUUM。

所以删除后 SQLite 文件物理大小可能不会立刻缩小，空闲页进入 freelist，后续写入会复用。getStatus 返回 reclaimableBytes 和 logicalSize，用于判断可复用空间和存储压力。

## 16. 正常停止与崩溃恢复

### 16.1 正常停止

停止 BMP 时自动执行：

1. 停止接收新数据并暂停 socket。
2. 关闭每个 BMP Session，写 connection_close。
3. 将关联 scope 设为 down。
4. drain 全部 mutation 队列。
5. 运行一次 sweep。
6. 执行 PASSIVE WAL checkpoint。
7. 关闭只读和写入 Worker。

### 16.2 异常退出

WAL 能保证已经提交的 SQLite transaction 在下次打开时恢复；尚在 JavaScript 内存队列、尚未提交的 mutation 在硬崩溃时可能丢失。

下次 Writer 打开数据库时会在一个事务内：

1. 找出 connection_state = open 的连接。
2. 将它们改为 closed。
3. closed_at_ms 为空时写入恢复时间。
4. close_reason 为空时写 collector-restart。
5. 将这些连接拥有的 scope 改为 down。
6. stale_reason 写 collector-restart。
7. 清除 refresh_started_ms 和 cleanup_pending_epoch。

这次恢复直接修正 connection/scope，不额外生成补偿 event。

## 17. 页面如何从数据库恢复

BMP 启动后，queryTopology 在一个读取事务内：

1. 读取每个 source generation 最新的 connection。
2. 读取所有 scope。
3. 联合 current routes 计算每个 scope 的 active/stale/total。
4. Peer scope 按 source_id + owner_key 聚合成 BGP Session。
5. Loc-RIB scope重建成 Instance。
6. Worker 再叠加真正存在的在线 BmpSession。

所以：

- 没有设备重连时，页面仍可显示已持久化的客户端、Session、Instance 和 stale 路由。
- 设备重连后，按 source_id、owner_key、scope_id 合并，不生成重复页面节点。
- 收到当前 epoch 的 UPDATE 和 EOR 后，路由恢复 active。
- 从未创建过任何 scope 的零路由 peer，无法仅依靠当前 schema 完整重建。
- 完整 Peer flags、router-id、TLV 等协议元数据没有全部进入 scope 表，离线页只能恢复数据库实际保存的字段。
- Statistics 页面可从 latest 投影恢复离线样本，并用当前 topology 覆盖“已连接/已断开”状态；在线内存报告仍优先于同键数据库样本。

## 18. 迁移规则

打开可写数据库时自动执行迁移：

1. user_version 大于 8：拒绝打开，避免新版本数据库被旧代码破坏。
2. user_version 等于 8：直接校验关键表和字段。
3. user_version 小于 8：在单个 transaction 内补齐当前 schema。
4. 完成后设置 PRAGMA user_version = 8。

当前迁移会自动：

- 补 bmp_connections.connection_generation。
- 补 bmp_rib_scopes.refresh_started_ms 和 cleanup_pending_epoch。
- 补 bmp_route_events.afi、safi、prefix、legacy_route_key。
- 补 bmp_current_routes.connection_id。
- 补 bmp_statistics_samples.report_kind 和 report_key。
- 创建 bmp_statistics_latest，并安全解析旧 statistics JSON 重建最新投影。
- 从 last_event_id 对应 event 回填 route connection_id。
- 从 scope 回填 event 的 AFI/SAFI。
- 从 route_json 回填 event 的 prefix/legacy key。
- 给旧 connection 按 opened_at_ms 和 connection_id 回填 generation。
- 创建缺失索引。

如果 current route 的 connection_id 无法从 last_event_id 恢复，迁移会失败，不会继续使用不可信投影。

只读连接要求 schema 已经精确等于 version 8。如果只读打开发现旧版本，主进程会暂时打开可写 migrator，迁移后重新创建只读连接。

## 19. 运维查询示例

建议在停止 BMP 后执行人工检查。运行中直接复制数据库时，应同时处理 WAL/SHM，或使用 SQLite 在线备份能力。

查看 schema 版本和表：

    PRAGMA user_version;
    PRAGMA foreign_keys;
    SELECT name, type
      FROM sqlite_master
     WHERE type IN ('table', 'index')
     ORDER BY type, name;

查看各业务表数量：

    SELECT 'sources' AS item, COUNT(*) AS count FROM bmp_sources
    UNION ALL
    SELECT 'connections', COUNT(*) FROM bmp_connections
    UNION ALL
    SELECT 'scopes', COUNT(*) FROM bmp_rib_scopes
    UNION ALL
    SELECT 'current_routes', COUNT(*) FROM bmp_current_routes
    UNION ALL
    SELECT 'route_events', COUNT(*) FROM bmp_route_events
    UNION ALL
    SELECT 'route_attributes', COUNT(*) FROM bmp_route_attributes
    UNION ALL
    SELECT 'statistics_samples', COUNT(*) FROM bmp_statistics_samples
    UNION ALL
    SELECT 'statistics_latest', COUNT(*) FROM bmp_statistics_latest
    UNION ALL
    SELECT 'ingest_batches', COUNT(*) FROM bmp_ingest_batches;

查看仍标记 open 的连接：

    SELECT connection_id, source_id, remote_ip, remote_port, opened_at_ms
      FROM bmp_connections
     WHERE connection_state = 'open'
     ORDER BY connection_generation DESC;

查看 scope 状态和 epoch：

    SELECT source_id, scope_kind, owner_key, afi, safi, rib_type,
           current_epoch, eor_epoch, scope_state, stale_reason,
           last_connection_id
      FROM bmp_rib_scopes
     ORDER BY source_id, owner_key, afi, safi, rib_type;

查看按数据库实际规则计算的 active/stale 数量：

    SELECT
        CASE
            WHEN r.explicit_state = 'stale'
              OR s.scope_state IN ('stale', 'down')
              OR r.connection_id <> s.last_connection_id
              OR r.rib_epoch < s.current_epoch
            THEN 'stale'
            ELSE 'active'
        END AS route_state,
        COUNT(*) AS route_count
      FROM bmp_current_routes r
      JOIN bmp_rib_scopes s ON s.scope_id = r.scope_id
     GROUP BY route_state;

查看最近事件：

    SELECT event_id, observed_at_ms, source_id, connection_id,
           scope_id, route_id, event_type, reason
      FROM bmp_route_events
     ORDER BY event_id DESC
     LIMIT 100;

## 20. SQL 调试日志

在“设置 → 通用设置”中把日志级别切换为 `debug` 并保存后，BMP SQLite 的 writer、只读 reader 和离线 reader 会开始输出 SQL 跟踪；运行中切回 `info`、`warn`、`error` 或 `off` 会立即停止 SQL 跟踪，不需要重启 BMP。

SQL 跟踪遵循以下规则：

- 记录原始 SQL 模板、调用类型、执行耗时以及行数或变更数等结果摘要。
- 绑定参数不会展开；Prefix、路由属性、Statistics JSON 和其他业务值不会出现在 SQL 日志中。
- 多行 SQL 会压缩为空白分隔的单行，超长模板会截断，避免单条日志无限增长。
- 跟踪由应用在 SQLite 调用层动态控制，没有常驻启用 `better-sqlite3 verbose`，因此非 `debug` 模式不会承担参数展开开销。
- BMP 路由写入频率高，`debug` 会产生大量 SQL 日志，只建议在定位数据库查询或写入问题时临时启用。

日志中的 SQL 使用占位符是预期行为。例如：

    [BMP SQLite] run 0.120ms changes=1 sql=INSERT INTO bmp_current_routes (...) VALUES (?, ?, ...)

## 21. 运维注意事项

- 所有以 _ms 结尾的时间字段都是 Unix epoch 毫秒，不是 SQLite datetime 文本。
- 所有以 _json 结尾的列都是 TEXT，应用负责 JSON 编解码。
- 不要只备份 bmp.sqlite3 而忽略正在使用的 bmp.sqlite3-wal。
- 最稳妥的离线备份方式是先停止 BMP，使写队列 drain 并 checkpoint，再复制数据库文件。
- 不要手工修改 source_id、scope_id、route_id、attr_id，它们是内容寻址或规范化身份哈希。
- 不要把 connection_id 当设备 ID；设备稳定身份是 source_id。
- 不要把 route_id 单独当全局业务主键；完整主键是 scope_id + route_id。
- 不要直接根据 explicit_state 判断 routeState，应使用 scope、connection、epoch 联合规则。
- 不要直接删除仍被引用的 event、attribute、connection、scope 或 source。
- 自动 retention 不会删除 active current routes。
- 数据库达到容量阈值时会优先缩短 stale 和 history 的保留，不会删除 active 路由。
