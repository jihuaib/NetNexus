<template>
    <div class="nn-main-container">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="ntp-config" tab="NTP配置" />
                <nn-tab-pane key="ntp-request-log" tab="请求日志" />
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

    defineOptions({ name: 'NtpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('ntp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'ntp-config';
    const tabKeys = new Set(['ntp-config', 'ntp-request-log']);

    const handleTabChange = key => {
        router.push(`/ntp/${key}`);
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
        if (route.path === '/ntp' || route.path === '/ntp/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/ntp/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
