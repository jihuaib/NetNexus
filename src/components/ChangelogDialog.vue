<template>
    <nn-modal
        v-model:open="isOpen"
        :title="remoteInfo ? '新版本更新内容' : '更新日志'"
        class="changelog-dialog"
        width="min(680px, calc(100vw - 32px))"
        :z-index="remoteInfo ? 10000 : 1100"
        @cancel="close"
    >
        <div class="changelog-content">
            <div class="changelog-version">
                <strong>NetNexus</strong>
                <nn-tag color="blue">v{{ version }}</nn-tag>
            </div>
            <template v-if="remoteReleaseNotes.length">
                <p v-if="remoteInfo.releaseName" class="changelog-summary">{{ remoteInfo.releaseName }}</p>
                <section
                    v-for="(note, index) in remoteReleaseNotes"
                    :key="`${note.version}-${index}`"
                    class="changelog-section"
                >
                    <h3 v-if="remoteReleaseNotes.length > 1 || note.version !== version">v{{ note.version }}</h3>
                    <div class="changelog-remote-notes">{{ note.text }}</div>
                </section>
            </template>
            <template v-else-if="releaseNotes">
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
            <p class="changelog-hint">
                {{
                    remoteInfo
                        ? '可在“设置 → 更新”中下载或安装新版本。'
                        : '每个版本首次启动时显示，也可在“设置 → 更新”中再次查看。'
                }}
            </p>
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
    const remoteInfo = ref(null);
    const releaseNotes = computed(() => (remoteInfo.value ? null : notesByVersion[version.value] || null));

    const releaseNoteText = note => {
        if (typeof note !== 'string') return '';
        const text = note.trim();
        if (
            !/<\/?(?:p|div|br|h[1-6]|ul|ol|li|pre|code|blockquote|table|tr|td|th|span|a|strong|em|img|script|style|iframe|object|embed|template)\b[^>]*>/iu.test(
                text
            )
        ) {
            return text;
        }

        const template = document.createElement('template');
        template.innerHTML = text;
        const content = template.content;
        content.querySelectorAll('script, style, iframe, object, embed, template').forEach(node => node.remove());
        content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
        content.querySelectorAll('li').forEach(node => node.prepend('- '));
        content
            .querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, tr')
            .forEach(node => node.append('\n'));
        return content.textContent
            .replace(/[\t ]+\n/gu, '\n')
            .replace(/\n{3,}/gu, '\n\n')
            .trim();
    };

    const remoteReleaseNotes = computed(() => {
        const notes = remoteInfo.value?.releaseNotes;
        const entries =
            typeof notes === 'string' ? [{ version: version.value, note: notes }] : Array.isArray(notes) ? notes : [];
        return entries
            .map(entry => ({ version: entry?.version || version.value, text: releaseNoteText(entry?.note) }))
            .filter(entry => entry.text);
    });

    const close = () => {
        isOpen.value = false;
    };

    const openDialog = async (currentVersion = appVersion, updateInfo = null) => {
        version.value = currentVersion || appVersion;
        remoteInfo.value = updateInfo ? { ...updateInfo } : null;
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

    defineExpose({ openDialog, close });
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

    .changelog-remote-notes {
        white-space: pre-wrap;
        user-select: text;
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
