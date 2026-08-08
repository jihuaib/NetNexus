<template>
    <FloatingProgressNotification
        root-class="update-notification"
        :visible="showNotification"
        :title="notificationTitle"
        :description="notificationDescription"
        :percent="downloadProgress.percent || 0"
        :show-progress="isDownloading"
        :status="notificationStatus"
        @click="handleNotificationClick"
        @close="closeNotification"
    >
        <template #icon>
            <exclamation-circle-outlined v-if="hasError" class="notification-icon-error" />
            <loading-outlined v-else-if="isChecking" class="notification-icon-primary" spin />
            <download-outlined v-else-if="isDownloading" class="notification-icon-success" />
            <cloud-download-outlined v-else-if="updateAvailable" class="notification-icon-primary" />
            <check-circle-outlined v-else-if="updateDownloaded" class="notification-icon-success" />
        </template>
        <template #actions>
            <nn-button
                v-if="updateAvailable && !isDownloading && !updateDownloaded"
                type="primary"
                size="small"
                @click="downloadUpdate"
            >
                下载
            </nn-button>
            <nn-button v-if="updateDownloaded" type="primary" size="small" @click="installUpdate">安装</nn-button>
        </template>
    </FloatingProgressNotification>
</template>

<script setup>
    import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
    import { notify } from '../utils/notify';
    import {
        CheckCircleOutlined,
        CloudDownloadOutlined,
        DownloadOutlined,
        ExclamationCircleOutlined,
        LoadingOutlined
    } from 'netnexus-ui/icons';

    import EventBus from '../utils/eventBus';
    import { TOOLS_EVENT_PAGE_ID } from '../const/toolsConst';
    import FloatingProgressNotification from './FloatingProgressNotification.vue';

    defineOptions({
        name: 'UpdateNotification'
    });

    // 响应式数据
    const showNotification = ref(false);
    const updateInfo = ref(null);
    const updateAvailable = ref(false);
    const updateDownloaded = ref(false);
    const isChecking = ref(false);
    const isDownloading = ref(false);
    const downloadProgress = ref({});
    const hasError = ref(false);
    const errorMessage = ref('');

    // 计算属性
    const notificationTitle = computed(() => {
        if (hasError.value) return '更新失败';
        if (isChecking.value) return '检查更新中...';
        if (isDownloading.value) return '下载更新中...';
        if (updateDownloaded.value) return '更新已下载完成';
        if (updateAvailable.value) return `发现新版本 ${updateInfo.value?.version || ''}`;
        return '检查更新';
    });

    const notificationDescription = computed(() => {
        if (hasError.value) return errorMessage.value || '更新过程中出现错误';
        if (isChecking.value) return '正在检查是否有新版本可用';
        if (isDownloading.value) {
            const percent = Math.round(downloadProgress.value.percent || 0);
            return `下载进度: ${percent}%`;
        }
        if (updateDownloaded.value) return '点击安装按钮重启应用并安装更新';
        if (updateAvailable.value) return '点击下载按钮开始下载更新';
        return '';
    });
    const notificationStatus = computed(() => {
        if (hasError.value) return 'error';
        if (updateDownloaded.value) return 'success';
        return isDownloading.value || isChecking.value ? 'loading' : 'info';
    });

    // 处理更新状态
    const handleUpdateStatus = respData => {
        if (respData.status !== 'success') {
            notify.error('检查更新失败');
            return;
        }
        const { type, data } = respData.data;

        switch (type) {
            case 'checking-for-update':
                isChecking.value = true;
                hasError.value = false;
                showNotification.value = false;
                break;
            case 'update-available':
                isChecking.value = false;
                updateAvailable.value = true;
                updateInfo.value = data;
                showNotification.value = true;
                break;
            case 'update-not-available':
                isChecking.value = false;
                updateAvailable.value = false;
                // 如果没有可用更新，3秒后自动隐藏通知
                setTimeout(() => {
                    showNotification.value = false;
                }, 3000);
                break;
            case 'download-started':
                isDownloading.value = true;
                showNotification.value = true;
                break;
            case 'download-progress':
                downloadProgress.value = data;
                break;
            case 'update-downloaded':
                isDownloading.value = false;
                updateDownloaded.value = true;
                showNotification.value = true;
                break;
            case 'update-error':
                isChecking.value = false;
                isDownloading.value = false;
                hasError.value = true;
                errorMessage.value = data.error || '更新过程中发生错误';
                showNotification.value = true;
                break;
        }
    };

    // 下载更新
    const downloadUpdate = async () => {
        if (!window.updaterApi) {
            notify.warning('更新功能仅在生产环境中可用');
            return;
        }

        try {
            await window.updaterApi.downloadUpdate();
        } catch (error) {
            console.error('下载更新失败:', error);
            notify.error('下载更新失败');
        }
    };

    // 安装更新
    const installUpdate = async () => {
        if (!window.updaterApi) {
            notify.warning('更新功能仅在生产环境中可用');
            return;
        }

        try {
            await window.updaterApi.quitAndInstall();
        } catch (error) {
            console.error('安装更新失败:', error);
            notify.error('安装更新失败');
        }
    };

    // 点击通知
    const handleNotificationClick = () => {
        // 点击通知可以导航到更新设置页面
        // 这里可以使用 router 进行导航
    };

    // 关闭通知
    const closeNotification = () => {
        showNotification.value = false;
    };

    onMounted(() => {
        EventBus.on('updater:update-status', TOOLS_EVENT_PAGE_ID.PAGE_ID_TOOLS_UPDATE_NOTIFICATION, handleUpdateStatus);
    });

    onBeforeUnmount(() => {
        EventBus.off('updater:update-status', TOOLS_EVENT_PAGE_ID.PAGE_ID_TOOLS_UPDATE_NOTIFICATION);
    });
</script>
