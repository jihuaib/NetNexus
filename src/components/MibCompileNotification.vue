<template>
    <FloatingProgressNotification
        root-class="mib-compile-notification"
        :visible="visible"
        :title="notificationTitle"
        :description="notificationDescription"
        :percent="progress.percent || 0"
        :show-progress="showProgress"
        :status="notificationStatus"
        @close="closeNotification"
    >
        <template #icon>
            <loading-outlined v-if="notificationStatus === 'loading'" class="notification-icon-primary" spin />
            <check-circle-outlined v-else-if="notificationStatus === 'success'" class="notification-icon-success" />
            <exclamation-circle-outlined
                v-else-if="notificationStatus === 'warning'"
                class="notification-icon-warning"
            />
            <exclamation-circle-outlined v-else class="notification-icon-error" />
        </template>
    </FloatingProgressNotification>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
    import EventBus from '../utils/eventBus';
    import { MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID } from '../const/snmpConst';
    import { CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined } from '../ui/icons';
    import FloatingProgressNotification from './FloatingProgressNotification.vue';

    defineOptions({ name: 'MibCompileNotification' });

    const visible = ref(false);
    const progress = ref({
        progressId: '',
        phase: 'preparing',
        completed: 0,
        total: 0,
        percent: 0,
        scanned: 0,
        scanTotal: 0,
        counts: { compiled: 0, skipped: 0, failed: 0 }
    });
    let dismissedProgressId = '';
    let closeTimer = null;

    const counts = computed(() => ({
        compiled: progress.value.counts?.compiled || 0,
        skipped: progress.value.counts?.skipped || 0,
        failed: progress.value.counts?.failed || 0
    }));
    const isTerminal = computed(() => ['completed', 'failed'].includes(progress.value.phase));
    const showProgress = computed(() => progress.value.phase !== 'failed');
    const notificationStatus = computed(() => {
        if (progress.value.phase === 'failed') return 'error';
        if (progress.value.phase === 'completed') return counts.value.failed > 0 ? 'warning' : 'success';
        return 'loading';
    });
    const notificationTitle = computed(() => {
        switch (progress.value.phase) {
            case 'scanning':
                return `正在扫描 MIB ${progress.value.scanned || 0}/${progress.value.scanTotal || 0}`;
            case 'compiling':
                return `正在编译 MIB ${progress.value.completed || 0}/${progress.value.total || 0}`;
            case 'planning':
                return '正在分析 MIB 依赖关系';
            case 'serializing':
                return `正在解析 MIB 批次 ${progress.value.completed || 0}/${progress.value.total || 0}`;
            case 'indexing':
                return '正在生成 OID 索引';
            case 'caching':
                return '正在保存 MIB 缓存';
            case 'syncing':
                return '正在同步 SNMP 服务';
            case 'completed':
                return counts.value.failed > 0 ? 'MIB 编译完成（部分文件失败）' : 'MIB 编译完成';
            case 'failed':
                return 'MIB 编译失败';
            default:
                return '正在准备 MIB 编译';
        }
    });
    const notificationDescription = computed(() => {
        if (progress.value.phase === 'completed') {
            const prefix = progress.value.cacheHit ? '缓存加载完成' : '编译完成';
            return `${prefix}：成功 ${counts.value.compiled}，跳过 ${counts.value.skipped}，失败 ${counts.value.failed}`;
        }
        if (progress.value.phase === 'failed') {
            return progress.value.message || 'MIB 编译过程中发生错误';
        }

        const currentFile = progress.value.filePath || progress.value.fileName || progress.value.message || '请稍候';
        if (['compiling', 'serializing'].includes(progress.value.phase)) {
            return `${currentFile} · 成功 ${counts.value.compiled} · 跳过 ${counts.value.skipped} · 失败 ${counts.value.failed}`;
        }
        return currentFile;
    });

    const clearCloseTimer = () => {
        if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
    };

    const scheduleClose = () => {
        clearCloseTimer();
        closeTimer = window.setTimeout(() => {
            visible.value = false;
        }, 5000);
    };

    const handleProgress = response => {
        if (response?.status !== 'success' || !response.data?.progressId) {
            return;
        }

        const next = response.data;
        if (next.progressId === dismissedProgressId) {
            return;
        }
        if (progress.value.progressId && next.progressId !== progress.value.progressId) {
            if (next.phase !== 'preparing' && !isTerminal.value) {
                return;
            }
            dismissedProgressId = '';
        }
        if (
            next.progressId === progress.value.progressId &&
            !['preparing', 'scanning'].includes(next.phase) &&
            Number(next.completed) < Number(progress.value.completed)
        ) {
            return;
        }

        clearCloseTimer();
        progress.value = {
            ...progress.value,
            ...next,
            counts: next.counts || progress.value.counts
        };
        visible.value = true;
        if (isTerminal.value) {
            scheduleClose();
        }
    };

    const closeNotification = () => {
        dismissedProgressId = progress.value.progressId;
        visible.value = false;
        clearCloseTimer();
    };

    onMounted(() => {
        EventBus.on(MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_MIB_NOTIFICATION, handleProgress);
    });

    onBeforeUnmount(() => {
        EventBus.off(MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_MIB_NOTIFICATION);
        clearCloseTimer();
    });
</script>
