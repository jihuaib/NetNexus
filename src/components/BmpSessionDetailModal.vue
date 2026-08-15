<template>
    <nn-modal
        :open="open"
        :title="modalTitle"
        :footer="null"
        class="modal-xlarge bmp-session-detail-modal"
        data-testid="bmp-session-detail-modal"
        @update:open="handleOpenChange"
        @cancel="close"
    >
        <nn-empty v-if="!session" description="暂无 Session 详情" />
        <nn-spin v-else :spinning="loading" class="session-detail-loading">
            <nn-tabs v-model:active-key="activeTabKey" size="small" class="session-detail-tabs">
                <nn-tab-pane key="overview" tab="会话概览">
                    <div class="session-detail-panel" data-testid="bmp-session-detail-overview">
                        <div class="summary-grid">
                            <div class="summary-card">
                                <span class="summary-label">BMP 连接</span>
                                <nn-tag :color="isOnline ? 'green' : 'orange'">
                                    {{ isOnline ? '在线' : '已断开' }}
                                </nn-tag>
                            </div>
                            <div class="summary-card">
                                <span class="summary-label">BGP Peer</span>
                                <nn-tag :color="sessionStateColor">{{ sessionStateText }}</nn-tag>
                            </div>
                            <div class="summary-card summary-card-number">
                                <span class="summary-label">当前 RIB 条目</span>
                                <strong>{{ formatCount(sessionSummary.active) }}</strong>
                            </div>
                            <div class="summary-card summary-card-number">
                                <span class="summary-label">过期 RIB 条目</span>
                                <strong class="summary-stale">{{ formatCount(sessionSummary.stale) }}</strong>
                            </div>
                            <div class="summary-card summary-card-number">
                                <span class="summary-label">RIB 记录总数</span>
                                <strong>{{ formatCount(sessionSummary.total) }}</strong>
                            </div>
                            <div class="summary-card summary-card-number">
                                <span class="summary-label">地址族 / Scope</span>
                                <strong>{{ ribMatrixRows.length }} / {{ routeScopes.length }}</strong>
                            </div>
                        </div>

                        <section class="detail-section">
                            <div class="section-title">Peer 身份</div>
                            <nn-descriptions :column="2" bordered size="small">
                                <nn-descriptions-item label="Session 类型">
                                    {{ sessionTypeText }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Session 状态">
                                    <nn-tag :color="sessionStateColor">{{ sessionStateText }}</nn-tag>
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer 地址">
                                    {{ formatValue(session.sessionIp) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer AS">
                                    {{ formatValue(session.sessionAs) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Router ID">
                                    {{ formatValue(session.sessionRouterId) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="RD / VRF">
                                    {{ sessionVrfOrRd }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="生效 Flags">
                                    {{ getBmpFlagsName(session.sessionFlags) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer 时间">
                                    {{ formatTimestamp(session.sessionTimestampMs) }}
                                </nn-descriptions-item>
                            </nn-descriptions>
                        </section>

                        <section class="detail-section" data-testid="bmp-session-detail-connection">
                            <div class="section-title">被监控的 BGP 邻接</div>
                            <nn-descriptions :column="2" bordered size="small">
                                <nn-descriptions-item label="本端">
                                    {{ formatEndpoint(session.localIp, session.localPort) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer">
                                    {{ formatEndpoint(session.sessionIp, session.remotePort) }}
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

                <nn-tab-pane key="ribs" :tab="`RIB 视图 (${routeScopes.length})`">
                    <div class="session-detail-panel" data-testid="bmp-session-detail-rib-scopes">
                        <nn-alert
                            class="scope-explanation"
                            type="info"
                            show-icon
                            message="一个地址族会拆成四个独立 RIB 视图"
                            description="Peer Up 时会预建 Pre/Post Adj-RIB-In/Out。尚未收到当前路由的方向显示为“未上报”；收到路由但没有 EOR 时才显示“等待 EOR”。"
                        />
                        <nn-table
                            :columns="ribMatrixColumns"
                            :data-source="ribMatrixRows"
                            :pagination="false"
                            :scroll="{ x: 1080 }"
                            row-key="key"
                            size="small"
                            class="rib-matrix-table"
                            data-testid="bmp-session-detail-scope-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'addressFamily'">
                                    <div class="family-cell">
                                        <strong>{{ record.name }}</strong>
                                        <span>AFI {{ record.afi }} / SAFI {{ record.safi }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.ribType">
                                    <div v-if="getMatrixScope(record, column.ribType)" class="rib-stage-cell">
                                        <nn-tag
                                            :color="getScopeStateMeta(getMatrixScope(record, column.ribType)).color"
                                        >
                                            {{ getScopeStateMeta(getMatrixScope(record, column.ribType)).label }}
                                        </nn-tag>
                                        <div class="rib-stage-counts">
                                            <strong>
                                                {{
                                                    formatCount(
                                                        getScopeSummary(getMatrixScope(record, column.ribType)).active
                                                    )
                                                }}
                                            </strong>
                                            <span>当前</span>
                                            <template
                                                v-if="getScopeSummary(getMatrixScope(record, column.ribType)).stale > 0"
                                            >
                                                <strong class="summary-stale">
                                                    {{
                                                        formatCount(
                                                            getScopeSummary(getMatrixScope(record, column.ribType))
                                                                .stale
                                                        )
                                                    }}
                                                    过期
                                                </strong>
                                            </template>
                                        </div>
                                        <div class="rib-stage-epoch">
                                            Epoch
                                            {{ formatValue(getMatrixScope(record, column.ribType).currentEpoch) }} · EOR
                                            {{ formatValue(getMatrixScope(record, column.ribType).eorEpoch) }}
                                        </div>
                                    </div>
                                    <span v-else class="empty-value">未创建</span>
                                </template>
                                <template v-else-if="column.key === 'summary'">
                                    <div class="row-summary">
                                        <strong>{{ formatCount(record.summary.active) }}</strong>
                                        <span>当前</span>
                                        <span v-if="record.summary.stale > 0" class="summary-stale">
                                            {{ formatCount(record.summary.stale) }} 过期
                                        </span>
                                    </div>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </nn-tab-pane>

                <nn-tab-pane key="capabilities" tab="能力协商">
                    <div class="session-detail-panel" data-testid="bmp-session-detail-capabilities">
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
                                    <nn-tag :color="record[column.key] ? 'green' : 'default'">
                                        {{ record[column.key] ? '是' : '否' }}
                                    </nn-tag>
                                </template>
                                <template v-else-if="column.key === 'remoteAddPath'">
                                    {{ formatAddPathMode(record.remoteAddPath) }}
                                </template>
                                <template v-else-if="column.key === 'localAddPath'">
                                    {{ formatAddPathMode(record.localAddPath) }}
                                </template>
                                <template v-else-if="column.key === 'effectiveAddPath'">
                                    <div class="add-path-state">
                                        <nn-tag :color="record.routerReceiveAddPath ? 'green' : 'default'">
                                            接收 {{ record.routerReceiveAddPath ? '开' : '关' }}
                                        </nn-tag>
                                        <nn-tag :color="record.routerSendAddPath ? 'green' : 'default'">
                                            发送 {{ record.routerSendAddPath ? '开' : '关' }}
                                        </nn-tag>
                                    </div>
                                </template>
                            </template>
                        </nn-table>

                        <section class="detail-section">
                            <div class="section-title">附加能力与通知</div>
                            <nn-descriptions :column="2" bordered size="small">
                                <nn-descriptions-item label="共同启用地址族">
                                    {{ capabilityRows.filter(item => item.enabled).length }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="VRF / Table">
                                    {{ vrfTableText }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer Up TLV">
                                    {{ session.peerUpTlvs?.length || 0 }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer Down TLV">
                                    {{ session.peerDownTlvs?.length || 0 }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Peer Down 原因">
                                    {{ peerDownReasonText }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="FSM Event Code">
                                    {{ formatValue(session.peerDownFsmEventCode) }}
                                </nn-descriptions-item>
                            </nn-descriptions>
                        </section>
                    </div>
                </nn-tab-pane>

                <nn-tab-pane key="advanced" tab="高级诊断">
                    <div class="session-detail-panel" data-testid="bmp-session-detail-advanced">
                        <nn-alert
                            class="advanced-alert"
                            type="info"
                            show-icon
                            message="以下信息主要用于持久化定位、重连恢复和问题排查"
                            description="普通查看无需关注哈希 ID、Epoch Map、原始 Flags 或完整 JSON。"
                        />
                        <nn-descriptions :column="1" bordered size="small" class="identity-details">
                            <nn-descriptions-item label="Source ID">
                                <span class="diagnostic-value">
                                    {{ formatValue(session.persistentSourceId || session.sourceId) }}
                                </span>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Owner Key">
                                <span class="diagnostic-value">
                                    {{ formatValue(session.persistentOwnerKey || session.ownerKey) }}
                                </span>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Connection ID">
                                <span class="diagnostic-value">
                                    {{ formatValue(session.persistentConnectionId || session.connectionId) }}
                                </span>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="原始 Session Flags">
                                {{ formatRawFlags(session.rawSessionFlags) }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                        <div v-if="activeTabKey === 'advanced'" class="raw-json-section">
                            <div class="section-title">完整原始 JSON</div>
                            <nn-json-viewer
                                :value="session"
                                :max-height="520"
                                wrap
                                data-testid="bmp-session-detail-raw-json"
                            />
                        </div>
                    </div>
                </nn-tab-pane>
            </nn-tabs>
        </nn-spin>
    </nn-modal>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../const/bgpConst';
    import {
        BMP_BGP_RIB_TYPE,
        BMP_PEER_DOWN_REASON_NAME,
        BMP_SESSION_STATE,
        BMP_SESSION_STATE_NAME,
        BMP_SESSION_TYPE_NAME,
        getBmpFlagsName
    } from '../const/bmpConst';

    const props = defineProps({
        open: { type: Boolean, default: false },
        loading: { type: Boolean, default: false },
        session: { type: Object, default: null }
    });
    const emit = defineEmits(['update:open']);

    const activeTabKey = ref('overview');
    const STANDARD_RIB_TYPES = [
        BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
        BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
    ];
    const RIB_TYPE_LABELS = {
        [BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN]: 'Pre-policy Adj-RIB-In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_IN]: 'Post-policy Adj-RIB-In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_OUT]: 'Pre-policy Adj-RIB-Out',
        [BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT]: 'Post-policy Adj-RIB-Out'
    };
    const ADD_PATH_MODE_NAMES = {
        1: '仅接收',
        2: '仅发送',
        3: '收发'
    };

    const ribMatrixColumns = [
        { title: '地址族', key: 'addressFamily', width: 180, fixed: 'left' },
        ...STANDARD_RIB_TYPES.map(ribType => ({
            title: RIB_TYPE_LABELS[ribType],
            key: String(ribType),
            ribType: String(ribType),
            width: 205
        })),
        { title: '合计', key: 'summary', width: 105 }
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
    const formatAddPathMode = mode => ADD_PATH_MODE_NAMES[Number(mode)] || '-';
    const hasAddressFamily = (families, afi, safi) =>
        Array.isArray(families) &&
        families.some(item => Number(item?.afi) === Number(afi) && Number(item?.safi) === Number(safi));
    const addressFamilyName = (addrFamilyType, afi, safi) => {
        const name = ADDRESS_FAMILY_NAME[addrFamilyType];
        return name ? name.replace('UNC', 'Unicast') : `AFI ${afi} / SAFI ${safi}`;
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

    const connection = computed(() => props.session?.connection || {});
    const isOnline = computed(() => {
        if (typeof props.session?.isOnline === 'boolean') return props.session.isOnline;
        return String(props.session?.connectionState || connection.value.state || '').toLowerCase() === 'open';
    });
    const connectionStateText = computed(() => (isOnline.value ? '在线' : '已断开'));
    const sessionStateText = computed(
        () => BMP_SESSION_STATE_NAME[props.session?.sessionState] || formatValue(props.session?.sessionState)
    );
    const sessionStateColor = computed(() => {
        const state = props.session?.sessionState;
        return state !== null && state !== undefined && Number(state) === BMP_SESSION_STATE.PEER_UP
            ? 'green'
            : 'orange';
    });
    const sessionTypeText = computed(
        () => BMP_SESSION_TYPE_NAME[props.session?.sessionType] || formatValue(props.session?.sessionType)
    );
    const modalTitle = computed(() => `BGP Session 详情 · ${formatValue(props.session?.sessionIp)}`);
    const vrfTableNames = computed(() =>
        Array.isArray(props.session?.vrfTableNames) ? props.session.vrfTableNames.filter(Boolean) : []
    );
    const vrfTableText = computed(() => (vrfTableNames.value.length > 0 ? vrfTableNames.value.join(', ') : '-'));
    const sessionVrfOrRd = computed(() => {
        if (vrfTableNames.value.length > 0) return vrfTableNames.value.join(', ');
        return props.session?.sessionRd === '0:0' ? 'Global' : formatValue(props.session?.sessionRd);
    });
    const peerDownReasonText = computed(() => {
        const reason = props.session?.peerDownReason;
        return reason === null || reason === undefined ? '-' : BMP_PEER_DOWN_REASON_NAME[reason] || reason;
    });

    const routeScopes = computed(() =>
        (Array.isArray(props.session?.routeScopes) ? props.session.routeScopes : [])
            .map(scope => {
                const afi = Number(scope?.afi);
                const safi = Number(scope?.safi);
                return {
                    ...scope,
                    afi,
                    safi,
                    addrFamilyType: scope?.addrFamilyType ?? getAddrFamilyType(afi, safi),
                    ribType: scope?.ribType === null || scope?.ribType === undefined ? null : String(scope.ribType)
                };
            })
            .filter(scope => Number.isFinite(scope.afi) && Number.isFinite(scope.safi) && scope.ribType !== null)
    );
    const sessionSummary = computed(() => {
        if (props.session?.routeSummary) return normalizeSummary(props.session.routeSummary);
        return routeScopes.value.reduce(
            (summary, scope) => {
                const item = normalizeSummary(scope.routeSummary);
                summary.active += item.active;
                summary.stale += item.stale;
                summary.total += item.total;
                return summary;
            },
            { active: 0, stale: 0, total: 0 }
        );
    });

    const buildFamilyMap = () => {
        const families = new Map();
        const ensureFamily = (afiValue, safiValue, addrFamilyType = null) => {
            const afi = Number(afiValue);
            const safi = Number(safiValue);
            if (!Number.isFinite(afi) || !Number.isFinite(safi)) return null;
            const key = `${afi}|${safi}`;
            if (!families.has(key)) {
                const resolvedType = addrFamilyType ?? getAddrFamilyType(afi, safi);
                families.set(key, {
                    key,
                    afi,
                    safi,
                    addrFamilyType: resolvedType,
                    name: addressFamilyName(resolvedType, afi, safi)
                });
            }
            return families.get(key);
        };

        [
            ...(props.session?.recvAddressFamilies || []),
            ...(props.session?.sendAddressFamilies || []),
            ...(props.session?.enabledAddressFamilies || [])
        ].forEach(item => ensureFamily(item?.afi, item?.safi));
        routeScopes.value.forEach(scope => ensureFamily(scope.afi, scope.safi, scope.addrFamilyType));
        return families;
    };

    const ribMatrixRows = computed(() => {
        const families = buildFamilyMap();
        routeScopes.value.forEach(scope => {
            const family = families.get(`${scope.afi}|${scope.safi}`);
            if (!family) return;
            if (!family.stages) family.stages = {};
            family.stages[String(scope.ribType)] = scope;
        });
        return Array.from(families.values()).map(family => {
            const stages = family.stages || {};
            const summary = Object.values(stages).reduce(
                (result, scope) => {
                    const item = normalizeSummary(scope.routeSummary);
                    result.active += item.active;
                    result.stale += item.stale;
                    result.total += item.total;
                    return result;
                },
                { active: 0, stale: 0, total: 0 }
            );
            return { ...family, stages, summary };
        });
    });

    const capabilityRows = computed(() =>
        Array.from(buildFamilyMap().values()).map(family => {
            const rawKey = `${family.afi}|${family.safi}`;
            const familyKey = String(family.addrFamilyType);
            return {
                ...family,
                received: hasAddressFamily(props.session?.recvAddressFamilies, family.afi, family.safi),
                sent: hasAddressFamily(props.session?.sendAddressFamilies, family.afi, family.safi),
                enabled: hasAddressFamily(props.session?.enabledAddressFamilies, family.afi, family.safi),
                remoteAddPath: props.session?.recvAddPathMap?.[rawKey],
                localAddPath: props.session?.sendAddPathMap?.[rawKey],
                routerReceiveAddPath: props.session?.addPathReceiveMap?.[familyKey] === true,
                routerSendAddPath: props.session?.addPathSendMap?.[familyKey] === true
            };
        })
    );

    const getMatrixScope = (record, ribType) => record?.stages?.[String(ribType)] || null;
    const getScopeSummary = scope => normalizeSummary(scope?.routeSummary);
    const getScopeStateMeta = scope => {
        const state = String(scope?.scopeState || '').toLowerCase();
        if (state === 'ready') return { label: '已就绪', color: 'green' };
        if (state === 'syncing') {
            const summary = getScopeSummary(scope);
            const currentEpoch = Number(scope?.currentEpoch);
            const eorEpoch = Number(scope?.eorEpoch);
            const hasCurrentEor =
                scope?.eorEpoch !== null &&
                scope?.eorEpoch !== undefined &&
                scope?.eorEpoch !== '' &&
                Number.isFinite(eorEpoch) &&
                (!Number.isFinite(currentEpoch) || eorEpoch >= currentEpoch);
            if (!hasCurrentEor && summary.active === 0) {
                return summary.stale > 0
                    ? { label: '未重新上报', color: 'orange' }
                    : { label: '未上报', color: 'default' };
            }
            return { label: '等待 EOR', color: 'blue' };
        }
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
    :global(.bmp-session-detail-modal .nn-modal-body) {
        height: min(620px, calc(92vh - 82px)) !important;
        min-height: min(620px, calc(92vh - 82px)) !important;
        max-height: min(620px, calc(92vh - 82px)) !important;
        overflow: hidden !important;
    }

    .session-detail-tabs {
        height: 100%;
        min-height: 0;
    }

    .session-detail-loading,
    .session-detail-loading :deep(.nn-spin-nested-loading),
    .session-detail-loading :deep(.nn-spin-container) {
        height: 100%;
        min-height: 0;
    }

    .session-detail-tabs :deep(.nn-tabs-nav) {
        margin-bottom: 10px;
    }

    .session-detail-tabs :deep(.nn-tabs-content-holder) {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
    }

    .session-detail-tabs :deep(.nn-tabs-content),
    .session-detail-tabs :deep(.nn-tabs-tabpane) {
        height: 100%;
        min-height: 0;
    }

    .session-detail-panel {
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

    .rib-matrix-table :deep(.nn-table-cell),
    .capability-table :deep(.nn-table-cell) {
        vertical-align: top;
    }

    .family-cell,
    .rib-stage-cell,
    .row-summary {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 4px;
    }

    .family-cell span,
    .rib-stage-epoch,
    .row-summary span,
    .empty-value {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .rib-stage-counts {
        display: flex;
        align-items: baseline;
        gap: 4px;
        flex-wrap: wrap;
    }

    .rib-stage-counts span {
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
