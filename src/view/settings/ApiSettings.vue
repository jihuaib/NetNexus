<template>
    <div class="api-settings">
        <nn-card title="外部接入" class="settings-card">
            <nn-form :model="settingsForm" layout="vertical">
                <nn-form-item label="接入方式" name="mode">
                    <nn-radio-group v-model:value="settingsForm.mode" button-style="solid">
                        <nn-radio-button :value="API_ACCESS_MODE.NONE">关闭</nn-radio-button>
                        <nn-radio-button :value="API_ACCESS_MODE.HTTP">HTTP API</nn-radio-button>
                        <nn-radio-button :value="API_ACCESS_MODE.CLI">Telnet CLI</nn-radio-button>
                    </nn-radio-group>
                </nn-form-item>

                <template v-if="settingsForm.mode === API_ACCESS_MODE.HTTP">
                    <nn-form-item label="HTTP监听端口" name="port">
                        <nn-input-number v-model:value="settingsForm.port" :min="1" :max="65535" style="width: 100%" />
                    </nn-form-item>

                    <nn-form-item label="分页最大条数" name="maxPageSize">
                        <nn-input-number
                            v-model:value="settingsForm.maxPageSize"
                            :min="1"
                            :max="10000"
                            style="width: 100%"
                        />
                    </nn-form-item>
                </template>

                <template v-if="settingsForm.mode === API_ACCESS_MODE.CLI">
                    <nn-form-item label="Telnet监听端口" name="cliPort">
                        <nn-input-number
                            v-model:value="settingsForm.cliPort"
                            :min="1"
                            :max="65535"
                            :disabled="true"
                            style="width: 100%"
                        />
                    </nn-form-item>

                    <nn-form-item label="最大会话数" name="cliMaxSessions">
                        <nn-input-number
                            v-model:value="settingsForm.cliMaxSessions"
                            :min="1"
                            :max="100"
                            style="width: 100%"
                        />
                    </nn-form-item>
                </template>

                <nn-form-item label="运行状态">
                    <nn-space direction="vertical" size="small">
                        <nn-space>
                            <nn-tag :color="apiStatus.running ? 'green' : 'default'">
                                {{ apiStatus.running ? '运行中' : '未运行' }}
                            </nn-tag>
                            <span v-if="apiStatus.running">{{ modeLabel(apiStatus.mode) }}</span>
                        </nn-space>
                        <nn-space wrap>
                            <nn-tag :color="apiStatus.http.running ? 'green' : 'default'">HTTP API</nn-tag>
                            <span>{{ apiStatus.http.host }}:{{ apiStatus.http.port }}</span>
                        </nn-space>
                        <nn-space wrap>
                            <nn-tag :color="apiStatus.cli.running ? 'green' : 'default'">Telnet CLI</nn-tag>
                            <span>{{ apiStatus.cli.host }}:{{ apiStatus.cli.port }}</span>
                        </nn-space>
                    </nn-space>
                </nn-form-item>

                <nn-form-item>
                    <nn-space>
                        <nn-button type="primary" @click="saveSettings">保存并应用</nn-button>
                        <nn-button @click="refreshStatus">刷新状态</nn-button>
                    </nn-space>
                </nn-form-item>
            </nn-form>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
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

    :deep(.nn-form-item-label > label) {
        font-size: 12px;
    }
</style>
