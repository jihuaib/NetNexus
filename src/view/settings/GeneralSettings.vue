<template>
    <div class="general-settings">
        <a-card title="通用设置">
            <a-form :model="settingsForm" layout="vertical">
                <a-form-item label="日志级别" name="logLevel">
                    <a-select v-model:value="settingsForm.logLevel" style="width: 100%">
                        <a-select-option value="off">关闭</a-select-option>
                        <a-select-option value="debug">debug</a-select-option>
                        <a-select-option value="info">info</a-select-option>
                        <a-select-option value="warn">warn</a-select-option>
                        <a-select-option value="error">error</a-select-option>
                    </a-select>
                </a-form-item>

                <a-form-item>
                    <a-button type="primary" @click="saveSettings">保存设置</a-button>
                </a-form-item>
            </a-form>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_LOG_SETTINGS } from '../../const/toolsConst';

    const settingsForm = ref({
        logLevel: DEFAULT_LOG_SETTINGS.logLevel
    });

    // 获取设置
    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getGeneralSettings();
            if (settings.status === 'success' && settings.data) {
                settingsForm.value = {
                    ...DEFAULT_LOG_SETTINGS,
                    ...settings.data
                };
            }
        } catch (error) {
            console.error('获取设置失败', error);
        }
    };

    // 保存设置
    const saveSettings = async () => {
        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            await window.commonApi.saveGeneralSettings(payload);
            message.success('设置已保存');
        } catch (error) {
            console.error('保存设置失败', error);
            message.error('保存设置失败');
        }
    };

    onMounted(() => {
        getSettings();
    });
</script>

<style scoped>
    .general-settings {
        max-width: 100%;
    }

    :deep(.ant-form-item-label > label) {
        font-size: 12px;
    }
</style>
