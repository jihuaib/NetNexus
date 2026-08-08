<template>
    <div class="general-settings">
        <nn-card title="通用设置" class="settings-card">
            <nn-form :model="settingsForm" layout="vertical">
                <nn-form-item label="主题" name="themePreset">
                    <nn-radio-group
                        v-model:value="settingsForm.themePreset"
                        class="theme-preset-options"
                        aria-label="主题颜色"
                        @change="handleThemePresetChange($event.target.value)"
                    >
                        <nn-radio
                            v-for="option in themePresetOptions"
                            :key="option.value"
                            :value="option.value"
                            :class="['theme-preset-option', `theme-preset-option-${option.value}`]"
                        >
                            <span class="theme-preset-preview" aria-hidden="true">
                                <span class="theme-preset-preview-sidebar" />
                                <span class="theme-preset-preview-main">
                                    <span class="theme-preset-preview-header" />
                                    <span class="theme-preset-preview-card" />
                                </span>
                            </span>
                            <span class="theme-preset-label">
                                <span>{{ option.label }}</span>
                                <CheckCircleOutlined
                                    v-if="settingsForm.themePreset === option.value"
                                    class="theme-preset-check"
                                />
                            </span>
                        </nn-radio>
                    </nn-radio-group>
                </nn-form-item>

                <nn-form-item label="日志级别" name="logLevel">
                    <nn-select v-model:value="settingsForm.logLevel" style="width: 100%">
                        <nn-select-option value="off">关闭</nn-select-option>
                        <nn-select-option value="debug">debug</nn-select-option>
                        <nn-select-option value="info">info</nn-select-option>
                        <nn-select-option value="warn">warn</nn-select-option>
                        <nn-select-option value="error">error</nn-select-option>
                    </nn-select>
                </nn-form-item>

                <nn-form-item>
                    <nn-button type="primary" @click="saveSettings">保存设置</nn-button>
                </nn-form-item>
            </nn-form>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_LOG_SETTINGS } from '../../const/toolsConst';
    import { APP_THEME_PRESET_OPTIONS, DEFAULT_THEME_PRESET, normalizeThemePreset } from 'netnexus-ui/theme';
    import { CheckCircleOutlined } from 'netnexus-ui/icons';
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

    :deep(.nn-form-item-label > label) {
        font-size: 12px;
    }

    .theme-preset-options {
        display: grid;
        width: 100%;
        max-width: 720px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
    }

    .theme-preset-options :deep(.nn-radio-wrapper) {
        --theme-preview-accent: #1677ff;
        --theme-preview-ring: rgba(22, 119, 255, 0.18);
        --theme-preview-sider: #243447;
        --theme-preview-canvas: #f5f7fb;
        --theme-preview-surface: #ffffff;
        --theme-preview-line: #d9e2ef;

        min-width: 0;
        padding: 9px;
        border: 1px solid var(--nn-color-border);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            transform 0.2s;
        white-space: normal;
    }

    .theme-preset-options :deep(.nn-radio-wrapper:hover) {
        border-color: var(--theme-preview-accent);
        transform: translateY(-1px);
    }

    .theme-preset-options :deep(.nn-radio-wrapper:focus-within) {
        border-color: var(--theme-preview-accent);
        box-shadow: 0 0 0 2px var(--theme-preview-ring);
    }

    .theme-preset-options :deep(.nn-radio-wrapper-checked) {
        border-color: var(--theme-preview-accent);
        box-shadow: 0 0 0 2px var(--theme-preview-ring);
    }

    .theme-preset-options :deep(.nn-radio) {
        display: none;
    }

    .theme-preset-options :deep(.nn-radio-label) {
        display: flex;
        width: 100%;
        min-width: 0;
        flex-direction: column;
        gap: 7px;
        overflow: visible;
    }

    .theme-preset-options :deep(.theme-preset-option-orange) {
        --theme-preview-accent: #f97316;
        --theme-preview-ring: rgba(249, 115, 22, 0.2);
    }

    .theme-preset-options :deep(.theme-preset-option-dark) {
        --theme-preview-accent: #2563eb;
        --theme-preview-ring: rgba(96, 165, 250, 0.24);
        --theme-preview-sider: #111827;
        --theme-preview-canvas: #0f172a;
        --theme-preview-surface: #1b263b;
        --theme-preview-line: #334155;
    }

    .theme-preset-preview {
        display: grid;
        height: 54px;
        overflow: hidden;
        border: 1px solid var(--theme-preview-line);
        border-radius: 5px;
        background: var(--theme-preview-canvas);
        grid-template-columns: 22px minmax(0, 1fr);
    }

    .theme-preset-preview-sidebar {
        background: var(--theme-preview-sider);
    }

    .theme-preset-preview-main {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 6px;
        padding: 7px;
        background: var(--theme-preview-canvas);
    }

    .theme-preset-preview-header {
        display: block;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 2px;
        background: var(--theme-preview-accent);
    }

    .theme-preset-preview-card {
        position: relative;
        display: block;
        flex: 1 1 0;
        overflow: hidden;
        border: 1px solid var(--theme-preview-line);
        border-radius: 2px;
        background: var(--theme-preview-surface);
    }

    .theme-preset-preview-card::before,
    .theme-preset-preview-card::after {
        position: absolute;
        left: 5px;
        height: 2px;
        border-radius: 999px;
        background: var(--theme-preview-line);
        content: '';
    }

    .theme-preset-preview-card::before {
        top: 6px;
        width: 62%;
    }

    .theme-preset-preview-card::after {
        top: 12px;
        width: 42%;
    }

    .theme-preset-label {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        color: var(--nn-color-text);
        font-size: 13px;
        line-height: 18px;
    }

    .theme-preset-check {
        flex: 0 0 auto;
        color: var(--theme-preview-accent);
        font-size: 15px;
    }

    @media (max-width: 720px) {
        .theme-preset-options {
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        }
    }
</style>
