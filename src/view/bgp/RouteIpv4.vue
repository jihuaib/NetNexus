<template>
    <div class="mt-container bgp-route-page" data-testid="bgp-route-ipv4-page">
        <a-card :title="routeCardTitle" class="bgp-route-card">
            <a-form :model="ipv4Data" :label-col="labelCol" :wrapper-col="wrapperCol" class="bgp-route-form">
                <div class="config-section">
                    <div class="section-title">基础配置</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="6">
                            <a-form-item label="地址族" name="addressFamily">
                                <a-select
                                    v-model:value="ipv4Data.addressFamily"
                                    style="width: 100%"
                                    :options="addressFamilyOptions"
                                />
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
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
                        <a-col :xs="24" :md="6">
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
                        <a-col :xs="24" :md="6">
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
                        <a-col :xs="24" :md="6">
                            <a-form-item label="RT" name="rt">
                                <a-tooltip :title="validationErrors.rt" :open="!!validationErrors.rt">
                                    <a-input v-model:value="ipv4Data.rt" :status="validationErrors.rt ? 'error' : ''" />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div v-if="!isLabelRoute" class="config-section">
                    <div class="section-title">ADD-PATH</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="6">
                            <a-form-item label="生成" name="addPathEnabled">
                                <a-switch v-model:checked="ipv4Data.addPathEnabled" />
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="Path Count" name="addPathCount">
                                <a-tooltip
                                    :title="validationErrors.addPathCount"
                                    :open="!!validationErrors.addPathCount"
                                >
                                    <a-input
                                        v-model:value="ipv4Data.addPathCount"
                                        :disabled="!ipv4Data.addPathEnabled"
                                        :status="validationErrors.addPathCount ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div v-if="isLabelRoute" class="config-section">
                    <div class="section-title">MPLS Label</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="8">
                            <a-form-item label="标签模式" name="labelMode">
                                <a-tooltip :title="validationErrors.labelMode" :open="!!validationErrors.labelMode">
                                    <a-radio-group v-model:value="ipv4Data.labelMode" button-style="solid">
                                        <a-radio-button :value="BGP_LABEL_MODE.FIXED">固定</a-radio-button>
                                        <a-radio-button :value="BGP_LABEL_MODE.INCREMENT">递增</a-radio-button>
                                    </a-radio-group>
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="8">
                            <a-form-item label="Label" name="labelStart">
                                <a-tooltip :title="validationErrors.labelStart" :open="!!validationErrors.labelStart">
                                    <a-input
                                        v-model:value="ipv4Data.labelStart"
                                        :status="validationErrors.labelStart ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col v-if="ipv4Data.labelMode === BGP_LABEL_MODE.INCREMENT" :xs="24" :md="8">
                            <a-form-item label="Step" name="labelStep">
                                <a-tooltip :title="validationErrors.labelStep" :open="!!validationErrors.labelStep">
                                    <a-input
                                        v-model:value="ipv4Data.labelStep"
                                        :status="validationErrors.labelStep ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                    </a-row>
                </div>

                <div v-if="!isLabelRoute" class="config-section">
                    <div class="section-title">SRv6</div>
                    <a-row :gutter="[16, 0]">
                        <a-col :xs="24" :md="6">
                            <a-form-item label="发送SID" name="srv6Enabled">
                                <a-switch v-model:checked="ipv4Data.srv6Enabled" />
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="SID模式" name="srv6SidMode">
                                <a-tooltip :title="validationErrors.srv6SidMode" :open="!!validationErrors.srv6SidMode">
                                    <a-radio-group
                                        v-model:value="ipv4Data.srv6SidMode"
                                        class="inline-radio-group"
                                        :disabled="!ipv4Data.srv6Enabled"
                                    >
                                        <a-radio :value="BGP_SRV6_SID_MODE.FIXED">固定</a-radio>
                                        <a-radio :value="BGP_SRV6_SID_MODE.INCREMENT">递增</a-radio>
                                    </a-radio-group>
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="8">
                            <a-form-item label="SID" name="srv6Sid">
                                <a-tooltip :title="validationErrors.srv6Sid" :open="!!validationErrors.srv6Sid">
                                    <a-input
                                        v-model:value="ipv4Data.srv6Sid"
                                        :disabled="!ipv4Data.srv6Enabled"
                                        :status="validationErrors.srv6Sid ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="SID Step" name="srv6SidStep">
                                <a-tooltip :title="validationErrors.srv6SidStep" :open="!!validationErrors.srv6SidStep">
                                    <a-input
                                        v-model:value="ipv4Data.srv6SidStep"
                                        :disabled="
                                            !ipv4Data.srv6Enabled ||
                                            ipv4Data.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT
                                        "
                                        :status="validationErrors.srv6SidStep ? 'error' : ''"
                                    />
                                </a-tooltip>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :md="6">
                            <a-form-item label="Endpoint" name="srv6EndpointBehavior">
                                <a-tooltip
                                    :title="validationErrors.srv6EndpointBehavior"
                                    :open="!!validationErrors.srv6EndpointBehavior"
                                >
                                    <a-select
                                        v-model:value="ipv4Data.srv6EndpointBehavior"
                                        :options="srv6EndpointBehaviorOptions"
                                        :disabled="!ipv4Data.srv6Enabled"
                                        :status="validationErrors.srv6EndpointBehavior ? 'error' : ''"
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
                        data-testid="bgp-generate-ipv4-routes-button"
                        type="primary"
                        :loading="routesGenerating"
                        @click="generateRoutes"
                    >
                        生成IPv4路由
                    </a-button>
                </div>
            </a-form>
        </a-card>

        <a-card :title="`已生成${displayRouteTitle}路由列表`" class="bgp-route-list-card">
            <template #extra>
                <a-space class="route-list-actions">
                    <a-button v-if="!isDisplayLabelRoute" size="small" @click="showRouteViewsImport">
                        从 RouteViews 导入
                    </a-button>
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
                </a-space>
            </template>

            <div class="route-display-toolbar">
                <a-radio-group
                    v-model:value="displayAddressFamily"
                    button-style="solid"
                    size="small"
                    class="route-display-switch"
                >
                    <a-radio-button :value="BGP_ADDR_FAMILY.IPV4_UNC">IPv4-UNC</a-radio-button>
                    <a-radio-button :value="BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST">IPv4 Label</a-radio-button>
                </a-radio-group>
            </div>

            <a-table
                data-testid="bgp-ipv4-route-table"
                :data-source="sentRoutes"
                :columns="routeColumns"
                :pagination="pagination"
                size="small"
                :row-key="record => `${record.rd || '0:0'}-${record.pathId ?? 0}-${record.ip}-${record.mask}`"
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
    import { onMounted, ref, computed, onActivated, nextTick, watch } from 'vue';
    import CustomPktDrawer from '../../components/CustomPktDrawer.vue';
    import RouteViewsImportModal from '../../components/RouteViewsImportModal.vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import { message, Modal } from 'ant-design-vue';
    import SettingOutlined from '@ant-design/icons-vue/es/icons/SettingOutlined';
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import FileSearchOutlined from '@ant-design/icons-vue/es/icons/FileSearchOutlined';
    import {
        BGP_ADDR_FAMILY,
        BGP_LABEL_MODE,
        BGP_SRV6_ENDPOINT_BEHAVIOR,
        BGP_SRV6_SID_MODE,
        DEFAULT_VALUES
    } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv4RouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv4'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };
    const addressFamilyOptions = [
        { label: 'IPv4-UNC', value: BGP_ADDR_FAMILY.IPV4_UNC },
        { label: 'IPv4 Label', value: BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST }
    ];
    const srv6EndpointBehaviorOptions = [
        { label: 'End.DT4', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4 },
        { label: 'End.DX4', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DX4 },
        { label: 'End.DT46', value: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT46 }
    ];

    const ipv4Data = ref({
        prefix: DEFAULT_VALUES.IPV4_PREFIX,
        mask: DEFAULT_VALUES.IPV4_MASK,
        count: DEFAULT_VALUES.IPV4_COUNT,
        addPathEnabled: DEFAULT_VALUES.IPV4_ADD_PATH_ENABLED,
        addPathCount: DEFAULT_VALUES.IPV4_ADD_PATH_COUNT,
        customAttr: '',
        rt: '',
        labelMode: DEFAULT_VALUES.IPV4_LABEL_MODE,
        labelStart: DEFAULT_VALUES.IPV4_LABEL_START,
        labelStep: DEFAULT_VALUES.IPV4_LABEL_STEP,
        srv6Enabled: DEFAULT_VALUES.IPV4_SRV6_ENABLED,
        srv6SidMode: DEFAULT_VALUES.IPV4_SRV6_SID_MODE,
        srv6Sid: DEFAULT_VALUES.IPV4_SRV6_SID,
        srv6SidStep: DEFAULT_VALUES.IPV4_SRV6_SID_STEP,
        srv6EndpointBehavior: DEFAULT_VALUES.IPV4_SRV6_ENDPOINT_BEHAVIOR,
        addressFamily: BGP_ADDR_FAMILY.IPV4_UNC
    });

    const validationErrors = ref({
        prefix: '',
        mask: '',
        count: '',
        addPathCount: '',
        rt: '',
        labelMode: '',
        labelStart: '',
        labelStep: '',
        srv6SidMode: '',
        srv6Sid: '',
        srv6SidStep: '',
        srv6EndpointBehavior: ''
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
    const displayAddressFamily = ref(BGP_ADDR_FAMILY.IPV4_UNC);
    const hasRoutes = computed(() => pagination.value.total > 0);
    const routesGenerating = ref(false);
    const deleteAllLoading = ref(false);
    const isLabelRoute = computed(() => ipv4Data.value.addressFamily === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST);
    const isDisplayLabelRoute = computed(() => displayAddressFamily.value === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST);
    const routeCardTitle = computed(() => (isLabelRoute.value ? 'IPv4 Label路由配置' : 'IPv4-UNC路由配置'));
    const displayRouteTitle = computed(() => (isDisplayLabelRoute.value ? 'IPv4 Label' : 'IPv4-UNC'));

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

    const routeColumns = computed(() => {
        const columns = [
            {
                title: '前缀',
                dataIndex: 'ip',
                key: 'ip',
                width: 140
            }
        ];

        if (!isDisplayLabelRoute.value) {
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
        }

        if (isDisplayLabelRoute.value) {
            columns.push({
                title: 'Label',
                dataIndex: 'label',
                key: 'label',
                width: 90,
                customRender: ({ text }) => (text === undefined || text === null ? '-' : text)
            });
        }

        columns.push({
            title: 'RT',
            dataIndex: 'rt',
            key: 'rt',
            width: 150,
            ellipsis: true
        });

        if (!isDisplayLabelRoute.value && sentRoutes.value.some(route => route.srv6Sid)) {
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

    watch(
        () => displayAddressFamily.value,
        async () => {
            pagination.value.current = 1;
            await refreshRoutes();
        }
    );

    watch(
        () => ipv4Data.value.addressFamily,
        value => {
            if (Number(value) === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
                ipv4Data.value.srv6Enabled = false;
                ipv4Data.value.addPathEnabled = false;
            }
        }
    );

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
            displayAddressFamily.value,
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
            const result = await window.bgpApi.getRouteDetail(route.addressFamily || displayAddressFamily.value, {
                ip: route.ip,
                mask: route.mask,
                rd: route.rd,
                pathId: route.pathId
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
                rd: route.rd || '0:0',
                pathId: route.pathId ?? 0,
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
                content: `确定要删除所有 ${pagination.value.total} 条${displayRouteTitle.value}路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    deleteAllLoading.value = true;
                    try {
                        // 调用新的批量删除API，只传地址族
                        const result = await window.bgpApi.deleteAllRoutesByFamily(displayAddressFamily.value);

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
                    } finally {
                        deleteAllLoading.value = false;
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

    .bgp-route-card :deep(.ant-card-head),
    .bgp-route-list-card :deep(.ant-card-head) {
        flex: 0 0 auto;
        min-height: 36px !important;
    }

    .bgp-route-card :deep(.ant-card-head-title),
    .bgp-route-list-card :deep(.ant-card-head-title) {
        padding: 8px 0 !important;
    }

    .bgp-route-list-card :deep(.ant-card-extra) {
        padding: 6px 0 !important;
    }

    .bgp-route-card :deep(.ant-card-body) {
        min-height: 0;
        overflow: visible;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .bgp-route-list-card :deep(.ant-card-body) {
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

    .bgp-route-form :deep(.ant-form-item) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .bgp-route-form :deep(.ant-form-item-label) {
        padding-bottom: 0;
    }

    .bgp-route-form :deep(.ant-input) {
        height: 28px;
    }

    .bgp-route-form :deep(.ant-select-selector) {
        min-height: 28px !important;
        height: 28px !important;
    }

    .bgp-route-form :deep(.ant-select-selection-item) {
        line-height: 26px !important;
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

    .route-list-actions {
        justify-content: flex-end;
    }

    .route-display-toolbar {
        flex: 0 0 auto;
        padding-bottom: 8px;
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

    .route-display-switch {
        display: inline-flex;
        flex-shrink: 0;
        flex-wrap: nowrap;
        gap: 0;
        white-space: nowrap;
    }

    .route-display-switch :deep(.ant-radio-button-wrapper) {
        min-width: 104px;
        text-align: center;
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
