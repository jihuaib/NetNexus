<template>
    <nn-modal
        :open="open"
        :title="modalTitle"
        :footer="null"
        class="modal-xlarge bmp-route-detail-modal"
        data-testid="bmp-route-detail-modal"
        @update:open="handleOpenChange"
        @cancel="close"
    >
        <nn-spin :spinning="loading" class="route-detail-loading" data-testid="bmp-route-detail-loading">
            <div v-if="loading && !route" class="route-detail-placeholder" aria-label="正在加载路由详情" />
            <nn-empty v-else-if="!route" description="暂无路由详情" />
            <nn-tabs v-else v-model:active-key="activeTabKey" size="small" class="route-detail-tabs">
                <nn-tab-pane v-for="tab in readableTabs" :key="tab.key" :tab="tab.label">
                    <div v-if="open && activeTabKey === tab.key" class="route-detail-panel" :data-testid="tab.testId">
                        <template v-if="tab.key === 'overview'">
                            <div class="route-identity">
                                <span class="route-family">{{ familyText }}</span>
                                <h3>{{ prefixText }}</h3>
                                <p>{{ ownerText }}</p>
                            </div>
                            <div class="summary-grid">
                                <div class="summary-card">
                                    <span class="summary-label">路由状态</span>
                                    <nn-tag :color="routeStateColor">{{ routeStateText }}</nn-tag>
                                </div>
                                <div class="summary-card">
                                    <span class="summary-label">解析状态</span>
                                    <nn-tag :color="parseStatusColor">{{ parseStatusText }}</nn-tag>
                                </div>
                                <div class="summary-card">
                                    <span class="summary-label">路径状态信息</span>
                                    <nn-tag :color="hasPathMarking ? 'green' : 'orange'">
                                        {{ hasPathMarking ? '设备上报' : '观测缺失' }}
                                    </nn-tag>
                                </div>
                                <div class="summary-card">
                                    <span class="summary-label">路由属性</span>
                                    <strong>{{ readableModel.attributes.length }}</strong>
                                </div>
                            </div>
                            <section class="detail-section">
                                <h3 class="section-title">路由与来源</h3>
                                <nn-table
                                    :columns="overviewColumns"
                                    :data-source="overviewDetails"
                                    :pagination="false"
                                    row-key="label"
                                    bordered
                                    size="small"
                                    class="detail-table overview-table"
                                >
                                    <template #bodyCell="{ column, record: item }">
                                        <span v-if="column.key === 'value'" class="detail-value">{{ item.value }}</span>
                                    </template>
                                </nn-table>
                            </section>
                            <nn-alert
                                class="evidence-alert"
                                :type="hasPathMarking ? 'success' : 'warning'"
                                show-icon
                                :message="hasPathMarking ? 'Path Marking：设备上报' : 'Path Marking：观测缺失'"
                                :description="
                                    hasPathMarking
                                        ? '路径状态与原因来自设备上报的路由扩展信息。'
                                        : '当前没有设备上报的路径状态，阶段关联及未选中原因只能作为推测。'
                                "
                            />
                        </template>

                        <section
                            v-for="section in tab.sections"
                            :key="section.key"
                            class="detail-section"
                            :data-testid="section.testId"
                        >
                            <h3 v-if="section.title" class="section-title">{{ section.title }}</h3>
                            <nn-table
                                v-if="section.rows.length"
                                :columns="tab.key === 'attributes' ? attributeColumns : groupColumns"
                                :data-source="section.rows"
                                :pagination="false"
                                :row-class-name="item => (item.groupStart ? 'detail-group-start' : '')"
                                row-key="key"
                                bordered
                                size="small"
                                class="detail-table"
                            >
                                <template #bodyCell="{ column, record: item }">
                                    <template v-if="column.key === 'value'">
                                        <div v-if="item.kind === 'tags'" class="community-tags">
                                            <nn-tag v-for="(tag, index) in item.value" :key="index">{{ tag }}</nn-tag>
                                        </div>
                                        <ul v-else-if="item.kind === 'list'" class="readable-list">
                                            <li v-for="(value, index) in item.value" :key="index">{{ value }}</li>
                                        </ul>
                                        <code
                                            v-else-if="item.kind === 'path' || item.kind === 'code'"
                                            class="readable-code"
                                        >
                                            {{ item.value }}
                                        </code>
                                        <span v-else class="detail-value">{{ item.value }}</span>
                                    </template>
                                </template>
                            </nn-table>
                            <nn-empty v-else-if="section.emptyText" :description="section.emptyText" />
                        </section>
                    </div>
                </nn-tab-pane>
                <nn-tab-pane key="advanced" tab="原始数据">
                    <div class="route-detail-panel">
                        <nn-json-viewer
                            v-if="open && activeTabKey === 'advanced'"
                            :value="route"
                            wrap
                            data-testid="bmp-route-detail-raw-json"
                        />
                    </div>
                </nn-tab-pane>
            </nn-tabs>
        </nn-spin>
    </nn-modal>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../const/bgpConst';
    import { BMP_BGP_RIB_TYPE_NAME, BMP_ROUTE_STATE_NAME } from '../const/bmpConst';
    import { formatBmpClientLabel } from '../utils/bmp/bmpClientLabel';
    import { getRouteParseStatusColor, getRouteParseStatusText } from '../utils/bmp/routeParseStatus';
    import {
        buildReadableRouteDetailModel,
        formatReadableRouteIdentity,
        formatRouteDetailValue,
        getRouteDetailRecord
    } from '../utils/bmp/routeDetail';

    const props = defineProps({
        open: { type: Boolean, default: false },
        route: { type: Object, default: null },
        loading: { type: Boolean, default: false },
        title: { type: String, default: '' },
        stageLabel: { type: String, default: '' }
    });
    const emit = defineEmits(['update:open']);
    const activeTabKey = ref('overview');
    const readableModel = computed(() => buildReadableRouteDetailModel(props.route));
    const record = computed(() => getRouteDetailRecord(props.route));
    const displayValue = value =>
        value === null || value === undefined || value === '' ? '-' : formatRouteDetailValue(value);
    const readableIdentity = computed(() => formatReadableRouteIdentity(props.route));
    const prefixText = computed(() => readableIdentity.value.summary || readableIdentity.value.title);
    const modalTitle = computed(() => {
        if (!props.route) return props.title || 'BMP 路由详情';
        return [readableIdentity.value.title, readableIdentity.value.summary, props.stageLabel]
            .filter(Boolean)
            .join(' · ');
    });
    const familyText = computed(() => {
        const route = record.value;
        const family =
            route.addrFamilyType ?? route.addressFamily ?? getAddrFamilyType(Number(route.afi), Number(route.safi));
        return ADDRESS_FAMILY_NAME[family]?.replace('UNC', '单播') || '未知地址族';
    });
    const routeStateText = computed(
        () => BMP_ROUTE_STATE_NAME[record.value.routeState] || displayValue(record.value.routeState)
    );
    const routeStateColor = computed(() =>
        record.value.routeState === 'active' ? 'green' : record.value.routeState === 'stale' ? 'orange' : 'default'
    );
    const parseStatusText = computed(() => {
        if (record.value.parseStatus === null || record.value.parseStatus === undefined) return '未知';
        const status = getRouteParseStatusText(record.value.parseStatus);
        return status === 'OK' ? '正常' : status;
    });
    const parseStatusColor = computed(() =>
        record.value.parseStatus === null || record.value.parseStatus === undefined
            ? 'default'
            : getRouteParseStatusColor(record.value.parseStatus)
    );
    const hasPathMarking = computed(() => {
        const route = record.value;
        return (
            props.route?.hasPathMarking === true ||
            (route.pathStatus !== null && route.pathStatus !== undefined) ||
            (Array.isArray(route.pathStatusNames) && route.pathStatusNames.length > 0) ||
            Boolean(route.pathStatusText) ||
            Boolean(route.pathStatusReasonText)
        );
    });
    const routeContext = computed(() => {
        const route = record.value;
        const context = props.route || {};
        const owner = context.session || context.instance || route.peer || {};
        const client = context.client || route.source || {};
        const stage =
            route.scopeKind === 'loc-rib' || context.instance
                ? 'Loc-RIB'
                : BMP_BGP_RIB_TYPE_NAME[route.ribType ?? context.ribType];
        const vrf =
            route.vrfName ||
            owner.vrf ||
            owner.vrfTableNames?.join(', ') ||
            route.rd ||
            owner.sessionRd ||
            owner.instanceRd;
        return { owner, client, stage: props.stageLabel || stage || displayValue(route.scopeKind), vrf };
    });
    const overviewColumns = [
        { title: '信息', key: 'label', dataIndex: 'label', width: '26%' },
        { title: '内容', key: 'value', dataIndex: 'value' }
    ];
    const groupColumns = [
        { title: '分组', key: 'group', dataIndex: 'group', width: '26%' },
        { title: '字段', key: 'label', dataIndex: 'label', width: '24%' },
        { title: '解析结果', key: 'value', dataIndex: 'value' }
    ];
    const attributeColumns = [{ ...groupColumns[0], title: '属性' }, ...groupColumns.slice(1)];
    const ownerText = computed(() => {
        const { owner, client } = routeContext.value;
        const address = owner.sessionIp ?? owner.instanceIp ?? owner.ip;
        return [formatBmpClientLabel(client), address].filter(value => value && value !== '-').join(' · ');
    });
    const overviewDetails = computed(() => {
        const { owner, client, stage, vrf } = routeContext.value;
        return [
            { label: 'RIB 阶段', value: stage },
            { label: 'VRF / RD', value: displayValue(vrf) },
            { label: 'BMP Client', value: formatBmpClientLabel(client) },
            { label: 'Peer / 实例地址', value: displayValue(owner.sessionIp ?? owner.instanceIp ?? owner.ip) },
            { label: 'Peer / 实例 AS', value: displayValue(owner.sessionAs ?? owner.instanceAs ?? owner.as) }
        ];
    });
    const buildGroupRows = groups =>
        groups.flatMap(group => {
            const items = [...(group.items || [])];
            if (group.tags?.length) items.push({ label: 'Community', value: group.tags, kind: 'tags' });
            if (!items.length) items.push({ label: '解析状态', value: '无可读解析结果' });
            return items.map((item, index) => ({
                ...item,
                key: `${group.key}-${index}`,
                group: index === 0 ? group.title : '',
                groupStart: index === 0
            }));
        });
    const readableTabs = computed(() => [
        {
            key: 'overview',
            label: '路由概览',
            testId: 'bmp-route-detail-overview',
            sections: [
                {
                    key: 'overview',
                    title: '观测信息',
                    rows: buildGroupRows(readableModel.value.overviewGroups)
                }
            ]
        },
        {
            key: 'attributes',
            label: 'BGP 属性',
            testId: 'bmp-route-detail-attributes',
            sections: [
                {
                    key: 'attributes',
                    title: '路由携带的 BGP 属性',
                    rows: buildGroupRows(readableModel.value.attributes),
                    emptyText: '暂无 BGP 路径属性'
                }
            ]
        },
        {
            key: 'nlri',
            label: 'NLRI / TLV',
            testId: 'bmp-route-detail-nlri',
            sections: [
                {
                    key: 'nlri',
                    title: '路由内容（NLRI）',
                    rows: buildGroupRows(readableModel.value.nlri),
                    emptyText: '暂无 NLRI 明细'
                },
                {
                    key: 'tlvs',
                    title: '设备上报的路由扩展',
                    rows: buildGroupRows(readableModel.value.tlvs),
                    emptyText: '暂无路由扩展',
                    testId: 'bmp-route-detail-tlvs'
                }
            ]
        }
    ]);
    const close = () => emit('update:open', false);
    const handleOpenChange = value => emit('update:open', value);
    watch(
        () => props.open,
        value => {
            if (value) {
                activeTabKey.value = 'overview';
            }
        }
    );
