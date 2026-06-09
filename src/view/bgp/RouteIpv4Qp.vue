<template>
    <div class="mt-container">
        <a-card title="IPv4-QP路由配置">
            <a-form :model="ipv4QpData" :label-col="labelCol" :wrapper-col="wrapperCol">
                <a-row>
                    <a-col :span="8">
                        <a-form-item label="Prefix" name="prefix">
                            <a-tooltip :title="validationErrors.prefix" :open="!!validationErrors.prefix">
                                <a-input
                                    v-model:value="ipv4QpData.prefix"
                                    :status="validationErrors.prefix ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Mask" name="mask">
                            <a-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                <a-input
                                    v-model:value="ipv4QpData.mask"
                                    :status="validationErrors.mask ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="Count" name="count">
                            <a-tooltip :title="validationErrors.count" :open="!!validationErrors.count">
                                <a-input
                                    v-model:value="ipv4QpData.count"
                                    :status="validationErrors.count ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                </a-row>
                <a-row>
                    <a-col :span="8">
                        <a-form-item label="Start DQPN" name="startDqpn">
                            <a-tooltip :title="validationErrors.startDqpn" :open="!!validationErrors.startDqpn">
                                <a-input
                                    v-model:value="ipv4QpData.startDqpn"
                                    :status="validationErrors.startDqpn ? 'error' : ''"
                                />
                            </a-tooltip>
                        </a-form-item>
                    </a-col>
                    <a-col :span="8">
                        <a-form-item label="BSID" name="bsid">
                            <a-tooltip :title="validationErrors.bsid" :open="!!validationErrors.bsid">
                                <a-input
                                    v-model:value="ipv4QpData.bsid"
                                    :status="validationErrors.bsid ? 'error' : ''"
                                />
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
                    <a-button type="primary" :loading="routesGenerating" @click="generateRoutes">生成IPv4-QP路由</a-button>
                </a-form-item>

                <!-- 路由列表 -->
                <div class="route-list-section">
                    <div class="route-list-header">
                        <UnorderedListOutlined />
                        <span class="header-text">已生成IPv4-QP路由列表</span>
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
                    </div>
                    <a-table
                        :data-source="sentRoutes"
                        :columns="routeColumns"
                        :pagination="pagination"
                        size="small"
                        :row-key="record => `${record.dqpn}-${record.ip}-${record.mask}`"
                        :scroll="{ y: 240 }"
                        @change="handleTableChange"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'action'">
                                <a-button type="primary" danger size="small" @click="deleteSingleRoute(record)">
                                    <template #icon><DeleteOutlined /></template>
                                    删除
                                </a-button>
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
            v-model:input-value="ipv4QpData.customAttr"
            @submit="handleCustomRouteAttrSubmit"
        />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, onActivated, nextTick } from 'vue';
    import CustomPktDrawer from '../../components/CustomPktDrawer.vue';
    import { message } from 'ant-design-vue';
    import { SettingOutlined, UnorderedListOutlined, DeleteOutlined } from '@ant-design/icons-vue';
    import { BGP_ADDR_FAMILY } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv4QpRouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv4Qp'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const ipv4QpData = ref({
        prefix: '1.1.1.1',
        mask: '32',
        count: '10',
        startDqpn: '1',
        bsid: '',
        customAttr: '',
        addressFamily: BGP_ADDR_FAMILY.IPV4_QP
    });

    const validationErrors = ref({
        prefix: '',
        mask: '',
        count: '',
        startDqpn: '',
        bsid: ''
    });

    const validator = new FormValidator(validationErrors);
    validator.addRules(createBgpIpv4QpRouteConfigValidationRules());

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
        ipv4QpData.value.customAttr = data;
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
            width: 140
        },
        {
            title: 'BSID (下一跳)',
            dataIndex: 'nextHop',
            key: 'nextHop',
            width: 150
        },
        {
            title: 'origin',
            dataIndex: 'origin',
            key: 'origin',
            width: 50
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
            width: 100,
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
        const savedConfig = await window.bgpApi.loadIpv4QpRouteConfig();
        if (savedConfig.status === 'success' && savedConfig.data) {
            Object.assign(ipv4QpData.value, savedConfig.data);
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
            BGP_ADDR_FAMILY.IPV4_QP,
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
            const hasErrors = validator.validate(ipv4QpData.value);
            if (hasErrors) {
                message.error('请检查IPv4-QP路由配置信息是否正确');
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = JSON.parse(JSON.stringify(ipv4QpData.value));
            const saveResult = await window.bgpApi.saveIpv4QpRouteConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.generateIpv4QpRoutes(payload);
            if (result.status === 'success') {
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`IPv4-QP路由生成失败: ${e.message}`);
        } finally {
            routesGenerating.value = false;
        }
    };

    const deleteAllRoutes = async () => {
        try {
            const result = await window.bgpApi.deleteAllRoutesByFamily(BGP_ADDR_FAMILY.IPV4_QP);
            if (result.status === 'success') {
                message.success(`${result.msg}`);
                pagination.value.current = 1;
                await refreshRoutes();
            } else {
                message.error(`${result.msg}`);
            }
        } catch (e) {
            message.error(`IPv4-QP路由删除失败: ${e.message}`);
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

            const result = await window.bgpApi.deleteIpv4QpRoutes(config);

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
    .route-list-section {
        margin-top: 24px;
        border-top: 1px solid #f0f0f0;
        padding-top: 16px;
    }

    .route-list-header {
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

    :deep(.ant-table-body) {
        min-height: 240px;
    }
</style>
