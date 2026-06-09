<template>
    <div class="mt-main-container">
        <div class="fixed-tabs">
            <a-tabs v-model:active-key="activeTabKey" @change="handleTabChange">
                <a-tab-pane key="tftp-config" tab="TFTP配置" />
                <a-tab-pane key="tftp-transfer-log" tab="传输日志" />
            </a-tabs>
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
    import { ref, onActivated } from 'vue';
    import { useRouter } from 'vue-router';

    defineOptions({ name: 'TftpMain' });

    const router = useRouter();
    const activeTabKey = ref('tftp-config');
    const currentTab = ref(null);

    const handleTabChange = key => {
        router.push(`/tftp/${key}`);
    };

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });

    onActivated(() => {
        router.push(`/tftp/${activeTabKey.value}`);
    });
</script>

<style scoped></style>
