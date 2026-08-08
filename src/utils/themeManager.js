import {
    DEFAULT_THEME_PRESET,
    THEME_PRESET_STORAGE_KEY,
    getThemeState,
    normalizeThemePreset,
    setThemePreset
} from 'netnexus-ui/theme';

function canUseDom() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readLocalStorage(key) {
    if (!canUseDom()) {
        return null;
    }

    try {
        return window.localStorage.getItem(key);
    } catch (error) {
        console.warn('读取主题设置失败:', error);
        return null;
    }
}

function readStoredThemePreset() {
    return normalizeThemePreset(readLocalStorage(THEME_PRESET_STORAGE_KEY), DEFAULT_THEME_PRESET);
}

export { getThemeState, setThemePreset };

export async function syncThemeFromGeneralSettings() {
    const { themePreset } = getThemeState();
    if (!canUseDom() || !window.commonApi || typeof window.commonApi.getGeneralSettings !== 'function') {
        return themePreset.value;
    }

    try {
        const settings = await window.commonApi.getGeneralSettings();
        const nextPreset =
            settings?.status === 'success' && settings.data
                ? normalizeThemePreset(settings.data.themePreset, readStoredThemePreset())
                : readStoredThemePreset();

        return setThemePreset(nextPreset);
    } catch (error) {
        console.warn('同步主题设置失败:', error);
        return themePreset.value;
    }
}
