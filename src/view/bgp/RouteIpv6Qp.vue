<template>
    <div class="mt-container qp-page">
        <a-card class="qp-card" title="IPv6-QP路由配置">
            <a-form class="qp-config-form" :model="ipv6QpData" :label-col="labelCol" :wrapper-col="wrapperCol">
                <div class="config-section">
                    <div class="section-title">生成范围</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :xl="24">
                            <a-form-item label="增长模式" name="routeGrowthMode">
                                <a-radio-group v-model:value="ipv6QpData.routeGrowthMode">
                                    <a-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN">IP + DQPN</a-radio>
                                    <a-radio :value="BGP_QP_ROUTE_GROWTH_MODE.IP">仅 IP</a-radio>
                                    <a-radio :value="BGP_QP_ROUTE_GROWTH_MODE.DQPN">仅 DQPN</a-radio>
                                </a-radio-group>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="Prefix" name="prefix">
                                <a-tooltip :title="validationErrors.prefix" :open="!!validationErrors.prefix">
                                    <a-input
                                        v-model:value="ipv6QpData.prefix"
                                        :status="validationErrors.prefix ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="Mask" name="mask">
                                <a-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                    <a-input
                                        v-model:value="ipv6QpData.mask"
                                        :status="validationErrors.mask ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="Count" name="count">
                                <a-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                    <a-input
                                        v-model:value="ipv6QpData.count"
                                        :status="validationErrors.count ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col v-if="routeGrowthIncludesIp" :xs="24" :md="6">
                            <a-form-item label="IP Step" name="ipStep">
                                <a-tooltip :title="validationErrors.ipStep" :open="!!validationErrors.ipStep">
                                    <a-input
                                        v-model:value="ipv6QpData.ipStep"
                                        :status="validationErrors.ipStep ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div class="config-section">
                    <div class="section-title">DQPN</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="8">
                            <a-form-item label="Start DQPN" name="startDqpn">
                                <a-tooltip :title="validationErrors.startDqpn" :open="!!validationErrors.startDqpn">
                                    <a-input
                                        v-model:value="ipv6QpData.startDqpn"
                                        :status="validationErrors.startDqpn ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col v-if="routeGrowthIncludesDqpn" :xs="24" :md="8">
                            <a-form-item label="DQPN Step" name="dqpnStep">
                                <a-tooltip :title="validationErrors.dqpnStep" :open="!!validationErrors.dqpnStep">
                                    <a-input
                                        v-model:value="ipv6QpData.dqpnStep"
                                        :status="validationErrors.dqpnStep ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div class="config-section">
                    <div class="section-title">BSID</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="8">
                            <a-form-item label="BSID模式" name="bsidMode">
                                <a-radio-group v-model:value="ipv6QpData.bsidMode">
                                    <a-radio :value="BGP_QP_BSID_MODE.FIXED">固定</a-radio>
                                    <a-radio :value="BGP_QP_BSID_MODE.CONTINUOUS">连续</a-radio>
                                </a-radio-group>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="8">
                            <a-form-item label="BSID" name="bsid">
                                <a-tooltip :title="validationErrors.bsid" :open="!!validationErrors.bsid">
                                    <a-input
                                        v-model:value="ipv6QpData.bsid"
                                        :status="validationErrors.bsid ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col v-if="ipv6QpData.bsidMode === BGP_QP_BSID_MODE.CONTINUOUS" :xs="24" :md="8">
                            <a-form-item label="BSID Step" name="bsidStep">
                                <a-tooltip :title="validationErrors.bsidStep" :open="!!validationErrors.bsidStep">
                                    <a-input
                                        v-model:value="ipv6QpData.bsidStep"
                                        :status="validationErrors.bsidStep ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div class="action-row">
                    <a-button class="custom-attr-button" type="link" @click="showCustomRouteAttr">
                        <template #icon><SettingOutlined /></template>
                        配置自定义路由属性
                    </a-button>
                    <a-button
                        class="generate-route-button"
                        type="primary"
                        :loading="routesGenerating"
                        @click="generateRoutes"
                    >
                        生成IPv6-QP路由
                    </a-button>
                </div>
            </a-form>
        </a-card>

        <a-card title="已生成IPv6-QP路由列表" class="qp-route-list-card">
            <template #extra>
                <a-button
                    class="route-delete-all-button"
                    :disabled="!hasRoutes || deleteAllLoading"
                    :loading="deleteAllLoading"
                    danger
                    size="small"
                    @click="deleteAllRoutes"
                >
                    <template #icon><DeleteOutlined /></template>
                    删除所有
                </a-button>
            </template>

            <a-table
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
                        <a-space>
                            <a-button size="small" @click="showRouteDetail(record)">
                                <template #icon><FileSearchOutlined /></template>
                                详情
                            </a-button>
                            <a-button type="primary" danger size="small" @click="deleteSingleRoute(record)">
                                <template #icon><DeleteOutlined /></template>
                                删除
                            </a-button>
                        </a-space>
                    </template>
                    <template v-else-if="column.key === 'ip'">
                        <div>{{ record.ip }}/{{ record.mask }}</div>
                    </template>
                </template>
            </a-table>
        </a-card>

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
    import { message } from 'ant-design-vue';
    import SettingOutlined from '@ant-design/icons-vue/es/icons/SettingOutlined';
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import FileSearchOutlined from '@ant-design/icons-vue/es/icons/FileSearchOutlined';
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
                message.error('请检查IPv6-QP路由配置信息是否正确');
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = JSON.parse(JSON.stringify(ipv6QpData.value));
            const saveResult = await window.bgpApi.saveIpv6QpRouteConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv6QpRoutes(payload);
            if (result.status === 'success') {
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`IPv6-QP路由生成失败: ${e.message}`);
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
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`IPv6-QP路由删除失败: ${e.message}`);
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
                message.error(`路由详情查询失败: ${result.msg}`);
            }
        } catch (e) {
            routeDetailVisible.value = false;
            message.error(`路由详情查询失败: ${e.message}`);
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
                message.success(`${result.msg}`);
                await refreshRoutes();
            } else {
                message.error(`路由删除失败: ${result.msg}`);
            }
        } catch (e) {
            message.error(`路由删除失败: ${e.message}`);
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

    .qp-card :deep(.ant-card-head),
    .qp-route-list-card :deep(.ant-card-head) {
        min-height: 36px !important;
    }

    .qp-card :deep(.ant-card-head-title),
    .qp-route-list-card :deep(.ant-card-head-title) {
        padding: 8px 0 !important;
    }

    .qp-route-list-card :deep(.ant-card-extra) {
        padding: 6px 0 !important;
    }

    .qp-card :deep(.ant-card-body) {
        flex: 0 0 auto;
        min-height: 0;
        overflow: visible;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .qp-route-list-card :deep(.ant-card-body) {
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
        border-top: 1px solid #f0f0f0;
        padding: 8px 0 0;
    }

    .config-section:first-child {
        border-top: none;
        padding-top: 0;
    }

    .section-title {
        margin-bottom: 6px;
        color: rgba(0, 0, 0, 0.65);
        font-size: 12px;
        font-weight: 600;
    }

    .action-row {
        border-top: 1px solid #f0f0f0;
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
    .bgp-route-table :deep(.ant-spin-nested-loading),
    .bgp-route-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .bgp-route-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-table :deep(.ant-table-container),
    .bgp-route-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .bgp-route-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .bgp-route-table :deep(.ant-pagination) {
        flex: 0 0 auto;
    }

    .bgp-route-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    :deep(.ant-table-thead > tr > th),
    :deep(.ant-table-tbody > tr > td) {
        padding: 4px 8px !important;
    }

    :deep(.ant-table-wrapper .ant-table-pagination.ant-pagination) {
        margin: 8px 0 0;
    }

    :deep(.qp-config-form .ant-form-item) {
        margin-bottom: 8px;
    }

    :deep(.qp-config-form .ant-form-item-label) {
        padding-bottom: 0;
    }

    :deep(.qp-config-form .ant-input) {
        height: 28px;
    }

    :deep(.qp-config-form .ant-radio-group) {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
    }

    .route-delete-all-button:disabled,
    .route-delete-all-button.ant-btn-disabled {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
        opacity: 1 !important;
    }

    .route-delete-all-button:disabled:hover,
    .route-delete-all-button.ant-btn-disabled:hover,
    .route-delete-all-button:disabled:focus,
    .route-delete-all-button.ant-btn-disabled:focus {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
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
