<template>
    <div class="mt-main-container">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="tftp-config" tab="TFTP配置" />
                <nn-tab-pane key="tftp-transfer-log" tab="传输日志" />
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

    defineOptions({ name: 'TftpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('tftp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'tftp-config';
    const tabKeys = new Set(['tftp-config', 'tftp-transfer-log']);

    const handleTabChange = key => {
        router.push(`/tftp/${key}`);
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
        if (route.path === '/tftp' || route.path === '/tftp/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/tftp/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
