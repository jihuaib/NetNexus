export const APP_THEME = {
    LIGHT: 'light',
    DARK: 'dark'
};

export const APP_THEME_PRESET = {
    ORANGE: 'orange',
    BLUE: 'blue',
    DARK: 'dark'
};

export const DEFAULT_THEME_PRESET = APP_THEME_PRESET.BLUE;

export const THEME_PRESET_STORAGE_KEY = 'netnexus.themePreset';

export const APP_THEME_PRESET_OPTIONS = [
    {
        label: '蓝色',
        value: APP_THEME_PRESET.BLUE
    },
    {
        label: '橙色',
        value: APP_THEME_PRESET.ORANGE
    },
    {
        label: '深色',
        value: APP_THEME_PRESET.DARK
    }
];

export function isAppThemePreset(value) {
    return Object.values(APP_THEME_PRESET).includes(value);
}

export function normalizeThemePreset(value, fallback = DEFAULT_THEME_PRESET) {
    return isAppThemePreset(value) ? value : fallback;
}

export function getResolvedThemeFromPreset(preset) {
    return normalizeThemePreset(preset) === APP_THEME_PRESET.DARK ? APP_THEME.DARK : APP_THEME.LIGHT;
}
