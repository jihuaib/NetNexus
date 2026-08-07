<template>
    <div class="nn-main-container">
        <div class="fixed-tabs">
            <nn-tabs active-key="syslog-config">
                <nn-tab-pane key="syslog-config" tab="Syslog配置" />
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
    import { ref } from 'vue';

    defineOptions({ name: 'SyslogMain' });

    const currentTab = ref(null);

    defineExpose({
        clearValidationErrors: () => {
            if (currentTab.value?.clearValidationErrors) {
                currentTab.value.clearValidationErrors();
            }
        }
    });
</script>

<style scoped></style>
