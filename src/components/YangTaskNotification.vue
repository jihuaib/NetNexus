<template>
    <FloatingProgressNotification
        root-class="yang-task-notification"
        :visible="visible"
        :title="notificationTitle"
        :description="notificationDescription"
        :percent="percent"
        :show-progress="showProgress"
        :status="notificationStatus"
        @close="closeNotification"
    >
        <template #icon>
            <LoadingOutlined v-if="notificationStatus === 'loading'" class="notification-icon-primary" spin />
            <CheckCircleOutlined v-else-if="notificationStatus === 'success'" class="notification-icon-success" />
            <ExclamationCircleOutlined v-else-if="notificationStatus === 'warning'" class="notification-icon-warning" />
            <ExclamationCircleOutlined v-else class="notification-icon-error" />
        </template>
    </FloatingProgressNotification>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
    import { YANG_EVENT, YANG_EVENT_PAGE_ID } from '../const/yangConst';
    import EventBus from '../utils/eventBus';
    import { CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined } from '../ui/icons';
    import { getTaskId, isTaskTerminal } from '../view/yang/yangUiUtils';
    import FloatingProgressNotification from './FloatingProgressNotification.vue';

    defineOptions({ name: 'YangTaskNotification' });

    const visible = ref(false);
    const progress = ref({
        taskId: '',
        action: '',
        phase: 'preparing',
        completed: 0,
        total: 0,
        percent: 0,
        counts: {}
    });
    const dismissedTaskIds = new Set();
    let closeTimer = null;

    const phase = computed(() => progress.value.phase || progress.value.status || 'preparing');
    const terminal = computed(() => isTaskTerminal(phase.value));
    const action = computed(
        () => progress.value.action || progress.value.taskType || progress.value.kind || progress.value.type || 'yang'
    );
    const percent = computed(() => {
        if (Number.isFinite(Number(progress.value.percent))) {
            return Math.max(0, Math.min(100, Number(progress.value.percent)));
        }
        const total = Number(progress.value.total || 0);
        return total > 0 ? Math.round((Number(progress.value.completed || 0) / total) * 100) : 0;
    });
    const failedCount = computed(() =>
        Number(
            progress.value.counts?.failed ||
                progress.value.failed ||
                progress.value.errorCount ||
                progress.value.result?.failed?.length ||
                0
        )
    );
    const notificationStatus = computed(() => {
        if (phase.value === 'failed') return 'error';
        if (phase.value === 'cancelled') return 'warning';
        if (phase.value === 'completed') return failedCount.value > 0 ? 'warning' : 'success';
        return 'loading';
    });
    const showProgress = computed(() => !['failed', 'cancelled'].includes(phase.value));

    const actionName = computed(() => {
        const names = {
            discover: '模型发现',
            discovery: '模型发现',
            download: '模型下载',
            import: '模型导入',
            compile: 'YANG 编译',
            indexing: 'Schema 索引',
            yang: 'YANG 任务'
        };
        return names[action.value] || progress.value.title || 'YANG 任务';
    });
    const notificationTitle = computed(() => {
        if (phase.value === 'completed') return `${actionName.value}完成`;
        if (phase.value === 'failed') return `${actionName.value}失败`;
        if (phase.value === 'cancelled') return `${actionName.value}已取消`;
        const phaseNames = {
            preparing: '正在准备',
            discovering: '正在读取设备模型',
            scanning: '正在扫描文件',
            planning: '正在解析依赖关系',
            dependencies: '正在解析依赖关系',
            downloading: '正在下载模型',
            importing: '正在导入模型',
            parsing: '正在解析 YANG',
            schema: '正在构建 Effective Schema',
            compiling: '正在构建 Effective Schema',
            external: '正在执行外部编译器',
            indexing: '正在生成 Schema 索引',
            caching: '正在保存缓存'
        };
        return phaseNames[phase.value] || `正在执行${actionName.value}`;
    });
    const notificationDescription = computed(() => {
        if (phase.value === 'completed') {
            const counts = progress.value.counts || {};
            const succeeded =
                counts.compiled ?? counts.downloaded ?? counts.imported ?? counts.parsed ?? counts.success;
            const parts = [];
            if (succeeded !== undefined) parts.push(`成功 ${succeeded}`);
            if (failedCount.value) parts.push(`失败 ${failedCount.value}`);
            if (progress.value.cacheHit) parts.push('缓存命中');
            return (
                progress.value.message ||
                progress.value.error?.message ||
                parts.join('，') ||
                `${actionName.value}已完成`
            );
        }
        if (['failed', 'cancelled'].includes(phase.value)) {
            return (
                progress.value.message ||
                progress.value.error?.message ||
                (phase.value === 'failed' ? '任务执行过程中发生错误' : '任务已取消')
            );
        }
        const current = progress.value.currentFile || progress.value.filePath || progress.value.fileName;
        const count = Number(progress.value.total || 0)
            ? `${progress.value.completed || 0}/${progress.value.total}`
            : '';
        return [current || progress.value.message || '请稍候', count].filter(Boolean).join(' · ');
    });

    const clearCloseTimer = () => {
        if (closeTimer) {
            window.clearTimeout(closeTimer);
            closeTimer = null;
        }
    };

    const scheduleClose = () => {
        clearCloseTimer();
        closeTimer = window.setTimeout(
            () => {
                visible.value = false;
            },
            notificationStatus.value === 'error' ? 8000 : 5000
        );
    };

    const handleTaskProgress = payload => {
        if (payload?.status === 'error') return;
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        const taskId = getTaskId(data);
        if (!taskId || dismissedTaskIds.has(taskId)) return;

        const currentTaskId = getTaskId(progress.value);
        if (currentTaskId && currentTaskId !== taskId && !terminal.value) {
            const incomingPhase = data.phase || data.status;
            if (
                !['preparing', 'queued', 'discovering', 'downloading', 'importing', 'compiling'].includes(incomingPhase)
            ) {
                return;
            }
        }

        clearCloseTimer();
        progress.value = {
            ...progress.value,
            ...data,
            taskId,
            counts: data.counts || progress.value.counts || {}
        };
        visible.value = true;
        if (isTaskTerminal(data.phase || data.status)) scheduleClose();
    };

    const closeNotification = () => {
        const taskId = getTaskId(progress.value);
        if (taskId) dismissedTaskIds.add(taskId);
        visible.value = false;
        clearCloseTimer();
    };

    onMounted(() => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.TASK_NOTIFICATION, handleTaskProgress);
    });

    onBeforeUnmount(() => {
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.TASK_NOTIFICATION);
        clearCloseTimer();
        dismissedTaskIds.clear();
    });
</script>
