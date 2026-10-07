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
                        <template v-if="activeTabKey === tab.key">
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
                                    <div class="section-title">路由与来源</div>
                                    <nn-descriptions :column="2" bordered size="small">
                                        <nn-descriptions-item
                                            v-for="item in overviewDetails"
                                            :key="item.label"
                                            :label="item.label"
                                            :span="item.span || 1"
                                        >
                                            <code v-if="item.kind === 'path'" class="readable-code readable-path">
                                                {{ item.value }}
                                            </code>
                                            <span v-else class="detail-value">{{ item.value }}</span>
                                        </nn-descriptions-item>
                                    </nn-descriptions>
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
                                class="detail-section readable-section"
                                :data-testid="section.testId"
                            >
                                <div v-if="section.title" class="section-heading">
                                    <h3>{{ section.title }}</h3>
                                    <span>{{ section.groups.length }} 项</span>
                                </div>
                                <div v-if="section.groups.length" class="readable-grid">
                                    <article
                                        v-for="group in section.groups"
                                        :key="group.key"
                                        class="readable-card"
                                        :class="{
                                            'readable-card-wide':
                                                group.tags?.length > 8 ||
                                                group.items?.some(item => item.kind === 'path' || item.kind === 'list')
                                        }"
                                        :data-testid="section.cardTestId"
                                        :data-group-key="group.key"
                                    >
                                        <div class="readable-card-heading">
                                            <h4>{{ group.title }}</h4>
                                            <p v-if="group.description">{{ group.description }}</p>
                                        </div>
                                        <nn-descriptions
                                            v-if="group.items?.length"
                                            :column="1"
                                            size="small"
                                            class="readable-descriptions"
                                        >
                                            <nn-descriptions-item
                                                v-for="(item, index) in group.items"
                                                :key="item.key || index"
                                                :label="item.label"
                                            >
                                                <ul
                                                    v-if="item.kind === 'list' && Array.isArray(item.value)"
                                                    class="readable-list"
                                                >
                                                    <li v-for="(value, valueIndex) in item.value" :key="valueIndex">
                                                        {{ value }}
                                                    </li>
                                                </ul>
                                                <code
                                                    v-else-if="item.kind === 'path' || item.kind === 'code'"
                                                    class="readable-code"
                                                    :class="{ 'readable-path': item.kind === 'path' }"
                                                >
                                                    {{ item.value }}
                                                </code>
                                                <span v-else class="detail-value">{{ item.value }}</span>
                                            </nn-descriptions-item>
                                        </nn-descriptions>
                                        <div v-if="group.tags?.length" class="community-tags">
                                            <nn-tag
                                                v-for="(tag, index) in visibleTags(section.key, group)"
                                                :key="index"
                                            >
                                                {{ tag }}
                                            </nn-tag>
                                            <nn-button
                                                v-if="group.tags.length > 8"
                                                type="link"
                                                size="small"
                                                class="tags-toggle"
                                                :aria-expanded="isGroupExpanded(section.key, group.key)"
                                                data-testid="bmp-route-detail-tags-toggle"
                                                @click="toggleGroupTags(section.key, group.key)"
                                            >
                                                {{
                                                    isGroupExpanded(section.key, group.key)
                                                        ? '收起'
                                                        : '展开全部（' + group.tags.length + '）'
                                                }}
                                            </nn-button>
                                        </div>
                                        <details
                                            v-if="group.raw !== null && group.raw !== undefined"
                                            class="raw-content"
                                        >
                                            <summary>查看原始内容</summary>
                                            <code>{{ group.raw || '无属性值' }}</code>
                                        </details>
                                    </article>
                                </div>
                                <nn-empty v-else-if="section.emptyText" :description="section.emptyText" />
                            </section>
                        </template>
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
        formatReadableAsPath,
        formatReadableNextHop,
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
    const expandedTagGroups = ref(new Set());
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
    const ownerText = computed(() => {
        const { owner, client } = routeContext.value;
        const address = owner.sessionIp ?? owner.instanceIp ?? owner.ip;
        return [formatBmpClientLabel(client), address].filter(value => value && value !== '-').join(' · ');
    });
    const overviewDetails = computed(() => {
        const route = record.value;
        const { owner, client, stage, vrf } = routeContext.value;
        return [
            { label: 'RIB 阶段', value: stage },
            { label: 'VRF / RD', value: displayValue(vrf) },
            { label: 'BMP Client', value: formatBmpClientLabel(client) },
            { label: 'Peer / 实例地址', value: displayValue(owner.sessionIp ?? owner.instanceIp ?? owner.ip) },
            { label: 'Peer / 实例 AS', value: displayValue(owner.sessionAs ?? owner.instanceAs ?? owner.as) },
            { label: '下一跳', value: formatReadableNextHop(route.nextHop) || '-' },
            { label: '本地优先级', value: displayValue(route.localPref) },
            { label: 'MED', value: displayValue(route.med) },
            {
                label: 'AS 路径（生效）',
                value:
                    route.asPath === null || route.asPath === undefined ? '未上报' : formatReadableAsPath(route.asPath),
                kind: 'path',
                span: 2
            }
        ];
    });
    const readableTabs = computed(() => [
        {
            key: 'overview',
            label: '路由概览',
            testId: 'bmp-route-detail-overview',
            sections: [
                {
                    key: 'overview',
                    groups: readableModel.value.overviewGroups,
                    cardTestId: 'bmp-route-detail-overview-card'
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
                    groups: readableModel.value.attributes,
                    emptyText: '暂无 BGP 路径属性',
                    cardTestId: 'bmp-route-detail-attribute-card'
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
                    groups: readableModel.value.nlri,
                    emptyText: '暂无 NLRI 明细',
                    cardTestId: 'bmp-route-detail-nlri-card'
                },
                {
                    key: 'tlvs',
                    title: '设备上报的路由扩展',
                    groups: readableModel.value.tlvs,
                    emptyText: '暂无路由扩展',
                    testId: 'bmp-route-detail-tlvs',
                    cardTestId: 'bmp-route-detail-tlv-card'
                }
            ]
        }
    ]);
    const tagGroupKey = (section, key) => section + ':' + key;
    const isGroupExpanded = (section, key) => expandedTagGroups.value.has(tagGroupKey(section, key));
    const visibleTags = (section, group) => (isGroupExpanded(section, group.key) ? group.tags : group.tags.slice(0, 8));
    const toggleGroupTags = (section, key) => {
        const groups = new Set(expandedTagGroups.value);
        const groupKey = tagGroupKey(section, key);
        if (groups.has(groupKey)) groups.delete(groupKey);
        else groups.add(groupKey);
        expandedTagGroups.value = groups;
    };
    const close = () => emit('update:open', false);
    const handleOpenChange = value => emit('update:open', value);
    watch(
        () => props.open,
        value => {
            if (value) {
                activeTabKey.value = 'overview';
                expandedTagGroups.value = new Set();
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
        margin-bottom: 14px;
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

    .section-title,
    .section-heading h3 {
        margin: 0 0 8px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 650;
    }

    .section-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
    }

    .section-heading h3 {
        margin-bottom: 0;
        font-size: 14px;
    }

    .section-heading span {
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .evidence-alert {
        margin-top: 16px;
    }

    .readable-section:first-child {
        margin-top: 2px;
    }

    .readable-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-flow: dense;
        align-items: start;
        gap: 12px;
    }

    .readable-card {
        min-width: 0;
        padding: 14px 16px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-muted);
    }

    .readable-card-wide {
        grid-column: 1 / -1;
    }

    .readable-card-heading h4 {
        margin: 0;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        line-height: 1.5;
        font-weight: 650;
    }

    .readable-card-heading p {
        margin: 4px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 1.6;
    }

    .readable-descriptions {
        margin-top: 12px;
    }

    .readable-descriptions :deep(.nn-descriptions-item-label) {
        width: 118px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .readable-descriptions :deep(.nn-descriptions-item-content) {
        color: var(--nn-color-text-strong);
        font-size: 12px;
    }

    .detail-value,
    .readable-code {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    .readable-code {
        font-family: var(--nn-font-family-monospace, Consolas, monospace);
        line-height: 1.8;
    }

    .readable-path {
        display: block;
        font-size: 14px;
        font-weight: 500;
    }

    .readable-list {
        margin: 0;
        padding-left: 16px;
        line-height: 1.8;
        overflow-wrap: anywhere;
    }

    .community-tags {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
        margin-top: 12px;
    }

    .community-tags :deep(.nn-tag) {
        margin: 0;
        max-width: 100%;
        padding: 3px 8px;
        font-family: var(--nn-font-family-monospace, Consolas, monospace);
        font-size: 12px;
        overflow-wrap: anywhere;
        white-space: normal;
    }

    .tags-toggle {
        padding: 0 2px;
    }

    .raw-content {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px dashed var(--nn-color-border-light);
    }

    .raw-content summary {
        color: var(--nn-color-text-muted);
        font-size: 11px;
        cursor: pointer;
    }

    .raw-content code {
        display: block;
        max-height: 180px;
        overflow: auto;
        margin-top: 8px;
        padding: 10px;
        border-radius: 5px;
        color: var(--nn-color-text-secondary);
        background: var(--nn-color-bg-muted);
        font-size: 11px;
        line-height: 1.7;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    @media (max-width: 720px) {
        .summary-grid {
            grid-template-columns: repeat(2, minmax(110px, 1fr));
        }

        .readable-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
