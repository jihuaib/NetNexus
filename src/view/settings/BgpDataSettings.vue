<template>
    <nn-settings class="bgp-data-settings">
        <nn-settings-section
            title="BGP 路由数据库"
            description="查看本地路由数据库状态。旧数据库不兼容时，可在停止 BGP 后删除重建。"
        >
            <template #actions>
                <span class="database-live-status" role="status" aria-live="polite">
                    <nn-tag :color="statusTag.color">{{ statusTag.text }}</nn-tag>
                </span>
            </template>

            <nn-alert
                type="warning"
                show-icon
                message="删除后无法恢复"
                description="此操作会永久删除全部地址族的已生成路由和属性。BGP、邻居和路由组配置会保留；下次启动 BGP 时创建空数据库。"
                class="database-warning"
            />

            <nn-alert
                v-if="operationError"
                type="error"
                show-icon
                message="数据库删除失败"
                :description="operationError"
                class="database-warning"
                data-testid="bgp-database-delete-error"
            />

            <div class="database-panel">
                <nn-descriptions :column="1" bordered size="small" class="database-details">
                    <nn-descriptions-item label="BGP 服务">
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

                <nn-settings-item title="数据库操作" align="center" actions-width="min(360px, 100%)">
                    <template #description>
                        <span id="bgp-database-delete-hint" data-testid="bgp-database-delete-hint">
                            {{ deleteHint }}
                        </span>
                    </template>
                    <template #actions>
                        <nn-button
                            :loading="refreshing"
                            :disabled="deleting"
                            data-testid="bgp-database-refresh-button"
                            @click="refreshDatabaseInfo()"
                        >
                            <template #icon><ReloadOutlined /></template>
                            刷新状态
                        </nn-button>
                        <nn-button
                            type="primary"
                            danger
                            data-testid="bgp-database-delete-button"
                            aria-describedby="bgp-database-delete-hint"
                            :loading="deleting"
                            :disabled="!canDeleteDatabase"
                            @click="confirmDeleteDatabase"
                        >
                            <template #icon><DeleteOutlined /></template>
                            删除 BGP 数据库
                        </nn-button>
                    </template>
                </nn-settings-item>
            </div>
        </nn-settings-section>
    </nn-settings>
</template>

<script setup>
    import { computed, onActivated, ref } from 'vue';
    import { DeleteOutlined, ReloadOutlined } from 'netnexus-ui/icons';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'BgpDataSettings' });

    const emptyDatabaseInfo = {
        dbPath: '',
        exists: false,
        running: false,
        starting: false,
        stopping: false,
        deleting: false,
        busy: false,
        totalSize: 0,
        fileCount: 0
    };
    const databaseInfo = ref({ ...emptyDatabaseInfo });
    const refreshing = ref(false);
    const deleting = ref(false);
    const loadError = ref('');
    const operationError = ref('');
    const hasLoaded = ref(false);
    const preloadRestartMessage = '请重启应用后使用 BGP 数据库管理';

    const getDatabaseApi = () => {
        const api = window.bgpApi;
        if (typeof api?.getRouteDatabaseInfo !== 'function' || typeof api?.deleteRouteDatabase !== 'function') {
            throw new Error(preloadRestartMessage);
        }
        return api;
    };

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
        if (databaseInfo.value.stopping) return { color: 'orange', text: '正在停止' };
        if (databaseInfo.value.running) return { color: 'green', text: '服务运行中' };
        if (databaseInfo.value.busy) return { color: 'orange', text: '数据库忙碌' };
        if (databaseInfo.value.exists) return { color: 'blue', text: '可管理' };
        return { color: 'default', text: '尚未创建' };
    });

    const serviceStatusText = computed(() => {
        if (!hasLoaded.value || loadError.value) return '未知';
        if (databaseInfo.value.starting) return '正在启动';
        if (databaseInfo.value.stopping) return '正在停止';
        if (databaseInfo.value.running) return '运行中';
        return '已停止';
    });

    const databaseStatusText = computed(() => {
        if (loadError.value) return `状态获取失败：${loadError.value}`;
        if (!hasLoaded.value) return '检测中';
        if (!databaseInfo.value.exists) return '不存在';
        return `已创建（${Number(databaseInfo.value.fileCount) || 1} 个文件）`;
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
            !databaseInfo.value.stopping &&
            !databaseInfo.value.deleting
    );

    const deleteHint = computed(() => {
        if (loadError.value === preloadRestartMessage) return preloadRestartMessage;
        if (loadError.value) return '数据库状态不可用，请刷新后重试。';
        if (deleting.value || databaseInfo.value.deleting) return '正在删除数据库，请稍候。';
        if (refreshing.value || !hasLoaded.value) return '正在检测数据库状态…';
        if (databaseInfo.value.stopping) return 'BGP 正在停止，请稍候刷新状态。';
        if (databaseInfo.value.running || databaseInfo.value.starting) return '请先停止 BGP 服务。';
        if (databaseInfo.value.busy) return '数据库正在使用，请稍候刷新状态。';
        if (!databaseInfo.value.exists) return '当前没有可删除的 BGP 数据库。';
        return 'BGP 已停止，可以删除数据库并在下次启动时重建。';
    });

    const refreshDatabaseInfo = async (preserveOperationError = false) => {
        if (refreshing.value) return;
        refreshing.value = true;
        loadError.value = '';
        if (!preserveOperationError) operationError.value = '';
        try {
            const response = await getDatabaseApi().getRouteDatabaseInfo();
            if (response?.status !== 'success') {
                throw new Error(response?.msg || '获取 BGP 数据库状态失败');
            }
            databaseInfo.value = { ...emptyDatabaseInfo, ...(response.data || {}) };
            hasLoaded.value = true;
        } catch (error) {
            loadError.value = error.message || '获取 BGP 数据库状态失败';
            hasLoaded.value = false;
        } finally {
            refreshing.value = false;
        }
    };

    const deleteDatabase = async () => {
        deleting.value = true;
        operationError.value = '';
        try {
            const response = await getDatabaseApi().deleteRouteDatabase();
            if (response?.status !== 'success') {
                throw new Error(response?.msg || '删除 BGP 数据库失败');
            }
            notify.success(response.msg || 'BGP 数据库删除成功');
            await refreshDatabaseInfo();
        } catch (error) {
            operationError.value = error.message || '删除 BGP 数据库失败';
            notify.error(operationError.value);
            await refreshDatabaseInfo(true);
            throw error;
        } finally {
            deleting.value = false;
        }
    };

    const confirmDeleteDatabase = () => {
        if (!canDeleteDatabase.value) return;

        dialog.confirm({
            title: '确认删除 BGP 数据库',
            content:
                '将永久删除全部地址族的已生成路由和属性，且无法恢复。BGP、邻居和路由组配置会保留，下次启动时创建空数据库。是否继续？',
            okText: '永久删除',
            cancelText: '取消',
            okType: 'danger',
            onOk: deleteDatabase
        });
    };

    onActivated(() => refreshDatabaseInfo());
</script>

<style scoped>
    .bgp-data-settings {
        max-width: 100%;
    }

    .database-warning {
        margin-bottom: 16px;
    }

    .database-panel {
        display: grid;
        min-width: 0;
        gap: 16px;
    }

    .database-live-status {
        display: inline-flex;
        flex: 0 0 auto;
    }

    .database-path {
        word-break: break-all;
    }
</style>
