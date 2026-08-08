<template>
    <div class="bmp-data-settings">
        <nn-card title="数据管理" class="settings-card">
            <nn-alert
                type="warning"
                show-icon
                message="删除后无法恢复"
                description="此操作会永久删除全部 BMP 客户端、会话、RIB 路由、历史事件和统计数据。BMP 配置不会被删除，下次启动时会创建空数据库。"
                class="database-warning"
            />

            <div class="database-panel">
                <div class="database-heading">
                    <div>
                        <div class="database-title">BMP SQLite 数据库</div>
                        <div class="database-subtitle">无需启动 BMP 即可查看并删除本地数据库。</div>
                    </div>
                    <span class="database-live-status" role="status" aria-live="polite">
                        <nn-tag :color="statusTag.color">{{ statusTag.text }}</nn-tag>
                    </span>
                </div>

                <nn-descriptions :column="1" bordered size="small" class="database-details">
                    <nn-descriptions-item label="BMP 服务">
                        {{ serviceStatusText }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="数据库文件">
                        {{ databaseStatusText }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="占用空间">
                        {{ databaseSizeText }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="存储路径">
                        <nn-typography-text v-if="displayDatabasePath" copyable class="database-path">
                            {{ displayDatabasePath }}
                        </nn-typography-text>
                        <span v-else>-</span>
                    </nn-descriptions-item>
                </nn-descriptions>

                <div class="database-actions">
                    <nn-button :loading="refreshing" :disabled="deleting" @click="refreshDatabaseInfo">
                        <template #icon><ReloadOutlined /></template>
                        刷新状态
                    </nn-button>
                    <nn-button
                        type="primary"
                        danger
                        data-testid="bmp-database-delete-button"
                        aria-describedby="bmp-database-delete-hint"
                        :loading="deleting"
                        :disabled="!canDeleteDatabase"
                        @click="confirmDeleteDatabase"
                    >
                        <template #icon><DeleteOutlined /></template>
                        删除 BMP 数据库
                    </nn-button>
                    <span id="bmp-database-delete-hint" class="database-action-hint">{{ deleteHint }}</span>
                </div>
            </div>
        </nn-card>
    </div>
</template>

<script setup>
    import { computed, onActivated, ref } from 'vue';
    import { DeleteOutlined, ReloadOutlined } from 'netnexus-ui/icons';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'BmpDataSettings' });

    const databaseInfo = ref({
        dbPath: '',
        exists: false,
        running: false,
        starting: false,
        deleting: false,
        busy: false,
        totalSize: 0,
        fileCount: 0
    });
    const refreshing = ref(false);
    const deleting = ref(false);
    const loadError = ref('');
    const hasLoaded = ref(false);

    const formatBytes = value => {
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes < 0) return '-';
        if (bytes === 0) return '0 B';

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const amount = bytes / 1024 ** unitIndex;
        return `${amount.toFixed(unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unitIndex]}`;
    };

    const statusTag = computed(() => {
        if (loadError.value) return { color: 'red', text: '状态异常' };
        if (deleting.value || databaseInfo.value.deleting) return { color: 'orange', text: '正在删除' };
        if (refreshing.value || !hasLoaded.value) return { color: 'blue', text: '检测中' };
        if (databaseInfo.value.starting) return { color: 'blue', text: '正在启动' };
        if (databaseInfo.value.running) return { color: 'green', text: '服务运行中' };
        if (databaseInfo.value.exists) return { color: 'blue', text: '可管理' };
        return { color: 'default', text: '尚未创建' };
    });

    const serviceStatusText = computed(() => {
        if (!hasLoaded.value || loadError.value) return '未知';
        if (databaseInfo.value.starting) return '正在启动';
        if (databaseInfo.value.running) return '运行中';
        return '已停止';
    });

    const databaseStatusText = computed(() => {
        if (loadError.value) return `状态获取失败：${loadError.value}`;
        if (!hasLoaded.value) return '检测中';
        if (!databaseInfo.value.exists) return '不存在';
        const count = Number(databaseInfo.value.fileCount) || 1;
        return `已创建（${count} 个 SQLite 文件）`;
    });

    const databaseSizeText = computed(() =>
        hasLoaded.value && !loadError.value ? formatBytes(databaseInfo.value.totalSize) : '-'
    );
    const displayDatabasePath = computed(() => (hasLoaded.value && !loadError.value ? databaseInfo.value.dbPath : ''));

    const canDeleteDatabase = computed(
        () =>
            !refreshing.value &&
            !deleting.value &&
            !loadError.value &&
            hasLoaded.value &&
            databaseInfo.value.exists &&
            !databaseInfo.value.busy &&
            !databaseInfo.value.running &&
            !databaseInfo.value.starting &&
            !databaseInfo.value.deleting
    );

    const deleteHint = computed(() => {
        if (loadError.value) return '数据库状态不可用，请刷新后重试。';
        if (deleting.value || databaseInfo.value.deleting) return '正在删除数据库，请稍候。';
        if (refreshing.value || !hasLoaded.value) return '正在检测数据库状态…';
        if (databaseInfo.value.running || databaseInfo.value.starting) return '请先停止 BMP 服务。';
        if (!databaseInfo.value.exists) return '当前没有可删除的 BMP 数据库。';
        return 'BMP 已停止，可以安全删除数据库。';
    });

    const refreshDatabaseInfo = async () => {
        refreshing.value = true;
        loadError.value = '';
        try {
            const response = await window.bmpApi.getPersistenceDatabaseInfo();
            if (response?.status !== 'success') {
                throw new Error(response?.msg || '获取 BMP 数据库状态失败');
            }
            databaseInfo.value = {
                ...databaseInfo.value,
                ...(response.data || {})
            };
            hasLoaded.value = true;
        } catch (error) {
            loadError.value = error.message || '获取 BMP 数据库状态失败';
            hasLoaded.value = false;
        } finally {
            refreshing.value = false;
        }
    };

    const deleteDatabase = async () => {
        deleting.value = true;
        try {
            const response = await window.bmpApi.deletePersistenceDatabase();
            if (response?.status !== 'success') {
                throw new Error(response?.msg || '删除 BMP 数据库失败');
            }
            notify.success(response.msg || 'BMP 数据库删除成功');
            await refreshDatabaseInfo();
        } catch (error) {
            notify.error(error.message || '删除 BMP 数据库失败');
            await refreshDatabaseInfo();
            throw error;
        } finally {
            deleting.value = false;
        }
    };

    const confirmDeleteDatabase = () => {
        if (!canDeleteDatabase.value) return;

        dialog.confirm({
            title: '确认删除 BMP 数据库',
            content: '将永久删除全部 BMP 客户端、会话、路由、历史事件和统计数据，且无法恢复。是否继续？',
            okText: '永久删除',
            cancelText: '取消',
            okType: 'danger',
            onOk: deleteDatabase
        });
    };

    onActivated(refreshDatabaseInfo);
</script>

<style scoped>
    .bmp-data-settings {
        max-width: 100%;
    }

    .database-warning {
        margin-bottom: 16px;
    }

    .database-panel {
        padding: 16px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .database-heading {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
    }

    .database-title {
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.5;
    }

    .database-live-status {
        display: inline-flex;
        flex: 0 0 auto;
    }

    .database-subtitle,
    .database-action-hint {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 1.5;
    }

    .database-subtitle {
        margin-top: 2px;
    }

    .database-details {
        margin-bottom: 16px;
    }

    .database-path {
        word-break: break-all;
    }

    .database-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
    }

    .database-action-hint {
        flex: 1 1 220px;
    }
</style>
