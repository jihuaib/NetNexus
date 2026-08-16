<template>
    <div class="nn-container bgp-config-page" data-testid="bgp-config-page">
        <!-- BGP 配置 Card -->
        <nn-form :model="bgpConfigData" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBgp">
            <nn-card title="BGP配置" class="bgp-config-card">
                <nn-row>
                    <nn-col :span="8">
                        <nn-form-item label="Local AS" name="localAs">
                            <nn-tooltip
                                :title="bgpConfigvalidationErrors.localAs"
                                :open="!!bgpConfigvalidationErrors.localAs"
                            >
                                <nn-input
                                    v-model:value="bgpConfigData.localAs"
                                    data-testid="bgp-local-as-input"
                                    :disabled="bgpRunning"
                                    :status="bgpConfigvalidationErrors.localAs ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <nn-form-item label="Router ID" name="routerId">
                            <nn-tooltip
                                :title="bgpConfigvalidationErrors.routerId"
                                :open="!!bgpConfigvalidationErrors.routerId"
                            >
                                <nn-input
                                    v-model:value="bgpConfigData.routerId"
                                    data-testid="bgp-router-id-input"
                                    :disabled="bgpRunning"
                                    :status="bgpConfigvalidationErrors.routerId ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <nn-form-item label="监听端口" name="port">
                            <nn-tooltip
                                :title="bgpConfigvalidationErrors.port"
                                :open="!!bgpConfigvalidationErrors.port"
                            >
                                <nn-input
                                    v-model:value="bgpConfigData.port"
                                    data-testid="bgp-port-input"
                                    :disabled="bgpRunning"
                                    :status="bgpConfigvalidationErrors.port ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                </nn-row>
                <nn-row>
                    <nn-col :span="12">
                        <nn-form-item label="地址族" name="addressFamily">
                            <nn-select
                                v-model:value="bgpConfigData.addressFamily"
                                :disabled="bgpRunning"
                                mode="multiple"
                                style="width: 100%"
                                :options="bgpAddressFamilyOptions"
                            />
                        </nn-form-item>
                    </nn-col>
                </nn-row>

                <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <nn-space size="middle">
                        <nn-button
                            data-testid="bgp-start-button"
                            type="primary"
                            html-type="submit"
                            :loading="bgpLoading"
                            :disabled="bgpRunning"
                        >
                            启动BGP
                        </nn-button>
                        <nn-button
                            data-testid="bgp-stop-button"
                            type="primary"
                            danger
                            :disabled="!bgpRunning"
                            @click="stopBgp"
                        >
                            停止BGP
                        </nn-button>
                    </nn-space>
                </nn-form-item>
            </nn-card>
        </nn-form>

        <!-- BGP 状态信息 Card -->
        <nn-card title="BGP 状态信息" class="status-card">
            <nn-table
                data-testid="bgp-instance-table"
                :columns="instanceColumns"
                :data-source="instanceInfoList"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    position: ['bottomCenter'],
                    showTotal: total => '共 ' + total + ' 条，每页 20 条'
                }"
                :scroll="{ y: '100%' }"
                size="middle"
                class="instance-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'addressFamily'">
                        <nn-tag color="blue">{{ getAddressFamilyLabel(record.addressFamily) }}</nn-tag>
                    </template>
                    <template v-else-if="column.key === 'routeCount'">
                        <nn-badge
                            :count="record.routeCount"
                            :overflow-count="999999"
                            :number-style="{ backgroundColor: 'var(--nn-color-success)' }"
                            show-zero
                        />
                    </template>
                </template>
            </nn-table>
        </nn-card>
    </div>
</template>

