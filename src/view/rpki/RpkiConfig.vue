<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="RPKI服务器配置">
                    <a-form :model="rpkiConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startRpki">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="服务端端口" name="port">
                                    <a-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <a-input
                                            v-model:value="rpkiConfig.port"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="启用认证" name="enableAuth">
                                    <a-checkbox v-model:checked="rpkiConfig.enableAuth" />
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <!-- 认证配置 -->
                        <template v-if="rpkiConfig.enableAuth">
                            <a-alert
                                v-if="!serverDeploymentStatus"
                                type="info"
                                message="认证需要服务器部署"
                                show-icon
                                style="margin-bottom: 16px"
                            >
                                <template #description>
                                    使用 认证需要先在 Linux 服务器上部署代理程序。
                                    <a style="margin-left: 8px" @click="openDeploymentSettings">前往服务器部署设置 →</a>
                                </template>
                            </a-alert>

                            <a-row>
                                <a-col :span="24">
                                    <a-form-item label="本地监听端口" name="localPort">
                                        <a-tooltip
                                            :title="validationErrors.localPort"
                                            :open="!!validationErrors.localPort"
                                        >
                                            <a-input
                                                v-model:value="rpkiConfig.localPort"
                                                :status="validationErrors.localPort ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                            </a-row>
                            <a-row>
                                <a-col :span="12">
                                    <a-form-item label="路由器IP" name="peerIP">
                                        <a-tooltip :title="validationErrors.peerIP" :open="!!validationErrors.peerIP">
                                            <a-input
                                                v-model:value="rpkiConfig.peerIP"
                                                :status="validationErrors.peerIP ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                                <a-col :span="12">
                                    <a-form-item label="认证模式" name="authMode">
                                        <a-radio-group v-model:value="rpkiConfig.authMode">
                                            <a-radio value="md5">MD5 密钥</a-radio>
                                            <a-radio value="keychain">Keychain</a-radio>
                                        </a-radio-group>
                                    </a-form-item>
                                </a-col>
                            </a-row>

                            <!-- MD5 模式 -->
                            <a-row v-if="rpkiConfig.authMode === 'md5'">
                                <a-col :span="24">
                                    <a-form-item label="MD5密钥" name="md5Password">
                                        <a-tooltip
                                            :title="validationErrors.md5Password"
                                            :open="!!validationErrors.md5Password"
                                        >
                                            <a-input-password
                                                v-model:value="rpkiConfig.md5Password"
                                                :status="validationErrors.md5Password ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                            </a-row>

                            <!-- Keychain 模式 -->
                            <a-row v-if="rpkiConfig.authMode === 'keychain'">
                                <a-col :span="24">
                                    <a-form-item label="选择 Keychain" name="keychainId">
                                        <a-select v-model:value="rpkiConfig.keychainId" placeholder="请选择 Keychain">
                                            <a-select-option v-for="kc in keychains" :key="kc.id" :value="kc.id">
                                                {{ kc.name }} ({{ kc.keys.length }} 个密钥)
                                            </a-select-option>
                                        </a-select>
                                    </a-form-item>
                                </a-col>
                            </a-row>
                        </template>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="ASPA编码格式" name="aspaFormat">
                                    <a-radio-group v-model:value="rpkiConfig.aspaFormat">
                                        <a-radio :value="RPKI_ASPA_FORMAT.LATEST">
                                            最新 (current 8210bis)
                                        </a-radio>
                                        <a-radio :value="RPKI_ASPA_FORMAT.LEGACY">
                                            兼容 (draft-10 / 华为 VRP)
                                        </a-radio>
                                    </a-radio-group>
                                    <div style="color: #999; font-size: 12px; line-height: 1.5">
                                        最新格式遵循当前 draft-ietf-sidrops-8210bis 规范；兼容格式按 draft-10 在 body 中携带
                                        Flags、AFI Flags 和 Provider AS Count，适用于华为 VRP 等老旧设备。仅在协议 v2 协商成功时生效。
                                    </div>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button
                                    type="primary"
                                    html-type="submit"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                >
                                    启动服务器
                                </a-button>
                                <a-button type="primary" danger :disabled="!serverRunning" @click="stopRpki">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- RPKI客户端列表 -->
        <a-row class="mt-margin-top-10">
            <a-col :span="24">
                <a-card title="RPKI客户端列表">
                    <div>
                        <a-table
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="
                                record =>
                                    `${record.localIp}|${record.localPort}|${record.remoteIp}|${record.remotePort}`
                            "
                            :pagination="{ pageSize: 10, showSizeChanger: false, position: ['bottomCenter'] }"
                            :scroll="{ y: 200 }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <a-button type="link" @click="viewClientDetails(record)">详情</a-button>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </a-card>
            </a-col>
        </a-row>

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
    import { message } from 'ant-design-vue';
    import { FormValidator, createRpkiConfigValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, RPKI_EVENT_PAGE_ID, RPKI_ASPA_FORMAT } from '../../const/rpkiConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'RpkiConfig'
    });

    const emit = defineEmits(['openSettings']);

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const rpkiConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_RPKI_PORT,
        localPort: '11019',
        enableAuth: false,
        authMode: 'md5', // 'md5' or 'keychain'
        peerIP: '',
        md5Password: '',
        keychainId: '',
        aspaFormat: RPKI_ASPA_FORMAT.LATEST
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);
    const serverDeploymentStatus = ref(false);
    const keychains = ref([]);

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

    // Open deployment settings
    const openDeploymentSettings = () => {
        emit('openSettings', 'server-deployment');
    };

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const startRpki = async () => {
        const hasErrors = validator.validate(rpkiConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }

        if (!serverDeploymentStatus.value && rpkiConfig.value.enableAuth) {
            message.error('请先部署服务器');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(rpkiConfig.value));
            const saveResult = await window.rpkiApi.saveRpkiConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.rpkiApi.startRpki(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                // 清空客户端列表
                clientList.value = [];
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'RPKI服务器启动失败');
            }
        } catch (error) {
            message.error(`RPKI服务器启动出错: ${error.message}`);
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
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'RPKI服务器停止失败');
            }
        } catch (error) {
            message.error(`RPKI服务器停止出错: ${error.message}`);
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
            message.error(result.msg || '获取客户端列表失败');
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
            message.error('加载数据失败');
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
                rpkiConfig.value.authMode = result.data.authMode || 'md5';
                rpkiConfig.value.localPort = result.data.localPort;
                rpkiConfig.value.peerIP = result.data.peerIP || '';
                rpkiConfig.value.md5Password = result.data.md5Password || '';
                rpkiConfig.value.keychainId = result.data.keychainId || '';
                rpkiConfig.value.aspaFormat = result.data.aspaFormat || RPKI_ASPA_FORMAT.LATEST;
            } else {
                console.error('配置文件加载失败', result.msg);
            }

            // 加载 Keychains
            const keychainsResult = await window.commonApi.loadKeychains();
            if (keychainsResult.status === 'success') {
                keychains.value = keychainsResult.data || [];
            }

            // 检查服务器部署状态
            const deploymentStatus = await window.commonApi.getServerDeploymentStatus();
            if (deploymentStatus.status === 'success' && deploymentStatus.data.success) {
                serverDeploymentStatus.value = true;
            }
        } catch (error) {
            console.error('初始化RPKI配置出错:', error);
        }
    });
</script>

<style scoped>
    :deep(.ant-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
