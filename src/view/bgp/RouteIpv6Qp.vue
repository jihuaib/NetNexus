<template>
    <div class="mt-container qp-page">
        <nn-card class="qp-card" title="IPv6-QP路由配置">
            <nn-form class="qp-config-form" :model="ipv6QpData" :label-col="labelCol" :wrapper-col="wrapperCol">
                <div class="config-section">
                    <div class="section-title">生成范围</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :xl="24">
                            <nn-form-item label="增长模式" name="routeGrowthMode">
                                <nn-radio-group v-model:value="ipv6QpData.routeGrowthMode">
                                    <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN">IP + DQPN</nn-radio>
                                    <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP">仅 IP</nn-radio>
                                    <nn-radio :value="BGP_QP_ROUTE_GROWTH_MODE.DQPN">仅 DQPN</nn-radio>
                                </nn-radio-group>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Prefix" name="prefix">
                                <nn-tooltip :title="validationErrors.prefix" :open="!!validationErrors.prefix">
                                    <nn-input
                                        v-model:value="ipv6QpData.prefix"
                                        :status="validationErrors.prefix ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Mask" name="mask">
                                <nn-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                    <nn-input
                                        v-model:value="ipv6QpData.mask"
                                        :status="validationErrors.mask ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="6">
                            <nn-form-item label="Count" name="count">
                                <nn-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                    <nn-input
                                        v-model:value="ipv6QpData.count"
                                        :status="validationErrors.count ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col v-if="routeGrowthIncludesIp" :xs="24" :md="6">
                            <nn-form-item label="IP Step" name="ipStep">
                                <nn-tooltip :title="validationErrors.ipStep" :open="!!validationErrors.ipStep">
                                    <nn-input
                                        v-model:value="ipv6QpData.ipStep"
                                        :status="validationErrors.ipStep ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div class="config-section">
                    <div class="section-title">DQPN</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :md="8">
                            <nn-form-item label="Start DQPN" name="startDqpn">
                                <nn-tooltip :title="validationErrors.startDqpn" :open="!!validationErrors.startDqpn">
                                    <nn-input
                                        v-model:value="ipv6QpData.startDqpn"
                                        :status="validationErrors.startDqpn ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col v-if="routeGrowthIncludesDqpn" :xs="24" :md="8">
                            <nn-form-item label="DQPN Step" name="dqpnStep">
                                <nn-tooltip :title="validationErrors.dqpnStep" :open="!!validationErrors.dqpnStep">
                                    <nn-input
                                        v-model:value="ipv6QpData.dqpnStep"
                                        :status="validationErrors.dqpnStep ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div class="config-section">
                    <div class="section-title">BSID</div>
                    <nn-row :gutter="[16, 0]">
                        <nn-col :xs="24" :md="8">
                            <nn-form-item label="BSID模式" name="bsidMode">
                                <nn-radio-group v-model:value="ipv6QpData.bsidMode">
                                    <nn-radio :value="BGP_QP_BSID_MODE.FIXED">固定</nn-radio>
                                    <nn-radio :value="BGP_QP_BSID_MODE.CONTINUOUS">连续</nn-radio>
                                </nn-radio-group>
                            </nn-form-item>
                        </nn-col>
                        <nn-col :xs="24" :md="8">
                            <nn-form-item label="BSID" name="bsid">
                                <nn-tooltip :title="validationErrors.bsid" :open="!!validationErrors.bsid">
                                    <nn-input
                                        v-model:value="ipv6QpData.bsid"
                                        :status="validationErrors.bsid ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                        <nn-col v-if="ipv6QpData.bsidMode === BGP_QP_BSID_MODE.CONTINUOUS" :xs="24" :md="8">
                            <nn-form-item label="BSID Step" name="bsidStep">
                                <nn-tooltip :title="validationErrors.bsidStep" :open="!!validationErrors.bsidStep">
                                    <nn-input
                                        v-model:value="ipv6QpData.bsidStep"
                                        :status="validationErrors.bsidStep ? 'error' : ''"
                                    />
                                </nn-tooltip>
                            </nn-form-item>
                        </nn-col>
                    </nn-row>
                </div>

                <div class="action-row">
                    <nn-button class="custom-attr-button" type="link" @click="showCustomRouteAttr">
                        <template #icon><SettingOutlined /></template>
                        配置自定义路由属性
                    </nn-button>
                    <nn-button
                        class="generate-route-button"
                        type="primary"
                        :loading="routesGenerating"
                        @click="generateRoutes"
                    >
                        生成IPv6-QP路由
                    </nn-button>
                </div>
            </nn-form>
        </nn-card>

        <nn-card title="已生成IPv6-QP路由列表" class="qp-route-list-card">
            <template #extra>
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
            </template>

            <nn-table
                :data-source="sentRoutes"
                :columns="routeColumns"
                :pagination="pagination"
                size="small"
                :row-key="record => `${record.dqpn}-${record.ip}-${record.mask}`"
                :scroll="{ x: 'max-content', y: '100%' }"
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
            v-model:input-value="ipv6QpData.customAttr"
            @submit="handleCustomRouteAttrSubmit"
        />

        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, onActivated, nextTick } from 'vue';
    import CustomPktDrawer from '../../components/CustomPktDrawer.vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import { notify } from '../../utils/notify';
    import { DeleteOutlined, FileSearchOutlined, SettingOutlined } from '../../ui/icons';

    import { BGP_ADDR_FAMILY, BGP_QP_ROUTE_GROWTH_MODE, BGP_QP_BSID_MODE } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv6QpRouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv6Qp'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const ipv6QpData = ref({
        prefix: '2001:db8::',
        mask: '64',
        count: '10',
        ipStep: '1',
        routeGrowthMode: BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN,
        startDqpn: '1',
        dqpnStep: '1',
        bsidMode: BGP_QP_BSID_MODE.FIXED,
        bsid: '',
        bsidStep: '1',
        customAttr: '',
        addressFamily: BGP_ADDR_FAMILY.IPV6_QP
    });

    const validationErrors = ref({
        prefix: '',
        mask: '',
        count: '',
        ipStep: '',
        startDqpn: '',
        dqpnStep: '',
        bsid: '',
        bsidStep: ''
    });

    const validator = new FormValidator(validationErrors);
    validator.addRules(createBgpIpv6QpRouteConfigValidationRules());

    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    const sentRoutes = ref([]);
    const hasRoutes = computed(() => pagination.value.total > 0);
    const routesGenerating = ref(false);
    const deleteAllLoading = ref(false);
    const routeGrowthIncludesIp = computed(
        () =>
            ipv6QpData.value.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP ||
            ipv6QpData.value.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN
    );
    const routeGrowthIncludesDqpn = computed(
        () =>
            ipv6QpData.value.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.DQPN ||
            ipv6QpData.value.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN
    );

    const customRouteAttrVisible = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);

    const showCustomRouteAttr = () => {
        customRouteAttrVisible.value = true;
    };

    const handleCustomRouteAttrSubmit = data => {
        ipv6QpData.value.customAttr = data;
    };

    const routeColumns = [
        {
            title: 'DQPN',
            dataIndex: 'dqpn',
            key: 'dqpn',
            width: 100
        },
        {
            title: '前缀',
            dataIndex: 'ip',
            key: 'ip',
            width: 200
        },
        {
            title: 'BSID (下一跳)',
            dataIndex: 'nextHop',
            key: 'nextHop',
            width: 200
        },
        {
            title: 'AS 路径',
            dataIndex: 'asPath',
            key: 'asPath',
            width: 150,
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action',
            width: 150,
            align: 'center'
        }
    ];

    const pagination = ref({
        current: 1,
        pageSize: 20,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条，每页 20 条`
    });

    onMounted(async () => {
        const savedConfig = await window.bgpApi.loadIpv6QpRouteConfig();
        if (savedConfig.status === 'success' && savedConfig.data) {
            Object.assign(ipv6QpData.value, savedConfig.data);
        }
    });

    onActivated(async () => {
        pagination.value.current = 1;
        await refreshRoutes();
    });

    const handleTableChange = (pag, _filters, _sorter) => {
        pagination.value.current = pag.current;
        refreshRoutes();
    };

    const refreshRoutes = async () => {
        const result = await window.bgpApi.getRoutes(
            BGP_ADDR_FAMILY.IPV6_QP,
            pagination.value.current,
            pagination.value.pageSize
        );
        if (result.status === 'success') {
            sentRoutes.value = result.data.list;
            pagination.value.total = result.data.total;
        } else {
            console.error(result.msg);
            sentRoutes.value = [];
        }
    };

    const generateRoutes = async () => {
        if (routesGenerating.value) {
            return;
        }

        try {
            const hasErrors = validator.validate(ipv6QpData.value);
            if (hasErrors) {
                notify.error('请检查IPv6-QP路由配置信息是否正确');
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = JSON.parse(JSON.stringify(ipv6QpData.value));
            const saveResult = await window.bgpApi.saveIpv6QpRouteConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv6QpRoutes(payload);
            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                notify.error(`${result.msg}`);
            }
        } catch (e) {
            notify.error(`IPv6-QP路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const deleteAllRoutes = async () => {
        if (deleteAllLoading.value) {
            return;
        }

        deleteAllLoading.value = true;
        try {
            const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV6_QP);
            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                notify.error(`${result.msg}`);
            }
        } catch (e) {
            notify.error(`IPv6-QP路由删除失败: ${e.message}`);
        } finally {
            deleteAllLoading.value = false;
        }
    };

    const showRouteDetail = async route => {
        routeDetailVisible.value = true;
        routeDetailLoading.value = true;
        routeDetail.value = null;

        try {
            const result = await window.bgpApi.getRouteDetail(BGP_ADDR_FAMILY.IPV6_QP, {
                dqpn: route.dqpn,
                ip: route.ip,
                mask: route.mask
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
                count: 1,
                startDqpn: route.dqpn,
                bsid: route.nextHop || '',
                customAttr: route.customAttr || '',
                addressFamily: route.addressFamily
            };

            const result = await window.bgpApi.deleteIpv6QpRoutes(config);

            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                await refreshRoutes();
            } else {
                notify.error(`路由删除失败: ${result.msg}`);
            }
        } catch (e) {
            notify.error(`路由删除失败: ${e.message}`);
        }
    };
