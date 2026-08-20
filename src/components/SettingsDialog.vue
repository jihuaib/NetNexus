<template>
    <nn-navigation-modal
        v-model:open="isOpen"
        v-model:active-key="activeKey"
        class="settings-dialog-modal"
        title="设置"
        :items="settingsNavigationItems"
        width="min(1400px, 80vw)"
        height="min(760px, calc(100vh - 32px))"
        @cancel="onClose"
    >
        <keep-alive>
            <component :is="currentSettingComponent" ref="currentSettingRef" />
        </keep-alive>
    </nn-navigation-modal>
</template>

<script setup>
    import { ref, computed, nextTick, watch } from 'vue';
    import { moduleNavigationIcons, settingsNavigationIcons } from '../const/navigationIcons';

    import GeneralSettings from '../view/settings/GeneralSettings.vue';
    import ToolsSettings from '../view/settings/ToolsSettings.vue';
    import UpdateSettings from '../view/settings/UpdateSettings.vue';
    import FtpSettings from '../view/settings/FtpSettings.vue';
    import ApiSettings from '../view/settings/ApiSettings.vue';
    import BmpDataSettings from '../view/settings/BmpDataSettings.vue';
    import RuntimeSettings from '../view/settings/RuntimeSettings.vue';
    import TcpAoSettings from '../view/settings/TcpAoSettings.vue';
    import TcpMd5Settings from '../view/settings/TcpMd5Settings.vue';

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:open', 'close']);

    // Use a local state instead of relying solely on the computed property
    const isOpen = ref(props.open);

    // Update isOpen when props.open changes
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
            if (!newValue) {
                currentSettingRef.value?.wipePlaintextKeys?.();
                currentSettingRef.value?.pauseBackgroundWork?.();
            } else {
                nextTick(() => currentSettingRef.value?.resumeBackgroundWork?.());
            }
            emit('update:open', newValue);
        }
    );

    const settingsNavigationItems = Object.freeze([
        {
            key: 'general',
            label: '通用',
            description: '界面主题与运行日志',
            icon: settingsNavigationIcons.general
        },
        {
            key: 'tools',
            label: '工具',
            description: '历史记录与 Wireshark 插件',
            icon: settingsNavigationIcons.tools
        },
        {
            key: 'ftp',
            label: 'FTP',
            description: 'FTP 用户记录存储',
            icon: settingsNavigationIcons.ftp
        },
        {
            key: 'api',
            label: 'API',
            description: 'HTTP API 与 Telnet CLI',
            icon: settingsNavigationIcons.externalApi
        },
        {
            key: 'data-management',
            label: '数据',
            description: 'BMP SQLite 数据库维护',
            icon: settingsNavigationIcons.dataManagement
        },
        {
            key: 'runtime',
            label: '运行时',
            description: 'YANG 编译器运行状态',
            icon: settingsNavigationIcons.runtime
        },
        {
            key: 'tcp-ao',
            label: 'TCP-AO',
            description: 'BMP/RPKI TCP-AO 密钥与轮换 Profile',
            icon: moduleNavigationIcons.rpki
        },
        {
            key: 'tcp-md5',
            label: 'TCP MD5',
            description: 'BMP 与 RPKI TCP MD5 对端与密钥 Profile',
            icon: moduleNavigationIcons.rpki
        },
        {
            key: 'update',
            label: '更新',
            description: '版本检查、下载与安装',
            icon: settingsNavigationIcons.update
        }
    ]);

    const settingComponents = Object.freeze({
        general: GeneralSettings,
        tools: ToolsSettings,
        ftp: FtpSettings,
        api: ApiSettings,
        'data-management': BmpDataSettings,
        runtime: RuntimeSettings,
        'tcp-ao': TcpAoSettings,
        'tcp-md5': TcpMd5Settings,
        update: UpdateSettings
    });

    const activeKey = ref('general');
    const currentSettingRef = ref(null);

    const currentSettingComponent = computed(() => settingComponents[activeKey.value] || GeneralSettings);

    const wipeCurrentPlaintext = () => {
        currentSettingRef.value?.wipePlaintextKeys?.();
    };

    const onClose = () => {
        wipeCurrentPlaintext();
        isOpen.value = false;
        emit('close');
    };

    const openDialog = (category = 'general') => {
        activeKey.value = category;
        isOpen.value = true;
    };

    // 暴露方法给父组件
    defineExpose({
        openDialog
    });
</script>

<style scoped>
    :global(.settings-dialog-modal .nn-navigation-modal-rail) {
        width: 160px;
        flex-basis: 160px;
    }

    @media (max-width: 680px) {
        :global(.settings-dialog-modal .nn-navigation-modal-rail) {
            width: 100%;
            flex-basis: auto;
        }
    }
</style>
