<template>
    <div class="mt-main-container">
        <!-- 固定 Tabs -->
        <div class="fixed-tabs">
            <nn-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <nn-tab-pane key="ftp-config" tab="FTP配置" />
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
    import { ref, onActivated } from 'vue';
    import { useRouter } from 'vue-router';

    defineOptions({ name: 'FtpMain' });

    const router = useRouter();
    const activeTabKey = ref('ftp-config');
    const currentTab = ref(null);

    const handleTabChange = key => {
        router.push(`/ftp/${key}`);
    };

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    onActivated(() => {
        activeTabKey.value = 'ftp-config';
        router.push('/ftp/ftp-config');
    });
</script>

<style scoped></style>
