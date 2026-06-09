<template>
    <a-modal
        v-model:open="isOpen"
        title="设置"
        :footer="null"
        class="modal-xlarge"
        :mask-closable="false"
        @cancel="onClose"
    >
        <div class="settings-layout">
            <!-- 左侧分类菜单 -->
            <div class="settings-sidebar">
                <a-menu v-model:selected-keys="selectedCategory" mode="inline" class="settings-menu">
                    <a-menu-item key="general">
                        <template #icon><SettingOutlined /></template>
                        <span>通用设置</span>
                    </a-menu-item>
                    <a-menu-item key="tools">
                        <template #icon><CodeOutlined /></template>
                        <span>工具集合</span>
                    </a-menu-item>
                    <a-menu-item key="ftp">
                        <template #icon><DownloadOutlined /></template>
                        <span>FTP服务器</span>
                    </a-menu-item>
                    <a-menu-item key="server-deployment">
                        <template #icon><CloudServerOutlined /></template>
                        <span>服务器部署</span>
                    </a-menu-item>
                    <a-menu-item key="update">
                        <template #icon><CloudDownloadOutlined /></template>
                        <span>应用更新</span>
                    </a-menu-item>
                </a-menu>
            </div>

            <!-- 右侧设置内容区域 -->
            <div class="settings-content">
                <keep-alive>
                    <component :is="currentSettingComponent" />
                </keep-alive>
            </div>
        </div>
    </a-modal>
</template>

<script setup>
    import { ref, computed, watch } from 'vue';
    import {
        SettingOutlined,
        CodeOutlined,
        CloudDownloadOutlined,
        DownloadOutlined,
        CloudServerOutlined
    } from '@ant-design/icons-vue';
    import GeneralSettings from '../view/settings/GeneralSettings.vue';
    import ToolsSettings from '../view/settings/ToolsSettings.vue';
    import UpdateSettings from '../view/settings/UpdateSettings.vue';
    import FtpSettings from '../view/settings/FtpSettings.vue';
    import ServerDeployment from '../view/settings/ServerDeployment.vue';

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
            case 'server-deployment':
                return ServerDeployment;
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
    .settings-layout {
        display: flex;
        height: 450px;
        overflow: hidden;
    }

    .settings-sidebar {
        width: 140px;
        border-right: 1px solid #f0f0f0;
        height: 100%;
    }

    .settings-menu {
        height: 100%;
        border-right: none;
        font-size: 13px;
    }

    .settings-menu :deep(.ant-menu-item) {
        font-size: 13px;
    }

    .settings-content {
        flex: 1;
        padding-left: 16px;
        overflow: auto;
        font-size: 0.9rem;
    }
</style>
