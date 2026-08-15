<template>
    <nn-modal
        :open="open"
        :title="modalTitle"
        :footer="null"
        class="modal-xlarge bmp-loc-rib-instance-detail-modal"
        data-testid="bmp-loc-rib-instance-detail-modal"
        @update:open="handleOpenChange"
        @cancel="close"
    >
        <nn-empty v-if="!instance" description="暂无 Loc-RIB Instance 详情" />
        <nn-tabs v-else v-model:active-key="activeTabKey" size="small" class="instance-detail-tabs">
            <nn-tab-pane key="overview" tab="实例概览">
                <div class="instance-detail-panel" data-testid="bmp-loc-rib-instance-detail-overview">
                    <div class="summary-grid">
                        <div class="summary-card">
                            <span class="summary-label">BMP 连接</span>
                            <nn-tag :color="isOnline ? 'green' : 'orange'">
                                {{ isOnline ? '在线' : '已断开' }}
                            </nn-tag>
                        </div>
                        <div class="summary-card">
                            <span class="summary-label">Instance 状态</span>
                            <nn-tag :color="instanceStateMeta.color">{{ instanceStateMeta.label }}</nn-tag>
                        </div>
                        <div class="summary-card">
                            <span class="summary-label">地址族</span>
                            <strong class="summary-family">{{ currentAddressFamilyName }}</strong>
                        </div>
                        <div class="summary-card summary-card-number">
                            <span class="summary-label">当前 RIB 条目</span>
                            <strong>{{ formatCount(displaySummary.active) }}</strong>
                        </div>
                        <div class="summary-card summary-card-number">
                            <span class="summary-label">过期 RIB 条目</span>
                            <strong class="summary-stale">{{ formatCount(displaySummary.stale) }}</strong>
                        </div>
                        <div class="summary-card summary-card-number">
                            <span class="summary-label">RIB 记录总数</span>
                            <strong>{{ formatCount(displaySummary.total) }}</strong>
                        </div>
                    </div>

                    <section class="detail-section">
                        <div class="section-title">Instance 身份</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="Instance 类型">
                                {{ instanceTypeText }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="VRF / Table">
                                {{ vrfTableText }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Instance 地址">
                                {{ formatValue(instance.instanceIp) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="AS">
                                {{ formatValue(instance.instanceAs) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Router ID">
                                {{ formatValue(instance.instanceRouterId) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="RD">
                                {{ formatValue(instance.instanceRd) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="生效 Flags">
                                {{ getBmpLocRibFlagsName(instance.instanceFlags) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="上报时间">
                                {{ formatTimestamp(instance.instanceTimestampMs) }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>

                    <section class="detail-section" data-testid="bmp-loc-rib-instance-detail-connection">
                        <div class="section-title">来源 BGP 邻接</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="本端">
                                {{ formatEndpoint(instance.localIp, instance.localPort) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Peer">
                                {{ formatEndpoint(instance.instanceIp, instance.remotePort) }}
                            </nn-descriptions-item>
                        </nn-descriptions>

                        <div class="section-title section-title-spaced">BMP Collector 连接</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="Collector 本端">
                                {{ formatEndpoint(connection.localIp, connection.localPort) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="BMP Router">
                                {{ formatEndpoint(connection.remoteIp, connection.remotePort) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="连接状态">
                                <nn-tag :color="isOnline ? 'green' : 'orange'">
                                    {{ connectionStateText }}
                                </nn-tag>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="建立时间">
                                {{ formatTimestamp(connection.openedAtMs) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item v-if="connection.closedAtMs" label="关闭时间">
                                {{ formatTimestamp(connection.closedAtMs) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item v-if="connection.closeReason" label="关闭原因">
                                {{ connection.closeReason }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="rib" :tab="`RIB 状态 (${routeScopes.length})`">
                <div class="instance-detail-panel" data-testid="bmp-loc-rib-instance-detail-rib-state">
                    <nn-alert
                        class="scope-explanation"
                        type="info"
                        show-icon
                        message="每个 Loc-RIB Instance 通常对应一个地址族 Scope"
                        description="这里展示该 Scope 的同步生命周期和条目统计；等待 EOR 不等于 BMP 连接异常。"
                    />
                    <nn-table
                        :columns="scopeColumns"
                        :data-source="routeScopes"
                        :pagination="false"
                        :scroll="{ x: 1120 }"
                        row-key="key"
                        size="small"
                        class="scope-table"
                        data-testid="bmp-loc-rib-instance-detail-scope-table"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'addressFamily'">
                                <div class="family-cell">
                                    <strong>{{ record.addressFamilyName }}</strong>
                                    <span>AFI {{ formatValue(record.afi) }} / SAFI {{ formatValue(record.safi) }}</span>
                                </div>
                            </template>
                            <template v-else-if="column.key === 'scopeState'">
                                <nn-tag :color="getScopeStateMeta(record).color">
                                    {{ getScopeStateMeta(record).label }}
                                </nn-tag>
                            </template>
                            <template v-else-if="['active', 'stale', 'total'].includes(column.key)">
                                <span :class="{ 'summary-stale': column.key === 'stale' && record.summary.stale > 0 }">
                                    {{ formatCount(record.summary[column.key]) }}
                                </span>
                            </template>
                            <template v-else-if="column.key === 'epoch'">
                                <div class="epoch-cell">
                                    <span>当前 {{ formatValue(record.currentEpoch) }}</span>
                                    <span>EOR {{ formatValue(record.eorEpoch) }}</span>
                                </div>
                            </template>
                            <template v-else-if="column.key === 'refreshStartedMs'">
                                {{ formatTimestamp(record.refreshStartedMs) }}
                            </template>
                            <template v-else-if="column.key === 'staleReason'">
                                <div class="stale-cell">
                                    <span>{{ formatValue(record.staleReason) }}</span>
                                    <span v-if="record.staleSinceMs" class="secondary-text">
                                        {{ formatTimestamp(record.staleSinceMs) }}
                                    </span>
                                </div>
                            </template>
                        </template>
                    </nn-table>

                    <section class="detail-section">
                        <div class="section-title">生命周期补充</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="顶层 RIB Epoch">
                                {{ formatValue(instance.ribEpoch) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="待清理 Epoch">
                                {{ formatValue(primaryScope.cleanupPendingEpoch) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Scope ID" :span="2">
                                <span class="diagnostic-value">
                                    {{ formatValue(primaryScope.persistentScopeId || primaryScope.scopeId) }}
                                </span>
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="capabilities" tab="能力协商">
                <div class="instance-detail-panel" data-testid="bmp-loc-rib-instance-detail-capabilities">
                    <nn-table
                        :columns="capabilityColumns"
                        :data-source="capabilityRows"
                        :pagination="false"
                        :scroll="{ x: 980 }"
                        row-key="key"
                        size="small"
                        class="capability-table"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'addressFamily'">
                                <div class="family-cell">
                                    <strong>{{ record.name }}</strong>
                                    <span>AFI {{ record.afi }} / SAFI {{ record.safi }}</span>
                                </div>
                            </template>
                            <template v-else-if="['received', 'sent', 'enabled'].includes(column.key)">
                                <nn-tag
                                    v-if="record[column.key] !== null"
                                    :color="record[column.key] ? 'green' : 'default'"
                                >
                                    {{ record[column.key] ? '是' : '否' }}
                                </nn-tag>
                                <span v-else class="secondary-text">未记录</span>
                            </template>
                            <template v-else-if="column.key === 'remoteAddPath'">
                                {{ formatAddPathMode(record.remoteAddPath) }}
                            </template>
                            <template v-else-if="column.key === 'localAddPath'">
                                {{ formatAddPathMode(record.localAddPath) }}
                            </template>
                            <template v-else-if="column.key === 'effectiveAddPath'">
                                <div class="add-path-state">
                                    <nn-tag :color="getCapabilityColor(record.routerReceiveAddPath)">
                                        接收 {{ formatCapabilityState(record.routerReceiveAddPath) }}
                                    </nn-tag>
                                    <nn-tag :color="getCapabilityColor(record.routerSendAddPath)">
                                        发送 {{ formatCapabilityState(record.routerSendAddPath) }}
                                    </nn-tag>
                                </div>
                            </template>
                        </template>
                    </nn-table>

                    <section class="detail-section">
                        <div class="section-title">附加能力</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="当前 Loc-RIB 地址族">
                                {{ currentAddressFamilyName }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="总体 ADD-PATH">
                                {{ formatBooleanCapability(instance.isAddPath) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Peer Up TLV">
                                {{ Array.isArray(instance.peerUpTlvs) ? instance.peerUpTlvs.length : 0 }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="RIB Types">
                                {{ ribTypesText }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="VRF / Table" :span="2">
                                {{ vrfTableText }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="advanced" tab="高级诊断">
                <div class="instance-detail-panel" data-testid="bmp-loc-rib-instance-detail-advanced">
                    <nn-alert
                        class="advanced-alert"
                        type="info"
                        show-icon
                        message="以下信息主要用于持久化定位、重连恢复和问题排查"
                        description="普通查看无需关注哈希 ID、原始 RD、Epoch 或完整 JSON。"
                    />
                    <nn-descriptions :column="1" bordered size="small" class="identity-details">
                        <nn-descriptions-item label="Source ID">
                            <span class="diagnostic-value">
                                {{ formatValue(instance.persistentSourceId || instance.sourceId) }}
                            </span>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Owner Key">
                            <span class="diagnostic-value">
                                {{ formatValue(instance.persistentOwnerKey || instance.ownerKey) }}
                            </span>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Scope ID">
                            <span class="diagnostic-value">
                                {{ formatValue(instance.persistentScopeId || instance.scopeId) }}
                            </span>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Connection ID">
                            <span class="diagnostic-value">
                                {{ formatValue(instance.persistentConnectionId || instance.connectionId) }}
                            </span>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="原始 RD">
                            {{ formatValue(instance.instanceRdRaw) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="原始 Instance Flags">
                            {{ formatRawFlags(instance.rawInstanceFlags) }}
                        </nn-descriptions-item>
                    </nn-descriptions>
                    <div v-if="activeTabKey === 'advanced'" class="raw-json-section">
                        <div class="section-title">完整原始 JSON</div>
                        <nn-json-viewer
                            :value="instance"
                            :max-height="520"
                            wrap
                            data-testid="bmp-loc-rib-instance-detail-raw-json"
                        />
                    </div>
                </div>
            </nn-tab-pane>
        </nn-tabs>
    </nn-modal>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../const/bgpConst';
    import {
        BMP_SESSION_STATE,
        BMP_SESSION_STATE_NAME,
        BMP_SESSION_TYPE_NAME,
        getBmpLocRibFlagsName
    } from '../const/bmpConst';

    const props = defineProps({
        open: { type: Boolean, default: false },
        instance: { type: Object, default: null },
        client: { type: Object, default: null },
        routeSummary: { type: Object, default: null }
    });
    const emit = defineEmits(['update:open']);

    const activeTabKey = ref('overview');
    const ADD_PATH_MODE_NAMES = {
        1: '仅接收',
        2: '仅发送',
        3: '收发'
    };
    const scopeColumns = [
        { title: '地址族', key: 'addressFamily', width: 180, fixed: 'left' },
        { title: '同步状态', key: 'scopeState', width: 105, align: 'center' },
        { title: '当前', key: 'active', width: 85, align: 'right' },
        { title: '过期', key: 'stale', width: 85, align: 'right' },
        { title: '总计', key: 'total', width: 85, align: 'right' },
        { title: 'Epoch / EOR', key: 'epoch', width: 120 },
        { title: '刷新开始', key: 'refreshStartedMs', width: 170 },
        { title: '过期原因 / 时间', key: 'staleReason', width: 220 }
    ];
    const capabilityColumns = [
        { title: '地址族', key: 'addressFamily', width: 180, fixed: 'left' },
        { title: '远端 OPEN', key: 'received', width: 100, align: 'center' },
        { title: '本端 OPEN', key: 'sent', width: 100, align: 'center' },
        { title: '共同启用', key: 'enabled', width: 100, align: 'center' },
        { title: '远端 ADD-PATH 声明', key: 'remoteAddPath', width: 150 },
        { title: '本端 ADD-PATH 声明', key: 'localAddPath', width: 150 },
        { title: '路由器实际 ADD-PATH', key: 'effectiveAddPath', width: 200 }
    ];

    const formatValue = value => (value === null || value === undefined || value === '' ? '-' : value);
    const formatCount = value => {
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
    };
    const formatTimestamp = value => {
        const timestamp = Number(value);
        return Number.isFinite(timestamp) && timestamp > 0
            ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
            : '-';
    };
    const formatEndpoint = (address, port) => {
        const normalizedAddress = address === null || address === undefined || address === '' ? '' : String(address);
        if (!normalizedAddress) return '-';
        if (port === null || port === undefined || port === '') return normalizedAddress;
        return normalizedAddress.includes(':') ? `[${normalizedAddress}]:${port}` : `${normalizedAddress}:${port}`;
    };
    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };
    const normalizeSummary = summary => {
        const active = Math.max(0, Number(summary?.active) || 0);
        const stale = Math.max(0, Number(summary?.stale) || 0);
        const hasTotal = summary?.total !== null && summary?.total !== undefined && summary?.total !== '';
        const totalValue = hasTotal ? Number(summary.total) : NaN;
        return {
            active,
            stale,
            total: Number.isFinite(totalValue) ? Math.max(0, totalValue) : active + stale
        };
    };
    const hasAddressFamily = (families, afi, safi) =>
        Array.isArray(families) &&
        families.some(item => Number(item?.afi) === Number(afi) && Number(item?.safi) === Number(safi));
    const addressFamilyName = (addrFamilyType, afi, safi) => {
        const name = ADDRESS_FAMILY_NAME[addrFamilyType];
        return name ? name.replace('UNC', 'Unicast') : `AFI ${formatValue(afi)} / SAFI ${formatValue(safi)}`;
    };
    const hasOwn = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);
    const readBooleanCapability = (map, rawKey, familyKey) => {
        if (hasOwn(map, rawKey)) return map[rawKey] === true;
        if (hasOwn(map, familyKey)) return map[familyKey] === true;
        return null;
    };
    const formatAddPathMode = mode => {
        if (mode === null || mode === undefined || mode === '') return '未记录';
        return ADD_PATH_MODE_NAMES[Number(mode)] || `模式 ${mode}`;
    };
    const formatCapabilityState = value => (value === null ? '未记录' : value ? '开' : '关');
    const formatBooleanCapability = value => (typeof value === 'boolean' ? (value ? '已启用' : '未启用') : '未记录');
    const getCapabilityColor = value => (value === null ? 'default' : value ? 'green' : 'default');

    const connection = computed(() => {
        if (props.instance?.connection && typeof props.instance.connection === 'object') {
            return props.instance.connection;
        }
        if (props.client?.connection && typeof props.client.connection === 'object') {
            return props.client.connection;
        }
        return props.client || {};
    });
    const isOnline = computed(() => {
        if (typeof props.instance?.isOnline === 'boolean') return props.instance.isOnline;
        if (typeof props.client?.isOnline === 'boolean') return props.client.isOnline;
        const state = String(
            props.instance?.connectionState || props.client?.connectionState || connection.value.state || ''
        ).toLowerCase();
        return ['online', 'connected', 'open', 'up'].includes(state);
    });
    const connectionStateText = computed(() => (isOnline.value ? '在线' : '已断开'));
    const instanceStateMeta = computed(() => {
        const state = props.instance?.instanceState;
        const label = BMP_SESSION_STATE_NAME[state] || formatValue(state);
        if (state !== null && state !== undefined && Number(state) === BMP_SESSION_STATE.PEER_UP) {
            return { label, color: 'green' };
        }
        if (state !== null && state !== undefined && Number(state) === BMP_SESSION_STATE.PEER_DOWN) {
            return { label, color: 'red' };
        }
        return { label, color: 'default' };
    });
    const instanceTypeText = computed(
        () => BMP_SESSION_TYPE_NAME[props.instance?.instanceType] || formatValue(props.instance?.instanceType)
    );
    const vrfTableNames = computed(() =>
        Array.isArray(props.instance?.vrfTableNames) ? props.instance.vrfTableNames.filter(Boolean) : []
    );
    const vrfTableText = computed(() => {
        if (vrfTableNames.value.length > 0) return vrfTableNames.value.join(', ');
        if (props.instance?.instanceRd === '0:0') return 'Global';
        return formatValue(props.instance?.instanceRd);
    });

    const rawRouteScopes = computed(() => {
        const scopes = Array.isArray(props.instance?.routeScopes) ? props.instance.routeScopes : [];
        if (scopes.length > 0) return scopes;
        if (!props.instance) return [];
        return [
            {
                persistentScopeId: props.instance.persistentScopeId || props.instance.scopeId,
                scopeId: props.instance.scopeId || props.instance.persistentScopeId,
                afi: props.instance.afi,
                safi: props.instance.safi,
                addrFamilyType: props.instance.addrFamilyType,
                ribType: 'loc-rib',
                currentEpoch: props.instance.ribEpoch,
                eorEpoch: null,
                scopeState: props.instance.scopeState,
                staleReason: props.instance.staleReason,
                staleSinceMs: props.instance.staleSinceMs,
                refreshStartedMs: props.instance.refreshStartedMs,
                cleanupPendingEpoch: props.instance.cleanupPendingEpoch,
                routeSummary: props.instance.routeSummary
            }
        ];
    });
    const routeScopes = computed(() =>
        rawRouteScopes.value.map((scope, index) => {
            const afi = Number(scope?.afi);
            const safi = Number(scope?.safi);
            const normalizedAfi = Number.isFinite(afi) ? afi : null;
            const normalizedSafi = Number.isFinite(safi) ? safi : null;
            const addrFamilyType =
                scope?.addrFamilyType ??
                (normalizedAfi !== null && normalizedSafi !== null
                    ? getAddrFamilyType(normalizedAfi, normalizedSafi)
                    : props.instance?.addrFamilyType);
            return {
                ...scope,
                key: scope?.persistentScopeId || scope?.scopeId || `${addrFamilyType || 'unknown'}-${index}`,
                afi: normalizedAfi,
                safi: normalizedSafi,
                addrFamilyType,
                addressFamilyName: addressFamilyName(addrFamilyType, normalizedAfi, normalizedSafi),
                summary: normalizeSummary(scope?.routeSummary || props.instance?.routeSummary)
            };
        })
    );
    const primaryScope = computed(() => routeScopes.value[0] || {});
    const currentAddrFamilyType = computed(
        () => primaryScope.value.addrFamilyType ?? props.instance?.addrFamilyType ?? null
    );
    const currentAddressFamilyName = computed(() =>
        addressFamilyName(currentAddrFamilyType.value, primaryScope.value.afi, primaryScope.value.safi)
    );
    const displaySummary = computed(() =>
        normalizeSummary(props.routeSummary || props.instance?.routeSummary || primaryScope.value.routeSummary)
    );
    const modalTitle = computed(() => `Loc-RIB 详情 · ${vrfTableText.value} · ${currentAddressFamilyName.value}`);
    const ribTypesText = computed(() => {
        const types = Array.isArray(props.instance?.ribTypes) ? props.instance.ribTypes : [];
        return types.length > 0 ? types.join(', ') : 'loc-rib';
    });

    const buildFamilyMap = () => {
        const families = new Map();
        const ensureFamily = (afiValue, safiValue, addrFamilyType = null) => {
            const afi = Number(afiValue);
            const safi = Number(safiValue);
            if (!Number.isFinite(afi) || !Number.isFinite(safi)) return;
            const key = `${afi}|${safi}`;
            if (families.has(key)) return;
            const resolvedType = addrFamilyType ?? getAddrFamilyType(afi, safi);
            families.set(key, {
                key,
                afi,
                safi,
                addrFamilyType: resolvedType,
                name: addressFamilyName(resolvedType, afi, safi)
            });
        };

        [
            ...(props.instance?.recvAddressFamilies || []),
            ...(props.instance?.sendAddressFamilies || []),
            ...(props.instance?.enabledAddressFamilies || [])
        ].forEach(item => ensureFamily(item?.afi, item?.safi));
        routeScopes.value.forEach(scope => ensureFamily(scope.afi, scope.safi, scope.addrFamilyType));
        return families;
    };
    const capabilityRows = computed(() => {
        const recvRecorded = Array.isArray(props.instance?.recvAddressFamilies);
        const sendRecorded = Array.isArray(props.instance?.sendAddressFamilies);
        const enabledRecorded = Array.isArray(props.instance?.enabledAddressFamilies);
        return Array.from(buildFamilyMap().values()).map(family => {
            const rawKey = `${family.afi}|${family.safi}`;
            const familyKey = String(family.addrFamilyType);
            return {
                ...family,
                received: recvRecorded
                    ? hasAddressFamily(props.instance.recvAddressFamilies, family.afi, family.safi)
                    : null,
                sent: sendRecorded
                    ? hasAddressFamily(props.instance.sendAddressFamilies, family.afi, family.safi)
                    : null,
                enabled: enabledRecorded
                    ? hasAddressFamily(props.instance.enabledAddressFamilies, family.afi, family.safi)
                    : null,
                remoteAddPath: props.instance?.recvAddPathMap?.[rawKey],
                localAddPath: props.instance?.sendAddPathMap?.[rawKey],
                routerReceiveAddPath: readBooleanCapability(props.instance?.addPathReceiveMap, rawKey, familyKey),
                routerSendAddPath: readBooleanCapability(props.instance?.addPathSendMap, rawKey, familyKey)
            };
        });
    });

    const getScopeStateMeta = scope => {
        const state = String(scope?.scopeState || '').toLowerCase();
        if (state === 'ready') return { label: '已就绪', color: 'green' };
        if (state === 'syncing') return { label: '等待 EOR', color: 'blue' };
        if (state === 'stale') return { label: '数据过期', color: 'orange' };
        if (state === 'down') return { label: '已离线', color: 'red' };
        return { label: scope?.scopeState || '未知', color: 'default' };
    };

    const close = () => emit('update:open', false);
    const handleOpenChange = value => emit('update:open', value);

    watch(
        () => props.open,
        value => {
            if (value) activeTabKey.value = 'overview';
        }
    );
</script>

<style scoped>
    :global(.bmp-loc-rib-instance-detail-modal .nn-modal-body) {
        height: min(620px, calc(92vh - 82px)) !important;
        min-height: min(620px, calc(92vh - 82px)) !important;
        max-height: min(620px, calc(92vh - 82px)) !important;
        overflow: hidden !important;
    }

    .instance-detail-tabs {
        height: 100%;
        min-height: 0;
    }

    .instance-detail-tabs :deep(.nn-tabs-nav) {
        margin-bottom: 10px;
    }

    .instance-detail-tabs :deep(.nn-tabs-content-holder) {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
    }

    .instance-detail-tabs :deep(.nn-tabs-content),
    .instance-detail-tabs :deep(.nn-tabs-tabpane) {
        height: 100%;
        min-height: 0;
    }

    .instance-detail-panel {
        box-sizing: border-box;
        height: 100%;
        min-width: 0;
        overflow: auto;
        padding-right: 2px;
    }

    .summary-grid {
        display: grid;
        grid-template-columns: repeat(6, minmax(120px, 1fr));
        gap: 8px;
    }

    .summary-card {
        min-width: 0;
        min-height: 64px;
        padding: 10px 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        flex-direction: column;
    }

    .summary-card-number strong {
        color: var(--nn-color-text-strong);
        font-size: 20px;
        line-height: 24px;
    }

    .summary-family {
        max-width: 100%;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .summary-label {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .summary-stale {
        color: var(--nn-color-warning);
    }

    .detail-section {
        margin-top: 14px;
    }

    .section-title {
        margin-bottom: 7px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 650;
    }

    .section-title-spaced {
        margin-top: 12px;
    }

    .scope-explanation,
    .advanced-alert {
        margin-bottom: 10px;
    }

    .scope-table :deep(.nn-table-cell),
    .capability-table :deep(.nn-table-cell) {
        vertical-align: top;
    }

    .family-cell,
    .epoch-cell,
    .stale-cell {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 4px;
    }

    .family-cell span,
    .epoch-cell span,
    .secondary-text {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .add-path-state {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
    }

    .add-path-state :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .identity-details :deep(.nn-descriptions-item-content),
    .diagnostic-value {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .raw-json-section {
        margin-top: 14px;
    }

    @media (max-width: 1180px) {
        .summary-grid {
            grid-template-columns: repeat(3, minmax(120px, 1fr));
        }
    }

    @media (max-width: 720px) {
        .summary-grid {
            grid-template-columns: repeat(2, minmax(110px, 1fr));
        }
    }
</style>
