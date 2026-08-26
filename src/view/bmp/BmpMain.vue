<template>
    <div class="nn-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="bmp-config" tab="BMP配置" />
                <nn-tab-pane key="route-assurance" tab="路由矩阵" />
                <nn-tab-pane key="route-lens" tab="路由追踪" />
            </nn-tabs>
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
    const tabKeys = new Set(['bmp-config', 'route-assurance', 'route-lens']);
    const monitorOnlyTabKeys = new Set(['bgp-session', 'bgp-loc-rib']);

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
        } else if (monitorOnlyTabKeys.has(childPath)) {
            activeTabKey.value = defaultTabKey;
            router.replace(`/bmp/${defaultTabKey}`);
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
