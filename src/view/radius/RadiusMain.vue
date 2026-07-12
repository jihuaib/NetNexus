<template>
    <div class="nn-main-container">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="radius-config" tab="RADIUS配置" />
                <nn-tab-pane key="radius-request-log" tab="请求日志" />
                <nn-tab-pane key="radius-session" tab="会话状态" />
            </nn-tabs>
        </div>

        <div class="content-container">
            <router-view v-slot="{ Component }">
                <keep-alive :include="$store.state.cachedViews">
                    <component :is="Component" ref="currentTab" />
                </keep-alive>
            </router-view>
        </div>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';

    defineOptions({ name: 'RadiusMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('radius-config');
    const currentTab = ref(null);
    const defaultTabKey = 'radius-config';
    const tabKeys = new Set(['radius-config', 'radius-request-log', 'radius-session']);

    const handleTabChange = key => {
        router.push(`/radius/${key}`);
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
        if (route.path === '/radius' || route.path === '/radius/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/radius/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
