<template>
    <nn-settings class="api-settings">
        <nn-settings-section title="接入配置" description="选择本机对外提供的访问方式及其运行参数。">
            <nn-settings-item title="服务模式" align="center" actions-width="min(360px, 100%)">
                <template #actions>
                    <nn-radio-group v-model:value="settingsForm.mode" button-style="solid" aria-label="接入方式">
                        <nn-radio-button :value="API_ACCESS_MODE.NONE">关闭</nn-radio-button>
                        <nn-radio-button :value="API_ACCESS_MODE.HTTP">HTTP API</nn-radio-button>
                        <nn-radio-button :value="API_ACCESS_MODE.CLI">Telnet CLI</nn-radio-button>
                    </nn-radio-group>
                </template>
            </nn-settings-item>

            <template v-if="settingsForm.mode === API_ACCESS_MODE.HTTP">
                <nn-settings-item
                    title="HTTP监听端口"
                    label-for="api-http-port"
                    align="center"
                    :actions-width="180"
                    class="api-setting-pair-start"
                >
                    <template #actions>
                        <nn-input-number
                            id="api-http-port"
                            v-model:value="settingsForm.port"
                            :min="1"
                            :max="65535"
                            style="width: 100%"
                        />
                    </template>
                </nn-settings-item>

                <nn-settings-item
                    title="分页最大条数"
                    label-for="api-max-page-size"
                    align="center"
                    :actions-width="180"
                >
                    <template #actions>
                        <nn-input-number
                            id="api-max-page-size"
                            v-model:value="settingsForm.maxPageSize"
                            :min="1"
                            :max="10000"
                            style="width: 100%"
                        />
                    </template>
                </nn-settings-item>
            </template>

            <template v-if="settingsForm.mode === API_ACCESS_MODE.CLI">
                <nn-settings-item
                    title="Telnet监听端口"
                    label-for="api-cli-port"
                    align="center"
                    :actions-width="180"
                    class="api-setting-pair-start"
                >
                    <template #actions>
                        <nn-input-number
                            id="api-cli-port"
                            v-model:value="settingsForm.cliPort"
                            :min="1"
                            :max="65535"
                            :disabled="true"
                            style="width: 100%"
                        />
                    </template>
                </nn-settings-item>

                <nn-settings-item
                    title="最大会话数"
                    label-for="api-cli-max-sessions"
                    align="center"
                    :actions-width="180"
                >
                    <template #actions>
                        <nn-input-number
                            id="api-cli-max-sessions"
                            v-model:value="settingsForm.cliMaxSessions"
                            :min="1"
                            :max="100"
                            style="width: 100%"
                        />
                    </template>
                </nn-settings-item>
            </template>
        </nn-settings-section>

        <nn-settings-section title="运行状态" description="查看当前 HTTP API 与 Telnet CLI 的监听状态。">
            <div class="api-status-panel">
                <nn-alert
                    :type="apiStatus.running ? 'success' : 'info'"
                    :message="apiStatusMessage"
                    :description="apiStatusDescription"
                    show-icon
                    variant="subtle"
                    class="api-status-summary"
                />

                <nn-descriptions :column="1" bordered size="small" class="api-status-details">
                    <nn-descriptions-item label="HTTP API">
                        <div class="api-endpoint-state">
                            <span class="api-endpoint-address">
                                {{ apiStatus.http.host }}:{{ apiStatus.http.port }}
                            </span>
                            <nn-tag :color="apiStatus.http.running ? 'green' : 'default'">
                                {{ apiStatus.http.running ? '运行中' : '未运行' }}
                            </nn-tag>
                        </div>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Telnet CLI">
                        <div class="api-endpoint-state">
                            <span class="api-endpoint-address">{{ apiStatus.cli.host }}:{{ apiStatus.cli.port }}</span>
                            <nn-tag :color="apiStatus.cli.running ? 'green' : 'default'">
                                {{ apiStatus.cli.running ? '运行中' : '未运行' }}
                            </nn-tag>
                        </div>
                    </nn-descriptions-item>
                </nn-descriptions>
            </div>
        </nn-settings-section>

        <div class="settings-page-actions">
            <nn-space wrap>
                <nn-button type="primary" @click="saveSettings">保存并应用</nn-button>
                <nn-button @click="refreshStatus">刷新状态</nn-button>
            </nn-space>
        </div>
    </nn-settings>
</template>

