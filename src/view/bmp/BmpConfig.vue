<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="BMP服务器配置">
                    <a-form :model="bmpConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBmp">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="服务端端口" name="port">
                                    <a-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <a-input
                                            v-model:value="bmpConfig.port"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="启用认证" name="enableAuth">
                                    <a-checkbox v-model:checked="bmpConfig.enableAuth" />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <!-- 认证配置 -->
                        <template v-if="bmpConfig.enableAuth">
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
                                                v-model:value="bmpConfig.localPort"
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
                                                v-model:value="bmpConfig.peerIP"
                                                :status="validationErrors.peerIP ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                                <a-col :span="12">
                                    <a-form-item label="认证模式" name="authMode">
                                        <a-radio-group v-model:value="bmpConfig.authMode">
                                            <a-radio value="md5">MD5 密钥</a-radio>
                                            <a-radio value="keychain">Keychain</a-radio>
                                        </a-radio-group>
                                    </a-form-item>
                                </a-col>
                            </a-row>

                            <!-- MD5 模式 -->
                            <a-row v-if="bmpConfig.authMode === 'md5'">
                                <a-col :span="24">
                                    <a-form-item label="MD5密钥" name="md5Password">
                                        <a-tooltip
                                            :title="validationErrors.md5Password"
                                            :open="!!validationErrors.md5Password"
                                        >
                                            <a-input-password
                                                v-model:value="bmpConfig.md5Password"
                                                :status="validationErrors.md5Password ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                            </a-row>

                            <!-- Keychain 模式 -->
                            <a-row v-if="bmpConfig.authMode === 'keychain'">
                                <a-col :span="24">
                                    <a-form-item label="选择 Keychain" name="keychainId">
                                        <a-select v-model:value="bmpConfig.keychainId" placeholder="请选择 Keychain">
                                            <a-select-option v-for="kc in keychains" :key="kc.id" :value="kc.id">
                                                {{ kc.name }} ({{ kc.keys.length }} 个密钥)
                                            </a-select-option>
                                        </a-select>
                                    </a-form-item>
                                </a-col>
                            </a-row>
                        </template>

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
                                <a-button type="primary" danger :disabled="!serverRunning" @click="stopBmp">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- BMP客户端列表 -->
        <a-row class="mt-margin-top-10">
            <a-col :span="24">
                <a-card title="BMP客户端列表">
                    <div>
                        <a-table
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="
                                record =>
                                    `${record.localIp || ''}-${record.localPort || ''}-${record.remoteIp || ''}-${record.remotePort || ''}`
                            "
                            :pagination="{ pageSize: 10, showSizeChanger: false, position: ['bottomCenter'] }"
                            :scroll="{ y: 200 }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'bmpVersion'">
                                    <a-tag :color="record.bmpVersion === 4 ? 'blue' : 'default'">
                                        {{ getBmpVersionName(record.bmpVersion) }}
                                    </a-tag>
                                </template>
                                <template v-else-if="column.key === 'tlvCount'">
                                    {{ getClientTlvCount(record) }}
                                </template>
                                <template v-else-if="column.key === 'action'">
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
    import { FormValidator, createBmpConfigValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, BMP_EVENT_PAGE_ID, getBmpVersionName } from '../../const/bmpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'BmpConfig'
    });

    const emit = defineEmits(['openSettings']);

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const bmpConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_BMP_PORT,
        localPort: '11019',
        enableAuth: false,
        authMode: 'md5', // 'md5' or 'keychain'
        peerIP: '',
        md5Password: '',
        keychainId: ''
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);
    const serverDeploymentStatus = ref(false);
    const keychains = ref([]);

    const getClientTlvCount = record => {
        return (record.rawTlvs || []).length + (record.terminationTlvs || []).length;
    };

    // Initiation messages list
    const clientList = ref([]);
    const clientColumns = [
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
            title: 'BMP版本',
            dataIndex: 'bmpVersion',
            key: 'bmpVersion',
            width: 90
        },
        {
            title: '系统名称',
            dataIndex: 'sysName',
            key: 'sysName',
            ellipsis: true
        },
        {
            title: '系统描述',
            dataIndex: 'sysDesc',
            key: 'sysDesc',
            ellipsis: true
        },
        {
            title: '接收时间',
            dataIndex: 'receivedAt',
            key: 'receivedAt',
            ellipsis: true,
            customRender: ({ text }) => {
                if (!text) return '';
                const date = new Date(text);
                return date.toLocaleString();
            }
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 90,
            align: 'right'
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
    validator.addRules(createBmpConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    // Open deployment settings
    const openDeploymentSettings = () => {
        emit('openSettings', 'server-deployment');
    };

    const startBmp = async () => {
        const hasErrors = validator.validate(bmpConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }

        if (!serverDeploymentStatus.value && bmpConfig.value.enableAuth) {
            message.error('请先部署服务器');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(bmpConfig.value));
            const saveResult = await window.bmpApi.saveBmpConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.bmpApi.startBmp(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                // Clear the client list when starting the server
                clientList.value = [];
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'BMP服务器启动失败');
            }
        } catch (error) {
            message.error(`BMP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopBmp = async () => {
        try {
            const result = await window.bmpApi.stopBmp();
            if (result.status === 'success') {
                serverRunning.value = false;
                clientList.value = [];
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'BMP服务器停止失败');
            }
        } catch (error) {
            message.error(`BMP服务器停止出错: ${error.message}`);
        }
    };

    const viewClientDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `BMP客户端信息: ${record.remoteIp}:${record.remotePort}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const onInitiationHandler = result => {
        const data = result.data;
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(
                client =>
                    `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                    `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
            );
            if (existingIndex !== -1) {
                clientList.value[existingIndex] = data;
            } else {
                clientList.value.push(data);
            }
        } else {
            console.error('initiation handler error', data.msg);
        }
    };

    const onTerminationHandler = result => {
        if (result && result.data) {
            const data = result.data;
            if (result.status === 'success') {
                const existingIndex = clientList.value.findIndex(
                    client =>
                        `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                        `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
                );
                if (existingIndex !== -1) {
                    clientList.value.splice(existingIndex, 1);
                }
            } else {
                console.error('termination handler error', data.msg);
            }
        } else {
            clientList.value = [];
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.bmpApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;
            }
        } catch (error) {
            console.error(error);
            message.error('加载数据失败');
        }
    };

    onActivated(async () => {
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onInitiationHandler);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onTerminationHandler);
        await loadClientList();
    });

    onDeactivated(() => {
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
    });

    onMounted(async () => {
        // 加载BMP配置
        const savedConfig = await window.bmpApi.loadBmpConfig();
        if (savedConfig.status === 'success' && savedConfig.data) {
            bmpConfig.value.port = savedConfig.data.port || DEFAULT_VALUES.DEFAULT_BMP_PORT;
            bmpConfig.value.enableAuth = savedConfig.data.enableAuth || false;
            bmpConfig.value.authMode = savedConfig.data.authMode || 'md5';
            bmpConfig.value.localPort = savedConfig.data.localPort;
            bmpConfig.value.peerIP = savedConfig.data.peerIP || '';
            bmpConfig.value.md5Password = savedConfig.data.md5Password || '';
            bmpConfig.value.keychainId = savedConfig.data.keychainId || '';
        } else {
            console.error('配置文件加载失败', savedConfig.msg);
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
    });
</script>

<style scoped>
    :deep(.ant-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
