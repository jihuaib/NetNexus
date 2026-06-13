<template>
    <div class="mt-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <a-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <a-tab-pane key="bmp-config" tab="BMP配置" />
                <a-tab-pane key="bgp-session" tab="BGP会话" />
                <a-tab-pane key="bgp-loc-rib" tab="BGP Loc-RIB" />
                <a-tab-pane key="bgp-session-statis-report" tab="BGP会话统计" />
                <a-tab-pane key="bgp-loc-rib-statis-report" tab="BGP Loc-RIB统计" />
            </a-tabs>
        </div>

        <!-- 可滚动内容区域 -->
        <div class="content-container">
            <router-view v-slot="{ Component }">
                <keep-alive :include="$store.state.cachedViews">
                    <component :is="Component" ref="currentTab" @open-settings="handleOpenSettings" />
                </keep-alive>
            </router-view>
        </div>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';

    defineOptions({ name: 'BmpMain' });

    const emit = defineEmits(['openSettings']);

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('bmp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'bmp-config';
    const tabKeys = new Set([
        'bmp-config',
        'bgp-session',
        'bgp-loc-rib',
        'bgp-session-statis-report',
        'bgp-loc-rib-statis-report'
    ]);

    const handleTabChange = key => {
        router.push(`/bmp/${key}`);
    };

    const handleOpenSettings = category => {
        emit('openSettings', category);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        if (tabKeys.has(childPath)) {
            activeTabKey.value = childPath;
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    watch(() => route.path, syncActiveTab, { immediate: true });

    onActivated(() => {
        if (route.path === '/bmp' || route.path === '/bmp/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/bmp/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
