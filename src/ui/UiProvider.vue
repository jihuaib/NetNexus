<template>
    <ConfigProvider :theme="antDesignThemeConfig">
        <slot />
    </ConfigProvider>
</template>

<script setup>
    import ConfigProvider from 'ant-design-vue/es/config-provider';
    import { useAntDesignThemeConfig } from '../theme/antDesignTheme';

    const antDesignThemeConfig = useAntDesignThemeConfig();
</script>
