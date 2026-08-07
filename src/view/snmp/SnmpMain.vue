<template>
    <div class="nn-main-container snmp-main">
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
    import { SNMP_ROUTE, SNMP_TABS } from '../../const/snmpConst';

    defineOptions({ name: 'SnmpMain' });

    const route = useRoute();
    const router = useRouter();
    const mainTabs = SNMP_TABS;
    const defaultTab = mainTabs[0];
    const activeTabKey = ref(defaultTab.key);
    const currentTab = ref(null);

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
        if (route.path === SNMP_ROUTE.BASE || route.path === `${SNMP_ROUTE.BASE}/`) {
            void router.replace(SNMP_ROUTE.CONFIG);
        } else if (route.path === SNMP_ROUTE.TRAP) {
            void router.replace(SNMP_ROUTE.MIB_WORKSPACE);
        }
    };

    watch(() => route.path, ensureMainRoute, { immediate: true });
</script>

<style scoped></style>
