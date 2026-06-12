<template>
    <div class="mt-container bgp-config-page">
        <!-- BGP 配置 Card -->
        <a-form :model="bgpConfigData" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBgp">
            <a-card title="BGP配置" class="bgp-config-card">
                <a-row>
                    <a-col :span="12">
                        <a-form-item label="Local AS" name="localAs">
                            <a-tooltip
                                :title="bgpConfigvalidationErrors.localAs"
                                :open="!!bgpConfigvalidationErrors.localAs"
                            >
                                <a-input
                                    v-model:value="bgpConfigData.localAs"
                                    :disabled="bgpRunning"
                                    :status="bgpConfigvalidationErrors.localAs ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="12">
                        <a-form-item label="Router ID" name="routerId">
                            <a-tooltip
                                :title="bgpConfigvalidationErrors.routerId"
                                :open="!!bgpConfigvalidationErrors.routerId"
                            >
                                <a-input
                                    v-model:value="bgpConfigData.routerId"
                                    :disabled="bgpRunning"
                                    :status="bgpConfigvalidationErrors.routerId ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <a-row>
                    <a-col :span="12">
                        <a-form-item label="地址族" name="addressFamily">
                            <a-select
                                v-model:value="bgpConfigData.addressFamily"
                                :disabled="bgpRunning"
                                mode="multiple"
                                style="width: 100%"
                                :options="bgpAddressFamilyOptions"
                            />
                        </a-form-item>
                    </a-col>
                </a-row>

                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <a-space size="middle">
                        <a-button type="primary" html-type="submit" :loading="bgpLoading" :disabled="bgpRunning">
                            启动BGP
                        </a-button>
                        <a-button type="primary" danger :disabled="!bgpRunning" @click="stopBgp">停止BGP</a-button>
                    </a-space>
                </a-form-item>
            </a-card>
        </a-form>

        <!-- BGP 状态信息 Card -->
        <a-card title="BGP 状态信息" class="status-card">
            <a-table
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
                        <a-tag color="blue">{{ getAddressFamilyLabel(record.addressFamily) }}</a-tag>
                    </template>
                    <template v-else-if="column.key === 'singleRouteSend'">
                        <a-tag :color="record.singleRouteSend ? 'orange' : 'cyan'">
                            {{ record.singleRouteSend ? '开启' : '关闭' }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'routeCount'">
                        <a-badge
                            :count="record.routeCount"
                            :overflow-count="999999"
                            :number-style="{ backgroundColor: '#52c41a' }"
                            show-zero
                        />
                    </template>
                </template>
            </a-table>
        </a-card>
    </div>
</template>

<script setup>
    import { onMounted, onActivated, ref } from 'vue';
    import { message } from 'ant-design-vue';
    import { BGP_ADDR_FAMILY, DEFAULT_VALUES } from '../../const/bgpConst';
    import { FormValidator, createBgpConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'BgpConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const bgpAddressFamilyOptions = [
        { label: 'Ipv4-UNC', value: BGP_ADDR_FAMILY.IPV4_UNC, disabled: true },
        { label: 'Ipv6-UNC', value: BGP_ADDR_FAMILY.IPV6_UNC },
        { label: 'IPv4-MVPN', value: BGP_ADDR_FAMILY.IPV4_MVPN },
        { label: 'IPv6-MVPN', value: BGP_ADDR_FAMILY.IPV6_MVPN },
        { label: 'IPv4-QP', value: BGP_ADDR_FAMILY.IPV4_QP },
        { label: 'IPv6-QP', value: BGP_ADDR_FAMILY.IPV6_QP }
    ];

    const bgpConfigData = ref({
        localAs: DEFAULT_VALUES.LOCAL_AS,
        routerId: DEFAULT_VALUES.ROUTER_ID,
        addressFamily: [BGP_ADDR_FAMILY.IPV4_UNC]
    });

    const bgpConfigvalidationErrors = ref({
        localAs: '',
        routerId: ''
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

    const instanceColumns = [
        { title: '地址族', dataIndex: 'addressFamily', key: 'addressFamily' },
        { title: 'PEER数量', dataIndex: 'peerCount', key: 'peerCount', align: 'center' },
        { title: '路由数量', dataIndex: 'routeCount', key: 'routeCount', align: 'center' },
        { title: '单条发送', dataIndex: 'singleRouteSend', key: 'singleRouteSend', align: 'center' }
    ];

    const fetchInstanceInfo = async () => {
        if (!bgpRunning.value) return;
        try {
            const result = await window.bgpApi.getInstanceInfo();
            if (result.status === 'success') {
                instanceInfoList.value = result.data;
            }
        } catch (error) {
            console.error('获取实例信息失败', error);
        }
    };

    onMounted(async () => {
        // 加载Bgp保存的配置
        const savedBgpConfig = await window.bgpApi.loadBgpConfig();
        if (savedBgpConfig.status === 'success' && savedBgpConfig.data) {
            bgpConfigData.value.localAs = savedBgpConfig.data.localAs;
            bgpConfigData.value.routerId = savedBgpConfig.data.routerId;
            bgpConfigData.value.addressFamily = Array.isArray(savedBgpConfig.data.addressFamily)
                ? [...savedBgpConfig.data.addressFamily]
                : [BGP_ADDR_FAMILY.IPV4_UNC];
        } else {
            console.error('BGP 配置文件加载失败', savedBgpConfig.msg);
        }
    });

    onActivated(() => {
        if (bgpRunning.value) {
            fetchInstanceInfo();
        }
    });

    const startBgp = async () => {
        const hasErrors = bgpValidator.validate(bgpConfigData.value);
        if (hasErrors) {
            message.error('请检查BGP配置信息是否正确');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(bgpConfigData.value));
            const saveResult = await window.bgpApi.saveBgpConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            bgpLoading.value = true;
            bgpRunning.value = false;

            const result = await window.bgpApi.startBgp(payload);
            if (result.status === 'success') {
                bgpLoading.value = false;
                bgpRunning.value = true;
                message.success('BGP 启动成功');
                fetchInstanceInfo();
            } else {
                bgpLoading.value = false;
                message.error(result.msg || 'BGP启动失败');
            }
        } catch (e) {
            bgpLoading.value = false;
            message.error(e);
        }
    };

    const stopBgp = async () => {
        const result = await window.bgpApi.stopBgp();
        if (result.status === 'success') {
            message.success(result.msg);
            bgpRunning.value = false;
            instanceInfoList.value = [];
        } else {
            message.error(result.msg || 'BGP停止失败');
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
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow: hidden;
    }

    .bgp-config-page > .ant-form {
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

    .status-card :deep(.ant-card-body) {
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
        color: #8c8c8c;
        margin-bottom: 8px;
    }

    .status-value {
        font-size: 14px;
        font-weight: 500;
        color: #262626;
        min-height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .instance-table,
    .instance-table :deep(.ant-spin-nested-loading),
    .instance-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .instance-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .instance-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .instance-table :deep(.ant-table-container),
    .instance-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .instance-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .instance-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .instance-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .instance-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
