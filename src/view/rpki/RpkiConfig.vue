<template>
    <div class="nn-container adaptive-list-page" data-testid="rpki-config-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="RPKI服务器配置">
                    <nn-alert
                        v-if="runtimeFailureMessage"
                        type="error"
                        message="RPKI服务已安全停止"
                        :description="runtimeFailureMessage"
                        show-icon
                        variant="subtle"
                        data-testid="rpki-runtime-failure"
                        class="rpki-runtime-alert"
                    />
                    <nn-form :model="rpkiConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startRpki">
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="服务端端口" name="port">
                                    <nn-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <nn-input
                                            v-model:value="rpkiConfig.port"
                                            data-testid="rpki-port-input"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="最高协议版本" name="maxProtocolVersion">
                                    <nn-radio-group v-model:value="rpkiConfig.maxProtocolVersion">
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V2">v2 - 支持 ASPA</nn-radio>
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V1">v1 - 支持 Router Key</nn-radio>
                                        <nn-radio :value="RPKI_PROTOCOL_VERSION.V0">v0 - 仅基础 ROA</nn-radio>
                                    </nn-radio-group>
                                    <div class="nn-helper-text">
                                        用于模拟不同能力的 RPKI-RTR cache。客户端请求高于该版本时，服务端返回
                                        Unsupported Protocol Version 并断开连接，客户端应按错误 PDU 版本重试。
                                    </div>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="ASPA编码格式" name="aspaFormat">
                                    <nn-radio-group
                                        v-model:value="rpkiConfig.aspaFormat"
                                        :disabled="rpkiConfig.maxProtocolVersion < RPKI_PROTOCOL_VERSION.V2"
                                    >
                                        <nn-radio :value="RPKI_ASPA_FORMAT.LATEST">最新 (current 8210bis)</nn-radio>
                                        <nn-radio :value="RPKI_ASPA_FORMAT.LEGACY">兼容 (draft-10 / 华为 VRP)</nn-radio>
                                    </nn-radio-group>
                                    <div class="nn-helper-text">
                                        最新格式遵循当前 draft-ietf-sidrops-8210bis 规范；兼容格式按 draft-10 在 body
                                        中携带 Flags、AFI Flags 和 Provider AS Count，适用于华为 VRP
                                        等老旧设备。仅在协议 v2 协商成功时生效。
                                    </div>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="认证方式" name="authType">
                                    <nn-radio-group
                                        v-model:value="rpkiConfig.authType"
                                        aria-label="RPKI认证方式"
                                        data-testid="rpki-auth-type-group"
                                        @change="clearAuthenticationError"
                                    >
                                        <nn-radio value="none">无认证</nn-radio>
                                        <nn-radio value="tcp-ao">TCP-AO</nn-radio>
                                    </nn-radio-group>
                                    <div class="nn-helper-text">
                                        TCP-AO 仅在支持该能力的 Linux 内核上生效；密钥统一在“设置 → TCP-AO”中保存到本机。
                                    </div>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row v-if="rpkiConfig.authType === 'tcp-ao'">
                            <nn-col :span="24">
                                <nn-form-item label="TCP-AO Profile" name="tcpAoProfileId">
                                    <template v-if="configuredTcpAoProfiles.length > 0">
                                        <nn-tooltip
                                            :title="validationErrors.tcpAoProfileId"
                                            :open="!!validationErrors.tcpAoProfileId"
                                        >
                                            <nn-select
                                                v-model:value="rpkiConfig.tcpAoProfileId"
                                                aria-label="TCP-AO Profile"
                                                data-testid="rpki-tcp-ao-profile-select"
                                                :status="validationErrors.tcpAoProfileId ? 'error' : ''"
                                                placeholder="请选择已保存密钥的 Profile"
                                                style="width: min(520px, 100%)"
                                                @change="clearAuthenticationError"
                                            >
                                                <nn-select-option
                                                    v-for="profile in configuredTcpAoProfiles"
                                                    :key="profile.id"
                                                    :value="profile.id"
                                                >
                                                    {{ profile.name }} · {{ profile.peer }} ·
                                                    {{ profile.keys.length }} 把密钥
                                                </nn-select-option>
                                            </nn-select>
                                        </nn-tooltip>
                                        <div v-if="selectedTcpAoProfile" class="tcp-ao-profile-summary">
                                            <nn-tag color="green">当前可发送</nn-tag>
                                            <span>
                                                当前 Send ID {{ selectedTcpAoProfile.currentSendKey.sndId }} / Receive
                                                ID {{ selectedTcpAoProfile.currentSendKey.rcvId }}；共
                                                {{ selectedTcpAoProfile.keys.length }} 把轮换密钥
                                            </span>
                                        </div>
                                    </template>
                                    <nn-alert
                                        v-else
                                        type="warning"
                                        message="尚无可用的 TCP-AO Profile"
                                        description="请先在设置中添加 Profile 并保存密钥，然后返回此处选择。"
                                        show-icon
                                        variant="subtle"
                                        data-testid="rpki-tcp-ao-profile-empty"
                                        class="tcp-ao-profile-alert"
                                    />
                                    <nn-button
                                        type="link"
                                        data-testid="rpki-open-tcp-ao-settings"
                                        class="tcp-ao-settings-link"
                                        @click="openTcpAoSettings"
                                    >
                                        前往 TCP-AO 设置
                                    </nn-button>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <nn-space>
                                <nn-button
                                    data-testid="rpki-start-button"
                                    type="primary"
                                    html-type="submit"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button
                                    data-testid="rpki-stop-button"
                                    type="primary"
                                    danger
                                    :disabled="!serverRunning"
                                    @click="stopRpki"
                                >
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </nn-form-item>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <!-- RPKI客户端列表 -->
        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card title="RPKI客户端列表" class="adaptive-list-card">
                    <div>
                        <nn-table
                            data-testid="rpki-client-table"
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="
                                record =>
                                    `${record.localIp}|${record.localPort}|${record.remoteIp}|${record.remotePort}`
                            "
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ y: '100%' }"
                            size="small"
                            class="adaptive-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <nn-button type="link" @click="viewClientDetails(record)">详情</nn-button>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <nn-json-viewer v-if="currentDetails" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
    import { notify } from '../../utils/notify';
    import { FormValidator, createRpkiConfigValidationRules } from '../../utils/validationCommon';
    import {
        DEFAULT_VALUES,
        RPKI_EVENT_PAGE_ID,
        RPKI_PROTOCOL_VERSION,
        RPKI_ASPA_FORMAT,
        RPKI_RUNTIME_CHANGED_EVENT
    } from '../../const/rpkiConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'RpkiConfig'
    });

    const emit = defineEmits(['open-settings']);

    const RPKI_AUTH_TYPE = Object.freeze({
        NONE: 'none',
        TCP_AO: 'tcp-ao'
    });
    const TCP_AO_SETTINGS_CHANGED_EVENT = 'rpki:tcpAoSettingsChanged';
    const TCP_AO_SETTINGS_LISTENER_ID = 'rpki-config-tcp-ao-settings';

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const rpkiConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_RPKI_PORT,
        maxProtocolVersion: DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION,
        aspaFormat: RPKI_ASPA_FORMAT.LATEST,
        authType: RPKI_AUTH_TYPE.NONE,
        tcpAoProfileId: ''
    });

    const tcpAoProfiles = ref([]);
    const currentTimeMs = ref(Date.now());
    const configuredTcpAoProfiles = computed(() =>
        tcpAoProfiles.value
            .map(profile => {
                const currentSendKeys = profile.keys.filter(keyItem =>
                    isKeyCurrentlySendable(keyItem, currentTimeMs.value)
                );
                return {
                    ...profile,
                    currentSendKey:
                        profile.keys.length > 0 &&
                        profile.keys.every(keyItem => keyItem.hasSavedKey) &&
                        currentSendKeys.length === 1
                            ? currentSendKeys[0]
                            : null
                };
            })
            .filter(profile => Boolean(profile.currentSendKey))
    );
    const selectedTcpAoProfile = computed(
        () => configuredTcpAoProfiles.value.find(profile => profile.id === rpkiConfig.value.tcpAoProfileId) || null
    );

    const serverLoading = ref(false);
    const serverRunning = ref(false);
    const runtimeFailureMessage = ref('');

    const normalizeMaxProtocolVersion = version => {
        const maxProtocolVersion = Number(version);
        return Object.values(RPKI_PROTOCOL_VERSION).includes(maxProtocolVersion)
            ? maxProtocolVersion
            : DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION;
    };

    // 客户端列表
    const clientList = ref([]);
    let clientListRequestId = 0;
    let configActive = false;
    let tcpAoClockTimer = null;
    const clientColumns = [
        {
            title: '本地IP',
            dataIndex: 'localIp',
            key: 'localIp',
            ellipsis: true
        },
        {
            title: '本地端口',
            dataIndex: 'localPort',
            key: 'localPort',
            ellipsis: true
        },
        {
            title: '客户端IP',
            dataIndex: 'remoteIp',
            key: 'remoteIp',
            ellipsis: true
        },
        {
            title: '客户端端口',
            dataIndex: 'remotePort',
            key: 'remotePort',
            ellipsis: true
        },
        {
            title: '协议版本',
            key: 'protocolVersion',
            ellipsis: true,
            customRender: ({ record }) =>
                record.protocolVersion === undefined || record.protocolVersion === null
                    ? '-'
                    : `v${record.protocolVersion}`
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const validationErrors = ref({ port: '', tcpAoProfileId: '' });

    let validator = new FormValidator(validationErrors);
    validator.addRules(createRpkiConfigValidationRules());

    const normalizeAuthType = value => (value === RPKI_AUTH_TYPE.TCP_AO ? RPKI_AUTH_TYPE.TCP_AO : RPKI_AUTH_TYPE.NONE);

    const normalizeTcpAoTimestamp = value => {
        if (value === '' || value === null || value === undefined || value === 0 || value === '0') return null;
        if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
            const numeric = Number(value);
            return numeric > 10_000_000_000 ? numeric : numeric * 1000;
        }
        const timestamp = Date.parse(String(value));
        return Number.isNaN(timestamp) ? Number.NaN : timestamp;
    };

    const sanitizeTcpAoKey = keyItem => ({
        id: String(keyItem?.id || ''),
        algorithm: String(keyItem?.algorithm || ''),
        sndId: Number(keyItem?.sndId),
        rcvId: Number(keyItem?.rcvId),
        macLength: Number(keyItem?.macLength),
        hasSavedKey: keyItem?.hasSavedKey === true,
        acceptStart: normalizeTcpAoTimestamp(keyItem?.acceptStart),
        sendStart: normalizeTcpAoTimestamp(keyItem?.sendStart),
        sendEnd: normalizeTcpAoTimestamp(keyItem?.sendEnd),
        acceptEnd: normalizeTcpAoTimestamp(keyItem?.acceptEnd)
    });

    const isKeyCurrentlySendable = (keyItem, now = Date.now()) =>
        keyItem.hasSavedKey &&
        !Number.isNaN(keyItem.sendStart) &&
        !Number.isNaN(keyItem.sendEnd) &&
        (keyItem.sendStart === null || keyItem.sendStart <= now) &&
        (keyItem.sendEnd === null || now < keyItem.sendEnd);

    const sanitizeTcpAoProfile = profile => {
        const keys = (Array.isArray(profile?.keys) ? profile.keys : []).map(sanitizeTcpAoKey);
        return {
            id: String(profile?.id || ''),
            name: String(profile?.name || ''),
            peer: String(profile?.peer || ''),
            keys
        };
    };

    const applyTcpAoProfiles = source => {
        tcpAoProfiles.value = (Array.isArray(source) ? source : [])
            .map(sanitizeTcpAoProfile)
            .filter(profile => profile.id && profile.name);

        if (
            rpkiConfig.value.tcpAoProfileId &&
            !configuredTcpAoProfiles.value.some(profile => profile.id === rpkiConfig.value.tcpAoProfileId)
        ) {
            rpkiConfig.value.tcpAoProfileId = '';
        }
    };

    const loadTcpAoProfiles = async () => {
        if (typeof window.rpkiApi?.loadTcpAoSettings !== 'function') {
            applyTcpAoProfiles([]);
            return;
        }
        try {
            const result = await window.rpkiApi.loadTcpAoSettings();
            if (result?.status === 'success') {
                applyTcpAoProfiles(result.data?.profiles);
            } else {
                applyTcpAoProfiles([]);
                console.error('TCP-AO配置加载失败', result?.msg);
            }
        } catch (error) {
            applyTcpAoProfiles([]);
            console.error('TCP-AO配置加载失败', error);
        }
    };

    const clearAuthenticationError = () => {
        validationErrors.value.tcpAoProfileId = '';
    };

    const validateAuthentication = () => {
        clearAuthenticationError();
        if (rpkiConfig.value.authType !== RPKI_AUTH_TYPE.TCP_AO) return false;

        if (!rpkiConfig.value.tcpAoProfileId) {
            validationErrors.value.tcpAoProfileId = '请选择 TCP-AO Profile';
            return true;
        }
        const selectedProfile = tcpAoProfiles.value.find(
            profile => profile.id === String(rpkiConfig.value.tcpAoProfileId)
        );
        const currentSendKeys = selectedProfile?.keys.filter(keyItem => isKeyCurrentlySendable(keyItem)) || [];
        if (
            !selectedProfile ||
            selectedProfile.keys.length === 0 ||
            !selectedProfile.keys.every(keyItem => keyItem.hasSavedKey) ||
            currentSendKeys.length !== 1
        ) {
            validationErrors.value.tcpAoProfileId = '所选 TCP-AO Profile 不存在或当前没有可发送的已保存密钥';
            return true;
        }
        return false;
    };

    const buildConfigPayload = () => {
        const authType = normalizeAuthType(rpkiConfig.value.authType);
        return {
            port: rpkiConfig.value.port,
            maxProtocolVersion: normalizeMaxProtocolVersion(rpkiConfig.value.maxProtocolVersion),
            aspaFormat: rpkiConfig.value.aspaFormat || RPKI_ASPA_FORMAT.LATEST,
            authType,
            tcpAoProfileId: authType === RPKI_AUTH_TYPE.TCP_AO ? String(rpkiConfig.value.tcpAoProfileId || '') : ''
        };
    };

    const openTcpAoSettings = () => {
        emit('open-settings', 'tcp-ao');
    };

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const clearClientRuntimeState = () => {
        clientListRequestId += 1;
        clientList.value = [];
        detailsDrawerVisible.value = false;
        detailsDrawerTitle.value = '';
        currentDetails.value = null;
    };

    const startRpki = async () => {
        const hasConfigErrors = validator.validate(rpkiConfig.value);
        const hasAuthenticationErrors = validateAuthentication();
        if (hasConfigErrors || hasAuthenticationErrors) {
            notify.error('请检查配置信息是否正确');
            return;
        }

        try {
            runtimeFailureMessage.value = '';
            // RPKI 启动和普通配置持久化只引用已保存的 Profile；密钥明文永不进入该 payload。
            const payload = buildConfigPayload();
            const saveResult = await window.rpkiApi.saveRpkiConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.rpkiApi.startRpki(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                clearClientRuntimeState();
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'RPKI服务器启动失败');
            }
        } catch (error) {
            notify.error(`RPKI服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopRpki = async () => {
        try {
            const result = await window.rpkiApi.stopRpki();
            if (result.status === 'success') {
                serverRunning.value = false;
                clearClientRuntimeState();
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'RPKI服务器停止失败');
            }
        } catch (error) {
            notify.error(`RPKI服务器停止出错: ${error.message}`);
        }
    };

    const viewClientDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `RPKI客户端信息: ${record.remoteIp}:${record.remotePort}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const handleRuntimeChanged = state => {
        const wasRunning = serverRunning.value;
        serverRunning.value = Boolean(state?.running);
        if (!serverRunning.value) {
            serverLoading.value = false;
            clearClientRuntimeState();
            const failureReason = state?.unexpected ? String(state.reason || '').trim() : '';
            if (failureReason) {
                runtimeFailureMessage.value = failureReason;
                notify.error(failureReason);
            }
            return;
        }

        runtimeFailureMessage.value = '';
        if (!wasRunning) {
            clearClientRuntimeState();
            if (configActive) void loadClientList();
        }
    };

    const onClientConnection = result => {
        if (!serverRunning.value) return;
        if (result.status === 'success') {
            const data = result.data;
            const matchClient = item =>
                item.localIp === data.data.localIp &&
                item.localPort === data.data.localPort &&
                item.remoteIp === data.data.remoteIp &&
                item.remotePort === data.data.remotePort;

            if (data.opType === 'add') {
                clientList.value.push(data.data);
            } else if (data.opType === 'delete') {
                const index = clientList.value.findIndex(matchClient);
                if (index !== -1) {
                    clientList.value.splice(index, 1);
                }
            } else if (data.opType === 'update') {
                const index = clientList.value.findIndex(matchClient);
                if (index !== -1) {
                    clientList.value[index] = { ...clientList.value[index], ...data.data };
                }
            }
        } else {
            notify.error(result.msg || '获取客户端列表失败');
        }
    };

    const loadClientList = async () => {
        const requestId = ++clientListRequestId;
        try {
            const clientListResult = await window.rpkiApi.getClientList();
            if (requestId !== clientListRequestId) return;
            if (clientListResult.status === 'success') {
                clientList.value = Array.isArray(clientListResult.data) ? clientListResult.data : [];
            } else {
                clearClientRuntimeState();
            }
        } catch (error) {
            if (requestId !== clientListRequestId) return;
            console.error(error);
            clearClientRuntimeState();
            notify.error('加载数据失败');
        }
    };

    onActivated(async () => {
        configActive = true;
        currentTimeMs.value = Date.now();
        if (tcpAoClockTimer !== null) clearInterval(tcpAoClockTimer);
        tcpAoClockTimer = setInterval(() => {
            currentTimeMs.value = Date.now();
        }, 1000);
        EventBus.on('rpki:clientConnection', RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG, onClientConnection);
        await Promise.all([loadClientList(), loadTcpAoProfiles()]);
    });

    onDeactivated(() => {
        configActive = false;
        if (tcpAoClockTimer !== null) {
            clearInterval(tcpAoClockTimer);
            tcpAoClockTimer = null;
        }
        EventBus.off('rpki:clientConnection', RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG);
    });

    onMounted(async () => {
        EventBus.on(RPKI_RUNTIME_CHANGED_EVENT, RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG, handleRuntimeChanged);
        EventBus.on(TCP_AO_SETTINGS_CHANGED_EVENT, TCP_AO_SETTINGS_LISTENER_ID, applyTcpAoProfiles);
        try {
            // 加载配置
            const result = await window.rpkiApi.loadRpkiConfig();
            if (result.status === 'success') {
                if (result.data) {
                    rpkiConfig.value.port = result.data.port;
                    rpkiConfig.value.maxProtocolVersion = normalizeMaxProtocolVersion(
                        result.data.maxProtocolVersion ?? DEFAULT_VALUES.DEFAULT_RPKI_MAX_PROTOCOL_VERSION
                    );
                    rpkiConfig.value.aspaFormat = result.data.aspaFormat || RPKI_ASPA_FORMAT.LATEST;
                    rpkiConfig.value.authType = normalizeAuthType(result.data.authType);
                    rpkiConfig.value.tcpAoProfileId = String(result.data.tcpAoProfileId || '');
                }
            } else {
                console.error('配置文件加载失败', result.msg);
            }
        } catch (error) {
            console.error('初始化RPKI配置出错:', error);
        }
        await loadTcpAoProfiles();
    });

    onBeforeUnmount(() => {
        if (tcpAoClockTimer !== null) clearInterval(tcpAoClockTimer);
        EventBus.off(RPKI_RUNTIME_CHANGED_EVENT, RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG);
        EventBus.off(TCP_AO_SETTINGS_CHANGED_EVENT, TCP_AO_SETTINGS_LISTENER_ID);
        EventBus.off('rpki:clientConnection', RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_CONFIG);
    });
</script>

<style scoped>
    .rpki-runtime-alert {
        margin-bottom: 12px;
    }

    .adaptive-list-page {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .tcp-ao-profile-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .tcp-ao-profile-alert {
        max-width: 620px;
    }

    .tcp-ao-settings-link {
        margin-top: 4px;
        padding-inline: 0;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.nn-card-body),
    .adaptive-list-card :deep(.nn-card-body > div) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.nn-spin-nested-loading),
    .adaptive-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .adaptive-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.nn-table-container),
    .adaptive-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
