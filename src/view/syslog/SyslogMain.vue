<template>
    <div class="mt-main-container">
        <div class="fixed-tabs">
            <a-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <a-tab-pane key="syslog-config" tab="Syslog配置" />
                <a-tab-pane key="syslog-message-log" tab="消息日志" />
            </a-tabs>
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

    defineOptions({ name: 'SyslogMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('syslog-config');
    const currentTab = ref(null);
    const defaultTabKey = 'syslog-config';
    const tabKeys = new Set(['syslog-config', 'syslog-message-log']);

    const handleTabChange = key => {
        router.push(`/syslog/${key}`);
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
        if (route.path === '/syslog' || route.path === '/syslog/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/syslog/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
