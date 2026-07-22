<template>
    <div class="nn-main-container snmp-main">
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane v-for="tab in SNMP_TABS" :key="tab.key" :tab="tab.label" />
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
    import { SNMP_ROUTE, SNMP_TABS } from '../../const/snmpConst';

    defineOptions({ name: 'SnmpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref(SNMP_TABS[0].key);
    const currentTab = ref(null);

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    const handleTabChange = key => {
        const tab = SNMP_TABS.find(item => item.key === key);
        if (tab) router.push(tab.route);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        activeTabKey.value = SNMP_TABS.some(tab => tab.key === childPath) ? childPath : SNMP_TABS[0].key;
    };

    watch(() => route.path, syncActiveTab, { immediate: true });

    onActivated(() => {
        syncActiveTab();
        if (route.path === SNMP_ROUTE.BASE || route.path === `${SNMP_ROUTE.BASE}/`) {
            router.replace(SNMP_ROUTE.CONFIG);
        }
    });
</script>

<style scoped></style>
