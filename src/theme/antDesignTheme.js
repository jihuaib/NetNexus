import { computed } from 'vue';
import antTheme from 'ant-design-vue/es/theme';
import { APP_THEME, APP_THEME_PRESET } from './themeConst';
import { getThemeState } from '../utils/themeManager';

const BASE_LIGHT_TOKENS = {
    colorSuccess: '#52c41a',
    colorWarning: '#faad14',
    colorError: '#ff4d4f',
    colorBgBase: '#f5f7fb',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorTextBase: '#1f2937',
    colorBorder: '#d9e2ef',
    colorBorderSecondary: '#e8eef6',
    borderRadius: 6,
    fontSize: 14
};

const THEME_TOKENS = {
    [APP_THEME_PRESET.ORANGE]: {
        ...BASE_LIGHT_TOKENS,
        colorPrimary: '#f97316',
        colorInfo: '#f97316'
    },
    [APP_THEME_PRESET.BLUE]: {
        ...BASE_LIGHT_TOKENS,
        colorPrimary: '#1677ff',
        colorInfo: '#1677ff'
    },
    [APP_THEME_PRESET.DARK]: {
        colorPrimary: '#60a5fa',
        colorSuccess: '#5ecf89',
        colorWarning: '#f5bf4f',
        colorError: '#ff7875',
        colorInfo: '#60a5fa',
        colorBgBase: '#0f172a',
        colorBgContainer: '#162033',
        colorBgElevated: '#1b263b',
        colorTextBase: '#e5e7eb',
        colorBorder: '#334155',
        colorBorderSecondary: '#293548',
        borderRadius: 6,
        fontSize: 14
    }
};

const COMPONENT_TOKENS = {
    [APP_THEME_PRESET.ORANGE]: {
        Card: {
            headerBg: '#f97316',
            colorTextHeading: '#ffffff'
        },
        Table: {
            headerBg: '#f3f6fb',
            rowHoverBg: '#fff7ed'
        },
        Menu: {
            itemSelectedBg: '#f97316',
            itemSelectedColor: '#ffffff'
        }
    },
    [APP_THEME_PRESET.BLUE]: {
        Card: {
            headerBg: '#1677ff',
            colorTextHeading: '#ffffff'
        },
        Table: {
            headerBg: '#f3f6fb',
            rowHoverBg: '#eef6ff'
        },
        Menu: {
            itemSelectedBg: '#1677ff',
            itemSelectedColor: '#ffffff'
        }
    },
    [APP_THEME_PRESET.DARK]: {
        Card: {
            headerBg: '#2563eb',
            colorTextHeading: '#f8fafc'
        },
        Table: {
            headerBg: '#1e293b',
            rowHoverBg: '#22324a'
        },
        Menu: {
            itemSelectedBg: '#2563eb',
            itemSelectedColor: '#f8fafc'
        }
    }
};

export function useAntDesignThemeConfig() {
    const { themePreset, resolvedTheme } = getThemeState();

    return computed(() => {
        const isDark = resolvedTheme.value === APP_THEME.DARK;
        const preset = themePreset.value;

        return {
            algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
            token: THEME_TOKENS[preset] || THEME_TOKENS[APP_THEME_PRESET.ORANGE],
            components: COMPONENT_TOKENS[preset] || COMPONENT_TOKENS[APP_THEME_PRESET.ORANGE]
        };
    });
}
