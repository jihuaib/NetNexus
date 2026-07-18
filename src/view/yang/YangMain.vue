<template>
    <div class="nn-main-container yang-main">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane v-for="tab in YANG_TABS" :key="tab.key" :tab="tab.label" />
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
    import { onActivated, ref, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';
    import { YANG_ROUTE, YANG_TABS } from '../../const/yangConst';

    defineOptions({ name: 'YangMain' });

    const route = useRoute();
    const router = useRouter();
    const currentTab = ref(null);
    const activeTabKey = ref(YANG_TABS[0].key);
    const handleTabChange = key => {
        const tab = YANG_TABS.find(item => item.key === key);
        if (tab) router.push(tab.route);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        activeTabKey.value = YANG_TABS.some(tab => tab.key === childPath) ? childPath : YANG_TABS[0].key;
    };

    watch(() => route.path, syncActiveTab, { immediate: true });

    onActivated(() => {
        syncActiveTab();
        if (route.path === YANG_ROUTE.BASE || route.path === `${YANG_ROUTE.BASE}/`) {
            router.replace(YANG_ROUTE.CONNECTION);
        }
    });

    defineExpose({
        clearValidationErrors: () => currentTab.value?.clearValidationErrors?.()
    });
</script>

<style scoped>
    .yang-main {
        background: var(--nn-color-bg-layout);
    }
</style>
