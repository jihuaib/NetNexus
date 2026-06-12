<template>
    <div class="mt-container bgp-route-page">
        <a-card title="IPv4-MVPN路由配置" class="bgp-route-card">
            <a-form :model="ipv4MvpnData" :label-col="labelCol" :wrapper-col="wrapperCol" class="bgp-route-form">
                <a-row>
                    <a-col :span="6">
                        <a-form-item label="RD" name="rd">
                            <a-tooltip :title="validationErrors.rd" :open="!!validationErrors.rd">
                                <a-input v-model:value="ipv4MvpnData.rd" :status="validationErrors.rd ? 'error' : ''" />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="6">
                        <a-form-item label="Route Type" name="routeType">
                            <a-select v-model:value="ipv4MvpnData.routeType" :options="mvpnRouteTypeOptions" />
                        </a-form-item>
                    </a-col>
                    <a-col :span="6">
                        <a-form-item label="RT" name="rt">
                            <a-tooltip :title="validationErrors.rt" :open="!!validationErrors.rt">
                                <a-input v-model:value="ipv4MvpnData.rt" :status="validationErrors.rt ? 'error' : ''" />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="6">
                        <a-form-item label="Count" name="count">
                            <a-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                <a-input
                                    v-model:value="ipv4MvpnData.count"
                                    :status="validationErrors.count ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <!-- Type 1: Intra-AS I-PMSI A-D - Only Originating Router -->
                <a-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD">
                    <a-col :span="12">
                        <a-form-item label="Orig Router" name="originatingRouterIp">
                            <a-tooltip
                                :title="validationErrors.originatingRouterIp"
                                :open="!!validationErrors.originatingRouterIp"
                            >
                                <a-input
                                    v-model:value="ipv4MvpnData.originatingRouterIp"
                                    :status="validationErrors.originatingRouterIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <!-- Type 2: Inter-AS I-PMSI A-D - Only Source AS -->
                <a-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD">
                    <a-col :span="12">
                        <a-form-item label="Source AS" name="sourceAs">
                            <a-tooltip :title="validationErrors.sourceAs" :open="!!validationErrors.sourceAs">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceAs"
                                    :status="validationErrors.sourceAs ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <!-- Type 3: S-PMSI A-D - Source, Group, Orig Router -->
                <a-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.S_PMSI_AD">
                    <a-col :span="8">
                        <a-form-item label="Source IP" name="sourceIp">
                            <a-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Group IP" name="groupIp">
                            <a-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Orig Router" name="originatingRouterIp">
                            <a-tooltip
                                :title="validationErrors.originatingRouterIp"
                                :open="!!validationErrors.originatingRouterIp"
                            >
                                <a-input
                                    v-model:value="ipv4MvpnData.originatingRouterIp"
                                    :status="validationErrors.originatingRouterIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <!-- Type 5: Source Active A-D - Source, Group -->
                <a-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD">
                    <a-col :span="12">
                        <a-form-item label="Source IP" name="sourceIp">
                            <a-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="12">
                        <a-form-item label="Group IP" name="groupIp">
                            <a-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <!-- Type 6/7: Join routes - Source AS, Group, Source -->
                <a-row
                    v-if="
                        ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN ||
                        ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    "
                >
                    <a-col :span="8">
                        <a-form-item label="Source AS" name="sourceAs">
                            <a-tooltip :title="validationErrors.sourceAs" :open="!!validationErrors.sourceAs">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceAs"
                                    :status="validationErrors.sourceAs ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Group IP" name="groupIp">
                            <a-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Source IP" name="sourceIp">
                            <a-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>

                <a-form-item :wrapper-col="{ offset: 8, span: 16 }">
                    <a-space size="middle">
                        <a-button type="primary" :loading="routesGenerating" @click="generateRoutes">
                            生成MVPN路由
                        </a-button>
                        <a-button type="primary" danger :disabled="!hasRoutes" @click="deleteRoutes">删除所有</a-button>
                    </a-space>
                </a-form-item>

                <!-- MVPN路由列表 - 按路由类型分类显示 -->
                <div class="route-list-section">
                    <div class="route-list-header">
                        <UnorderedListOutlined />
                        <span class="header-text">已生成MVPN路由列表</span>
                    </div>

                    <!-- 按路由类型分组显示 -->
                    <a-tabs v-model:active-key="activeMvpnTab" type="card" class="mvpn-route-tabs">
                        <a-tab-pane v-for="group in groupedMvpnRoutes" :key="group.type" :tab="group.typeName">
                            <a-table
                                :data-source="group.routes"
                                :columns="getRouteColumns(group.type)"
                                :pagination="pagination"
                                size="small"
                                :row-key="
                                    record =>
                                        `${record.rd}-${record.routeType}-${record.sourceIp || ''}-${record.groupIp || ''}-${record.originatingRouterIp || ''}`
                                "
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
                                            <a-button
                                                type="primary"
                                                danger
                                                size="small"
                                                @click="deleteSingleRoute(record)"
                                            >
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </a-space>
                                    </template>
                                    <template v-else-if="column.key === 'rd'">
                                        {{ record.rd }}
                                    </template>
                                    <template v-else-if="column.key === 'rt'">
                                        {{ record.rt }}
                                    </template>
                                    <template v-else-if="column.key === 'source'">
                                        {{ record.sourceIp }}
                                    </template>
                                    <template v-else-if="column.key === 'group'">
                                        {{ record.groupIp }}
                                    </template>
                                    <template v-else-if="column.key === 'sourceAs'">
                                        {{ record.sourceAs }}
                                    </template>
                                    <template v-else-if="column.key === 'originatingRouter'">
                                        {{ record.originatingRouterIp }}
                                    </template>
                                </template>
                            </a-table>
                        </a-tab-pane>
                    </a-tabs>
                </div>
            </a-form>
        </a-card>

        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, watch, onActivated, nextTick } from 'vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import { message, Modal } from 'ant-design-vue';
    import { UnorderedListOutlined, DeleteOutlined, FileSearchOutlined } from '@ant-design/icons-vue';
    import { BGP_ADDR_FAMILY, DEFAULT_VALUES, BGP_MVPN_ROUTE_TYPE } from '../../const/bgpConst';
    import { FormValidator, createBgpMvpnRouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteMvpn'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const ipv4MvpnData = ref({
        rd: '100:1',
        routeType: BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
        rt: '1:1',
        sourceIp: '1.1.1.1',
        groupIp: '239.1.1.1',
        originatingRouterIp: DEFAULT_VALUES.ROUTER_ID,
        sourceAs: DEFAULT_VALUES.LOCAL_AS,
        count: '1',
        addressFamily: BGP_ADDR_FAMILY.IPV4_MVPN
    });

    const pagination = ref({
        current: 1,
        pageSize: 20,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条，每页 20 条`
    });

    const validationErrors = ref({
        rd: '',
        rt: '',
        count: '',
        originatingRouterIp: '',
        sourceAs: '',
        sourceIp: '',
        groupIp: ''
    });

    const validator = new FormValidator(validationErrors);
    validator.addRules(createBgpMvpnRouteConfigValidationRules());

    // 暴露给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    // 监听路由类型变化时清空错误信息
    watch(
        () => ipv4MvpnData.value.routeType,
        () => {
            validator.clearErrors();
        }
    );

    const mvpnRouteTypeOptions = [
        { label: 'Intra-AS I-PMSI A-D (Type 1)', value: BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD },
        { label: 'Inter-AS I-PMSI A-D (Type 2)', value: BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD },
        { label: 'S-PMSI A-D (Type 3)', value: BGP_MVPN_ROUTE_TYPE.S_PMSI_AD },
        { label: 'Leaf A-D (Type 4)', value: BGP_MVPN_ROUTE_TYPE.LEAF_AD },
        { label: 'Source Active A-D (Type 5)', value: BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD },
        { label: 'Shared Tree Join (Type 6)', value: BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN },
        { label: 'Source Tree Join (Type 7)', value: BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN }
    ];

    const sentRoutes = ref([]);
    const hasRoutes = computed(() => pagination.value.total > 0);
    const activeMvpnTab = ref(null);
    const routesGenerating = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);

    const getRouteColumns = type => {
        const commonColumns = [
            { title: 'RD', key: 'rd', width: 100 },
            { title: 'RT', key: 'rt', width: 100 },
            { title: 'AS 路径', dataIndex: 'asPath', key: 'asPath', width: 150, ellipsis: true },
            { title: '操作', key: 'action', width: 150, align: 'center' }
        ];

        let specificColumns = [];
        switch (type) {
            case BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD: // Type 1
                specificColumns = [{ title: 'Orig Router', key: 'originatingRouter', width: 150 }];
                break;
            case BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD: // Type 2
                specificColumns = [{ title: 'Source AS', key: 'sourceAs', width: 100 }];
                break;
            case BGP_MVPN_ROUTE_TYPE.S_PMSI_AD: // Type 3
                specificColumns = [
                    { title: 'Source IP', key: 'source', width: 150 },
                    { title: 'Group IP', key: 'group', width: 150 },
                    { title: 'Orig Router', key: 'originatingRouter', width: 150 }
                ];
                break;
            case BGP_MVPN_ROUTE_TYPE.LEAF_AD: // Type 4
                // Type 4 usually has Route Key (S, G) or similar
                specificColumns = [
                    { title: 'Key', key: 'key', width: 200 }, // Placeholder if needed
                    { title: 'Orig Router', key: 'originatingRouter', width: 150 }
                ];
                break;
            case BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD: // Type 5
                specificColumns = [
                    { title: 'Source IP', key: 'source', width: 150 },
                    { title: 'Group IP', key: 'group', width: 150 }
                ];
                break;
            case BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN: // Type 6
            case BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN: // Type 7
                specificColumns = [
                    { title: 'Source AS', key: 'sourceAs', width: 100 },
                    { title: 'Source IP', key: 'source', width: 150 },
                    { title: 'Group IP', key: 'group', width: 150 }
                ];
                break;
            default:
                specificColumns = [
                    { title: 'Source IP', key: 'source', width: 150 },
                    { title: 'Group IP', key: 'group', width: 150 }
                ];
        }

        // Insert specific columns before the 'action' column
        const columns = [...commonColumns];
        columns.splice(columns.length - 1, 0, ...specificColumns);
        return columns;
    };

    // 计算属性：按路由类型分组MVPN路由
    const groupedMvpnRoutes = computed(() => {
        if (!sentRoutes.value) {
            return [];
        }
        // 遍历所有定义的路由类型选项
        return mvpnRouteTypeOptions.map(option => {
            const routes = sentRoutes.value.filter(route => route.routeType === option.value);
            return {
                type: option.value,
                typeName: option.label,
                routes: routes || []
            };
        });
    });

    // 默认选中第一个Tab
    watch(
        activeMvpnTab,
        newVal => {
            if (!newVal && mvpnRouteTypeOptions.length > 0) {
                activeMvpnTab.value = mvpnRouteTypeOptions[0].value;
            }
        },
        { immediate: true }
    );

    onMounted(async () => {
        // Load MVPN Config
        const savedConfig = await window.bgpApi.loadIpv4MvpnRouteConfig();
        if (savedConfig.status === 'success' && savedConfig.data) {
            Object.assign(ipv4MvpnData.value, savedConfig.data);
        }
    });

    onActivated(async () => {
        // 加载已生成的路由列表
        pagination.value.current = 1;
        await refreshRoutes();
    });

    const refreshRoutes = async () => {
        const result = await window.bgpApi.getRoutes(
            BGP_ADDR_FAMILY.IPV4_MVPN,
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

    const handleTableChange = (pag, _filters, _sorter) => {
        pagination.value.current = pag.current;
        refreshRoutes();
    };

    const generateRoutes = async () => {
        if (routesGenerating.value) {
            return;
        }

        try {
            const hasErrors = validator.validate(ipv4MvpnData.value);
            if (hasErrors) {
                message.error('请检查MVPN路由配置信息是否正确');
                return;
            }

            let config;
            if (ipv4MvpnData.value.routeType === BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
                config = {
                    rd: ipv4MvpnData.value.rd,
                    routeType: ipv4MvpnData.value.routeType,
                    originatingRouterIp: ipv4MvpnData.value.originatingRouterIp,
                    addressFamily: BGP_ADDR_FAMILY.IPV4_MVPN,
                    rt: ipv4MvpnData.value.rt,
                    count: ipv4MvpnData.value.count
                };
            } else if (ipv4MvpnData.value.routeType === BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD) {
                config = {
                    rd: ipv4MvpnData.value.rd,
                    routeType: ipv4MvpnData.value.routeType,
                    sourceAs: ipv4MvpnData.value.sourceAs,
                    addressFamily: BGP_ADDR_FAMILY.IPV4_MVPN,
                    rt: ipv4MvpnData.value.rt,
                    count: ipv4MvpnData.value.count
                };
            } else {
                config = ipv4MvpnData.value;
            }

            routesGenerating.value = true;
            await nextTick();

            const saveResult = await window.bgpApi.saveIpv4MvpnRouteConfig(config);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv4MvpnRoutes(config);

            if (result.status === 'success') {
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`MVPN路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const deleteRoutes = async () => {
        try {
            Modal.confirm({
                title: '确认删除',
                content: `确定要删除所有 ${pagination.value.total} 条MVPN路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    try {
                        const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV4_MVPN);

                        if (result.status === 'success') {
                            message.success(`${result.msg}`);
                            pagination.value.current = 1;
                            await refreshRoutes();
                        } else {
                            message.error(`${result.msg}`);
                        }
                    } catch (e) {
                        message.error(`MVPN路由删除失败: ${e.message}`);
                    }
                }
            });
        } catch (e) {
            message.error(`MVPN路由删除失败: ${e.message}`);
        }
    };

    const showRouteDetail = async route => {
        routeDetailVisible.value = true;
        routeDetailLoading.value = true;
        routeDetail.value = null;

        try {
            const result = await window.bgpApi.getRouteDetail(BGP_ADDR_FAMILY.IPV4_MVPN, {
                routeType: route.routeType,
                rd: route.rd,
                sourceAs: route.sourceAs,
                sourceIp: route.sourceIp,
                groupIp: route.groupIp,
                originatingRouterIp: route.originatingRouterIp
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
                addressFamily: route.addressFamily,
                routeType: route.routeType,
                rd: route.rd,
                count: 1,
                originatingRouterIp: route.originatingRouterIp,
                sourceIp: route.sourceIp,
                groupIp: route.groupIp,
                sourceAs: route.sourceAs
            };

            const result = await window.bgpApi.deleteIpv4MvpnRoutes(config);

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

    .mvpn-route-tabs {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .mvpn-route-tabs :deep(.ant-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .mvpn-route-tabs :deep(.ant-tabs-content-holder),
    .mvpn-route-tabs :deep(.ant-tabs-content),
    .mvpn-route-tabs :deep(.ant-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
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
