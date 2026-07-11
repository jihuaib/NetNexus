<template>
    <div class="mt-container radius-config-page">
        <nn-row class="radius-config-row" :gutter="10">
            <nn-col :span="24">
                <nn-card title="RADIUS服务器配置">
                    <nn-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <nn-row :gutter="24">
                            <nn-col :span="8">
                                <nn-form-item label="认证端口">
                                    <nn-tooltip :title="validationErrors.authPort" :open="!!validationErrors.authPort">
                                        <nn-input-number
                                            v-model:value="formData.authPort"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :disabled="!formData.enableAuth"
                                            :status="validationErrors.authPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="计费端口">
                                    <nn-tooltip
                                        :title="validationErrors.accountingPort"
                                        :open="!!validationErrors.accountingPort"
                                    >
                                        <nn-input-number
                                            v-model:value="formData.accountingPort"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :disabled="!formData.enableAccounting"
                                            :status="validationErrors.accountingPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="动态授权端口">
                                    <nn-tooltip :title="validationErrors.coaPort" :open="!!validationErrors.coaPort">
                                        <nn-input-number
                                            v-model:value="formData.coaPort"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :disabled="!formData.enableDynamicAuth"
                                            :status="validationErrors.coaPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row :gutter="24">
                            <nn-col :span="8">
                                <nn-form-item label="认证服务">
                                    <nn-switch v-model:checked="formData.enableAuth" />
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="计费服务">
                                    <nn-switch v-model:checked="formData.enableAccounting" />
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="动态授权">
                                    <nn-switch v-model:checked="formData.enableDynamicAuth" />
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row :gutter="24">
                            <nn-col :span="8">
                                <nn-form-item label="默认共享密钥">
                                    <nn-tooltip
                                        :title="validationErrors.sharedSecret"
                                        :open="!!validationErrors.sharedSecret"
                                    >
                                        <nn-input-password
                                            v-model:value="formData.sharedSecret"
                                            :status="validationErrors.sharedSecret ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="强制消息认证">
                                    <nn-switch v-model:checked="formData.requireMessageAuthenticator" />
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="拒绝未知客户端">
                                    <nn-switch v-model:checked="formData.rejectUnknownClients" />
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row :gutter="24">
                            <nn-col :span="24">
                                <nn-form-item label="配置文件">
                                    <nn-input v-model:value="formData.configFilePath" readonly />
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <div class="actions">
                            <nn-space>
                                <nn-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="isServerRunning"
                                    @click="startRadius"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button type="primary" danger :disabled="!isServerRunning" @click="stopRadius">
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </div>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-row class="radius-fill-row">
            <nn-col :span="24">
                <nn-card title="服务状态" class="radius-fill-card">
                    <nn-descriptions :column="2" bordered>
                        <nn-descriptions-item label="服务状态">
                            <nn-tag :color="isServerRunning ? 'green' : 'red'">
                                {{ isServerRunning ? '运行中' : '已停止' }}
                            </nn-tag>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="认证端口">
                            {{ displayedStatus.authPort || formData.authPort }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="计费端口">
                            {{ displayedStatus.accountingPort || formData.accountingPort }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="动态授权端口">
                            {{ displayedStatus.coaPort || formData.coaPort }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="IPv6认证端口">
                            {{ displayedStatus.authPort6 || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="IPv6计费端口">
                            {{ displayedStatus.accountingPort6 || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="IPv6动态授权端口">
                            {{ displayedStatus.coaPort6 || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="请求日志">{{ requestCount }}</nn-descriptions-item>
                        <nn-descriptions-item label="活动会话">{{ sessionCount }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近请求时间">{{ lastRequestAt }}</nn-descriptions-item>
                        <nn-descriptions-item label="最近客户端">{{ lastClient }}</nn-descriptions-item>
                    </nn-descriptions>
                </nn-card>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_VALUES, RADIUS_EVENT_PAGE_ID, RADIUS_SUB_EVT_TYPES } from '../../const/radiusConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'RadiusConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const formData = ref({
        authPort: DEFAULT_VALUES.DEFAULT_AUTH_PORT,
        accountingPort: DEFAULT_VALUES.DEFAULT_ACCOUNTING_PORT,
        coaPort: DEFAULT_VALUES.DEFAULT_COA_PORT,
        enableAuth: true,
        enableAccounting: true,
        enableDynamicAuth: true,
        sharedSecret: DEFAULT_VALUES.DEFAULT_SHARED_SECRET,
        requireMessageAuthenticator: false,
        rejectUnknownClients: false,
        configFilePath: '',
        maxHistory: 500,
        duplicateCacheTtlMs: 30000
    });

    const validationErrors = ref({});
    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const requestCount = ref(0);
    const sessionCount = ref(0);
    const lastRequestAt = ref('-');
    const lastClient = ref('-');
    const displayedStatus = ref({});

    const validatePort = (errors, key, label, enabled) => {
        if (!enabled) return;
        const value = Number(formData.value[key]);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            errors[key] = `${label}范围 1-65535`;
        }
    };

    const validateConfig = () => {
        const errors = {};
        if (!formData.value.enableAuth && !formData.value.enableAccounting && !formData.value.enableDynamicAuth) {
            errors.authPort = '至少启用一种服务';
        }
        validatePort(errors, 'authPort', '认证端口', formData.value.enableAuth);
        validatePort(errors, 'accountingPort', '计费端口', formData.value.enableAccounting);
        validatePort(errors, 'coaPort', '动态授权端口', formData.value.enableDynamicAuth);

        const enabledPorts = [
            formData.value.enableAuth ? Number(formData.value.authPort) : null,
            formData.value.enableAccounting ? Number(formData.value.accountingPort) : null,
            formData.value.enableDynamicAuth ? Number(formData.value.coaPort) : null
        ].filter(Boolean);
        if (new Set(enabledPorts).size !== enabledPorts.length) {
            errors.coaPort = '启用的端口不能重复';
        }
        if (!String(formData.value.sharedSecret || '').trim()) {
            errors.sharedSecret = '共享密钥不能为空';
        }
        validationErrors.value = errors;
        return Object.keys(errors).length === 0;
    };

    const buildPayload = () => {
        const payload = JSON.parse(JSON.stringify(formData.value));
        delete payload.configFilePath;
        delete payload.bindAddress;
        delete payload.bindAddress6;
        delete payload.enableIpv6;
        return payload;
    };

    const loadConfig = async () => {
        try {
            const result = await window.radiusApi.getRadiusConfig();
            if (result.status === 'success' && result.data) {
                const base = { ...result.data };
                delete base.clients;
                delete base.users;
                delete base.bindAddress;
                delete base.bindAddress6;
                delete base.enableIpv6;
                formData.value = {
                    ...formData.value,
                    ...base
                };
            }
        } catch (error) {
            notify.error('加载RADIUS配置失败: ' + error.message);
        }
    };

    const startRadius = async () => {
        if (!validateConfig()) {
            notify.error('请检查输入的数据');
            return;
        }

        try {
            const payload = buildPayload();
            const saveResult = await window.radiusApi.saveRadiusConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;
            const startResult = await window.radiusApi.startRadius(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                displayedStatus.value = startResult.data || {};
                notify.success(startResult.msg || 'RADIUS服务启动成功');
            } else {
                notify.error(startResult.msg || 'RADIUS服务启动失败');
            }
        } catch (error) {
            notify.error('RADIUS服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopRadius = async () => {
        try {
            const result = await window.radiusApi.stopRadius();
            if (result.status === 'success') {
                notify.success(result.msg || 'RADIUS服务已停止');
                isServerRunning.value = false;
                requestCount.value = 0;
                sessionCount.value = 0;
                lastRequestAt.value = '-';
                lastClient.value = '-';
            } else {
                notify.error(result.msg || 'RADIUS服务停止失败');
            }
        } catch (error) {
            notify.error('RADIUS服务停止失败: ' + error.message);
        }
    };

    const handleRadiusEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }
        const payload = respData.data;
        if (payload.type === RADIUS_SUB_EVT_TYPES.REQUEST_RECEIVED) {
            requestCount.value = payload.stats?.requestCount ?? requestCount.value + 1;
            sessionCount.value = payload.stats?.sessionCount ?? sessionCount.value;
            lastRequestAt.value = payload.stats?.lastRequestAt || payload.data.timestamp;
            lastClient.value = payload.stats?.lastClient || `${payload.data.clientAddress}:${payload.data.clientPort}`;
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.SERVER_STATUS) {
            isServerRunning.value = payload.data.status === 'running';
            displayedStatus.value = payload.data || {};
            requestCount.value = payload.data.requestCount ?? requestCount.value;
            sessionCount.value = payload.data.sessionCount ?? sessionCount.value;
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.HISTORY_CLEARED) {
            requestCount.value = 0;
            lastRequestAt.value = '-';
            lastClient.value = '-';
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.SESSION_UPDATED) {
            sessionCount.value = payload.data.sessionCount ?? 0;
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            validationErrors.value = {};
        }
    });

    onMounted(loadConfig);

    onActivated(() => {
        EventBus.on('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_CONFIG, handleRadiusEvent);
    });

    onDeactivated(() => {
        EventBus.off('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_CONFIG);
    });
</script>

<style scoped>
    .radius-config-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .radius-config-row {
        flex: 0 0 auto;
    }

    .radius-fill-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .radius-fill-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .radius-fill-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .radius-fill-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }

    .actions {
        margin-top: 12px;
        display: flex;
        justify-content: center;
    }
</style>
