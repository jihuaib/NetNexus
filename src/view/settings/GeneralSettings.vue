<template>
    <div class="general-settings">
        <nn-card title="通用设置" class="settings-card">
            <a-form :model="settingsForm" layout="vertical">
                <a-form-item label="主题" name="themePreset">
                    <a-select
                        v-model:value="settingsForm.themePreset"
                        style="width: 100%"
                        @change="handleThemePresetChange"
                    >
                        <a-select-option v-for="option in themePresetOptions" :key="option.value" :value="option.value">
                            {{ option.label }}
                        </a-select-option>
                    </a-select>
                </a-form-item>

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
                    <nn-button type="primary" @click="saveSettings">保存设置</nn-button>
                </a-form-item>
            </a-form>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_LOG_SETTINGS } from '../../const/toolsConst';
    import { APP_THEME_PRESET_OPTIONS, DEFAULT_THEME_PRESET, normalizeThemePreset } from '../../theme/themeConst';
    import { getThemeState, setThemePreset } from '../../utils/themeManager';

    const { themePreset } = getThemeState();
    const themePresetOptions = APP_THEME_PRESET_OPTIONS;
    const settingsForm = ref({
        themePreset: normalizeThemePreset(themePreset.value, DEFAULT_THEME_PRESET),
        logLevel: DEFAULT_LOG_SETTINGS.logLevel
    });

    // 获取设置
    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getGeneralSettings();
            if (settings.status === 'success' && settings.data) {
                settingsForm.value = {
                    ...DEFAULT_LOG_SETTINGS,
                    logLevel: settings.data.logLevel || DEFAULT_LOG_SETTINGS.logLevel,
                    themePreset: normalizeThemePreset(settings.data.themePreset, themePreset.value)
                };
                setThemePreset(settingsForm.value.themePreset, { persistLocal: false });
            }
        } catch (error) {
            console.error('获取设置失败', error);
        }
    };

    const handleThemePresetChange = value => {
        setThemePreset(value, { persistLocal: false });
    };

    // 保存设置
    const saveSettings = async () => {
        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            payload.themePreset = normalizeThemePreset(payload.themePreset);
            const result = await window.commonApi.saveGeneralSettings(payload);
            if (result?.status && result.status !== 'success') {
                throw new Error(result.message || '保存设置失败');
            }
            setThemePreset(payload.themePreset);
            notify.success('设置已保存');
        } catch (error) {
            console.error('保存设置失败', error);
            notify.error('保存设置失败');
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
