<template>
    <div class="mt-container bgp-route-page" data-testid="bgp-route-ipv4-page">
        <a-card title="IPv4-UNC路由配置" class="bgp-route-card">
            <a-form :model="ipv4Data" :label-col="labelCol" :wrapper-col="wrapperCol" class="bgp-route-form">
                <a-row>
                    <a-col :span="8">
                        <a-form-item label="Prefix" name="prefix">
                            <a-tooltip :title="validationErrors.prefix" :open="!!validationErrors.prefix">
                                <a-input
                                    v-model:value="ipv4Data.prefix"
                                    data-testid="bgp-ipv4-route-prefix-input"
                                    :status="validationErrors.prefix ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Mask" name="mask">
                            <a-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                <a-input
                                    v-model:value="ipv4Data.mask"
                                    data-testid="bgp-ipv4-route-mask-input"
                                    :status="validationErrors.mask ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Count" name="count">
                            <a-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                <a-input
                                    v-model:value="ipv4Data.count"
                                    data-testid="bgp-ipv4-route-count-input"
                                    :status="validationErrors.count ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <a-row>
                    <a-col :span="8">
                        <a-form-item label="RT" name="rt">
                            <a-tooltip :title="validationErrors.rt" :open="!!validationErrors.rt">
                                <a-input v-model:value="ipv4Data.rt" :status="validationErrors.rt ? 'error' : ''" />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <a-form-item>
                    <a-button type="link" @click="showCustomRouteAttr">
                        <template #icon><SettingOutlined /></template>
                        配置自定义路由属性
                    </a-button>
                </a-form-item>
                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <a-button
                        data-testid="bgp-generate-ipv4-routes-button"
                        type="primary"
                        :loading="routesGenerating"
                        @click="generateRoutes"
                    >
                        生成IPv4路由
                    </a-button>
                </a-form-item>

                <!-- 路由列表 -->
                <div class="route-list-section">
                    <div class="route-list-header">
                        <UnorderedListOutlined />
                        <span class="header-text">已生成IPv4路由列表</span>
                        <a-button
                            :disabled="!hasRoutes"
                            type="primary"
                            danger
                            size="small"
                            style="margin-left: auto"
                            @click="deleteAllRoutes"
                        >
                            <template #icon><DeleteOutlined /></template>
                            删除所有
                        </a-button>
                        <a-button size="small" type="primary" style="margin-left: 8px" @click="showRouteViewsImport">
                            从 RouteViews 导入
                        </a-button>
                    </div>
                    <a-table
                        data-testid="bgp-ipv4-route-table"
                        :data-source="sentRoutes"
                        :columns="routeColumns"
                        :pagination="pagination"
                        size="small"
                        :row-key="record => `${record.ip}-${record.mask}`"
                        :scroll="{ y: '100%' }"
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
                </div>
            </a-form>
        </a-card>

        <CustomPktDrawer
            v-model:open="customRouteAttrVisible"
            v-model:input-value="ipv4Data.customAttr"
            @submit="handleCustomRouteAttrSubmit"
        />

        <RouteViewsImportModal
            v-model:open="routeViewsImportVisible"
            :address-family="BGP_ADDR_FAMILY.IPV4_UNC"
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
    import { message, Modal } from 'ant-design-vue';
    import SettingOutlined from '@ant-design/icons-vue/es/icons/SettingOutlined';
    import UnorderedListOutlined from '@ant-design/icons-vue/es/icons/UnorderedListOutlined';
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import FileSearchOutlined from '@ant-design/icons-vue/es/icons/FileSearchOutlined';
    import { BGP_ADDR_FAMILY, DEFAULT_VALUES } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv4RouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv4'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const ipv4Data = ref({
        prefix: DEFAULT_VALUES.IPV4_PREFIX,
        mask: DEFAULT_VALUES.IPV4_MASK,
        count: DEFAULT_VALUES.IPV4_COUNT,
        customAttr: '',
        rt: '',
        addressFamily: BGP_ADDR_FAMILY.IPV4_UNC
    });

    const validationErrors = ref({
        prefix: '',
        mask: '',
        count: '',
        rt: ''
    });

    const validator = new FormValidator(validationErrors);
    validator.addRules(createBgpIpv4RouteConfigValidationRules());

    // 暴露给父组件
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

    const customRouteAttrVisible = ref(false);

    const showCustomRouteAttr = () => {
        customRouteAttrVisible.value = true;
    };

    const handleCustomRouteAttrSubmit = data => {
        ipv4Data.value.customAttr = data;
    };

    const routeViewsImportVisible = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);

    const showRouteViewsImport = () => {
        routeViewsImportVisible.value = true;
    };

    const routeColumns = [
        {
            title: '前缀',
            dataIndex: 'ip',
            key: 'ip',
            width: 140
        },
        {
            title: 'RT',
            dataIndex: 'rt',
            key: 'rt',
            width: 150,
            ellipsis: true
        },
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
        // 加载保存的配置
        const savedConfig = await window.bgpApi.loadIpv4UNCRouteConfig();
        if (savedConfig.status === 'success' && savedConfig.data) {
            Object.assign(ipv4Data.value, savedConfig.data);
        } else {
            console.error('IPv4-UNC路由配置文件加载失败', savedConfig.msg);
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
        const result = await window.bgpApi.getRoutes(
            BGP_ADDR_FAMILY.IPV4_UNC,
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
            const hasErrors = validator.validate(ipv4Data.value);
            if (hasErrors) {
                message.error('请检查IPv4路由配置信息是否正确');
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = JSON.parse(JSON.stringify(ipv4Data.value));
            const saveResult = await window.bgpApi.saveIpv4UNCRouteConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv4Routes(payload);
            if (result.status === 'success') {
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`IPv4路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const showRouteDetail = async route => {
        routeDetailVisible.value = true;
        routeDetailLoading.value = true;
        routeDetail.value = null;

        try {
            const result = await window.bgpApi.getRouteDetail(BGP_ADDR_FAMILY.IPV4_UNC, {
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
                customAttr: route.customAttr || '',
                addressFamily: route.addressFamily
            };

            const result = await window.bgpApi.deleteIpv4Routes(config);

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

    const deleteAllRoutes = async () => {
        try {
            // 显示确认对话框
            Modal.confirm({
                title: '确认删除',
                content: `确定要删除所有 ${pagination.value.total} 条IPv4路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    try {
                        // 调用新的批量删除API，只传地址族
                        const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV4_UNC);

                        if (result.status === 'success') {
                            message.success(result.msg || '成功删除所有路由');
                            // 刷新路由列表
                            pagination.value.current = 1;
                            await refreshRoutes();
                        } else {
                            message.error(`删除失败: ${result.msg}`);
                        }
                    } catch (e) {
                        message.error(`批量删除失败: ${e.message}`);
                    }
                }
            });
        } catch (e) {
            message.error(`批量删除失败: ${e.message}`);
        }
    };
</script>

<style scoped>
    .bgp-route-page {
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .bgp-route-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .bgp-route-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .bgp-route-form {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-form :deep(.ant-form-item) {
        flex: 0 0 auto;
    }

    .route-list-section {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        margin-top: 24px;
        border-top: 1px solid #f0f0f0;
        padding-top: 16px;
        overflow: hidden;
    }

    .route-list-header {
        flex: 0 0 auto;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        font-weight: 500;
        color: rgba(0, 0, 0, 0.85);
    }

    .header-text {
        margin-left: 8px;
        margin-right: 8px;
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
        margin: 10px 0 0;
    }

    .bgp-route-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
