<template>
    <div class="api-settings">
        <a-card title="外部API" class="settings-card">
            <a-form :model="settingsForm" layout="vertical">
                <a-form-item label="启用API服务" name="enabled">
                    <a-switch v-model:checked="settingsForm.enabled" />
                </a-form-item>

                <a-form-item label="监听端口" name="port">
                    <a-input-number v-model:value="settingsForm.port" :min="1" :max="65535" style="width: 100%" />
                </a-form-item>

                <a-form-item label="分页最大条数" name="maxPageSize">
                    <a-input-number
                        v-model:value="settingsForm.maxPageSize"
                        :min="1"
                        :max="10000"
                        style="width: 100%"
                    />
                </a-form-item>

                <a-form-item label="运行状态">
                    <a-space>
                        <a-tag :color="apiStatus.running ? 'green' : 'default'">
                            {{ apiStatus.running ? '运行中' : '未运行' }}
                        </a-tag>
                        <span v-if="apiStatus.running">{{ apiStatus.host }}:{{ apiStatus.port }}</span>
                    </a-space>
                </a-form-item>

                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="saveSettings">保存设置</a-button>
                        <a-button @click="refreshStatus">刷新状态</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_API_SETTINGS } from '../../const/apiConst';

    const settingsForm = ref({
        ...DEFAULT_API_SETTINGS
    });

    const apiStatus = ref({
        running: false,
        enabled: false,
        host: DEFAULT_API_SETTINGS.host,
        port: DEFAULT_API_SETTINGS.port
    });

    const validateSettings = () => {
        const port = Number(settingsForm.value.port);
        const maxPageSize = Number(settingsForm.value.maxPageSize);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            message.error('监听端口必须是1到65535之间的整数');
            return false;
        }
        if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 10000) {
            message.error('分页最大条数必须是1到10000之间的整数');
            return false;
        }
        return true;
    };

    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getApiSettings();
            if (settings.status === 'success' && settings.data) {
                settingsForm.value = {
                    ...DEFAULT_API_SETTINGS,
                    ...settings.data
                };
            }
        } catch (error) {
            console.error('获取API设置失败', error);
        }
    };

    const refreshStatus = async () => {
        try {
            const result = await window.commonApi.getApiServerStatus();
            if (result.status === 'success' && result.data) {
                apiStatus.value = {
                    ...apiStatus.value,
                    ...result.data
                };
            }
        } catch (error) {
            console.error('获取API运行状态失败', error);
        }
    };

    const saveSettings = async () => {
        if (!validateSettings()) {
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            payload.host = DEFAULT_API_SETTINGS.host;
            const result = await window.commonApi.saveApiSettings(payload);
            if (result.status === 'success') {
                message.success('设置已保存');
                await refreshStatus();
            } else {
                message.error(result.msg || '保存设置失败');
            }
        } catch (error) {
            console.error('保存API设置失败', error);
            message.error('保存设置失败');
        }
    };

    onMounted(async () => {
        await getSettings();
        await refreshStatus();
    });
</script>

<style scoped>
    .api-settings {
        max-width: 100%;
    }

    :deep(.ant-form-item-label > label) {
        font-size: 12px;
    }
</style>
