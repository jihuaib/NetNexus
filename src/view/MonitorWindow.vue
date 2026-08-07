<template>
    <main class="monitor-window" :data-testid="monitorTestId">
        <section
            class="monitor-window-content"
            :class="{ 'monitor-window-content-compact-top': route.meta.monitorCompactTop }"
        >
            <router-view />
        </section>
    </main>
</template>

<script setup>
    import { computed, provide, shallowRef, watch, watchEffect } from 'vue';
    import { useRoute } from 'vue-router';

    const route = useRoute();
    const dynamicWindowTitle = shallowRef(null);

    provide('monitorWindowTitle', {
        setTitle: (owner, title = '') => {
            dynamicWindowTitle.value = {
                owner,
                title: String(title || '')
            };
        },
        clearTitle: owner => {
            if (dynamicWindowTitle.value?.owner === owner) {
                dynamicWindowTitle.value = null;
            }
        }
    });

    watch(
        () => route.name,
        () => {
            dynamicWindowTitle.value = null;
        },
        { flush: 'sync' }
    );

    const monitorTestId = computed(() => route.meta.monitorTestId || 'monitor-window-shell');

    watchEffect(() => {
        document.title = dynamicWindowTitle.value?.title || route.meta.windowTitle || 'NetNexus 监控窗口';
    });
</script>

<style scoped>
    .monitor-window {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100vh;
        min-height: 0;
        overflow: hidden;
        background: var(--nn-color-bg-layout);
    }

    .monitor-window-content {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        padding: 8px;
        overflow: hidden;
    }

    .monitor-window-content-compact-top {
        padding-top: 4px;
    }

    .monitor-window-content > :deep(.nn-container) {
        width: 100%;
        height: 100%;
        min-height: 0;
        margin: 0;
    }
</style>
