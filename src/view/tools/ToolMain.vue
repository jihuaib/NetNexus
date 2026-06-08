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
    import { ref, onActivated } from 'vue';
    import { useRouter } from 'vue-router';

    defineOptions({
        name: 'ToolMain'
    });

    const router = useRouter();
    const activeTabKey = ref('string-generator');
    const currentTab = ref(null);

    const handleTabChange = key => {
        router.push(`/tools/${key}`);
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
        activeTabKey.value = 'string-generator';
        router.push('/tools/string-generator');
    });
</script>

<style scoped></style>
