<template>
    <div class="nn-container adaptive-config-page">
        <nn-row class="adaptive-config-row">
            <nn-col :span="24">
                <nn-card title="NTP服务器配置">
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
                                <nn-form-item label="Stratum">
                                    <nn-tooltip :title="validationErrors.stratum" :open="!!validationErrors.stratum">
                                        <nn-input-number
                                            v-model:value="formData.stratum"
                                            :min="1"
                                            :max="15"
                                            style="width: 100%"
                                            :status="validationErrors.stratum ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="Reference ID">
                                    <nn-tooltip
                                        :title="validationErrors.referenceId"
                                        :open="!!validationErrors.referenceId"
                                    >
                                        <nn-input
                                            v-model:value="formData.referenceId"
                                            :maxlength="4"
                                            placeholder="例如 LOCL"
                                            :status="validationErrors.referenceId ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row :gutter="24">
                            <nn-col :span="8">
                                <nn-form-item label="时间偏移">
                                    <nn-tooltip
                                        :title="validationErrors.timeOffsetMs"
                                        :open="!!validationErrors.timeOffsetMs"
                                    >
                                        <nn-input-number
                                            v-model:value="formData.timeOffsetMs"
                                            :min="-86400000"
                                            :max="86400000"
                                            addon-after="ms"
                                            style="width: 100%"
                                            :status="validationErrors.timeOffsetMs ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="Root Delay">
                                    <nn-tooltip
                                        :title="validationErrors.rootDelayMs"
                                        :open="!!validationErrors.rootDelayMs"
                                    >
                                        <nn-input-number
                                            v-model:value="formData.rootDelayMs"
                                            :min="0"
                                            :max="60000"
                                            addon-after="ms"
                                            style="width: 100%"
                                            :status="validationErrors.rootDelayMs ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="8">
                                <nn-form-item label="Root Dispersion">
                                    <nn-tooltip
                                        :title="validationErrors.rootDispersionMs"
                                        :open="!!validationErrors.rootDispersionMs"
                                    >
                                        <nn-input-number
                                            v-model:value="formData.rootDispersionMs"
                                            :min="0"
                                            :max="60000"
                                            addon-after="ms"
                                            style="width: 100%"
                                            :status="validationErrors.rootDispersionMs ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <div style="margin-top: 8px; color: var(--nn-color-text-muted)">
                            默认端口为 123。若系统服务已占用或当前进程没有特权，可改为其他端口供测试脚本验证。
                        </div>

                        <div style="margin-top: 12px; display: flex; justify-content: center">
                            <nn-space>
                                <nn-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="isServerRunning"
                                    @click="startNtp"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button type="primary" danger :disabled="!isServerRunning" @click="stopNtp">
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
                    <template #extra>
                        <nn-button @click="refreshDisplayedTimes">刷新时间</nn-button>
                    </template>
                    <nn-descriptions :column="2" bordered>
                        <nn-descriptions-item label="服务状态">
                            <nn-tag :color="isServerRunning ? 'green' : 'red'">
                                {{ isServerRunning ? '运行中' : '已停止' }}
                            </nn-tag>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="监听端口">
                            {{ formData.port }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="当前本机时间">
                            {{ systemTimeText }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="当前NTP时间">
                            {{ serverTimeText }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Stratum">
                            {{ formData.stratum }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Reference ID">
                            {{ formData.referenceId }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="时间偏移">{{ formData.timeOffsetMs }} ms</nn-descriptions-item>
                        <nn-descriptions-item label="已记录请求">
                            {{ requestCount }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="最近请求时间">
                            {{ lastRequestAt }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="最近客户端">
                            {{ lastClient }}
                        </nn-descriptions-item>
                    </nn-descriptions>
                    <div style="margin-top: 12px; color: var(--nn-color-text-muted)">
                        点击“刷新时间”后按“本机当前时间 + 时间偏移”同步显示，对应服务端响应里的 `transmitTimestamp`。
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_VALUES, NTP_SUB_EVT_TYPES, NTP_EVENT_PAGE_ID } from '../../const/ntpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'NtpConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const formData = ref({
        port: DEFAULT_VALUES.DEFAULT_NTP_PORT,
        stratum: DEFAULT_VALUES.DEFAULT_NTP_STRATUM,
        referenceId: DEFAULT_VALUES.DEFAULT_REFERENCE_ID,
        timeOffsetMs: DEFAULT_VALUES.DEFAULT_TIME_OFFSET_MS,
        rootDelayMs: DEFAULT_VALUES.DEFAULT_ROOT_DELAY_MS,
        rootDispersionMs: DEFAULT_VALUES.DEFAULT_ROOT_DISPERSION_MS
    });

    const validationErrors = ref({
        port: '',
        stratum: '',
        referenceId: '',
        timeOffsetMs: '',
        rootDelayMs: '',
        rootDispersionMs: ''
    });

    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const requestCount = ref(0);
    const lastRequestAt = ref('-');
    const lastClient = ref('-');
    const systemTimeText = ref('-');
    const serverTimeText = ref('-');

    const padNumber = (value, width = 2) => String(value).padStart(width, '0');

    const formatDateTime = ms => {
        const date = new Date(ms);
        if (Number.isNaN(date.getTime())) {
            return '-';
        }

        return (
            `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ` +
            `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.` +
            `${padNumber(date.getMilliseconds(), 3)}`
        );
    };

    const refreshDisplayedTimes = () => {
        const systemNow = Date.now();
        const timeOffsetMs = Number(formData.value.timeOffsetMs);
        const safeOffsetMs = Number.isFinite(timeOffsetMs) ? timeOffsetMs : 0;

        systemTimeText.value = formatDateTime(systemNow);
        serverTimeText.value = formatDateTime(systemNow + safeOffsetMs);
    };

    const validateConfig = () => {
        const errors = {};
        const port = Number(formData.value.port);
        const stratum = Number(formData.value.stratum);
        const timeOffsetMs = Number(formData.value.timeOffsetMs);
        const rootDelayMs = Number(formData.value.rootDelayMs);
        const rootDispersionMs = Number(formData.value.rootDispersionMs);
        const referenceId = String(formData.value.referenceId || '').trim();

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            errors.port = '端口范围 1-65535';
        }
        if (!Number.isInteger(stratum) || stratum < 1 || stratum > 15) {
            errors.stratum = 'Stratum 范围 1-15';
        }
        if (!/^[\x20-\x7e]{1,4}$/.test(referenceId)) {
            errors.referenceId = 'Reference ID 需为 1-4 位 ASCII 字符';
        }
        if (!Number.isFinite(timeOffsetMs)) {
            errors.timeOffsetMs = '时间偏移必须为有效数字';
        }
        if (!Number.isFinite(rootDelayMs) || rootDelayMs < 0) {
            errors.rootDelayMs = 'Root Delay 不能小于 0';
        }
        if (!Number.isFinite(rootDispersionMs) || rootDispersionMs < 0) {
            errors.rootDispersionMs = 'Root Dispersion 不能小于 0';
        }

        validationErrors.value = errors;
        return Object.keys(errors).length === 0;
    };

    const loadConfig = async () => {
        try {
            const result = await window.ntpApi.getNtpConfig();
            if (result.status === 'success' && result.data) {
                formData.value = {
                    ...formData.value,
                    ...result.data
                };
                refreshDisplayedTimes();
            }
        } catch (error) {
            notify.error('加载配置失败: ' + error.message);
        }
    };

    const startNtp = async () => {
        if (!validateConfig()) {
            notify.error('请检查输入的数据');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(formData.value));
            const saveResult = await window.ntpApi.saveNtpConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;
            const startResult = await window.ntpApi.startNtp(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                notify.success(startResult.msg || 'NTP服务启动成功');
            } else {
                notify.error(startResult.msg || 'NTP服务启动失败');
            }
        } catch (error) {
            notify.error('NTP服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopNtp = async () => {
        try {
            const result = await window.ntpApi.stopNtp();
            if (result.status === 'success') {
                notify.success(result.msg || 'NTP服务已停止');
                isServerRunning.value = false;
                requestCount.value = 0;
                lastRequestAt.value = '-';
                lastClient.value = '-';
            } else {
                notify.error(result.msg || 'NTP服务停止失败');
            }
        } catch (error) {
            notify.error('NTP服务停止失败: ' + error.message);
        }
    };

    const handleNtpEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === NTP_SUB_EVT_TYPES.REQUEST_RECEIVED) {
            requestCount.value = payload.stats?.requestCount ?? requestCount.value + 1;
            lastRequestAt.value = payload.stats?.lastRequestAt || payload.data.timestamp;
            lastClient.value = payload.stats?.lastClient || `${payload.data.clientAddress}:${payload.data.clientPort}`;
        } else if (payload.type === NTP_SUB_EVT_TYPES.SERVER_STATUS) {
            isServerRunning.value = payload.data.status === 'running';
            requestCount.value = payload.data.requestCount ?? requestCount.value;
            if (!isServerRunning.value) {
                lastRequestAt.value = '-';
                lastClient.value = '-';
            }
        } else if (payload.type === NTP_SUB_EVT_TYPES.HISTORY_CLEARED) {
            requestCount.value = 0;
            lastRequestAt.value = '-';
            lastClient.value = '-';
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            validationErrors.value = {
                port: '',
                stratum: '',
                referenceId: '',
                timeOffsetMs: '',
                rootDelayMs: '',
                rootDispersionMs: ''
            };
        }
    });

    onMounted(() => {
        loadConfig();
        refreshDisplayedTimes();
    });

    onActivated(() => {
        EventBus.on('ntp:event', NTP_EVENT_PAGE_ID.PAGE_ID_NTP_CONFIG, handleNtpEvent);
    });

    onDeactivated(() => {
        EventBus.off('ntp:event', NTP_EVENT_PAGE_ID.PAGE_ID_NTP_CONFIG);
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
