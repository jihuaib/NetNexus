<template>
    <div class="mt-container adaptive-config-page">
        <a-row class="adaptive-config-row">
            <a-col :span="24">
                <a-card title="TFTP服务器配置">
                    <a-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row :gutter="24">
                            <a-col :span="8">
                                <a-form-item label="监听端口">
                                    <a-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <a-input-number
                                            v-model:value="formData.port"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="16">
                                <a-form-item label="根目录">
                                    <a-tooltip :title="validationErrors.rootDir" :open="!!validationErrors.rootDir">
                                        <a-input-group compact>
                                            <a-input
                                                v-model:value="formData.rootDir"
                                                :status="validationErrors.rootDir ? 'error' : ''"
                                                style="width: calc(100% - 40px)"
                                                readonly
                                                placeholder="请选择 TFTP 文件根目录"
                                            />
                                            <a-button type="primary" @click="selectDirectory">
                                                <folder-outlined />
                                            </a-button>
                                        </a-input-group>
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row :gutter="24">
                            <a-col :span="8">
                                <a-form-item label="块大小">
                                    <a-tooltip :title="validationErrors.blockSize" :open="!!validationErrors.blockSize">
                                        <a-input-number
                                            v-model:value="formData.blockSize"
                                            :min="8"
                                            :max="65464"
                                            addon-after="字节"
                                            style="width: 100%"
                                            :status="validationErrors.blockSize ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="超时时间">
                                    <a-tooltip :title="validationErrors.timeout" :open="!!validationErrors.timeout">
                                        <a-input-number
                                            v-model:value="formData.timeout"
                                            :min="1"
                                            :max="255"
                                            addon-after="秒"
                                            style="width: 100%"
                                            :status="validationErrors.timeout ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="重传次数">
                                    <a-tooltip :title="validationErrors.retries" :open="!!validationErrors.retries">
                                        <a-input-number
                                            v-model:value="formData.retries"
                                            :min="0"
                                            :max="20"
                                            style="width: 100%"
                                            :status="validationErrors.retries ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row :gutter="24">
                            <a-col :span="8">
                                <a-form-item label="允许读取(下载)">
                                    <a-switch v-model:checked="formData.allowRead" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="允许写入(上传)">
                                    <a-switch v-model:checked="formData.allowWrite" />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <div style="margin-top: 8px; color: rgba(0, 0, 0, 0.45)">
                            默认端口为 69（绑定该端口通常需要管理员/root 权限）。支持 RFC 2347/2348/2349
                            选项协商（blksize、timeout、tsize）。
                        </div>

                        <div style="margin-top: 12px; display: flex; justify-content: center">
                            <a-space>
                                <a-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="isServerRunning"
                                    @click="startTftp"
                                >
                                    启动服务器
                                </a-button>
                                <a-button type="primary" danger :disabled="!isServerRunning" @click="stopTftp">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </div>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <a-row class="adaptive-config-fill-row">
            <a-col :span="24">
                <a-card title="服务状态" class="adaptive-config-fill-card">
                    <a-descriptions :column="2" bordered>
                        <a-descriptions-item label="服务状态">
                            <a-tag :color="isServerRunning ? 'green' : 'red'">
                                {{ isServerRunning ? '运行中' : '已停止' }}
                            </a-tag>
                        </a-descriptions-item>
                        <a-descriptions-item label="监听端口">{{ formData.port }}</a-descriptions-item>
                        <a-descriptions-item label="根目录" :span="2">
                            {{ formData.rootDir || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="块大小">{{ formData.blockSize }} 字节</a-descriptions-item>
                        <a-descriptions-item label="已记录传输">{{ transferCount }}</a-descriptions-item>
                        <a-descriptions-item label="最近传输时间">{{ lastTransferAt }}</a-descriptions-item>
                        <a-descriptions-item label="最近客户端">{{ lastClient }}</a-descriptions-item>
                    </a-descriptions>
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import FolderOutlined from '@ant-design/icons-vue/es/icons/FolderOutlined';
    import { DEFAULT_VALUES, TFTP_SUB_EVT_TYPES, TFTP_EVENT_PAGE_ID } from '../../const/tftpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'TftpConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const formData = ref({
        port: DEFAULT_VALUES.DEFAULT_TFTP_PORT,
        rootDir: DEFAULT_VALUES.DEFAULT_TFTP_ROOT_DIR,
        blockSize: DEFAULT_VALUES.DEFAULT_TFTP_BLOCK_SIZE,
        timeout: DEFAULT_VALUES.DEFAULT_TFTP_TIMEOUT,
        retries: DEFAULT_VALUES.DEFAULT_TFTP_RETRIES,
        allowRead: DEFAULT_VALUES.DEFAULT_TFTP_ALLOW_READ,
        allowWrite: DEFAULT_VALUES.DEFAULT_TFTP_ALLOW_WRITE
    });

    const validationErrors = ref({
        port: '',
        rootDir: '',
        blockSize: '',
        timeout: '',
        retries: ''
    });

    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const transferCount = ref(0);
    const lastTransferAt = ref('-');
    const lastClient = ref('-');

    const emptyErrors = () => ({ port: '', rootDir: '', blockSize: '', timeout: '', retries: '' });

    const validateConfig = () => {
        const errors = {};
        const port = Number(formData.value.port);
        const blockSize = Number(formData.value.blockSize);
        const timeout = Number(formData.value.timeout);
        const retries = Number(formData.value.retries);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            errors.port = '端口范围 1-65535';
        }
        if (!formData.value.rootDir) {
            errors.rootDir = '请选择根目录';
        }
        if (!Number.isInteger(blockSize) || blockSize < 8 || blockSize > 65464) {
            errors.blockSize = '块大小范围 8-65464';
        }
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 255) {
            errors.timeout = '超时范围 1-255 秒';
        }
        if (!Number.isInteger(retries) || retries < 0 || retries > 20) {
            errors.retries = '重传次数范围 0-20';
        }

        validationErrors.value = { ...emptyErrors(), ...errors };
        return Object.keys(errors).length === 0;
    };

    const loadConfig = async () => {
        try {
            const result = await window.tftpApi.getTftpConfig();
            if (result.status === 'success' && result.data) {
                formData.value = { ...formData.value, ...result.data };
            }
        } catch (error) {
            message.error('加载配置失败: ' + error.message);
        }
    };

    const selectDirectory = async () => {
        try {
            const result = await window.commonApi.selectDirectory();
            if (result.status === 'success') {
                const data = result.data;
                if (data.filePaths && data.filePaths.length > 0) {
                    formData.value.rootDir = data.filePaths[0];
                }
            }
        } catch (error) {
            message.error(`选择目录失败: ${error.message}`);
        }
    };

    const startTftp = async () => {
        if (!validateConfig()) {
            message.error('请检查输入的数据');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(formData.value));
            const saveResult = await window.tftpApi.saveTftpConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;
            const startResult = await window.tftpApi.startTftp(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                message.success(startResult.msg || 'TFTP服务启动成功');
            } else {
                message.error(startResult.msg || 'TFTP服务启动失败');
            }
        } catch (error) {
            message.error('TFTP服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopTftp = async () => {
        try {
            const result = await window.tftpApi.stopTftp();
            if (result.status === 'success') {
                message.success(result.msg || 'TFTP服务已停止');
                isServerRunning.value = false;
                transferCount.value = 0;
                lastTransferAt.value = '-';
                lastClient.value = '-';
            } else {
                message.error(result.msg || 'TFTP服务停止失败');
            }
        } catch (error) {
            message.error('TFTP服务停止失败: ' + error.message);
        }
    };

    const handleTftpEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === TFTP_SUB_EVT_TYPES.TRANSFER_UPDATE) {
            transferCount.value = payload.stats?.transferCount ?? transferCount.value;
            lastTransferAt.value = payload.stats?.lastTransferAt || lastTransferAt.value;
            lastClient.value = payload.stats?.lastClient || lastClient.value;
        } else if (payload.type === TFTP_SUB_EVT_TYPES.SERVER_STATUS) {
            isServerRunning.value = payload.data.status === 'running';
            if (!isServerRunning.value) {
                transferCount.value = 0;
                lastTransferAt.value = '-';
                lastClient.value = '-';
            }
        } else if (payload.type === TFTP_SUB_EVT_TYPES.HISTORY_CLEARED) {
            transferCount.value = 0;
            lastTransferAt.value = '-';
            lastClient.value = '-';
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            validationErrors.value = emptyErrors();
        }
    });

    onMounted(() => {
        loadConfig();
    });

    onActivated(() => {
        EventBus.on('tftp:event', TFTP_EVENT_PAGE_ID.PAGE_ID_TFTP_CONFIG, handleTftpEvent);
    });

    onDeactivated(() => {
        EventBus.off('tftp:event', TFTP_EVENT_PAGE_ID.PAGE_ID_TFTP_CONFIG);
    });
</script>

<style scoped>
    .adaptive-config-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-config-row {
        flex: 0 0 auto;
    }

    .adaptive-config-fill-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-config-fill-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-config-fill-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-config-fill-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
</style>
