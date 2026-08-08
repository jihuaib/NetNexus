<template>
    <div class="nn-container bgp-route-page" data-testid="bgp-route-ipv6-page">
        <nn-card title="IPv6-UNC路由配置" class="bgp-route-card">
            <nn-form :model="ipv6Data" :label-col="labelCol" :wrapper-col="wrapperCol" class="bgp-route-form">
                <div class="config-section">
                    <div class="section-title">基础配置</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Prefix" name="prefix">
                                <nn-tooltip :title="validationErrors.prefix" :open="!!validationErrors.prefix">
                                    <nn-input
                                        v-model:value="ipv6Data.prefix"
                                        :status="validationErrors.prefix ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Mask" name="mask">
                                <nn-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                    <nn-input
                                        v-model:value="ipv6Data.mask"
                                        :status="validationErrors.mask ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Count" name="count">
                                <nn-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                    <nn-input
                                        v-model:value="ipv6Data.count"
                                        :status="validationErrors.count ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="RT" name="rt">
                                <nn-tooltip :title="validationErrors.rt" :open="!!validationErrors.rt">
                                    <nn-input
                                        v-model:value="ipv6Data.rt"
                                        :status="validationErrors.rt ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div v-if="false" class="config-section">
                    <div class="section-title">ADD-PATH</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="生成" name="addPathEnabled">
                                <nn-switch v-model:checked="ipv6Data.addPathEnabled" />
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Path Count" name="addPathCount">
                                <nn-tooltip
                                    :title="validationErrors.addPathCount"
                                    :open="!!validationErrors.addPathCount"
                                >
                                    <nn-input
                                        v-model:value="ipv6Data.addPathCount"
                                        :disabled="!ipv6Data.addPathEnabled"
                                        :status="validationErrors.addPathCount ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div v-if="false" class="config-section">
                    <div class="section-title">SRv6</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="发送SID" name="srv6Enabled">
                                <nn-switch v-model:checked="ipv6Data.srv6Enabled" />
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="SID模式" name="srv6SidMode">
                                <nn-tooltip
                                    :title="validationErrors.srv6SidMode"
                                    :open="!!validationErrors.srv6SidMode"
                                >
                                    <nn-radio-group
                                        v-model:value="ipv6Data.srv6SidMode"
                                        class="inline-radio-group"
                                        :disabled="!ipv6Data.srv6Enabled"
                                    >
                                        <nn-radio :value="BGP_SRV6_SID_MODE.FIXED">固定</nn-radio>
                                        <nn-radio :value="BGP_SRV6_SID_MODE.INCREMENT">递增</nn-radio>
                                    </nn-radio-group>
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="8">
                            <nn-form-item label="SID" name="srv6Sid">
                                <nn-tooltip :title="validationErrors.srv6Sid" :open="!!validationErrors.srv6Sid">
                                    <nn-input
                                        v-model:value="ipv6Data.srv6Sid"
                                        :disabled="!ipv6Data.srv6Enabled"
                                        :status="validationErrors.srv6Sid ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="SID Step" name="srv6SidStep">
                                <nn-tooltip
                                    :title="validationErrors.srv6SidStep"
                                    :open="!!validationErrors.srv6SidStep"
                                >
                                    <nn-input
                                        v-model:value="ipv6Data.srv6SidStep"
                                        :disabled="
                                            !ipv6Data.srv6Enabled ||
                                            ipv6Data.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT
                                        "
                                        :status="validationErrors.srv6SidStep ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Endpoint" name="srv6EndpointBehavior">
                                <nn-tooltip
                                    :title="validationErrors.srv6EndpointBehavior"
                                    :open="!!validationErrors.srv6EndpointBehavior"
                                >
                                    <nn-select
                                        v-model:value="ipv6Data.srv6EndpointBehavior"
                                        :options="srv6EndpointBehaviorOptions"
                                        :disabled="!ipv6Data.srv6Enabled"
                                        :status="validationErrors.srv6EndpointBehavior ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div class="action-row">
                    <div class="route-secondary-actions">
                        <nn-button class="custom-attr-button" type="link" @click="showCustomRouteAttr">
                            <template #icon><SettingOutlined /></template>
                            配置自定义路由属性
                        </nn-button>
                        <nn-button class="advanced-config-button" type="link" @click="advancedConfigVisible = true">
                            <template #icon><SettingOutlined /></template>
                            高级配置
                        </nn-button>
                    </div>
                    <nn-button
                        class="generate-route-button"
                        type="primary"
                        :loading="routesGenerating"
                        @click="generateRoutes"
                    >
                        生成IPv6路由
                    </nn-button>
                </div>
            </nn-form>
        </nn-card>

        <nn-card title="已生成IPv6路由列表" class="bgp-route-list-card">
            <template #extra>
                <nn-space>
                    <nn-button size="small" @click="showRouteViewsImport">从 RouteViews 导入</nn-button>
                    <nn-button
                        class="route-delete-all-button"
                        :disabled="!hasRoutes || deleteAllLoading"
                        :loading="deleteAllLoading"
                        danger
                        size="small"
                        @click="deleteAllRoutes"
                    >
                        <template #icon><DeleteOutlined /></template>
                        删除所有
                    </nn-button>
                </nn-space>
            </template>

            <nn-table
                data-testid="bgp-ipv6-route-table"
                :data-source="sentRoutes"
                :columns="routeColumns"
                :pagination="pagination"
                :loading="routeListLoading"
                size="small"
                :row-key="record => `${record.rd || '0:0'}-${record.pathId ?? 0}-${record.ip}-${record.mask}`"
                :scroll="{ y: '100%' }"
                class="bgp-route-table"
                @change="handleTableChange"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'action'">
                        <nn-space>
                            <nn-button size="small" @click="showRouteDetail(record)">
                                <template #icon><FileSearchOutlined /></template>
                                详情
                            </nn-button>
                            <nn-button type="primary" danger size="small" @click="deleteSingleRoute(record)">
                                <template #icon><DeleteOutlined /></template>
                                删除
                            </nn-button>
                        </nn-space>
                    </template>
                    <template v-else-if="column.key === 'ip'">
                        <div>{{ record.ip }}/{{ record.mask }}</div>
                    </template>
                </template>
            </nn-table>
        </nn-card>

        <CustomPktDrawer
            v-model:open="customRouteAttrVisible"
            v-model:input-value="ipv6Data.customAttr"
            @submit="handleCustomRouteAttrSubmit"
        />

        <BgpIpv4AdvancedRouteModal
            v-model:open="advancedConfigVisible"
            :config="ipv6Data"
            :endpoint-options="srv6EndpointBehaviorOptions"
            title="IPv6 路由高级配置"
            show-add-path
            show-srv6
            @apply="config => Object.assign(ipv6Data, config)"
        />

        <RouteViewsImportModal
            v-model:open="routeViewsImportVisible"
            :address-family="BGP_ADDR_FAMILY.IPV6_UNC"
            @imported="refreshRoutes"
        />

        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, onActivated, nextTick } from 'vue';
    import CustomPktDrawer from '../../components/CustomPktDrawer.vue';
    import RouteViewsImportModal from '../../components/RouteViewsImportModal.vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import BgpIpv4AdvancedRouteModal from '../../components/BgpIpv4AdvancedRouteModal.vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { DeleteOutlined, FileSearchOutlined, SettingOutlined } from 'netnexus-ui/icons';

    import {
        BGP_ADDR_FAMILY,
        BGP_SRV6_ENDPOINT_BEHAVIOR,
        BGP_SRV6_SID_MODE,
        DEFAULT_VALUES
    } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv6RouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv6'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const srv6EndpointBehaviorOptions = [
        { label: 'End.DT6', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6 },
        { label: 'End.DX6', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DX6 },
        { label: 'End.DT46', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT46 }
    ];

    const ipv6Data = ref({
        prefix: DEFAULT_VALUES.IPV6_PREFIX,
        mask: DEFAULT_VALUES.IPV6_MASK,
        count: DEFAULT_VALUES.IPV6_COUNT,
        randomAsPathEnabled: false,
        asMin: 64512,
        asMax: 65534,
        asPathMinLength: 1,
        asPathMaxLength: 5,
        addPathEnabled: DEFAULT_VALUES.IPV6_ADD_PATH_ENABLED,
        addPathCount: DEFAULT_VALUES.IPV6_ADD_PATH_COUNT,
        customAttr: '',
        rt: '',
        srv6Enabled: DEFAULT_VALUES.IPV6_SRV6_ENABLED,
        srv6SidMode: DEFAULT_VALUES.IPV6_SRV6_SID_MODE,
        srv6Sid: DEFAULT_VALUES.IPV6_SRV6_SID,
        srv6SidStep: DEFAULT_VALUES.IPV6_SRV6_SID_STEP,
        srv6EndpointBehavior: DEFAULT_VALUES.IPV6_SRV6_ENDPOINT_BEHAVIOR,
        addressFamily: BGP_ADDR_FAMILY.IPV6_UNC
    });

    const validationErrors = ref({
        prefix: '',
        mask: '',
        count: '',
        addPathCount: '',
        rt: '',
        srv6SidMode: '',
        srv6Sid: '',
        srv6SidStep: '',
        srv6EndpointBehavior: ''
    });

    const validator = new FormValidator(validationErrors);
    validator.addRules(createBgpIpv6RouteConfigValidationRules());

    // 暴露给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    const sentRoutes = ref([]);
    const routeListLoading = ref(false);
    let routeListRequestId = 0;
    const hasRoutes = computed(() => pagination.value.total > 0);
    const routesGenerating = ref(false);
    const deleteAllLoading = ref(false);

    const customRouteAttrVisible = ref(false);
    const advancedConfigVisible = ref(false);

    const showCustomRouteAttr = () => {
        customRouteAttrVisible.value = true;
    };

    const handleCustomRouteAttrSubmit = data => {
        ipv6Data.value.customAttr = data;
    };

    const routeViewsImportVisible = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);

    const showRouteViewsImport = () => {
        routeViewsImportVisible.value = true;
    };

    const routeColumns = computed(() => {
        const columns = [
            {
                title: '前缀',
                dataIndex: 'ip',
                key: 'ip',
                width: 240
            }
        ];

        columns.push(
            {
                title: 'RD',
                dataIndex: 'rd',
                key: 'rd',
                width: 90,
                customRender: ({ text }) => text || '0:0'
            },
            {
                title: 'Path ID',
                dataIndex: 'pathId',
                key: 'pathId',
                width: 90,
                customRender: ({ text }) => (text === undefined || text === null ? 0 : text)
            }
        );

        columns.push({
            title: 'RT',
            dataIndex: 'rt',
            key: 'rt',
            width: 150,
            ellipsis: true
        });

        if (sentRoutes.value.some(route => route.srv6Sid)) {
            columns.push({
                title: 'SRv6 SID',
                dataIndex: 'srv6Sid',
                key: 'srv6Sid',
                width: 220,
                ellipsis: true
            });
        }

        columns.push(
            {
                title: 'AS 路径',
                dataIndex: 'asPath',
                key: 'asPath',
                width: 180,
                ellipsis: true
            },
            {
                title: '操作',
                key: 'action',
                width: 150,
                align: 'center'
            }
        );

        return columns;
    });

    const pagination = ref({
        current: 1,
        pageSize: 25,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条，每页 25 条`
    });

    onMounted(async () => {
        // 加载保存的配置
        const savedConfig = await window.bgpApi.loadIpv6UNCRouteConfig();
        if (savedConfig.status === 'success') {
            if (savedConfig.data) {
                Object.assign(ipv6Data.value, savedConfig.data);
            }
        } else {
            console.error('IPv6-UNC路由配置文件加载失败', savedConfig.msg);
        }
    });

    onActivated(async () => {
        // 加载已生成的路由列表
        pagination.value.current = 1;
        await refreshRoutes();
    });

    const handleTableChange = (pag, _filters, _sorter) => {
        pagination.value.current = pag.current;
        refreshRoutes();
    };

    const refreshRoutes = async () => {
        const requestId = ++routeListRequestId;
        const current = pagination.value.current;
        const pageSize = pagination.value.pageSize;
        routeListLoading.value = true;

        try {
            const result = await window.bgpApi.getRoutes(BGP_ADDR_FAMILY.IPV6_UNC, current, pageSize);
            if (requestId !== routeListRequestId) {
                return;
            }

            if (result.status === 'success') {
                sentRoutes.value = result.data.list;
                pagination.value.total = result.data.total;
            } else {
                console.error(result.msg);
                sentRoutes.value = [];
                pagination.value.total = 0;
            }
        } catch (e) {
            if (requestId === routeListRequestId) {
                console.error(e);
                sentRoutes.value = [];
                pagination.value.total = 0;
            }
        } finally {
            if (requestId === routeListRequestId) {
                routeListLoading.value = false;
            }
        }
    };

    const refreshRoutesAfterSingleDelete = async () => {
        const remainingTotal = Math.max(0, pagination.value.total - 1);
        const lastPage = Math.max(1, Math.ceil(remainingTotal / pagination.value.pageSize));
        pagination.value.current = Math.min(pagination.value.current, lastPage);
        await refreshRoutes();
    };

    const generateRoutes = async () => {
        if (routesGenerating.value) {
            return;
        }

        try {
            const hasErrors = validator.validate(ipv6Data.value);
            if (hasErrors) {
                notify.error('请检查IPv6路由配置信息是否正确');
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = JSON.parse(JSON.stringify(ipv6Data.value));
            const saveResult = await window.bgpApi.saveIpv6UNCRouteConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv6Routes(payload);
            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                notify.error(`${result.msg}`);
            }
        } catch (e) {
            notify.error(`IPv6路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const showRouteDetail = async route => {
        routeDetailVisible.value = true;
        routeDetailLoading.value = true;
        routeDetail.value = null;

        try {
            const result = await window.bgpApi.getRouteDetail(BGP_ADDR_FAMILY.IPV6_UNC, {
                ip: route.ip,
                mask: route.mask,
                rd: route.rd,
                pathId: route.pathId
            });
            if (result.status === 'success') {
                routeDetail.value = result.data;
            } else {
                routeDetailVisible.value = false;
                notify.error(`路由详情查询失败: ${result.msg}`);
            }
        } catch (e) {
            routeDetailVisible.value = false;
            notify.error(`路由详情查询失败: ${e.message}`);
        } finally {
            routeDetailLoading.value = false;
        }
    };

    const deleteSingleRoute = async route => {
        try {
            const config = {
                prefix: route.ip,
                mask: parseInt(route.mask),
                rd: route.rd || '0:0',
                pathId: route.pathId ?? 0,
                count: 1,
                customAttr: route.customAttr || '',
                addressFamily: route.addressFamily
            };

            const result = await window.bgpApi.deleteIpv6Routes(config);

            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                await refreshRoutesAfterSingleDelete();
            } else {
                notify.error(`路由删除失败: ${result.msg}`);
            }
        } catch (e) {
            notify.error(`路由删除失败: ${e.message}`);
        }
    };

    const deleteAllRoutes = async () => {
        try {
            // 显示确认对话框
            dialog.confirm({
                title: '确认删除',
                content: `确定要删除所有 ${pagination.value.total} 条IPv6路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    deleteAllLoading.value = true;
                    try {
                        // 调用新的批量删除API，只传地址族
                        const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV6_UNC);

                        if (result.status === 'success') {
                            notify.success(result.msg || '成功删除所有路由');
                            // 刷新路由列表
                            pagination.value.current = 1;
                            await refreshRoutes();
                        } else {
                            notify.error(`删除失败: ${result.msg}`);
                        }
                    } catch (e) {
                        notify.error(`批量删除失败: ${e.message}`);
                    } finally {
                        deleteAllLoading.value = false;
                    }
                }
            });
        } catch (e) {
            notify.error(`批量删除失败: ${e.message}`);
        }
    };
</script>

<style scoped>
    .bgp-route-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .bgp-route-card {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-list-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-card :deep(.nn-card-body) {
        min-height: 0;
        overflow: visible;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .bgp-route-list-card :deep(.nn-card-body) {
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .bgp-route-form {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        overflow: visible;
    }

    .bgp-route-form :deep(.nn-form-item) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .bgp-route-form :deep(.nn-form-item-label) {
        padding-bottom: 0;
    }

    .bgp-route-form :deep(.nn-input) {
        height: 28px;
    }

    .bgp-route-form :deep(.nn-select-selector) {
        min-height: 28px !important;
        height: 28px !important;
    }

    .bgp-route-form :deep(.nn-select-selection-item) {
        line-height: 26px !important;
    }

    .config-section {
        border-top: 1px solid var(--nn-color-border-light);
        padding: 8px 0 0;
    }

    .config-section:first-child {
        border-top: none;
        padding-top: 0;
    }

    .section-title {
        margin-bottom: 6px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        font-weight: 600;
    }

    .action-row {
        border-top: 1px solid var(--nn-color-border-light);
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 12px;
        align-items: center;
        padding: 8px 0;
    }

    .custom-attr-button {
        justify-self: start;
        padding-left: 0;
    }

    .route-secondary-actions {
        display: flex;
        align-items: center;
        justify-self: start;
    }

    .generate-route-button {
        grid-column: 2;
        justify-self: center;
    }

    .route-delete-all-button:disabled,
    .route-delete-all-button.nn-button-disabled {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
        opacity: 1 !important;
    }

    .route-delete-all-button:disabled:hover,
    .route-delete-all-button.nn-button-disabled:hover,
    .route-delete-all-button:disabled:focus,
    .route-delete-all-button.nn-button-disabled:focus {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
    }

    .bgp-route-table,
    .bgp-route-table :deep(.nn-spin-nested-loading),
    .bgp-route-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .bgp-route-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-table :deep(.nn-table-container),
    .bgp-route-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .bgp-route-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .bgp-route-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .bgp-route-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .inline-radio-group {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
    }

    @media (max-width: 768px) {
        .action-row {
            grid-template-columns: 1fr;
        }

        .custom-attr-button {
            justify-self: start;
            text-align: left;
        }

        .generate-route-button {
            grid-column: 1;
            justify-self: stretch;
        }
    }
</style>
