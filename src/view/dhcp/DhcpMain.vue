<template>
    <div class="nn-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="dhcp-config" tab="DHCP配置" />
                <nn-tab-pane key="dhcp-lease" tab="租约列表" />
            </nn-tabs>
        </div>

        <!-- 可滚动内容区域 -->
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

    defineOptions({ name: 'DhcpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('dhcp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'dhcp-config';
    const tabKeys = new Set(['dhcp-config', 'dhcp-lease']);

    const handleTabChange = key => {
        router.push(`/dhcp/${key}`);
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
        if (route.path === '/dhcp' || route.path === '/dhcp/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/dhcp/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
