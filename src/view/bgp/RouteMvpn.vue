<template>
    <div class="mt-container bgp-route-page">
        <nn-card title="IPv4-MVPN路由配置" class="bgp-route-card">
            <a-form :model="ipv4MvpnData" :label-col="labelCol" :wrapper-col="wrapperCol" class="bgp-route-form">
                <nn-row>
                    <nn-col :span="6">
                        <a-form-item label="RD" name="rd">
                            <nn-tooltip :title="validationErrors.rd" :open="!!validationErrors.rd">
                                <a-input v-model:value="ipv4MvpnData.rd" :status="validationErrors.rd ? 'error' : ''" />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="6">
                        <a-form-item label="Route Type" name="routeType">
                            <a-select v-model:value="ipv4MvpnData.routeType" :options="mvpnRouteTypeOptions" />
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="6">
                        <a-form-item label="RT" name="rt">
                            <nn-tooltip :title="validationErrors.rt" :open="!!validationErrors.rt">
                                <a-input v-model:value="ipv4MvpnData.rt" :status="validationErrors.rt ? 'error' : ''" />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="6">
                        <a-form-item label="Count" name="count">
                            <nn-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                <a-input
                                    v-model:value="ipv4MvpnData.count"
                                    :status="validationErrors.count ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>
                <!-- Type 1: Intra-AS I-PMSI A-D - Only Originating Router -->
                <nn-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD">
                    <nn-col :span="12">
                        <a-form-item label="Orig Router" name="originatingRouterIp">
                            <nn-tooltip
                                :title="validationErrors.originatingRouterIp"
                                :open="!!validationErrors.originatingRouterIp"
                            >
                                <a-input
                                    v-model:value="ipv4MvpnData.originatingRouterIp"
                                    :status="validationErrors.originatingRouterIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>
                <!-- Type 2: Inter-AS I-PMSI A-D - Only Source AS -->
                <nn-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD">
                    <nn-col :span="12">
                        <a-form-item label="Source AS" name="sourceAs">
                            <nn-tooltip :title="validationErrors.sourceAs" :open="!!validationErrors.sourceAs">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceAs"
                                    :status="validationErrors.sourceAs ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>
                <!-- Type 3: S-PMSI A-D - Source, Group, Orig Router -->
                <nn-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.S_PMSI_AD">
                    <nn-col :span="8">
                        <a-form-item label="Source IP" name="sourceIp">
                            <nn-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <a-form-item label="Group IP" name="groupIp">
                            <nn-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <a-form-item label="Orig Router" name="originatingRouterIp">
                            <nn-tooltip
                                :title="validationErrors.originatingRouterIp"
                                :open="!!validationErrors.originatingRouterIp"
                            >
                                <a-input
                                    v-model:value="ipv4MvpnData.originatingRouterIp"
                                    :status="validationErrors.originatingRouterIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>
                <!-- Type 5: Source Active A-D - Source, Group -->
                <nn-row v-if="ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD">
                    <nn-col :span="12">
                        <a-form-item label="Source IP" name="sourceIp">
                            <nn-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="12">
                        <a-form-item label="Group IP" name="groupIp">
                            <nn-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>
                <!-- Type 6/7: Join routes - Source AS, Group, Source -->
                <nn-row
                    v-if="
                        ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN ||
                        ipv4MvpnData.routeType === BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    "
                >
                    <nn-col :span="8">
                        <a-form-item label="Source AS" name="sourceAs">
                            <nn-tooltip :title="validationErrors.sourceAs" :open="!!validationErrors.sourceAs">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceAs"
                                    :status="validationErrors.sourceAs ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <a-form-item label="Group IP" name="groupIp">
                            <nn-tooltip :title="validationErrors.groupIp" :open="!!validationErrors.groupIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.groupIp"
                                    :status="validationErrors.groupIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <a-form-item label="Source IP" name="sourceIp">
                            <nn-tooltip :title="validationErrors.sourceIp" :open="!!validationErrors.sourceIp">
                                <a-input
                                    v-model:value="ipv4MvpnData.sourceIp"
                                    :status="validationErrors.sourceIp ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </a-form-item>
                    </nn-col>
                </nn-row>

                <a-form-item :wrapper-col="{ offset: 8, span: 16 }">
                    <nn-button type="primary" :loading="routesGenerating" @click="generateRoutes">
                        生成MVPN路由
                    </nn-button>
                </a-form-item>
            </a-form>
        </nn-card>

        <nn-card title="已生成MVPN路由列表" class="bgp-route-list-card">
            <template #extra>
                <nn-button
                    class="route-delete-all-button"
                    :disabled="!hasRoutes || deleteAllLoading"
                    :loading="deleteAllLoading"
                    danger
                    size="small"
                    @click="deleteRoutes"
                >
                    <template #icon><DeleteOutlined /></template>
                    删除所有
                </nn-button>
            </template>

            <!-- 按路由类型分组显示 -->
            <nn-tabs v-model:active-key="activeMvpnTab" type="card" class="mvpn-route-tabs">
                <nn-tab-pane v-for="group in groupedMvpnRoutes" :key="group.type" :tab="group.typeName">
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
                </nn-tab-pane>
            </nn-tabs>
        </nn-card>

        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, watch, onActivated, nextTick } from 'vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { DeleteOutlined, FileSearchOutlined } from '../../ui/icons';

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
    const deleteAllLoading = ref(false);
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
                notify.error('请检查MVPN路由配置信息是否正确');
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
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv4MvpnRoutes(config);

            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                notify.error(`${result.msg}`);
            }
        } catch (e) {
            notify.error(`MVPN路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const deleteRoutes = async () => {
        try {
            dialog.confirm({
                title: '确认删除',
                content: `确定要删除所有 ${pagination.value.total} 条MVPN路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    if (deleteAllLoading.value) {
                        return;
                    }

                    deleteAllLoading.value = true;
                    try {
                        const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV4_MVPN);

                        if (result.status === 'success') {
                            notify.success(`${result.msg}`);
                            pagination.value.current = 1;
                            await refreshRoutes();
                        } else {
                            notify.error(`${result.msg}`);
                        }
                    } catch (e) {
                        notify.error(`MVPN路由删除失败: ${e.message}`);
                    } finally {
                        deleteAllLoading.value = false;
                    }
                }
            });
        } catch (e) {
            notify.error(`MVPN路由删除失败: ${e.message}`);
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
    .bgp-route-page {
        height: calc(100vh - 70px);
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
        min-height: 0;
        overflow: hidden;
    }

    .bgp-route-list-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-card :deep(.nn-card-head),
    .bgp-route-list-card :deep(.nn-card-head) {
        min-height: 36px !important;
    }

    .bgp-route-card :deep(.nn-card-head-title),
    .bgp-route-list-card :deep(.nn-card-head-title) {
        padding: 8px 0 !important;
    }

    .bgp-route-list-card :deep(.nn-card-extra) {
        padding: 6px 0 !important;
    }

    .bgp-route-card :deep(.nn-card-body) {
        flex: 0 0 auto;
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
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: visible;
    }

    .bgp-route-form :deep(.ant-form-item) {
        flex: 0 0 auto;
    }

    .mvpn-route-tabs {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .mvpn-route-tabs :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .mvpn-route-tabs :deep(.nn-tabs-content-holder),
    .mvpn-route-tabs :deep(.nn-tabs-content),
    .mvpn-route-tabs :deep(.nn-tabs-tabpane) {
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
</style>
