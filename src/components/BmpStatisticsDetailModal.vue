<template>
    <nn-modal
        :open="open"
        :title="modalTitle"
        :footer="null"
        class="modal-xlarge bmp-statistics-detail-modal"
        data-testid="bmp-statistics-detail-modal"
        @update:open="handleOpenChange"
        @cancel="close"
    >
        <nn-empty v-if="!report" description="暂无统计详情" />
        <nn-tabs v-else v-model:active-key="activeTabKey" size="small" class="statistics-detail-tabs">
            <nn-tab-pane key="overview" tab="统计概览">
                <div class="statistics-detail-panel" data-testid="bmp-statistics-detail-overview">
                    <div class="summary-grid">
                        <div class="summary-card">
                            <span class="summary-label">BMP 连接</span>
                            <nn-tag :color="connectionStatus.color">{{ connectionStatus.label }}</nn-tag>
                        </div>
                        <div class="summary-card">
                            <span class="summary-label">RIB 视图</span>
                            <strong class="summary-text">{{ ribTypeText }}</strong>
                        </div>
                        <div class="summary-card summary-card-number">
                            <span class="summary-label">统计项目</span>
                            <strong>{{ statistics.length }}</strong>
                        </div>
                        <div class="summary-card summary-card-number">
                            <span class="summary-label">TLV 扩展</span>
                            <strong>{{ tlvs.length }}</strong>
                        </div>
                    </div>

                    <section class="detail-section">
                        <div class="section-title">{{ isLocRib ? 'Instance 身份' : 'Peer 身份' }}</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item v-for="item in ownerDetails" :key="item.label" :label="item.label">
                                {{ item.value }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="统计更新时间" :span="2">
                                {{ formatTimestamp(report.updatedAt) }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>

                    <section class="detail-section">
                        <div class="section-title">BMP Collector 连接</div>
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="Client">
                                {{ formatBmpClientLabel(reportClient) }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="连接状态">
                                <nn-tag :color="connectionStatus.color">{{ connectionStatus.label }}</nn-tag>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="Collector 本端">
                                {{
                                    formatEndpoint(
                                        connection.localIp ?? reportClient.localIp,
                                        connection.localPort ?? reportClient.localPort
                                    )
                                }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="BMP Router">
                                {{
                                    formatEndpoint(
                                        connection.remoteIp ?? reportClient.remoteIp,
                                        connection.remotePort ?? reportClient.remotePort
                                    )
                                }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </section>
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="statistics" tab="统计明细">
                <div class="statistics-detail-panel">
                    <nn-table
                        v-if="activeTabKey === 'statistics'"
                        :columns="columns"
                        :data-source="statistics"
                        :pagination="{ pageSize: 20, showSizeChanger: false, position: ['bottomCenter'] }"
                        :row-key="(_record, index) => index"
                        :scroll="{ x: 820 }"
                        size="small"
                        bordered
                        data-testid="bmp-statistics-detail-table"
                    />
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="tlvs" :tab="`TLV 扩展 (${tlvs.length})`">
                <div class="statistics-detail-panel" data-testid="bmp-statistics-detail-tlvs">
                    <template v-if="activeTabKey === 'tlvs'">
                        <nn-empty v-if="tlvs.length === 0" description="暂无 TLV 扩展" />
                        <nn-json-viewer v-else :value="tlvs" wrap />
                    </template>
                </div>
            </nn-tab-pane>

            <nn-tab-pane key="advanced" tab="原始数据">
                <div class="statistics-detail-panel" data-testid="bmp-statistics-detail-advanced">
                    <nn-json-viewer
                        v-if="activeTabKey === 'advanced'"
                        :value="report"
                        wrap
                        data-testid="bmp-statistics-detail-raw-json"
                    />
                </div>
            </nn-tab-pane>
        </nn-tabs>
    </nn-modal>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../const/bgpConst';
    import { BMP_BGP_RIB_TYPE, BMP_SESSION_TYPE_NAME, BMP_STATS_TYPE_NAME } from '../const/bmpConst';
    import { formatBmpClientLabel } from '../utils/bmp/bmpClientLabel';

    const props = defineProps({
        open: { type: Boolean, default: false },
        report: { type: Object, default: null },
        client: { type: Object, default: null }
    });
    const emit = defineEmits(['update:open']);
    const activeTabKey = ref('overview');
    const RIB_TYPE_LABELS = {
        [BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN]: 'Pre Adj RIB In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_IN]: 'Post Adj RIB In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_OUT]: 'Pre Adj RIB Out',
        [BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT]: 'Post Adj RIB Out'
    };

    const formatValue = value => (value === null || value === undefined || value === '' ? '-' : value);
    const formatTimestamp = value => {
        if (value === null || value === undefined || value === '') return '-';
        const numeric = Number(value);
        const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
        return Number.isFinite(timestamp) && timestamp > 0
            ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
            : '-';
    };
    const formatEndpoint = (address, port) => {
        if (address === null || address === undefined || address === '') return '-';
        const ip = String(address);
        if (port === null || port === undefined || port === '') return ip;
        return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
    };
    const formatAddressFamily = record => {
        if (record.afi === null || record.afi === undefined || record.safi === null || record.safi === undefined) {
            return '-';
        }
        const family = getAddrFamilyType(Number(record.afi), Number(record.safi));
        return `${ADDRESS_FAMILY_NAME[family] || '未知地址族'} (${record.afi}/${record.safi})`;
    };
    const columns = [
        { title: 'Type', dataIndex: 'type', key: 'type', width: 80 },
        {
            title: '统计类型',
            key: 'typeName',
            width: 320,
            customRender: ({ record }) =>
                record.typeName || BMP_STATS_TYPE_NAME[record.type] || `Unknown (${record.type})`
        },
        {
            title: '地址族',
            key: 'addressFamily',
            width: 180,
            customRender: ({ record }) => formatAddressFamily(record)
        },
        {
            title: '数值',
            key: 'value',
            width: 160,
            align: 'right',
            customRender: ({ record }) => formatValue(record.value)
        }
    ];

    const isLocRib = computed(() => Boolean(props.report?.instance));
    const owner = computed(() => props.report?.instance || props.report?.session || {});
    const statistics = computed(() => (Array.isArray(props.report?.statistics) ? props.report.statistics : []));
    const tlvs = computed(() => (Array.isArray(props.report?.tlvs) ? props.report.tlvs : []));
    const reportClient = computed(() => props.client || props.report?.client || {});
    const connection = computed(() => reportClient.value.connection || {});
    const connectionStatus = computed(() => {
        const client = reportClient.value;
        const state = connection.value.state || client.connectionState;
        if (client.isOnline === true || (client.isOnline !== false && state === 'open')) {
            return { label: '在线', color: 'green' };
        }
        if (client.isOnline === false || state === 'closed') return { label: '已断开', color: 'orange' };
        return { label: '未知', color: 'default' };
    });
    const ribTypeText = computed(() =>
        isLocRib.value ? 'Loc-RIB' : RIB_TYPE_LABELS[props.report?.ribType] || formatValue(props.report?.ribType)
    );
    const vrfTableText = computed(() => {
        const names = Array.isArray(owner.value.vrfTableNames) ? owner.value.vrfTableNames.filter(Boolean) : [];
        const rd = isLocRib.value ? owner.value.instanceRd : owner.value.sessionRd;
        return names.length > 0 ? names.join(', ') : rd === '0:0' ? 'global' : formatValue(rd);
    });
    const ownerDetails = computed(() => {
        const record = owner.value;
        return isLocRib.value
            ? [
                  {
                      label: 'Instance 类型',
                      value: BMP_SESSION_TYPE_NAME[record.instanceType] || formatValue(record.instanceType)
                  },
                  { label: 'VRF / Table', value: vrfTableText.value },
                  { label: 'Instance 地址', value: formatValue(record.instanceIp) },
                  { label: 'AS', value: formatValue(record.instanceAs) },
                  { label: 'RD', value: formatValue(record.instanceRd) },
                  { label: 'Router ID', value: formatValue(record.instanceRouterId) }
              ]
            : [
                  {
                      label: 'Session 类型',
                      value: BMP_SESSION_TYPE_NAME[record.sessionType] || formatValue(record.sessionType)
                  },
                  { label: 'RIB 视图', value: ribTypeText.value },
                  { label: 'Peer 地址', value: formatValue(record.sessionIp) },
                  { label: 'Peer AS', value: formatValue(record.sessionAs) },
                  { label: 'RD / VRF', value: vrfTableText.value },
                  { label: 'Router ID', value: formatValue(record.sessionRouterId) }
              ];
    });
    const modalTitle = computed(() =>
        isLocRib.value
            ? `Loc-RIB 统计详情 · ${vrfTableText.value}`
            : `会话统计详情 · ${formatValue(owner.value.sessionIp)} · ${ribTypeText.value}`
    );
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
    :global(.bmp-statistics-detail-modal .nn-modal-body) {
        height: min(620px, calc(92vh - 82px)) !important;
        min-height: min(620px, calc(92vh - 82px)) !important;
        max-height: min(620px, calc(92vh - 82px)) !important;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
    }

    .statistics-detail-tabs {
        flex: 1 1 0;
        min-height: 0;
    }

    .statistics-detail-tabs :deep(.nn-tabs-nav) {
        margin-bottom: 10px;
    }

    .statistics-detail-tabs :deep(.nn-tabs-content-holder) {
        height: 0;
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
    }

    .statistics-detail-tabs :deep(.nn-tabs-content),
    .statistics-detail-tabs :deep(.nn-tabs-tabpane) {
        height: 100%;
        min-height: 0;
    }

    .statistics-detail-panel {
        box-sizing: border-box;
        height: 100%;
        min-width: 0;
        overflow: auto;
        padding-right: 2px;
    }

    .statistics-detail-panel :deep(.nn-json-viewer-content) {
        max-height: none !important;
        overflow: visible !important;
    }

    .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(110px, 1fr));
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

    .summary-label {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .summary-card-number strong {
        color: var(--nn-color-text-strong);
        font-size: 20px;
        line-height: 24px;
    }

    .summary-text {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        overflow-wrap: anywhere;
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

    .detail-section :deep(.nn-descriptions-item-content) {
        overflow-wrap: anywhere;
    }

    @media (max-width: 960px) {
        .summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }
</style>
