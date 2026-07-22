<template>
    <nn-modal
        v-model:open="isOpen"
        title="设置"
        :footer="null"
        class="modal-xlarge settings-dialog-modal"
        wrap-class-name="settings-dialog-wrap"
        :mask-closable="false"
        @cancel="onClose"
    >
        <div class="settings-layout">
            <!-- 左侧分类菜单 -->
            <div class="settings-sidebar">
                <nn-menu v-model:selected-keys="selectedCategory" mode="inline" class="settings-menu">
                    <nn-menu-item key="general">
                        <template #icon><component :is="settingsNavigationIcons.general" /></template>
                        <span>通用设置</span>
                    </nn-menu-item>
                    <nn-menu-item key="tools">
                        <template #icon><component :is="settingsNavigationIcons.tools" /></template>
                        <span>工具集合</span>
                    </nn-menu-item>
                    <nn-menu-item key="ftp">
                        <template #icon><component :is="settingsNavigationIcons.ftp" /></template>
                        <span>FTP服务器</span>
                    </nn-menu-item>
                    <nn-menu-item key="api">
                        <template #icon><component :is="settingsNavigationIcons.externalApi" /></template>
                        <span>外部API</span>
                    </nn-menu-item>
                    <nn-menu-item key="server-deployment">
                        <template #icon><component :is="settingsNavigationIcons.serverDeployment" /></template>
                        <span>服务器部署</span>
                    </nn-menu-item>
                    <nn-menu-item key="data-management">
                        <template #icon><component :is="settingsNavigationIcons.dataManagement" /></template>
                        <span>数据管理</span>
                    </nn-menu-item>
                    <nn-menu-item key="runtime">
                        <template #icon><component :is="settingsNavigationIcons.runtime" /></template>
                        <span>运行时诊断</span>
                    </nn-menu-item>
                    <nn-menu-item key="update">
                        <template #icon><component :is="settingsNavigationIcons.update" /></template>
                        <span>应用更新</span>
                    </nn-menu-item>
                </nn-menu>
            </div>

            <!-- 右侧设置内容区域 -->
            <div class="settings-content">
                <keep-alive>
                    <component :is="currentSettingComponent" />
                </keep-alive>
            </div>
        </div>
    </nn-modal>
</template>

<script setup>
    import { ref, computed, watch } from 'vue';
    import { settingsNavigationIcons } from '../ui/navigationIcons';

    import GeneralSettings from '../view/settings/GeneralSettings.vue';
    import ToolsSettings from '../view/settings/ToolsSettings.vue';
    import UpdateSettings from '../view/settings/UpdateSettings.vue';
    import FtpSettings from '../view/settings/FtpSettings.vue';
    import ServerDeployment from '../view/settings/ServerDeployment.vue';
    import ApiSettings from '../view/settings/ApiSettings.vue';
    import BmpDataSettings from '../view/settings/BmpDataSettings.vue';
    import RuntimeSettings from '../view/settings/RuntimeSettings.vue';

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:open', 'close']);

    // Use a local state instead of relying solely on the computed property
    const isOpen = ref(props.open);

    // Update isOpen when props.visible changes
    watch(
        () => props.open,
        newValue => {
            isOpen.value = newValue;
        }
    );

    // When isOpen changes, emit the update event
    watch(
        () => isOpen.value,
        newValue => {
            emit('update:open', newValue);
        }
    );

    const selectedCategory = ref(['general']);

    const currentSettingComponent = computed(() => {
        const category = selectedCategory.value[0];
        switch (category) {
            case 'general':
                return GeneralSettings;
            case 'tools':
                return ToolsSettings;
            case 'ftp':
                return FtpSettings;
            case 'api':
                return ApiSettings;
            case 'server-deployment':
                return ServerDeployment;
            case 'data-management':
                return BmpDataSettings;
            case 'runtime':
                return RuntimeSettings;
            case 'update':
                return UpdateSettings;
            default:
                return GeneralSettings;
        }
    });

    const onClose = () => {
        isOpen.value = false;
        emit('close');
    };

    const openDialog = (category = 'general') => {
        selectedCategory.value = [category];
        isOpen.value = true;
    };

    // 暴露方法给父组件
    defineExpose({
        openDialog
    });
</script>

<style scoped>
    :global(.settings-dialog-wrap) {
        overflow: hidden !important;
    }

    :global(.settings-dialog-modal) {
        max-height: calc(100vh - 32px) !important;
        padding-bottom: 0 !important;
    }

    :global(.settings-dialog-modal .nn-modal-content) {
        height: min(760px, calc(100vh - 32px)) !important;
        max-height: calc(100vh - 32px) !important;
    }

    :global(.settings-dialog-modal .nn-modal-body) {
        flex: 1 !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: hidden !important;
    }

    .settings-layout {
        display: flex;
        width: 100%;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .settings-sidebar {
        flex: 0 0 140px;
        min-height: 0;
        border-right: 1px solid var(--nn-color-border-light);
        overflow: auto;
    }

    .settings-menu {
        min-height: 100%;
        border-right: none;
        font-size: 13px;
    }

    .settings-menu :deep(.nn-menu-item) {
        font-size: 13px;
    }

    .settings-content {
        flex: 1;
        min-width: 0;
        min-height: 0;
        padding-left: 16px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font-size: 0.9rem;
    }

    .settings-content :deep(.general-settings),
    .settings-content :deep(.tools-settings),
    .settings-content :deep(.ftp-settings),
    .settings-content :deep(.api-settings),
    .settings-content :deep(.server-deployment-container),
    .settings-content :deep(.bmp-data-settings),
    .settings-content :deep(.runtime-settings),
    .settings-content :deep(.update-settings) {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .settings-content :deep(.settings-card) {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .settings-content :deep(.settings-card > .nn-card-body) {
        flex: 1 1 0;
        min-height: 0;
        overflow: auto;
    }
</style>
