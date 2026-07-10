<template>
    <!-- 更新通知浮层 -->
    <teleport to="body">
        <transition name="slide-up">
            <div v-if="showNotification" class="update-notification" @click="handleNotificationClick">
                <div class="notification-content">
                    <div class="notification-icon">
                        <loading-outlined v-if="isChecking" class="notification-icon-primary" spin />
                        <download-outlined v-else-if="isDownloading" class="notification-icon-success" />
                        <cloud-download-outlined v-else-if="updateAvailable" class="notification-icon-primary" />
                        <check-circle-outlined v-else-if="updateDownloaded" class="notification-icon-success" />
                        <exclamation-circle-outlined v-else-if="hasError" class="notification-icon-error" />
                    </div>
                    <div class="notification-text">
                        <div class="notification-title">{{ notificationTitle }}</div>
                        <div class="notification-description">{{ notificationDescription }}</div>
                        <div v-if="isDownloading && downloadProgress.percent" class="progress-bar">
                            <div class="progress-fill" :style="{ width: `${downloadProgress.percent}%` }" />
                        </div>
                    </div>
                    <div class="notification-actions">
                        <nn-button
                            v-if="updateAvailable && !isDownloading && !updateDownloaded"
                            type="primary"
                            size="small"
                            @click.stop="downloadUpdate"
                        >
                            下载
                        </nn-button>
                        <nn-button v-if="updateDownloaded" type="primary" size="small" @click.stop="installUpdate">
                            安装
                        </nn-button>
                        <nn-button size="small" @click.stop="closeNotification">关闭</nn-button>
                    </div>
                </div>
            </div>
        </transition>
    </teleport>
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
    } from '../ui/icons';

    import EventBus from '../utils/eventBus';
    import { TOOLS_EVENT_PAGE_ID } from '../const/toolsConst';

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
        if (isChecking.value) return '检查更新中...';
        if (isDownloading.value) return '下载更新中...';
        if (updateDownloaded.value) return '更新已下载完成';
        if (updateAvailable.value) return `发现新版本 ${updateInfo.value?.version || ''}`;
        if (hasError.value) return '更新失败';
        return '检查更新';
    });

    const notificationDescription = computed(() => {
        if (isChecking.value) return '正在检查是否有新版本可用';
        if (isDownloading.value) {
            const percent = Math.round(downloadProgress.value.percent || 0);
            return `下载进度: ${percent}%`;
        }
        if (updateDownloaded.value) return '点击安装按钮重启应用并安装更新';
        if (updateAvailable.value) return '点击下载按钮开始下载更新';
        if (hasError.value) return errorMessage.value || '更新过程中出现错误';
        return '';
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

<style scoped>
    .update-notification {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: var(--nn-color-bg-elevated);
        border-radius: 8px;
        box-shadow: var(--nn-shadow-floating);
        border: 1px solid var(--nn-color-border-light);
        max-width: 400px;
        min-width: 300px;
        z-index: 9999;
        cursor: pointer;
        transition: all 0.3s ease;
    }

    .update-notification:hover {
        box-shadow: var(--nn-shadow-floating-hover);
        transform: translateY(-2px);
    }

    .notification-content {
        padding: 16px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
    }

    .notification-icon {
        font-size: 20px;
        color: var(--nn-color-primary);
        margin-top: 2px;
        flex-shrink: 0;
    }

    .notification-text {
        flex: 1;
        min-width: 0;
    }

    .notification-title {
        font-weight: 500;
        font-size: 14px;
        color: var(--nn-color-text);
        margin-bottom: 4px;
    }

    .notification-description {
        font-size: 12px;
        color: var(--nn-color-text-muted);
        line-height: 1.4;
        margin-bottom: 8px;
    }

    .progress-bar {
        width: 100%;
        height: 4px;
        background: var(--nn-color-bg-progress);
        border-radius: 2px;
        overflow: hidden;
        margin-top: 8px;
    }

    .progress-fill {
        height: 100%;
        background: var(--nn-gradient-progress);
        border-radius: 2px;
        transition: width 0.3s ease;
    }

    .notification-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
    }

    .notification-actions .nn-button {
        font-size: 12px;
        height: 24px;
        padding: 0 8px;
    }

    /* 动画效果 */
    .slide-up-enter-active,
    .slide-up-leave-active {
        transition: all 0.3s ease;
    }

    .slide-up-enter-from {
        transform: translateY(100%);
        opacity: 0;
    }

    .slide-up-leave-to {
        transform: translateY(100%);
        opacity: 0;
    }

    /* 响应式设计 */
    @media (max-width: 480px) {
        .update-notification {
            left: 20px;
            right: 20px;
            max-width: none;
            min-width: 0;
        }
    }

    /* 状态特定样式 */
    .notification-icon :deep(.notification-icon-primary) {
        color: var(--nn-color-primary);
    }

    .notification-icon :deep(.notification-icon-success) {
        color: var(--nn-color-success);
    }

    .notification-icon :deep(.notification-icon-error) {
        color: var(--nn-color-error);
    }
</style>
