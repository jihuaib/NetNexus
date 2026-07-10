<template>
    <div class="mt-container adaptive-list-page" data-testid="rpki-config-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="RPKI服务器配置">
                    <a-form :model="rpkiConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startRpki">
                        <nn-row>
                            <nn-col :span="24">
                                <a-form-item label="服务端端口" name="port">
                                    <nn-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <a-input
                                            v-model:value="rpkiConfig.port"
                                            data-testid="rpki-port-input"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </a-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <a-form-item label="启用认证" name="enableAuth">
                                    <nn-checkbox v-model:checked="rpkiConfig.enableAuth" />
                                </a-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <a-form-item label="最高协议版本" name="maxProtocolVersion">
                                    <nn-radio-group v-model:value="rpkiConfig.maxProtocolVersion">
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V2">v2 - 支持 ASPA</nn-radio>
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V1">v1 - 支持 Router Key</nn-radio>
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V0">v0 - 仅基础 ROA</nn-radio>
                                    </nn-radio-group>
                                    <div style="color: var(--nn-color-text-muted); font-size: 12px; line-height: 1.5">
                                        用于模拟不同能力的 RPKI-RTR cache。客户端请求高于该版本时，服务端返回
                                        Unsupported Protocol Version 并断开连接，客户端应按错误 PDU 版本重试。
                                    </div>
                                </a-form-item>
                            </nn-col>
                        </nn-row>
                        <!-- 认证配置 -->
                        <nn-row :gutter="12">
                            <nn-col :span="8">
                                <a-form-item label="本地监听端口" name="localPort">
                                    <nn-tooltip
                                        :title="validationErrors.localPort"
                                        :open="rpkiConfig.enableAuth && !!validationErrors.localPort"
                                    >
                                        <a-input
                                            v-model:value="rpkiConfig.localPort"
                                            :disabled="!rpkiConfig.enableAuth"
                                            :status="rpkiConfig.enableAuth && validationErrors.localPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </a-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <a-form-item label="路由器IP" name="peerIP">
                                    <nn-tooltip
                                        :title="validationErrors.peerIP"
                                        :open="rpkiConfig.enableAuth && !!validationErrors.peerIP"
                                    >
                                        <a-input
                                            v-model:value="rpkiConfig.peerIP"
                                            :disabled="!rpkiConfig.enableAuth"
                                            :status="rpkiConfig.enableAuth && validationErrors.peerIP ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </a-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <a-form-item label="MD5密钥" name="md5Password">
                                    <nn-tooltip
                                        :title="validationErrors.md5Password"
                                        :open="rpkiConfig.enableAuth && !!validationErrors.md5Password"
                                    >
                                        <a-input-password
                                            v-model:value="rpkiConfig.md5Password"
                                            :disabled="!rpkiConfig.enableAuth"
                                            :status="
                                                rpkiConfig.enableAuth && validationErrors.md5Password ? 'error' : ''
                                            "
                                        />
                                    </nn-tooltip>
                                </a-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <a-form-item label="ASPA编码格式" name="aspaFormat">
                                    <nn-radio-group
                                        v-model:value="rpkiConfig.aspaFormat"
                                        :disabled="rpkiConfig.maxProtocolVersion < RPKI_PROTOCOL_VERSION.V2"
                                    >
                                        <nn-radio :value="RPKI_ASPA_FORMAT.LATEST">最新 (current 8210bis)</nn-radio>
                                        <nn-radio :value="RPKI_ASPA_FORMAT.LEGACY">兼容 (draft-10 / 华为 VRP)</nn-radio>
                                    </nn-radio-group>
                                    <div style="color: var(--nn-color-text-muted); font-size: 12px; line-height: 1.5">
                                        最新格式遵循当前 draft-ietf-sidrops-8210bis 规范；兼容格式按 draft-10 在 body
                                        中携带 Flags、AFI Flags 和 Provider AS Count，适用于华为 VRP
                                        等老旧设备。仅在协议 v2 协商成功时生效。
                                    </div>
                                </a-form-item>
                            </nn-col>
                        </nn-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <nn-space>
                                <nn-button
                                    data-testid="rpki-start-button"
                                    type="primary"
                                    html-type="submit"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button
                                    data-testid="rpki-stop-button"
                                    type="primary"
                                    danger
                                    :disabled="!serverRunning"
                                    @click="stopRpki"
                                >
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </a-form-item>
                    </a-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <!-- RPKI客户端列表 -->
        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card title="RPKI客户端列表" class="adaptive-list-card">
                    <div>
                        <a-table
                            data-testid="rpki-client-table"
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="
                                record =>
                                    `${record.localIp}|${record.localPort}|${record.remoteIp}|${record.remotePort}`
                            "
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ y: '100%' }"
                            size="small"
                            class="adaptive-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <nn-button type="link" @click="viewClientDetails(record)">详情</nn-button>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <a-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </a-drawer>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { FormValidator, createRpkiConfigValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, RPKI_EVENT_PAGE_ID, RPKI_PROTOCOL_VERSION, RPKI_ASPA_FORMAT } from '../../const/rpkiConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'RpkiConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const rpkiConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_RPKI_PORT,
        localPort: '11019',
        enableAuth: false,
        peerIP: '',
        md5Password: '',
        maxProtocolVersion: DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION,
        aspaFormat: RPKI_ASPA_FORMAT.LATEST
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);

    const normalizeMaxProtocolVersion = version => {
        const maxProtocolVersion = Number(version);
        return Object.values(RPKI_PROTOCOL_VERSION).includes(maxProtocolVersion)
            ? maxProtocolVersion
            : DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION;
    };

    // 客户端列表
    const clientList = ref([]);
    const clientColumns = [
        {
            title: '本地IP',
            dataIndex: 'localIp',
            key: 'localIp',
            ellipsis: true
        },
        {
            title: '本地端口',
            dataIndex: 'localPort',
            key: 'localPort',
            ellipsis: true
        },
        {
            title: '客户端IP',
            dataIndex: 'remoteIp',
            key: 'remoteIp',
            ellipsis: true
        },
        {
            title: '客户端端口',
            dataIndex: 'remotePort',
            key: 'remotePort',
            ellipsis: true
        },
        {
            title: '协议版本',
            key: 'protocolVersion',
            ellipsis: true,
            customRender: ({ record }) =>
                record.protocolVersion === undefined || record.protocolVersion === null
                    ? '-'
                    : `v${record.protocolVersion}`
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const validationErrors = ref({
        port: '',
        localPort: '',
        peerIP: '',
        md5Password: ''
    });

    let validator = new FormValidator(validationErrors);
    validator.addRules(createRpkiConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    const isServerDeployed = async () => {
        const deploymentStatus = await window.commonApi.getServerDeploymentStatus();
        return deploymentStatus.status === 'success' && deploymentStatus.data.success;
    };

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const startRpki = async () => {
        const hasErrors = validator.validate(rpkiConfig.value);
        if (hasErrors) {
            notify.error('请检查配置信息是否正确');
            return;
        }

        if (rpkiConfig.value.enableAuth && !(await isServerDeployed())) {
            notify.error('请先部署服务器');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(rpkiConfig.value));
            const saveResult = await window.rpkiApi.saveRpkiConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.rpkiApi.startRpki(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                // 清空客户端列表
                clientList.value = [];
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'RPKI服务器启动失败');
            }
        } catch (error) {
            notify.error(`RPKI服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopRpki = async () => {
        try {
            const result = await window.rpkiApi.stopRpki();
            if (result.status === 'success') {
                serverRunning.value = false;
                // 清空客户端列表
                clientList.value = [];
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'RPKI服务器停止失败');
            }
        } catch (error) {
            notify.error(`RPKI服务器停止出错: ${error.message}`);
        }
    };

    const viewClientDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `RPKI客户端信息: ${record.remoteIp}:${record.remotePort}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const onClientConnection = result => {
        if (result.status === 'success') {
            const data = result.data;
            const matchClient = item =>
                item.localIp === data.data.localIp &&
                item.localPort === data.data.localPort &&
                item.remoteIp === data.data.remoteIp &&
                item.remotePort === data.data.remotePort;

            if (data.opType === 'add') {
                clientList.value.push(data.data);
            } else if (data.opType === 'delete') {
                const index = clientList.value.findIndex(matchClient);
                if (index !== -1) {
                    clientList.value.splice(index, 1);
                }
            } else if (data.opType === 'update') {
                const index = clientList.value.findIndex(matchClient);
                if (index !== -1) {
                    clientList.value[index] = { ...clientList.value[index], ...data.data };
                }
            }
        } else {
            notify.error(result.msg || '获取客户端列表失败');
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.rpkiApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    onActivated(async () => {
        EventBus.on('rpki:clientConnection', RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG, onClientConnection);
        await loadClientList();
    });

    onDeactivated(() => {
        EventBus.off('rpki:clientConnection', RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG);
    });

    onMounted(async () => {
        try {
            // 加载配置
            const result = await window.rpkiApi.loadRpkiConfig();
            if (result.status === 'success' && result.data) {
                rpkiConfig.value.port = result.data.port;
                rpkiConfig.value.enableAuth = result.data.enableAuth || false;
                rpkiConfig.value.localPort = result.data.localPort;
                rpkiConfig.value.peerIP = result.data.peerIP || '';
                rpkiConfig.value.md5Password = result.data.md5Password || '';
                rpkiConfig.value.maxProtocolVersion = normalizeMaxProtocolVersion(
                    result.data.maxProtocolVersion ?? DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION
                );
                rpkiConfig.value.aspaFormat = result.data.aspaFormat || RPKI_ASPA_FORMAT.LATEST;
            } else {
                console.error('配置文件加载失败', result.msg);
            }
        } catch (error) {
            console.error('初始化RPKI配置出错:', error);
        }
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.nn-card-body),
    .adaptive-list-card :deep(.nn-card-body > div) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.ant-spin-nested-loading),
    .adaptive-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .adaptive-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.ant-table-container),
    .adaptive-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
