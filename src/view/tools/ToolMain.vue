<template>
    <div class="mt-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <a-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <a-tab-pane key="string-generator" tab="字符串生成" />
                <a-tab-pane key="packet-parser" tab="报文解析" />
                <a-tab-pane key="port-monitor" tab="端口监听" />
                <a-tab-pane key="network-info" tab="网络信息" />
                <a-tab-pane key="tcp-ao-mac" tab="TCP-AO MAC" />
                <a-tab-pane key="http-api-tester" tab="HTTP API测试" />
            </a-tabs>
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

    defineOptions({
        name: 'ToolMain'
    });

    const router = useRouter();
    const route = useRoute();
    const activeTabKey = ref('string-generator');
    const currentTab = ref(null);
    const tabKeys = new Set([
        'string-generator',
        'packet-parser',
        'port-monitor',
        'network-info',
        'tcp-ao-mac',
        'http-api-tester'
    ]);

    const handleTabChange = key => {
        router.push(`/tools/${key}`);
    };

    const syncActiveTabFromRoute = () => {
        const key = route.path.split('/').filter(Boolean)[1];
        if (tabKeys.has(key)) {
            activeTabKey.value = key;
        }
    };

    // 向父组件(Main.vue)暴露清空验证错误的方法
    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value && typeof currentTab.value.clearValidationErrors === 'function') {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    onActivated(() => {
        if (route.path === '/tools' || route.path === '/tools/') {
            activeTabKey.value = 'string-generator';
            router.replace('/tools/string-generator');
            return;
        }
        syncActiveTabFromRoute();
    });

    watch(
        () => route.path,
        () => {
            syncActiveTabFromRoute();
        }
    );
</script>

<style scoped></style>
