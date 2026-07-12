<template>
    <div class="nn-container adaptive-config-page">
        <nn-row class="adaptive-config-row">
            <nn-col :span="24">
                <nn-card title="Syslog服务器配置">
                    <nn-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <nn-row :gutter="24">
                            <nn-col :span="8">
                                <nn-form-item label="监听端口">
                                    <nn-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <nn-input-number
                                            v-model:value="formData.port"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="最大消息长度">
                                    <nn-tooltip
                                        :title="validationErrors.maxMessageLength"
                                        :open="!!validationErrors.maxMessageLength"
                                    >
                                        <nn-input-number
                                            v-model:value="formData.maxMessageLength"
                                            :min="128"
                                            :max="65535"
                                            addon-after="字节"
                                            style="width: 100%"
                                            :status="validationErrors.maxMessageLength ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="传输协议">
                                    <nn-tooltip :title="validationErrors.protocol" :open="!!validationErrors.protocol">
                                        <nn-space>
                                            <span>UDP</span>
                                            <nn-switch v-model:checked="formData.enableUdp" />
                                            <span>TCP</span>
                                            <nn-switch v-model:checked="formData.enableTcp" />
                                        </nn-space>
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <div style="margin-top: 8px; color: var(--nn-color-text-muted)">
                            默认端口为 514（绑定该端口通常需要管理员/root 权限）。TCP 同时支持 RFC 6587 octet-counting
                            和换行分帧。
                        </div>

                        <div style="margin-top: 12px; display: flex; justify-content: center">
                            <nn-space>
                                <nn-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="isServerRunning"
                                    @click="startSyslog"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button type="primary" danger :disabled="!isServerRunning" @click="stopSyslog">
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </div>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-row class="adaptive-config-fill-row">
            <nn-col :span="24">
                <nn-card title="服务状态" class="adaptive-config-fill-card">
                    <nn-descriptions :column="2" bordered>
                        <nn-descriptions-item label="服务状态">
                            <nn-tag :color="isServerRunning ? 'green' : 'red'">
                                {{ isServerRunning ? '运行中' : '已停止' }}
                            </nn-tag>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="监听端口">{{ formData.port }}</nn-descriptions-item>
                        <nn-descriptions-item label="传输协议">{{ protocolText }}</nn-descriptions-item>
                        <nn-descriptions-item label="最大消息长度">
                            {{ formData.maxMessageLength }} 字节
                        </nn-descriptions-item>
                        <nn-descriptions-item label="已记录消息">{{ messageCount }}</nn-descriptions-item>
                        <nn-descriptions-item label="累计接收消息">{{ totalReceived }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近接收时间">{{ lastMessageAt }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近客户端">{{ lastClient }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近Facility">{{ lastFacility }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近Severity">{{ lastSeverity }}</nn-descriptions-item>
                    </nn-descriptions>
                </nn-card>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    import { ref, computed, onMounted, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_VALUES, SYSLOG_SUB_EVT_TYPES, SYSLOG_EVENT_PAGE_ID } from '../../const/syslogConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SyslogConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const formData = ref({
        port: DEFAULT_VALUES.DEFAULT_SYSLOG_PORT,
        enableUdp: DEFAULT_VALUES.DEFAULT_ENABLE_UDP,
        enableTcp: DEFAULT_VALUES.DEFAULT_ENABLE_TCP,
        maxMessageLength: DEFAULT_VALUES.DEFAULT_MAX_MESSAGE_LENGTH
    });

    const emptyErrors = () => ({
        port: '',
        maxMessageLength: '',
        protocol: ''
    });

    const validationErrors = ref(emptyErrors());
    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const messageCount = ref(0);
    const totalReceived = ref(0);
    const lastMessageAt = ref('-');
    const lastClient = ref('-');
    const lastFacility = ref('-');
    const lastSeverity = ref('-');

    const protocolText = computed(() => {
        const protocols = [];
        if (formData.value.enableUdp) {
            protocols.push('UDP');
        }
        if (formData.value.enableTcp) {
            protocols.push('TCP');
        }
        return protocols.length > 0 ? protocols.join(' / ') : '-';
    });

    const validateConfig = () => {
        const errors = {};
        const port = Number(formData.value.port);
        const maxMessageLength = Number(formData.value.maxMessageLength);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            errors.port = '端口范围 1-65535';
        }
        if (!Number.isInteger(maxMessageLength) || maxMessageLength < 128 || maxMessageLength > 65535) {
            errors.maxMessageLength = '长度范围 128-65535 字节';
        }
        if (!formData.value.enableUdp && !formData.value.enableTcp) {
            errors.protocol = '请至少启用 UDP 或 TCP';
        }

        validationErrors.value = { ...emptyErrors(), ...errors };
        return Object.keys(errors).length === 0;
    };

    const loadConfig = async () => {
        try {
            const result = await window.syslogApi.getSyslogConfig();
            if (result.status === 'success' && result.data) {
                formData.value = {
                    ...formData.value,
                    ...result.data
                };
            }
        } catch (error) {
            notify.error('加载配置失败: ' + error.message);
        }
    };

    const startSyslog = async () => {
        if (!validateConfig()) {
            notify.error('请检查输入的数据');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(formData.value));
            const saveResult = await window.syslogApi.saveSyslogConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;
            const startResult = await window.syslogApi.startSyslog(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                messageCount.value = startResult.data?.messageCount || 0;
                totalReceived.value = startResult.data?.totalReceived || 0;
                notify.success(startResult.msg || 'Syslog服务启动成功');
            } else {
                notify.error(startResult.msg || 'Syslog服务启动失败');
            }
        } catch (error) {
            notify.error('Syslog服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopSyslog = async () => {
        try {
            const result = await window.syslogApi.stopSyslog();
            if (result.status === 'success') {
                notify.success(result.msg || 'Syslog服务已停止');
                isServerRunning.value = false;
                messageCount.value = 0;
                lastMessageAt.value = '-';
                lastClient.value = '-';
                lastFacility.value = '-';
                lastSeverity.value = '-';
            } else {
                notify.error(result.msg || 'Syslog服务停止失败');
            }
        } catch (error) {
            notify.error('Syslog服务停止失败: ' + error.message);
        }
    };

    const applyStats = stats => {
        if (!stats) {
            return;
        }
        messageCount.value = stats.messageCount ?? messageCount.value;
        totalReceived.value = stats.totalReceived ?? totalReceived.value;
        lastMessageAt.value = stats.lastMessageAt || lastMessageAt.value;
        lastClient.value = stats.lastClient || lastClient.value;
        lastFacility.value = stats.lastFacility || lastFacility.value;
        lastSeverity.value = stats.lastSeverity || lastSeverity.value;
    };

    const handleSyslogEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === SYSLOG_SUB_EVT_TYPES.MESSAGE_RECEIVED) {
            applyStats(payload.stats);
        } else if (payload.type === SYSLOG_SUB_EVT_TYPES.SERVER_STATUS) {
            isServerRunning.value = payload.data.status === 'running';
            messageCount.value = payload.data.messageCount ?? messageCount.value;
            totalReceived.value = payload.data.totalReceived ?? totalReceived.value;
            if (!isServerRunning.value) {
                messageCount.value = 0;
                lastMessageAt.value = '-';
                lastClient.value = '-';
                lastFacility.value = '-';
                lastSeverity.value = '-';
            }
        } else if (payload.type === SYSLOG_SUB_EVT_TYPES.HISTORY_CLEARED) {
            messageCount.value = 0;
            lastMessageAt.value = '-';
            lastClient.value = '-';
            lastFacility.value = '-';
            lastSeverity.value = '-';
            totalReceived.value = payload.stats?.totalReceived ?? totalReceived.value;
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
        EventBus.on('syslog:event', SYSLOG_EVENT_PAGE_ID.PAGE_ID_SYSLOG_CONFIG, handleSyslogEvent);
    });

    onDeactivated(() => {
        EventBus.off('syslog:event', SYSLOG_EVENT_PAGE_ID.PAGE_ID_SYSLOG_CONFIG);
    });
</script>

<style scoped>
    .adaptive-config-page {
        height: 100%;
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

    .adaptive-config-fill-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-config-fill-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-config-fill-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
</style>
