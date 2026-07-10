<template>
    <div
        class="download-stats"
        :title="tooltipText"
        aria-live="polite"
    >
        <span class="stats-icon" aria-hidden="true">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
        </span>
        <span class="stats-body">
            <span class="stats-value">{{ displayValue }}</span>
            <span class="stats-label">总下载次数</span>
            <span class="stats-detail">{{ detailText }}</span>
        </span>
    </div>
</template>

<script setup>
    import { computed, onMounted, ref } from 'vue';
    import { fetchReleaseDownloadStats, formatDownloadCount } from '../utils/githubReleaseStats';

    const status = ref('loading');
    const stats = ref({
        totalDownloads: null,
        releaseCount: 0,
        assetCount: 0,
        fromCache: false
    });

    const displayValue = computed(() => {
        if (status.value === 'loading') {
            return '同步中';
        }
        if (status.value === 'error') {
            return '--';
        }
        return formatDownloadCount(stats.value.totalDownloads);
    });

    const detailText = computed(() => {
        if (status.value === 'loading') {
            return '正在读取 GitHub Release';
        }
        if (status.value === 'error') {
            return 'GitHub API 暂不可用';
        }
        return `${stats.value.releaseCount} 个版本 / ${stats.value.assetCount} 个安装包文件`;
    });

    const tooltipText = computed(() =>
        status.value === 'success'
            ? '统计 GitHub Releases 中安装包和归档文件的 download_count 总和，不含更新元数据、源码包和第三方镜像'
            : detailText.value
    );

    onMounted(async () => {
        try {
            stats.value = await fetchReleaseDownloadStats();
            status.value = 'success';
        } catch (error) {
            console.warn('Failed to load release download stats:', error);
            status.value = 'error';
        }
    });
</script>

<style scoped>
    .download-stats {
        display: inline-flex;
        align-items: center;
        gap: 0.9rem;
        width: min(100%, 360px);
        min-height: 84px;
        margin-top: 2rem;
        padding: 1rem 1.25rem;
        border: 1px solid var(--glass-border);
        border-radius: 14px;
        background: rgba(0, 33, 64, 0.62);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
        color: var(--text-primary);
        text-align: left;
        backdrop-filter: blur(12px);
        transition:
            border-color 0.2s ease,
            transform 0.2s ease,
            box-shadow 0.2s ease;
    }

    .stats-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 44px;
        width: 44px;
        height: 44px;
        border-radius: 12px;
        color: var(--accent-primary);
        background: rgba(24, 144, 255, 0.12);
    }

    .stats-body {
        display: grid;
        min-width: 0;
    }

    .stats-value {
        font-size: 1.75rem;
        font-weight: 800;
        line-height: 1.1;
        color: #fff;
    }

    .stats-label {
        margin-top: 0.15rem;
        font-size: 0.92rem;
        font-weight: 600;
        color: var(--text-primary);
    }

    .stats-detail {
        margin-top: 0.15rem;
        overflow: hidden;
        color: var(--text-secondary);
        font-size: 0.78rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    @media (max-width: 640px) {
        .download-stats {
            width: 100%;
            max-width: 340px;
        }

        .stats-value {
            font-size: 1.5rem;
        }
    }
</style>
