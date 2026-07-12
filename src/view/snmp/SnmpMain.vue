<template>
    <div class="nn-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="snmp-config" tab="SNMP配置" />
                <nn-tab-pane key="snmp-mib" tab="MIB管理" />
                <nn-tab-pane key="snmp-trap" tab="Trap监控" />
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

    defineOptions({ name: 'SnmpMain' });

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('snmp-config');
    const currentTab = ref(null);
    const defaultTabKey = 'snmp-config';

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    const handleTabChange = key => {
        router.push(`/snmp/${key}`);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        activeTabKey.value = childPath || defaultTabKey;
    };

    watch(() => route.path, syncActiveTab, { immediate: true });

    onActivated(() => {
        syncActiveTab();
        if (route.path === '/snmp' || route.path === '/snmp/') {
            router.replace('/snmp/snmp-config');
        }
    });
</script>

<style scoped></style>
