<template>
    <div class="nn-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="rpki-config" tab="RPKI配置" />
                <nn-tab-pane key="rpki-roa-config" tab="RPKI ROA配置" />
                <nn-tab-pane key="rpki-router-key-config" tab="Router Key (v1+)" />
                <nn-tab-pane key="rpki-aspa-config" tab="ASPA (v2)" />
            </nn-tabs>
        </div>

        <!-- 可滚动内容区域 -->
        <div class="content-container">
            <router-view v-slot="{ Component }">
                <keep-alive :include="$store.state.cachedViews">
                    <component :is="Component" ref="currentTab" @open-settings="handleOpenSettings" />
                </keep-alive>
            </router-view>
        </div>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';

    defineOptions({ name: 'RpkiMain' });

    const emit = defineEmits(['openSettings']);

    const route = useRoute();
    const router = useRouter();
    const activeTabKey = ref('rpki-config');
    const currentTab = ref(null);
    const defaultTabKey = 'rpki-config';
    const tabKeys = new Set(['rpki-config', 'rpki-roa-config', 'rpki-router-key-config', 'rpki-aspa-config']);

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    const handleOpenSettings = category => {
        emit('openSettings', category);
    };

    const handleTabChange = key => {
        router.push(`/rpki/${key}`);
    };

    const syncActiveTab = () => {
        const childPath = route.path.split('/').filter(Boolean)[1];
        if (tabKeys.has(childPath)) {
            activeTabKey.value = childPath;
        }
    };

    watch(() => route.path, syncActiveTab, { immediate: true });

    onActivated(() => {
        if (route.path === '/rpki' || route.path === '/rpki/') {
            activeTabKey.value = defaultTabKey;
            router.replace(`/rpki/${defaultTabKey}`);
            return;
        }
        syncActiveTab();
    });
</script>

<style scoped></style>