</script>

<style scoped>
    :global(.bmp-route-detail-modal .nn-modal-body) {
        height: min(620px, calc(92vh - 82px)) !important;
        min-height: min(620px, calc(92vh - 82px)) !important;
        max-height: min(620px, calc(92vh - 82px)) !important;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
    }

    .route-detail-loading,
    .route-detail-loading :deep(.nn-spin-container) {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-height: 0;
    }

    .route-detail-placeholder {
        flex: 1 1 0;
        min-height: 160px;
    }

    .route-detail-tabs {
        flex: 1 1 0;
        min-height: 0;
    }

    .route-detail-tabs :deep(.nn-tabs-nav) {
        margin-bottom: 12px;
    }

    .route-detail-tabs :deep(.nn-tabs-content-holder) {
        height: 0;
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
    }

    .route-detail-tabs :deep(.nn-tabs-content),
    .route-detail-tabs :deep(.nn-tabs-tabpane) {
        height: 100%;
        min-height: 0;
    }

    .route-detail-panel {
        box-sizing: border-box;
        height: 100%;
        min-width: 0;
        overflow: auto;
        padding: 0 4px 8px 0;
    }

    .route-identity {
        padding: 2px 0 16px;
    }

    .route-family {
        color: var(--nn-color-primary);
        font-size: 12px;
        font-weight: 600;
    }

    .route-identity h3 {
        margin: 4px 0 6px;
        color: var(--nn-color-text-strong);
        font-size: 22px;
        line-height: 1.4;
        font-weight: 650;
        overflow-wrap: anywhere;
    }

    .route-identity p {
        margin: 0;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(120px, 1fr));
        gap: 10px;
    }

    .summary-card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: space-between;
        min-width: 0;
        min-height: 66px;
        padding: 10px 12px;
        gap: 8px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-muted);
    }

    .summary-label {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .summary-card strong {
        color: var(--nn-color-text-strong);
        font-size: 20px;
        line-height: 24px;
    }

    .detail-section {
        margin-top: 18px;
    }

    .evidence-alert {
        margin-top: 16px;
    }

    .section-title {
        margin: 0 0 8px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .detail-table :deep(table) {
        width: 100%;
        table-layout: fixed;
    }

    .detail-table :deep(.nn-table-cell) {
        padding: 7px 10px;
        font-size: 12px;
        line-height: 1.6;
        vertical-align: top;
        overflow-wrap: anywhere;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
    }

    .detail-table :deep(.detail-group-start > .nn-table-cell:first-child) {
        color: var(--nn-color-text-strong);
        font-weight: 500;
    }

    .detail-value,
    .readable-code {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    .readable-code {
        font-family: var(--nn-font-family-monospace, Consolas, monospace);
        font-size: inherit;
    }

    .readable-list {
        margin: 0;
        padding-left: 16px;
        overflow-wrap: anywhere;
    }

    .community-tags {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
    }

    .detail-table :deep(.nn-tag) {
        margin: 0;
        max-width: 100%;
        font-size: 12px;
        overflow-wrap: anywhere;
        white-space: normal;
    }

    .community-tags :deep(.nn-tag) {
        font-family: var(--nn-font-family-monospace, Consolas, monospace);
    }
    @media (max-width: 720px) {
        .summary-grid {
            grid-template-columns: repeat(2, minmax(110px, 1fr));
        }
    }
</style>
