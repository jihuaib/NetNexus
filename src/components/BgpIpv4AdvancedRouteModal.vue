<template>
    <nn-modal
        :open="open"
        :title="title"
        class="modal-large"
        ok-text="应用"
        cancel-text="取消"
        @ok="apply"
        @cancel="close"
    >
        <nn-form :model="draft" layout="vertical">
            <nn-alert v-if="advancedErrorMessage" type="error" :message="advancedErrorMessage" show-icon />
            <BgpRandomAsPathFields :config="draft" @change="(field, value) => (draft[field] = value)" />

            <div v-if="showLabel && isLabelRoute" class="advanced-section">
                <div class="section-title">MPLS Label</div>
                <nn-row :gutter="[16, 0]">
                    <nn-col :xs="24" :sm="8">
                        <nn-form-item label="标签模式">
                            <nn-radio-group v-model:value="draft.labelMode">
                                <nn-radio :value="BGP_LABEL_MODE.FIXED">固定</nn-radio>
                                <nn-radio :value="BGP_LABEL_MODE.INCREMENT">递增</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="8">
                        <nn-form-item label="Label">
                            <nn-input v-model:value="draft.labelStart" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="8">
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
                <nn-row :gutter="[16, 0]">
                    <nn-col :xs="24" :sm="16">
                        <nn-form-item label="增长模式">
                            <nn-radio-group v-model:value="draft.routeGrowthMode">
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN">IP + DQPN</nn-radio>
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP">仅 IP</nn-radio>
                                <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.DQPN">仅 DQPN</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="8">
                        <nn-form-item label="IP Step">
                            <nn-input v-model:value="draft.ipStep" :disabled="!qpGrowthIncludesIp" />
                        </nn-form-item>
                    </nn-col>
                </nn-row>
            </div>

            <div v-if="showQp" class="advanced-section">
                <div class="section-title">DQPN</div>
                <nn-row :gutter="[16, 0]">
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
                <nn-row :gutter="[16, 0]">
                    <nn-col :xs="24" :sm="12">
                        <nn-form-item label="生成多路径">
                            <nn-switch v-model:checked="draft.addPathEnabled" />
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
                <nn-row :gutter="[16, 0]">
                    <nn-col :xs="24" :sm="8">
                        <nn-form-item label="发送 SID">
                            <nn-switch v-model:checked="draft.srv6Enabled" />
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="8">
                        <nn-form-item label="SID 模式">
                            <nn-radio-group v-model:value="draft.srv6SidMode" :disabled="!draft.srv6Enabled">
                                <nn-radio :value="BGP_SRV6_SID_MODE.FIXED">固定</nn-radio>
                                <nn-radio :value="BGP_SRV6_SID_MODE.INCREMENT">递增</nn-radio>
                            </nn-radio-group>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :xs="24" :sm="8">
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
    .advanced-section + .advanced-section {
        margin-top: 12px;
        padding-top: 16px;
        border-top: 1px solid var(--nn-border-color, #e5e7eb);
    }

    .section-title {
        margin-bottom: 12px;
        font-weight: 600;
    }
</style>
