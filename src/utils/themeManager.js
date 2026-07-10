import { computed, ref, watch } from 'vue';
import {
    DEFAULT_THEME_PRESET,
    THEME_PRESET_STORAGE_KEY,
    getResolvedThemeFromPreset,
    normalizeThemePreset
} from '../theme/themeConst';

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

function writeLocalStorage(key, value) {
    if (!canUseDom()) {
        return;
    }

    try {
        window.localStorage.setItem(key, value);
    } catch (error) {
        console.warn('保存主题设置失败:', error);
    }
}

function readStoredThemePreset() {
    return normalizeThemePreset(readLocalStorage(THEME_PRESET_STORAGE_KEY), DEFAULT_THEME_PRESET);
}

const themePreset = ref(readStoredThemePreset());
const resolvedTheme = computed(() => getResolvedThemeFromPreset(themePreset.value));

function applyThemeAttributes() {
    if (!canUseDom()) {
        return;
    }

    const normalizedPreset = normalizeThemePreset(themePreset.value);
    const root = document.documentElement;
    root.dataset.theme = getResolvedThemeFromPreset(normalizedPreset);
    root.dataset.themePreset = normalizedPreset;
    root.style.colorScheme = root.dataset.theme;
}

watch(themePreset, applyThemeAttributes, { immediate: true });

export function initializeTheme() {
    applyThemeAttributes();
}

export function getThemeState() {
    return {
        themePreset,
        resolvedTheme
    };
}

export function setThemePreset(preset, options = {}) {
    const normalizedPreset = normalizeThemePreset(preset);
    themePreset.value = normalizedPreset;

    if (options.persistLocal !== false) {
        writeLocalStorage(THEME_PRESET_STORAGE_KEY, normalizedPreset);
    }

    return normalizedPreset;
}

export async function syncThemeFromGeneralSettings() {
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