</script>

<style scoped>
    .qp-page {
        margin-top: 4px;
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .qp-card {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }

    .qp-route-list-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .qp-card :deep(.nn-card-head),
    .qp-route-list-card :deep(.nn-card-head) {
        min-height: 36px !important;
    }

    .qp-card :deep(.nn-card-head-title),
    .qp-route-list-card :deep(.nn-card-head-title) {
        padding: 8px 0 !important;
    }

    .qp-route-list-card :deep(.nn-card-extra) {
        padding: 6px 0 !important;
    }

    .qp-card :deep(.nn-card-body) {
        flex: 0 0 auto;
        min-height: 0;
        overflow: visible;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .qp-route-list-card :deep(.nn-card-body) {
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .qp-config-form {
        flex: 0 0 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: visible;
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
        margin-top: 0;
        padding: 8px 0;
    }

    .custom-attr-button {
        justify-self: start;
        padding-left: 0;
    }

    .generate-route-button {
        grid-column: 2;
        justify-self: center;
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
    }

    .bgp-route-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    :deep(.nn-table-thead > tr > th),
    :deep(.nn-table-tbody > tr > td) {
        padding: 4px 8px !important;
    }

    :deep(.nn-table-wrapper .nn-table-pagination.nn-pagination) {
        margin: 8px 0 0;
    }

    :deep(.qp-config-form .nn-form-item) {
        margin-bottom: 8px;
    }

    :deep(.qp-config-form .nn-form-item-label) {
        padding-bottom: 0;
    }

    :deep(.qp-config-form .nn-input) {
        height: 28px;
    }

    :deep(.qp-config-form .nn-radio-group) {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
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
