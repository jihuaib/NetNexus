<template>
    <div class="tools-settings">
        <a-card title="Tools设置" class="settings-card">
            <a-form :model="settingsForm" layout="vertical">
                <a-divider>字符串生成</a-divider>
                <a-form-item label="字符串生成历史记录最大存储条数" name="maxStringHistory">
                    <a-input-number
                        v-model:value="settingsForm.stringGenerator.maxStringHistory"
                        :min="10"
                        :max="1000"
                        style="width: 100%"
                    />
                </a-form-item>

                <a-divider>报文解析</a-divider>
                <a-form-item label="报文解析历史记录最大存储条数" name="maxMessageHistory">
                    <a-input-number
                        v-model:value="settingsForm.packetParser.maxMessageHistory"
                        :min="10"
                        :max="1000"
                        style="width: 100%"
                    />
                </a-form-item>

                <a-divider>Wireshark</a-divider>
                <div class="wireshark-plugin-panel">
                    <a-descriptions size="small" :column="1" bordered>
                        <a-descriptions-item label="BMP draft-20 Lua插件">
                            <a-space wrap>
                                <a-tag :color="wiresharkPluginTag.color">{{ wiresharkPluginTag.text }}</a-tag>
                                <span class="plugin-path">{{ wiresharkPluginStatus.installedPath || '-' }}</span>
                            </a-space>
                        </a-descriptions-item>
                        <a-descriptions-item label="TShark">
                            <span class="plugin-path">
                                {{ wiresharkPluginStatus.tsharkPath || '未检测到，使用默认插件目录' }}
                            </span>
                        </a-descriptions-item>
                    </a-descriptions>
                    <a-space wrap class="plugin-actions">
                        <a-button type="primary" :loading="wiresharkPluginLoading" @click="installWiresharkBmpPlugin">
                            安装/更新插件
                        </a-button>
                        <a-button
                            danger
                            :loading="wiresharkPluginUninstalling"
                            :disabled="!wiresharkPluginStatus.installed"
                            @click="uninstallWiresharkBmpPlugin"
                        >
                            卸载插件
                        </a-button>
                        <a-button :loading="wiresharkPluginOpening" @click="openWiresharkPluginDirectory">
                            打开插件目录
                        </a-button>
                        <a-button :loading="wiresharkPluginRefreshing" @click="refreshWiresharkBmpPluginStatus">
                            刷新状态
                        </a-button>
                    </a-space>
                </div>
                <a-form-item>
                    <a-button type="primary" @click="saveSettings">保存设置</a-button>
                </a-form-item>
            </a-form>
        </a-card>
    </div>
</template>

<script setup>
    import { computed, ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_TOOLS_SETTINGS } from '../../const/toolsConst';

    // 工具设置组件
    const settingsForm = ref({
        packetParser: {
            maxMessageHistory: DEFAULT_TOOLS_SETTINGS.packetParser.maxMessageHistory
        },
        stringGenerator: {
            maxStringHistory: DEFAULT_TOOLS_SETTINGS.stringGenerator.maxStringHistory
        }
    });
    const wiresharkPluginStatus = ref({});
    const wiresharkPluginLoading = ref(false);
    const wiresharkPluginUninstalling = ref(false);
    const wiresharkPluginOpening = ref(false);
    const wiresharkPluginRefreshing = ref(false);

    const wiresharkPluginTag = computed(() => {
        const status = wiresharkPluginStatus.value || {};
        if (!Object.keys(status).length) {
            return {
                color: 'default',
                text: '检测中'
            };
        }
        if (!status.sourceExists) {
            return {
                color: 'red',
                text: '资源缺失'
            };
        }
        if (status.upToDate) {
            return {
                color: 'green',
                text: '已安装'
            };
        }
        if (status.installed) {
            return {
                color: 'orange',
                text: '需更新'
            };
        }
        return {
            color: 'default',
            text: '未安装'
        };
    });

    // 获取设置
    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getToolsSettings();
            if (settings.status === 'success' && settings.data) {
                if (settings.data.packetParser) {
                    settingsForm.value.packetParser = settings.data.packetParser;
                }
                if (settings.data.stringGenerator) {
                    settingsForm.value.stringGenerator = settings.data.stringGenerator;
                }
            }
        } catch (error) {
            console.error('获取工具设置失败', error);
        }
    };

    // 保存设置
    const saveSettings = async () => {
        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            await window.commonApi.saveToolsSettings(payload);
            message.success('设置已保存');
        } catch (error) {
            console.error('保存设置失败', error);
            message.error('保存设置失败');
        }
    };

    const refreshWiresharkBmpPluginStatus = async () => {
        wiresharkPluginRefreshing.value = true;
        try {
            const resp = await window.commonApi.getWiresharkBmpPluginStatus();
            if (resp.status === 'success') {
                wiresharkPluginStatus.value = resp.data || {};
            } else {
                message.error(resp.msg || '获取Wireshark插件状态失败');
            }
        } catch (error) {
            console.error('获取Wireshark插件状态失败', error);
            message.error('获取Wireshark插件状态失败');
        } finally {
            wiresharkPluginRefreshing.value = false;
        }
    };

    const installWiresharkBmpPlugin = async () => {
        wiresharkPluginLoading.value = true;
        try {
            const resp = await window.commonApi.installWiresharkBmpPlugin();
            if (resp.status === 'success') {
                wiresharkPluginStatus.value = resp.data || {};
                message.success('插件已安装，重启Wireshark后生效');
            } else {
                message.error(resp.msg || '安装Wireshark插件失败');
            }
        } catch (error) {
            console.error('安装Wireshark插件失败', error);
            message.error('安装Wireshark插件失败');
        } finally {
            wiresharkPluginLoading.value = false;
        }
    };

    const openWiresharkPluginDirectory = async () => {
        wiresharkPluginOpening.value = true;
        try {
            const resp = await window.commonApi.openWiresharkPluginDirectory();
            if (resp.status === 'success') {
                wiresharkPluginStatus.value = resp.data || {};
            } else {
                message.error(resp.msg || '打开Wireshark插件目录失败');
            }
        } catch (error) {
            console.error('打开Wireshark插件目录失败', error);
            message.error('打开Wireshark插件目录失败');
        } finally {
            wiresharkPluginOpening.value = false;
        }
    };

    const uninstallWiresharkBmpPlugin = async () => {
        wiresharkPluginUninstalling.value = true;
        try {
            const resp = await window.commonApi.uninstallWiresharkBmpPlugin();
            if (resp.status === 'success') {
                wiresharkPluginStatus.value = resp.data || {};
                message.success('插件已卸载，重启Wireshark后生效');
            } else {
                message.error(resp.msg || '卸载Wireshark插件失败');
            }
        } catch (error) {
            console.error('卸载Wireshark插件失败', error);
            message.error('卸载Wireshark插件失败');
        } finally {
            wiresharkPluginUninstalling.value = false;
        }
    };

    onMounted(() => {
        getSettings();
        refreshWiresharkBmpPluginStatus();
    });
</script>

<style scoped>
    .tools-settings {
        max-width: 100%;
    }

    :deep(.ant-form-item-label > label) {
        font-size: 12px;
    }

    .wireshark-plugin-panel {
        margin-bottom: 24px;
    }

    .plugin-actions {
        margin-top: 12px;
    }

    .plugin-path {
        max-width: 720px;
        word-break: break-all;
        color: #606266;
        font-size: 12px;
    }
</style>