<script setup>
    import { onBeforeUnmount, onMounted, onActivated, ref } from 'vue';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import {
        BGP_ADDR_FAMILY,
        BGP_EVENT_PAGE_ID,
        BGP_RUNTIME_CHANGED_EVENT,
        DEFAULT_VALUES
    } from '../../const/bgpConst';
    import { FormValidator, createBgpConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'BgpConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const bgpAddressFamilyOptions = [
        { label: 'Ipv4-UNC', value: BGP_ADDR_FAMILY.IPV4_UNC, disabled: true },
        { label: 'IPv4 Label', value: BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST },
        { label: 'Ipv6-UNC', value: BGP_ADDR_FAMILY.IPV6_UNC },
        { label: 'IPv4-MVPN', value: BGP_ADDR_FAMILY.IPV4_MVPN },
        { label: 'IPv6-MVPN', value: BGP_ADDR_FAMILY.IPV6_MVPN },
        { label: 'IPv4-QP', value: BGP_ADDR_FAMILY.IPV4_QP },
        { label: 'IPv6-QP', value: BGP_ADDR_FAMILY.IPV6_QP }
    ];

    const bgpConfigData = ref({
        localAs: DEFAULT_VALUES.LOCAL_AS,
        routerId: DEFAULT_VALUES.ROUTER_ID,
        port: DEFAULT_VALUES.BGP_PORT,
        addressFamily: [BGP_ADDR_FAMILY.IPV4_UNC]
    });

    const bgpConfigvalidationErrors = ref({
        localAs: '',
        routerId: '',
        port: ''
    });

    let bgpValidator = new FormValidator(bgpConfigvalidationErrors);
    bgpValidator.addRules(createBgpConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (bgpValidator) {
                bgpValidator.clearErrors();
            }
        }
    });

    const bgpLoading = ref(false);
    const bgpRunning = ref(false);
    const instanceInfoList = ref([]);
    let instanceInfoRequestId = 0;

    const clearInstanceInfo = () => {
        instanceInfoRequestId += 1;
        instanceInfoList.value = [];
    };

    const handleRuntimeChanged = state => {
        bgpRunning.value = Boolean(state?.running);
        clearInstanceInfo();
        if (bgpRunning.value) {
            fetchInstanceInfo();
            return;
        }
        bgpLoading.value = false;
    };

    const instanceColumns = [
        { title: '地址族', dataIndex: 'addressFamily', key: 'addressFamily' },
        { title: 'PEER数量', dataIndex: 'peerCount', key: 'peerCount', align: 'center' },
        { title: '路由数量', dataIndex: 'routeCount', key: 'routeCount', align: 'center' }
    ];

    const fetchInstanceInfo = async () => {
        if (!bgpRunning.value) return;
        const requestId = ++instanceInfoRequestId;
        try {
            const result = await window.bgpApi.getInstanceInfo();
            if (requestId === instanceInfoRequestId && bgpRunning.value && result.status === 'success') {
                instanceInfoList.value = result.data;
            }
        } catch (error) {
            console.error('获取实例信息失败', error);
        }
    };

    onMounted(async () => {
        EventBus.on(BGP_RUNTIME_CHANGED_EVENT, BGP_EVENT_PAGE_ID.PAGE_ID_BGP_CONFIG, handleRuntimeChanged);
        // 加载Bgp保存的配置
        const savedBgpConfig = await window.bgpApi.loadBgpConfig();
        if (savedBgpConfig.status === 'success') {
            if (savedBgpConfig.data) {
                bgpConfigData.value.localAs = savedBgpConfig.data.localAs;
                bgpConfigData.value.routerId = savedBgpConfig.data.routerId;
                bgpConfigData.value.port = savedBgpConfig.data.port || DEFAULT_VALUES.BGP_PORT;
                bgpConfigData.value.addressFamily = Array.isArray(savedBgpConfig.data.addressFamily)
                    ? [...savedBgpConfig.data.addressFamily]
                    : [BGP_ADDR_FAMILY.IPV4_UNC];
            }
        } else {
            console.error('BGP 配置文件加载失败', savedBgpConfig.msg);
        }
    });

    onBeforeUnmount(() => {
        EventBus.off(BGP_RUNTIME_CHANGED_EVENT, BGP_EVENT_PAGE_ID.PAGE_ID_BGP_CONFIG);
    });

    onActivated(() => {
        if (bgpRunning.value) {
            fetchInstanceInfo();
        }
    });

    const startBgp = async () => {
        const hasErrors = bgpValidator.validate(bgpConfigData.value);
        if (hasErrors) {
            notify.error('请检查BGP配置信息是否正确');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(bgpConfigData.value));
            const saveResult = await window.bgpApi.saveBgpConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            bgpLoading.value = true;
            bgpRunning.value = false;
            clearInstanceInfo();

            const result = await window.bgpApi.startBgp(payload);
            if (result.status === 'success') {
                bgpLoading.value = false;
                const wasRunning = bgpRunning.value;
                bgpRunning.value = true;
                notify.success('BGP 启动成功');
                if (!wasRunning) fetchInstanceInfo();
            } else {
                bgpLoading.value = false;
                notify.error(result.msg || 'BGP启动失败');
            }
        } catch (e) {
            bgpLoading.value = false;
            notify.error(e);
        }
    };

    const stopBgp = async () => {
        const result = await window.bgpApi.stopBgp();
        if (result.status === 'success') {
            notify.success(result.msg);
            bgpRunning.value = false;
            clearInstanceInfo();
        } else {
            notify.error(result.msg || 'BGP停止失败');
        }
    };

    // 获取地址族标签
    const getAddressFamilyLabel = family => {
        const option = bgpAddressFamilyOptions.find(opt => opt.value === family);
        return option ? option.label : family;
    };
</script>

<style scoped>
    .bgp-config-page {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow: hidden;
    }

    .bgp-config-page > .nn-form {
        flex: 0 0 auto;
    }

    .bgp-config-card {
        flex: 0 0 auto;
    }

    .status-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        margin-top: 0;
    }

    .status-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .status-item {
        text-align: center;
    }

    .status-label {
        font-size: 12px;
        color: var(--nn-color-text-muted);
        margin-bottom: 8px;
    }

    .status-value {
        font-size: 14px;
        font-weight: 500;
        color: var(--nn-color-text-strong);
        min-height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .instance-table,
    .instance-table :deep(.nn-spin-nested-loading),
    .instance-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .instance-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .instance-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .instance-table :deep(.nn-table-container),
    .instance-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .instance-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .instance-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .instance-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .instance-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
