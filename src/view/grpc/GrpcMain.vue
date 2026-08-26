<template>
    <div class="nn-main-container grpc-main">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane v-for="tab in mainTabs" :key="tab.key" :tab="tab.label" />
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
    import { ref, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';
    import { GRPC_ROUTE, GRPC_TABS } from '../../const/grpcConst';
    import { useGrpcRuntime } from './useGrpcRuntime';

    defineOptions({ name: 'GrpcMain' });

    const route = useRoute();
    const router = useRouter();
    const mainTabs = GRPC_TABS;
    const defaultTab = mainTabs[0];
    const activeTabKey = ref(defaultTab.key);
    const currentTab = ref(null);
    useGrpcRuntime();

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    const handleTabChange = key => {
        const tab = mainTabs.find(item => item.key === key);
        if (tab) router.push(tab.route);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        activeTabKey.value = mainTabs.some(tab => tab.key === childPath) ? childPath : defaultTab.key;
    };

    const ensureMainRoute = () => {
        syncActiveTab();
        if (route.path === GRPC_ROUTE.BASE || route.path === `${GRPC_ROUTE.BASE}/`) {
            void router.replace(GRPC_ROUTE.PROTO);
        }
    };

    watch(() => route.path, ensureMainRoute, { immediate: true });
</script>

<style scoped></style>
