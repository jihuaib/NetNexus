<template>
    <div class="mt-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="bgp-config" tab="BGP配置" />
                <nn-tab-pane key="bgp-peer-config" tab="邻居配置" />
                <nn-tab-pane key="route-ipv4" tab="IPv4路由" />
                <nn-tab-pane key="route-ipv6" tab="IPv6路由" />
                <nn-tab-pane key="route-mvpn" tab="MVPN路由" />
                <nn-tab-pane key="route-ipv4-qp" tab="IPv4 QP路由" />
                <nn-tab-pane key="route-ipv6-qp" tab="IPv6 QP路由" />
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

    defineOptions({ name: 'BgpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('bgp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'bgp-config';
    const tabKeys = new Set([
        'bgp-config',
        'bgp-peer-config',
        'route-ipv4',
        'route-ipv6',
        'route-mvpn',
        'route-ipv4-qp',
        'route-ipv6-qp'
    ]);

    const handleTabChange = key => {
        router.push(`/bgp/${key}`);
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
        if (route.path === '/bgp' || route.path === '/bgp/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/bgp/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
