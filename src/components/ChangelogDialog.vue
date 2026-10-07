<template>
    <nn-modal
        v-model:open="isOpen"
        title="更新日志"
        class="changelog-dialog"
        width="min(680px, calc(100vw - 32px))"
        :z-index="1100"
        @cancel="close"
    >
        <div class="changelog-content">
            <div class="changelog-version">
                <strong>NetNexus</strong>
                <nn-tag color="blue">v{{ version }}</nn-tag>
            </div>
            <template v-if="releaseNotes">
                <p class="changelog-summary">{{ releaseNotes.summary }}</p>
                <section v-for="section in releaseNotes.sections" :key="section.title" class="changelog-section">
                    <h3>{{ section.title }}</h3>
                    <ul>
                        <li v-for="item in section.items" :key="item">{{ item }}</li>
                    </ul>
                </section>
            </template>
            <nn-alert
                v-else
                type="info"
                show-icon
                message="此版本暂未附带详细更新日志，可前往 GitHub Releases 查看发布说明。"
            />
            <p class="changelog-hint">每个版本首次启动时显示，也可在“设置 → 更新”中再次查看。</p>
        </div>
        <template #footer>
            <nn-button @click="openReleasesPage">GitHub Releases</nn-button>
            <nn-button type="primary" @click="close">知道了</nn-button>
        </template>
    </nn-modal>
</template>

<script setup>
    import { computed, nextTick, ref } from 'vue';
    import { version as appVersion } from '../../package.json';
    import notesByVersion from '../data/releaseNotes.json';
    import { notify } from '../utils/notify';

    const isOpen = ref(false);
    const version = ref(appVersion);
    const releaseNotes = computed(() => notesByVersion[version.value] || null);

    const close = () => {
        isOpen.value = false;
    };

    const openDialog = async (currentVersion = appVersion) => {
        version.value = currentVersion || appVersion;
        isOpen.value = true;
        await nextTick();
    };

    const openReleasesPage = async () => {
        try {
            if (window.updaterApi?.openReleasesPage) {
                const result = await window.updaterApi.openReleasesPage();
                if (result?.success === false) throw new Error(result.error || '打开失败');
            } else {
                window.open('https://github.com/jihuaib/NetNexus/releases', '_blank', 'noopener,noreferrer');
            }
        } catch (error) {
            notify.error('打开 GitHub Releases 失败: ' + error.message);
        }
    };

    defineExpose({ openDialog });
</script>

<style scoped>
    :global(.changelog-dialog .nn-modal-body) {
        max-height: min(560px, calc(100vh - 180px)) !important;
        overflow-y: auto;
    }

    .changelog-content {
        color: var(--nn-color-text);
        font-size: 13px;
        line-height: 1.55;
        overflow-wrap: anywhere;
    }

    .changelog-version {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
    }

    .changelog-version strong {
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 600;
    }

    .changelog-version :deep(.nn-tag) {
        font-size: 12px;
    }

    .changelog-summary {
        margin: 0 0 12px;
        color: var(--nn-color-text-secondary);
    }

    .changelog-section + .changelog-section {
        margin-top: 12px;
    }

    .changelog-section h3 {
        margin: 0 0 4px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .changelog-section ul {
        margin: 0;
        padding-left: 16px;
    }

    .changelog-section li + li {
        margin-top: 4px;
    }

    .changelog-hint {
        margin: 16px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    :global(.changelog-dialog .nn-modal-footer .nn-button) {
        font-size: 13px;
        height: 28px;
        min-height: 28px;
        padding: 4px 12px;
        line-height: 1.4;
    }
</style>
