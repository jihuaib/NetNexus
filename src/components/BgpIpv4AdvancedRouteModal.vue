<template>
    <nn-modal
        :open="open"
        :title="title"
        :width="840"
        class="bgp-route-advanced-modal"
        data-testid="bgp-route-advanced-modal"
        ok-text="应用"
        cancel-text="取消"
        @ok="apply"
        @cancel="close"
    >
        <nn-form :model="draft" :label-col="advancedLabelCol" layout="horizontal" class="bgp-route-advanced-form">
            <nn-alert v-if="advancedErrorMessage" type="error" :message="advancedErrorMessage" show-icon />
            <BgpRandomAsPathFields :config="draft" @change="(field, value) => (draft[field] = value)" />

            <div v-if="showLabel && isLabelRoute" class="advanced-section">
                <div class="section-title">MPLS Label</div>
                <nn-row :gutter="[12, 0]">
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="标签模式">
                            <nn-radio-group v-model:value="draft.labelMode" size="small">
                                <nn-radio :value="BGP_LABEL_MODE.FIXED">固定</nn-radio>
                                <nn-radio :value="BGP_LABEL_MODE.INCREMENT">递增</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="Label">
                            <nn-input v-model:value="draft.labelStart" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="Step">
                            <nn-input
                                v-model:value="draft.labelStep"
                                :disabled="draft.labelMode !== BGP_LABEL_MODE.INCREMENT"
                            />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>

            <div v-if="showQp" class="advanced-section">
                <div class="section-title">生成策略</div>
                <nn-row :gutter="[12, 0]">
                    <nn-col :xs="24" :sm="12" :lg="16">
                        <nn-form-item label="增长模式">
                            <nn-radio-group v-model:value="draft.routeGrowthMode" size="small">
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN">IP + DQPN</nn-radio>
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP">仅 IP</nn-radio>
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.DQPN">仅 DQPN</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="IP Step">
                            <nn-input v-model:value="draft.ipStep" :disabled="!qpGrowthIncludesIp" />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>

            <div v-if="showQp" class="advanced-section">
                <div class="section-title">DQPN</div>
                <nn-row :gutter="[12, 0]">
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="Start DQPN">
                            <nn-input v-model:value="draft.startDqpn" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="DQPN Step">
                            <nn-input v-model:value="draft.dqpnStep" :disabled="!qpGrowthIncludesDqpn" />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>

            <div v-if="showAddPath && !isLabelRoute" class="advanced-section">
                <div class="section-title">ADD-PATH</div>
                <nn-row :gutter="[12, 0]">
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="生成多路径">
                            <nn-switch v-model:checked="draft.addPathEnabled" size="small" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="Path Count">
                            <nn-input v-model:value="draft.addPathCount" :disabled="!draft.addPathEnabled" />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>

            <div v-if="showSrv6 && !isLabelRoute" class="advanced-section">
                <div class="section-title">SRv6</div>
                <nn-row :gutter="[12, 0]">
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="发送 SID">
                            <nn-switch v-model:checked="draft.srv6Enabled" size="small" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="SID 模式">
                            <nn-radio-group
                                v-model:value="draft.srv6SidMode"
                                size="small"
                                :disabled="!draft.srv6Enabled"
                            >
                                <nn-radio :value="BGP_SRV6_SID_MODE.FIXED">固定</nn-radio>
                                <nn-radio :value="BGP_SRV6_SID_MODE.INCREMENT">递增</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12" :lg="8">
                        <nn-form-item label="SID">
                            <nn-input v-model:value="draft.srv6Sid" :disabled="!draft.srv6Enabled" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="SID Step">
                            <nn-input
                                v-model:value="draft.srv6SidStep"
                                :disabled="!draft.srv6Enabled || draft.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT"
                            />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="Endpoint">
                            <nn-select
                                v-model:value="draft.srv6EndpointBehavior"
                                :options="endpointOptions"
                                :disabled="!draft.srv6Enabled"
                            />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>
        </nn-form>
    </nn-modal>
</template>