<script setup>
    import { computed, ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { API_ACCESS_MODE, DEFAULT_API_SETTINGS } from '../../const/apiConst';

    const settingsForm = ref({
        ...DEFAULT_API_SETTINGS
    });

    const apiStatus = ref({
        running: false,
        mode: API_ACCESS_MODE.NONE,
        http: {
            running: false,
            enabled: false,
            host: DEFAULT_API_SETTINGS.host,
            port: DEFAULT_API_SETTINGS.port
        },
        cli: {
            running: false,
            enabled: false,
            loaded: false,
            host: DEFAULT_API_SETTINGS.cliHost,
            port: DEFAULT_API_SETTINGS.cliPort,
            maxSessions: DEFAULT_API_SETTINGS.cliMaxSessions,
            sessions: 0
        }
    });

    const validateSettings = () => {
        const port = Number(settingsForm.value.port);
        const maxPageSize = Number(settingsForm.value.maxPageSize);
        const cliPort = Number(settingsForm.value.cliPort);
        const cliMaxSessions = Number(settingsForm.value.cliMaxSessions);

        if (settingsForm.value.mode === API_ACCESS_MODE.HTTP) {
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                notify.error('HTTP监听端口必须是1到65535之间的整数');
                return false;
            }
            if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 10000) {
                notify.error('分页最大条数必须是1到10000之间的整数');
                return false;
            }
        }
        if (settingsForm.value.mode === API_ACCESS_MODE.CLI) {
            if (!Number.isInteger(cliPort) || cliPort < 1 || cliPort > 65535) {
                notify.error('CLI监听端口必须是1到65535之间的整数');
                return false;
            }
            if (!Number.isInteger(cliMaxSessions) || cliMaxSessions < 1 || cliMaxSessions > 100) {
                notify.error('CLI最大会话数必须是1到100之间的整数');
                return false;
            }
        }
        return true;
    };

    const modeLabel = mode => {
        if (mode === API_ACCESS_MODE.HTTP) {
            return 'HTTP API';
        }
        if (mode === API_ACCESS_MODE.CLI) {
            return 'Telnet CLI';
        }
        return '关闭';
    };

    const apiStatusMessage = computed(() => {
        if (!apiStatus.value.running) {
            return '外部接入服务未运行';
        }

        if (apiStatus.value.mode === API_ACCESS_MODE.NONE) {
            return '外部接入服务正在运行';
        }

        return `${modeLabel(apiStatus.value.mode)} 正在运行`;
    });

    const apiStatusDescription = computed(() =>
        apiStatus.value.running ? '当前对外接入服务已启动。' : 'HTTP API 与 Telnet CLI 当前均未监听。'
    );

    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getApiSettings();
            if (settings.status === 'success' && settings.data) {
                settingsForm.value = {
                    ...DEFAULT_API_SETTINGS,
                    ...settings.data
                };
            }
        } catch (error) {
            console.error('获取API设置失败', error);
        }
    };

    const normalizeStatus = data => {
        const http = {
            running: false,
            enabled: false,
            host: DEFAULT_API_SETTINGS.host,
            port: DEFAULT_API_SETTINGS.port,
            ...(data.http || {})
        };
        const cli = {
            running: false,
            enabled: false,
            loaded: false,
            host: DEFAULT_API_SETTINGS.cliHost,
            port: DEFAULT_API_SETTINGS.cliPort,
            maxSessions: DEFAULT_API_SETTINGS.cliMaxSessions,
            sessions: 0,
            ...(data.cli || {})
        };
        let mode = data.mode || API_ACCESS_MODE.NONE;
        if (http.running) {
            mode = API_ACCESS_MODE.HTTP;
        } else if (cli.running) {
            mode = API_ACCESS_MODE.CLI;
        }
        return {
            running: Boolean(data.running || http.running || cli.running),
            mode,
            http,
            cli
        };
    };

    const refreshStatus = async () => {
        try {
            const result = await window.commonApi.getApiServerStatus();
            if (result.status === 'success' && result.data) {
                apiStatus.value = normalizeStatus(result.data);
            }
        } catch (error) {
            console.error('获取接入运行状态失败', error);
        }
    };

    const saveSettings = async () => {
        if (!validateSettings()) {
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            payload.enabled = payload.mode !== API_ACCESS_MODE.NONE;
            payload.host = DEFAULT_API_SETTINGS.host;
            payload.cliHost = DEFAULT_API_SETTINGS.cliHost;
            const result = await window.commonApi.saveApiSettings(payload);
            if (result.status === 'success') {
                notify.success('设置已保存');
                await refreshStatus();
            } else {
                notify.error(result.msg || '保存设置失败');
            }
        } catch (error) {
            console.error('保存API设置失败', error);
            notify.error('保存设置失败');
        }
    };

    onMounted(async () => {
        await getSettings();
        await refreshStatus();
    });
</script>

<style scoped>
    .api-settings {
        max-width: 100%;
    }

    .api-status-panel {
        display: grid;
        gap: 12px;
        min-width: 0;
    }

    .api-settings :deep(.api-setting-pair-start) {
        min-height: 0;
        padding-bottom: 4px;
        border-bottom: 0;
    }

    .api-settings :deep(.api-setting-pair-start + .nn-settings-item) {
        min-height: 0;
        padding-top: 4px;
    }

    .api-status-details {
        min-width: 0;
    }

    .api-endpoint-state {
        display: flex;
        gap: 8px 16px;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
    }

    .api-endpoint-address {
        min-width: 0;
        color: var(--nn-color-text-strong);
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
    }
</style>