<script setup>
    import { computed, reactive, watch } from 'vue';
    import { BGP_LABEL_MODE, BGP_QP_ROUTE_GROWTH_MODE, BGP_SRV6_SID_MODE } from '../const/bgpConst';
    import BgpRandomAsPathFields from './BgpRandomAsPathFields.vue';

    const props = defineProps({
        open: { type: Boolean, default: false },
        config: { type: Object, required: true },
        isLabelRoute: { type: Boolean, default: false },
        endpointOptions: { type: Array, default: () => [] },
        validationErrors: { type: Object, default: () => ({}) },
        title: { type: String, default: '路由高级配置' },
        showAddPath: { type: Boolean, default: false },
        showSrv6: { type: Boolean, default: false },
        showQp: { type: Boolean, default: false },
        showLabel: { type: Boolean, default: false }
    });
    const emit = defineEmits(['update:open', 'apply']);
    const advancedLabelCol = { style: { width: '88px' } };
    const draft = reactive({});
    const advancedErrorMessage = computed(() =>
        ['ipStep', 'startDqpn', 'dqpnStep', 'labelMode', 'labelStart', 'labelStep']
            .map(field => props.validationErrors[field])
            .find(Boolean)
    );
    const qpGrowthIncludesDqpn = computed(() =>
        [BGP_QP_ROUTE_GROWTH_MODE.DQPN, BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN].includes(draft.routeGrowthMode)
    );
    const qpGrowthIncludesIp = computed(() =>
        [BGP_QP_ROUTE_GROWTH_MODE.IP, BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN].includes(draft.routeGrowthMode)
    );

    watch(
        () => props.open,
        value => {
            if (value) Object.assign(draft, props.config);
        },
        { immediate: true }
    );

    const close = () => emit('update:open', false);
    const apply = () => {
        emit('apply', { ...draft });
        close();
    };
</script>

<style scoped>
    :global(.bgp-route-advanced-modal.nn-modal) {
        max-width: calc(100vw - 32px) !important;
    }

    :global(.bgp-route-advanced-modal .nn-modal-content) {
        padding: 0 !important;
    }

    :global(.bgp-route-advanced-modal .nn-modal-header) {
        min-height: 44px !important;
        padding: 8px 14px !important;
    }

    :global(.bgp-route-advanced-modal .nn-modal-body) {
        min-height: 0 !important;
        padding: 10px 14px !important;
    }

    :global(.bgp-route-advanced-modal .nn-modal-footer) {
        min-height: 44px !important;
        padding: 7px 14px !important;
    }

    .advanced-section + .advanced-section {
        margin-top: 4px;
        padding-top: 10px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .bgp-route-advanced-form {
        font-size: 13px !important;
    }

    .bgp-route-advanced-form :deep(.section-title) {
        margin-bottom: 6px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
        line-height: 20px;
    }

    .bgp-route-advanced-form :deep(.nn-form-item) {
        margin-bottom: 6px !important;
    }

    .bgp-route-advanced-form :deep(.nn-form-item-horizontal .nn-form-item-label) {
        padding-right: 8px;
    }

    .bgp-route-advanced-form :deep(.nn-form-item-label > label) {
        min-height: 28px;
        font-size: 12px;
    }

    .bgp-route-advanced-form :deep(.nn-form-item-control-input) {
        min-height: 28px;
    }

    .bgp-route-advanced-form :deep(.nn-input) {
        height: 28px;
        padding: 2px 8px !important;
        font-size: 13px !important;
    }

    .bgp-route-advanced-form :deep(.nn-select) {
        min-height: 28px;
        padding-inline: 8px;
        font-size: 13px;
    }

    .bgp-route-advanced-form :deep(.nn-radio-group) {
        column-gap: 12px;
        row-gap: 4px;
    }

    .bgp-route-advanced-form :deep(.nn-radio-wrapper) {
        font-size: 13px;
    }

    .bgp-route-advanced-form :deep(.nn-alert) {
        margin-bottom: 8px;
    }

    @media (max-width: 720px) {
        .bgp-route-advanced-form :deep(.nn-form-item-horizontal .nn-form-item-label) {
            padding: 0 0 2px;
        }

        .bgp-route-advanced-form :deep(.nn-form-item-horizontal .nn-form-item-label > label) {
            min-height: 20px;
        }
    }
</style>
