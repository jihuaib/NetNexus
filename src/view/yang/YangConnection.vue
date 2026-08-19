<template>
    <div class="nn-container yang-connection-page">
        <nn-card title="连接设置" class="connection-card">
            <template #extra>
                <nn-space>
                    <nn-tag :color="sessionStatusMeta.color">NETCONF {{ sessionStatusMeta.text }}</nn-tag>
                    <nn-tag color="blue">Profile {{ profiles.length }}</nn-tag>
                </nn-space>
            </template>

            <div class="connection-layout">
                <section class="connection-panel profile-card">
                    <div class="connection-panel-header">
                        <div class="connection-panel-heading">
                            <span class="connection-panel-title">连接 Profile</span>
                            <span class="connection-panel-meta">选择设备连接配置</span>
                        </div>
                        <nn-button type="primary" size="small" @click="addProfile">
                            <template #icon><PlusOutlined /></template>
                            新建
                        </nn-button>
                    </div>

                    <div class="connection-panel-body profile-panel-body">
                        <nn-spin :spinning="profileLoading">
                            <div class="profile-list">
                                <button
                                    v-for="profile in profiles"
                                    :key="profile.id"
                                    type="button"
                                    class="profile-list-item"
                                    :class="{ 'profile-list-item-active': profile.id === selectedProfileId }"
                                    @click="selectProfile(profile)"
                                >
                                    <span class="profile-avatar"><CloudServerOutlined /></span>
                                    <span class="profile-content">
                                        <span class="profile-name">{{ profile.name || '未命名连接' }}</span>
                                        <span class="profile-address">
                                            {{ profile.host || '-' }}:{{ profile.port || 830 }}
                                        </span>
                                    </span>
                                    <span
                                        v-if="isConnected && activeProfileId === profile.id"
                                        class="profile-online-dot"
                                        title="当前会话"
                                    />
                                </button>
                                <nn-empty
                                    v-if="!profileLoading && profiles.length === 0"
                                    description="暂无连接 Profile"
                                />
                            </div>
                        </nn-spin>
                    </div>
                </section>

                <section class="connection-panel profile-editor-card">
                    <div class="connection-panel-header profile-editor-header">
                        <div class="connection-panel-heading">
                            <span class="connection-panel-title">Profile 配置</span>
                            <span class="connection-panel-meta">
                                {{ selectedProfile?.name || '请选择或新建一个连接 Profile' }}
                            </span>
                        </div>
                        <nn-space wrap class="profile-editor-actions">
                            <nn-tag v-if="isDirty" color="warning">未保存</nn-tag>
                            <nn-button :loading="testing" :disabled="!selectedProfileId" @click="testConnection">
                                测试连接
                            </nn-button>
                            <nn-button
                                type="primary"
                                :loading="saving"
                                :disabled="!selectedProfileId"
                                @click="saveProfile"
                            >
                                <template #icon><SaveOutlined /></template>
                                保存
                            </nn-button>
                            <nn-button
                                v-if="!isConnected"
                                type="primary"
                                :loading="connecting"
                                :disabled="!selectedProfileId"
                                @click="connectProfile"
                            >
                                <template #icon><ApiOutlined /></template>
                                连接
                            </nn-button>
                            <nn-button danger :disabled="!selectedProfileId" @click="deleteProfile">
                                <template #icon><DeleteOutlined /></template>
                                删除
                            </nn-button>
                        </nn-space>
                    </div>

                    <div class="connection-panel-body profile-editor-body">
                        <nn-empty v-if="!selectedProfileId" description="请选择或新建一个连接 Profile" />
                        <nn-form v-else :model="draft" :label-col="labelCol" class="profile-form">
                            <nn-row :gutter="16">
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="Profile 名称" required>
                                        <nn-input
                                            v-model:value="draft.name"
                                            placeholder="例如：核心路由器"
                                            :maxlength="80"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="认证方式" required>
                                        <nn-select v-model:value="draft.authMethod" :options="NETCONF_AUTH_OPTIONS" />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>

                            <nn-row :gutter="16">
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="设备地址" required>
                                        <nn-input v-model:value="draft.host" placeholder="IP 地址或主机名" />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="端口" required>
                                        <nn-input-number
                                            v-model:value="draft.port"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>

                            <nn-row :gutter="16">
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="用户名" required>
                                        <nn-input
                                            v-model:value="draft.username"
                                            autocomplete="off"
                                            placeholder="NETCONF 用户名"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col v-if="draft.authMethod === 'password'" :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="密码" required>
                                        <nn-input-password
                                            v-model:value="draft.password"
                                            autocomplete="new-password"
                                            placeholder="设备登录密码"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col v-else :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="私钥口令">
                                        <nn-input-password
                                            v-model:value="draft.passphrase"
                                            autocomplete="new-password"
                                            placeholder="没有口令可留空"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>

                            <nn-form-item v-if="draft.authMethod === 'privateKey'" label="私钥路径" required>
                                <div class="private-key-picker">
                                    <nn-input v-model:value="draft.privateKeyPath" placeholder="本机私钥文件绝对路径" />
                                    <nn-button :loading="privateKeySelecting" @click="selectPrivateKey">
                                        选择文件
                                    </nn-button>
                                </div>
                            </nn-form-item>

                            <nn-form-item label="Host Key 指纹">
                                <nn-input
                                    v-model:value="draft.hostKeyFingerprint"
                                    placeholder="首次连接可留空；确认后建议固定 SHA256 指纹"
                                />
                            </nn-form-item>

                            <nn-row :gutter="16">
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="连接超时">
                                        <nn-input-number
                                            v-model:value="draft.connectTimeout"
                                            :min="1000"
                                            :max="120000"
                                            :step="1000"
                                            addon-after="ms"
                                            style="width: 100%"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12" :xs="24" :sm="12">
                                    <nn-form-item label="Keepalive">
                                        <nn-input-number
                                            v-model:value="draft.keepaliveInterval"
                                            :min="0"
                                            :max="300000"
                                            :step="1000"
                                            addon-after="ms"
                                            style="width: 100%"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>

                            <nn-form-item label="自动重连">
                                <div class="profile-options">
                                    <nn-checkbox v-model:checked="draft.rememberCredentials">
                                        在本机保存凭据
                                    </nn-checkbox>
                                    <nn-checkbox v-model:checked="draft.autoReconnect">
                                        连接意外中断后自动尝试恢复会话
                                    </nn-checkbox>
                                </div>
                            </nn-form-item>
                        </nn-form>
                    </div>
                </section>

                <section class="connection-panel session-card">
                    <div class="connection-panel-header session-panel-header">
                        <div class="connection-panel-heading">
                            <span class="connection-panel-title">当前会话</span>
                        </div>
                    </div>
                    <div class="session-panel-body">
                        <nn-table
                            :columns="sessionColumns"
                            :data-source="currentSessionRows"
                            :pagination="false"
                            :scroll="{ x: 830 }"
                            row-key="key"
                            size="small"
                            bordered
                            class="session-table"
                        >
                            <template #bodyCell="{ column }">
                                <template v-if="column.key === 'action'">
                                    <nn-space v-if="isConnected" :size="4" class="session-actions">
                                        <nn-button type="link" size="small" @click="capabilityDrawerOpen = true">
                                            Capability {{ capabilities.length }}
                                        </nn-button>
                                        <nn-button
                                            type="link"
                                            danger
                                            size="small"
                                            :loading="disconnecting"
                                            @click="disconnectProfile"
                                        >
                                            断开连接
                                        </nn-button>
                                    </nn-space>
                                    <span v-else class="session-offline">未连接</span>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </section>
            </div>
        </nn-card>

        <nn-drawer
            v-model:open="capabilityDrawerOpen"
            title="设备 Capability"
            placement="right"
            width="min(720px, calc(100vw - 24px))"
            :body-style="{ padding: '12px', overflow: 'hidden' }"
        >
            <div class="capability-drawer-content">
                <nn-input-search
                    v-model:value="capabilityQuery"
                    allow-clear
                    placeholder="筛选 capability URI"
                    class="capability-search"
                />
                <div class="capability-list">
                    <div v-for="capability in filteredCapabilities" :key="capability" class="capability-row">
                        <nn-typography-text copyable>{{ capability }}</nn-typography-text>
                    </div>
                    <nn-empty v-if="filteredCapabilities.length === 0" description="暂无 Capability" />
                </div>
            </div>
        </nn-drawer>

        <nn-modal
            :open="connectionPageActive && profileDataLoad.visible"
            title="切换 Profile"
            width="500px"
            :footer="null"
            :closable="profileDataLoadTerminal"
            :keyboard="profileDataLoadTerminal"
            :mask-closable="false"
            :draggable="false"
            data-testid="yang-profile-data-load-modal"
            @update:open="handleProfileDataLoadOpenChange"
        >
            <section
                class="profile-data-load"
                :class="`profile-data-load-${profileDataLoad.status}`"
                data-testid="yang-profile-data-load"
                role="status"
                aria-live="polite"
            >
                <div class="profile-data-load-header">
                    <div class="profile-data-load-heading">
                        <span class="profile-data-load-title">Profile 数据载入</span>
                        <span class="profile-data-load-profile">{{ profileDataLoad.profileName }}</span>
                    </div>
                    <nn-tag :color="profileDataLoadStatus.color">
                        {{ profileDataLoadStatus.text }}
                    </nn-tag>
                </div>
                <div class="profile-data-load-detail">
                    <span>{{ profileDataLoad.message }}</span>
                    <span>{{ profileDataLoad.percent }}%</span>
                </div>
                <nn-progress
                    :percent="profileDataLoad.percent"
                    :aria-label="profileDataLoad.message"
                    :status="profileDataLoad.status === 'error' ? 'error' : 'active'"
                    :stroke-width="4"
                />
                <div v-if="profileDataLoadTerminal" class="profile-data-load-summary">
                    <span>模型 {{ profileDataLoad.moduleCount }}</span>
                    <span>Schema 模块 {{ profileDataLoad.workspaceModuleCount }}</span>
                    <span>节点 {{ profileDataLoad.nodeCount }}</span>
                </div>
                <div v-if="profileDataLoadTerminal" class="profile-data-load-actions">
                    <nn-button type="primary" @click="closeProfileDataLoad">完成</nn-button>
                </div>
            </section>
        </nn-modal>

        <nn-modal v-model:open="testResultOpen" title="连接测试结果" :footer="null" width="680px">
            <nn-alert
                :type="testResult.success ? 'success' : 'error'"
                show-icon
                :message="testResult.success ? 'NETCONF 连接测试成功' : 'NETCONF 连接测试失败'"
                :description="testResult.message || (testResult.success ? 'SSH、subsystem 与 hello 交换均正常' : '')"
            />
            <nn-descriptions v-if="testResult.success" :column="2" bordered size="small" class="test-result-detail">
                <nn-descriptions-item label="耗时">{{ testResult.latency ?? '-' }} ms</nn-descriptions-item>
                <nn-descriptions-item label="NETCONF Base">{{ testResult.baseVersion || '-' }}</nn-descriptions-item>
                <nn-descriptions-item label="Session ID">{{ testResult.sessionId || '-' }}</nn-descriptions-item>
                <nn-descriptions-item label="能力数量">{{ testResult.capabilities?.length || 0 }}</nn-descriptions-item>
                <nn-descriptions-item v-if="testResult.hostKeyFingerprint" label="Host Key" :span="2">
                    <nn-typography-text copyable>{{ testResult.hostKeyFingerprint }}</nn-typography-text>
                </nn-descriptions-item>
            </nn-descriptions>
        </nn-modal>
    </div>
</template>

<script setup>
    import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import {
        DEFAULT_NETCONF_PROFILE,
        NETCONF_AUTH_OPTIONS,
        NETCONF_SESSION_STATUS,
        NETCONF_SESSION_STATUS_META,
        YANG_EVENT,
        YANG_EVENT_PAGE_ID
    } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { ApiOutlined, CloudServerOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from 'netnexus-ui/icons';
    import {
        clonePlain,
        formatDateTime,
        invokeBridge,
        normalizeCapability,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';
    import { useYangProfileContext } from './useYangProfileContext';

    defineOptions({ name: 'YangConnection' });

    const labelCol = { style: { width: '108px' } };
    const sessionColumns = [
        { title: 'Profile', dataIndex: 'profileName', key: 'profileName', width: 120, ellipsis: true },
        { title: '远端', dataIndex: 'remote', key: 'remote', width: 150, ellipsis: true },
        { title: 'NETCONF Base', dataIndex: 'baseVersion', key: 'baseVersion', width: 120 },
        { title: 'Session ID', dataIndex: 'sessionId', key: 'sessionId', width: 110, ellipsis: true },
        { title: '连接时间', dataIndex: 'connectedAt', key: 'connectedAt', width: 150 },
        { title: '操作', key: 'action', width: 180, fixed: 'right', align: 'center' }
    ];
    const profiles = ref([]);
    const selectedProfileId = ref('');
    const {
        selectedProfileId: sharedProfileId,
        refreshProfiles: refreshSharedProfiles,
        selectProfile: selectSharedProfile,
        upsertProfile: upsertSharedProfile,
        removeProfile: removeSharedProfile
    } = useYangProfileContext();
    const draft = ref(clonePlain(DEFAULT_NETCONF_PROFILE));
    const savedFingerprint = ref('');
    const profileLoading = ref(false);
    const saving = ref(false);
    const testing = ref(false);
    const connecting = ref(false);
    const disconnecting = ref(false);
    const privateKeySelecting = ref(false);
    const session = ref({ status: NETCONF_SESSION_STATUS.DISCONNECTED, capabilities: [] });
    const capabilityDrawerOpen = ref(false);
    const capabilityQuery = ref('');
    const testResultOpen = ref(false);
    const testResult = ref({ success: false, message: '' });
    const connectionPageActive = ref(true);
    const profileDataLoad = ref({
        visible: false,
        status: 'idle',
        phase: 'idle',
        percent: 0,
        profileId: '',
        profileName: '',
        message: '',
        operationId: '',
        moduleCount: 0,
        workspaceModuleCount: 0,
        nodeCount: 0
    });
    let profileContextRevision = 0;
    let profileListRequestRevision = 0;
    let saveRequestRevision = 0;
    let testRequestRevision = 0;
    let privateKeyRequestRevision = 0;
    let connectRequestRevision = 0;
    let disconnectRequestRevision = 0;
    let profileDataLoadRevision = 0;
    let profileDataLoadOperationSequence = 0;
    let dismissedProfileDataLoadOperationId = '';
    let initialConnectionLoadSettled = false;
    const profileConnectionStatuses = new Map();
    const processedProfileConnections = new Map();
    const pendingProfileSwitches = new Map();

    const profileContextMatches = (profileId, revision) =>
        revision === profileContextRevision && String(selectedProfileId.value || '') === String(profileId || '');

    const invalidateProfileContext = () => {
        profileContextRevision += 1;
        saving.value = false;
        testing.value = false;
        connecting.value = false;
        disconnecting.value = false;
        privateKeySelecting.value = false;
        testResultOpen.value = false;
    };

    const normalizeProfile = profile => ({
        ...clonePlain(DEFAULT_NETCONF_PROFILE),
        ...(profile || {}),
        id: profile?.id || profile?.profileId || '',
        port: Number(profile?.port || 830),
        connectTimeout: Number(profile?.connectTimeout || 15000),
        rpcTimeout: Number.isFinite(Number(profile?.rpcTimeout))
            ? Number(profile.rpcTimeout)
            : DEFAULT_NETCONF_PROFILE.rpcTimeout,
        keepaliveInterval: Number.isFinite(Number(profile?.keepaliveInterval))
            ? Number(profile.keepaliveInterval)
            : 30000,
        autoReconnect: Boolean(profile?.autoReconnect)
    });

    const stableDraft = value => {
        const normalized = normalizeProfile(value);
        return JSON.stringify(normalized);
    };

    const selectedProfile = computed(() => profiles.value.find(profile => profile.id === selectedProfileId.value));
    const isDirty = computed(() => selectedProfileId.value && stableDraft(draft.value) !== savedFingerprint.value);
    const sessionStatus = computed(() => {
        const state = session.value?.status || session.value?.state;
        if (session.value?.connected === true) return NETCONF_SESSION_STATUS.CONNECTED;
        if (session.value?.connected === false && !state) return NETCONF_SESSION_STATUS.DISCONNECTED;
        return NETCONF_SESSION_STATUS_META[state] ? state : NETCONF_SESSION_STATUS.DISCONNECTED;
    });
    const sessionStatusMeta = computed(
        () => NETCONF_SESSION_STATUS_META[sessionStatus.value] || NETCONF_SESSION_STATUS_META.disconnected
    );
    const profileDataLoadStatus = computed(() => {
        if (profileDataLoad.value.status === 'connecting') return { text: '连接中', color: 'processing' };
        if (profileDataLoad.value.status === 'completed') return { text: '切换完成', color: 'success' };
        if (profileDataLoad.value.status === 'warning') return { text: '部分载入', color: 'warning' };
        if (profileDataLoad.value.status === 'failed') {
            return {
                text: profileDataLoad.value.phase === 'connect' ? '连接失败' : '载入失败',
                color: 'error'
            };
        }
        return { text: '载入中', color: 'processing' };
    });
    const profileDataLoadTerminal = computed(() =>
        ['completed', 'warning', 'failed'].includes(profileDataLoad.value.status)
    );
    const isConnected = computed(() => sessionStatus.value === NETCONF_SESSION_STATUS.CONNECTED);
    const activeProfileId = computed(() => session.value?.profileId || session.value?.connectionId || '');
    const currentSessionRows = computed(() => {
        const profile = selectedProfile.value;
        const host = session.value.host || profile?.host || '-';
        const port = session.value.port || profile?.port || 830;
        if (!isConnected.value) {
            return [
                {
                    key: 'disconnected-session',
                    profileName: profile?.name || '-',
                    remote: host === '-' ? '-' : `${host}:${port}`,
                    baseVersion: '-',
                    sessionId: '-',
                    connectedAt: '-'
                }
            ];
        }
        return [
            {
                key: session.value.sessionId || activeProfileId.value || 'current-session',
                profileName: session.value.profileName || profile?.name || '-',
                remote: `${host}:${port}`,
                baseVersion: session.value.baseVersion || session.value.version || '-',
                sessionId: session.value.sessionId || '-',
                connectedAt: formatDateTime(session.value.connectedAt)
            }
        ];
    });
    const capabilities = computed(() => {
        const values = session.value?.capabilities || session.value?.serverCapabilities || [];
        return [...new Set(unwrapArray(values).map(normalizeCapability).filter(Boolean))];
    });
    const filteredCapabilities = computed(() => {
        const query = capabilityQuery.value.trim().toLowerCase();
        return query ? capabilities.value.filter(item => item.toLowerCase().includes(query)) : capabilities.value;
    });

    const applyDraft = profile => {
        draft.value = normalizeProfile(profile);
        savedFingerprint.value = stableDraft(draft.value);
    };

    const createProfileDataLoadOperation = profileId =>
        `${String(profileId || 'profile')}:${Date.now()}:${++profileDataLoadOperationSequence}`;

    const currentProfileDataLoadOperation = profileId =>
        profileDataLoad.value.profileId === String(profileId || '') ? profileDataLoad.value.operationId : '';

    const connectionInstanceKey = state => {
        const profileId = String(state?.profileId || state?.connectionId || '');
        const sessionId = String(state?.sessionId || state?.sessionID || '');
        const connectedAt = String(state?.connectedAt || '');
        return profileId && (sessionId || connectedAt) ? `${profileId}:${sessionId}:${connectedAt}` : '';
    };

    const showProfileConnectionProgress = (profile, message = '正在连接设备，连接成功后将切换 Profile') => {
        const profileId = String(profile?.id || profile?.profileId || '');
        const operationId = createProfileDataLoadOperation(profileId);
        profileDataLoadRevision += 1;
        profileDataLoad.value = {
            visible: connectionPageActive.value,
            status: 'connecting',
            phase: 'connect',
            percent: 10,
            profileId,
            profileName: profile?.name || profile?.host || profileId,
            message,
            operationId,
            moduleCount: 0,
            workspaceModuleCount: 0,
            nodeCount: 0
        };
    };

    const showProfileConnectionFailure = (profileId, error) => {
        const normalizedProfileId = String(profileId || '');
        const profile = profiles.value.find(item => item.id === normalizedProfileId) || draft.value;
        const operationId =
            currentProfileDataLoadOperation(normalizedProfileId) || createProfileDataLoadOperation(normalizedProfileId);
        profileDataLoadRevision += 1;
        profileDataLoad.value = {
            visible: connectionPageActive.value && dismissedProfileDataLoadOperationId !== operationId,
            status: 'failed',
            phase: 'connect',
            percent: 100,
            profileId: normalizedProfileId,
            profileName: profile?.name || profile?.host || normalizedProfileId,
            message: `连接失败，仍保留当前 Profile：${error?.message || error}`,
            operationId,
            moduleCount: 0,
            workspaceModuleCount: 0,
            nodeCount: 0
        };
    };

    const closeProfileDataLoad = () => {
        if (!profileDataLoadTerminal.value) return;
        dismissedProfileDataLoadOperationId = profileDataLoad.value.operationId;
        profileDataLoadRevision += 1;
        profileDataLoad.value = { ...profileDataLoad.value, visible: false };
    };

    const handleProfileDataLoadOpenChange = open => {
        if (!open) closeProfileDataLoad();
    };

    const loadConnectedProfileData = async (connectedSession, reason = 'connected', profileChanged = false) => {
        const profileId = String(connectedSession?.profileId || connectedSession?.connectionId || '');
        if (!profileId) return;
        const operationId = currentProfileDataLoadOperation(profileId) || createProfileDataLoadOperation(profileId);
        const requestRevision = ++profileDataLoadRevision;
        const profile = profiles.value.find(item => item.id === profileId);
        const profileName = connectedSession?.profileName || profile?.name || connectedSession?.host || profileId;
        const errors = [];
        let moduleCount = 0;
        let workspaceModuleCount = 0;
        let nodeCount = 0;
        let compileId = '';

        profileDataLoad.value = {
            visible: connectionPageActive.value && dismissedProfileDataLoadOperationId !== operationId,
            status: 'loading',
            phase: 'data',
            percent: 35,
            profileId,
            profileName,
            message: '连接成功，正在载入模型库',
            operationId,
            moduleCount: 0,
            workspaceModuleCount: 0,
            nodeCount: 0
        };

        try {
            const { data } = await invokeBridge('yangApi', 'listModules', { profileId });
            if (requestRevision !== profileDataLoadRevision) return;
            moduleCount = unwrapArray(data, ['modules', 'items', 'records']).length;
        } catch (error) {
            if (requestRevision !== profileDataLoadRevision) return;
            errors.push({ stage: 'modules', message: error.message });
        }

        profileDataLoad.value = {
            ...profileDataLoad.value,
            percent: 70,
            message: '正在载入 Schema 工作区',
            moduleCount
        };

        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace', { profileId });
            if (requestRevision !== profileDataLoadRevision) return;
            const workspace = data?.workspace || data || {};
            const summary = workspace.summary || {};
            compileId = workspace.compileId || '';
            workspaceModuleCount =
                Number(summary.moduleCount ?? unwrapArray(workspace.modules, ['modules']).length) || 0;
            nodeCount = Number(summary.nodeCount ?? workspace.schemaTree?.nodeCount) || 0;
        } catch (error) {
            if (requestRevision !== profileDataLoadRevision) return;
            errors.push({ stage: 'workspace', message: error.message });
        }

        const status = errors.length === 0 ? 'completed' : errors.length === 1 ? 'warning' : 'failed';
        const message =
            status === 'completed'
                ? '模型库与 Schema 工作区已载入'
                : status === 'warning'
                  ? `部分数据载入失败：${errors[0].message}`
                  : '模型库与 Schema 工作区载入失败';
        profileDataLoad.value = {
            ...profileDataLoad.value,
            status,
            phase: 'data',
            percent: 100,
            message,
            moduleCount,
            workspaceModuleCount,
            nodeCount
        };
        EventBus.emit(YANG_EVENT.PROFILE_DATA_REFRESH, {
            profileId,
            revision: requestRevision,
            reason,
            profileChanged,
            modules: { count: moduleCount },
            workspace: { compileId, moduleCount: workspaceModuleCount, nodeCount },
            errors
        });
    };

    const updateConnectedProfile = (state, options = {}) => {
        const profileId = String(state?.profileId || state?.connectionId || '');
        if (!profileId) return false;
        const status = String(state?.status || state?.state || '').toLowerCase();
        const previousStatus = profileConnectionStatuses.get(profileId);
        profileConnectionStatuses.set(profileId, status);
        const connected = state?.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
        const connectionKey = connectionInstanceKey(state);
        const connectionAlreadyProcessed =
            Boolean(connectionKey) && processedProfileConnections.get(profileId) === connectionKey;
        if (
            !connected ||
            connectionAlreadyProcessed ||
            (!options.force && previousStatus === NETCONF_SESSION_STATUS.CONNECTED)
        ) {
            return false;
        }
        const profileChanged =
            options.profileChanged ??
            (pendingProfileSwitches.has(profileId)
                ? pendingProfileSwitches.get(profileId)
                : sharedProfileId.value !== profileId);
        pendingProfileSwitches.delete(profileId);
        selectSharedProfile(profileId);
        if (connectionKey) processedProfileConnections.set(profileId, connectionKey);
        if (options.loadData !== false) {
            void loadConnectedProfileData(
                state,
                options.reason ||
                    (previousStatus === NETCONF_SESSION_STATUS.RECONNECTING ? 'reconnected' : 'connected'),
                profileChanged
            );
        }
        return true;
    };

    const loadProfiles = async ({ preserveSelection = true } = {}) => {
        const requestRevision = ++profileListRequestRevision;
        profileLoading.value = true;
        try {
            const loadedProfiles = await refreshSharedProfiles();
            if (requestRevision !== profileListRequestRevision) return;
            const localDrafts = profiles.value.filter(profile => String(profile.id).startsWith('draft-'));
            profiles.value = [
                ...loadedProfiles.map(normalizeProfile),
                ...localDrafts.filter(draftProfile => loadedProfiles.every(profile => profile.id !== draftProfile.id))
            ];
            const existing = preserveSelection
                ? profiles.value.find(profile => profile.id === selectedProfileId.value)
                : null;
            const shared = profiles.value.find(profile => profile.id === sharedProfileId.value);
            const nextProfile =
                (existing && String(existing.id).startsWith('draft-') ? existing : null) ||
                shared ||
                existing ||
                profiles.value[0];
            if (nextProfile) {
                const preserveCurrentDraft = existing === nextProfile && isDirty.value;
                if (!preserveCurrentDraft) invalidateProfileContext();
                selectedProfileId.value = nextProfile.id;
                if (!preserveCurrentDraft) applyDraft(nextProfile);
            } else {
                invalidateProfileContext();
                selectedProfileId.value = '';
                applyDraft(DEFAULT_NETCONF_PROFILE);
            }
        } catch (error) {
            if (requestRevision === profileListRequestRevision) {
                notify.error(`加载连接 Profile 失败：${error.message}`);
            }
        } finally {
            if (requestRevision === profileListRequestRevision) profileLoading.value = false;
        }
    };

    const loadSessionState = async ({ activateSharedProfile = false } = {}) => {
        const profileId = String(selectedProfileId.value || '');
        const requestRevision = profileContextRevision;
        if (!profileId || profileId.startsWith('draft-')) {
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            return;
        }
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState', profileId);
            if (!profileContextMatches(profileId, requestRevision)) return;
            session.value = { ...session.value, ...(data || {}) };
            if (activateSharedProfile) updateConnectedProfile(session.value, { loadData: false });
        } catch (error) {
            if (profileContextMatches(profileId, requestRevision)) {
                console.warn('Unable to load NETCONF session state:', error.message);
            }
        }
    };

    const selectProfile = profile => {
        invalidateProfileContext();
        selectedProfileId.value = profile.id;
        applyDraft(profile);
        session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
        void loadSessionState();
    };

    const addProfile = () => {
        invalidateProfileContext();
        const profile = normalizeProfile({
            id: `draft-${Date.now()}`,
            name: `新连接 ${profiles.value.length + 1}`
        });
        profiles.value = [...profiles.value, profile];
        selectedProfileId.value = profile.id;
        draft.value = clonePlain(profile);
        savedFingerprint.value = '';
        nextTick(() => window.scrollTo?.({ top: 0, behavior: 'smooth' }));
    };

    const validateDraft = () => {
        const missing = [];
        if (!String(draft.value.name || '').trim()) missing.push('Profile 名称');
        if (!String(draft.value.host || '').trim()) missing.push('设备地址');
        if (
            !Number.isInteger(Number(draft.value.port)) ||
            Number(draft.value.port) < 1 ||
            Number(draft.value.port) > 65535
        ) {
            missing.push('有效端口');
        }
        if (!String(draft.value.username || '').trim()) missing.push('用户名');
        if (
            draft.value.authMethod === 'password' &&
            !String(draft.value.password || '') &&
            !(draft.value.hasSavedCredentials && draft.value.rememberCredentials)
        ) {
            missing.push('密码');
        }
        if (draft.value.authMethod === 'privateKey' && !String(draft.value.privateKeyPath || '').trim()) {
            missing.push('私钥路径');
        }
        if (missing.length === 0) return true;
        notify.error(`连接设置不完整，请填写：${missing.join('、')}`);
        return false;
    };

    const persistProfile = async ({ silent = false } = {}) => {
        if (!validateDraft()) return null;
        const actionRevision = ++saveRequestRevision;
        const requestContextRevision = profileContextRevision;
        const oldId = String(selectedProfileId.value || '');
        const draftSnapshot = normalizeProfile(clonePlain(draft.value));
        saving.value = true;
        try {
            const payload = normalizeProfile(clonePlain(draftSnapshot));
            if (String(payload.id).startsWith('draft-')) delete payload.id;
            const { data } = await invokeBridge('netconfApi', 'saveProfile', clonePlain(payload));
            const returned = data?.profile || data || { ...payload, id: oldId };
            const saved = normalizeProfile({
                ...draftSnapshot,
                ...returned,
                password: returned.password || draftSnapshot.password,
                passphrase: returned.passphrase || draftSnapshot.passphrase
            });
            const existingIndex = profiles.value.findIndex(profile => profile.id === oldId);
            if (existingIndex >= 0) profiles.value.splice(existingIndex, 1, saved);
            else profiles.value.push(saved);
            const contextCurrent = profileContextMatches(oldId, requestContextRevision);
            if (contextCurrent) {
                profileContextRevision += 1;
                selectedProfileId.value = saved.id;
                upsertSharedProfile(saved, { select: false });
                applyDraft(saved);
            } else {
                upsertSharedProfile(saved, { select: false });
            }
            if (!silent) notify.success('连接 Profile 已保存');
            return contextCurrent ? saved : null;
        } catch (error) {
            if (profileContextMatches(oldId, requestContextRevision)) notify.error(`保存失败：${error.message}`);
            return null;
        } finally {
            if (actionRevision === saveRequestRevision) saving.value = false;
        }
    };

    const saveProfile = () => persistProfile();

    const deleteProfile = () => {
        const profile = selectedProfile.value || draft.value;
        if (!profile?.id) return;
        dialog.confirm({
            title: '删除连接 Profile',
            content: `确定删除“${profile.name || profile.host || '未命名连接'}”吗？`,
            okText: '删除',
            okType: 'danger',
            onOk: async () => {
                try {
                    if (!String(profile.id).startsWith('draft-')) {
                        await invokeBridge('netconfApi', 'deleteProfile', profile.id);
                    }
                    profileConnectionStatuses.delete(String(profile.id));
                    processedProfileConnections.delete(String(profile.id));
                    pendingProfileSwitches.delete(String(profile.id));
                    if (profileDataLoad.value.profileId === String(profile.id)) {
                        profileDataLoadRevision += 1;
                        profileDataLoad.value = { ...profileDataLoad.value, visible: false };
                    }
                    profiles.value = profiles.value.filter(item => item.id !== profile.id);
                    const nextId = removeSharedProfile(profile.id);
                    if (selectedProfileId.value === profile.id) {
                        const next = profiles.value.find(item => item.id === nextId) || profiles.value[0];
                        invalidateProfileContext();
                        selectedProfileId.value = next?.id || '';
                        applyDraft(next || DEFAULT_NETCONF_PROFILE);
                        session.value = {
                            status: NETCONF_SESSION_STATUS.DISCONNECTED,
                            connected: false,
                            capabilities: []
                        };
                        if (next?.id && !String(next.id).startsWith('draft-')) void loadSessionState();
                    }
                    notify.success('连接 Profile 已删除');
                } catch (error) {
                    notify.error(`删除失败：${error.message}`);
                }
            }
        });
    };

    const testConnection = async () => {
        if (!validateDraft()) return;
        const actionRevision = ++testRequestRevision;
        const profileId = String(selectedProfileId.value || '');
        const requestContextRevision = profileContextRevision;
        const requestProfile = clonePlain(draft.value);
        testing.value = true;
        try {
            const startedAt = Date.now();
            const { data } = await invokeBridge('netconfApi', 'testConnection', requestProfile);
            if (!profileContextMatches(profileId, requestContextRevision)) return;
            testResult.value = {
                success: true,
                latency: data?.latency ?? Date.now() - startedAt,
                ...(data || {})
            };
            testResultOpen.value = true;
        } catch (error) {
            if (!profileContextMatches(profileId, requestContextRevision)) return;
            testResult.value = { success: false, message: error.message };
            testResultOpen.value = true;
        } finally {
            if (actionRevision === testRequestRevision) testing.value = false;
        }
    };

    const selectPrivateKey = async () => {
        const actionRevision = ++privateKeyRequestRevision;
        const profileId = String(selectedProfileId.value || '');
        const requestContextRevision = profileContextRevision;
        privateKeySelecting.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'selectPrivateKey');
            if (!profileContextMatches(profileId, requestContextRevision)) return;
            const filePath = typeof data === 'string' ? data : data?.filePath || data?.path || '';
            if (filePath) draft.value.privateKeyPath = filePath;
        } catch (error) {
            if (profileContextMatches(profileId, requestContextRevision)) {
                notify.error(`选择私钥失败：${error.message}`);
            }
        } finally {
            if (actionRevision === privateKeyRequestRevision) privateKeySelecting.value = false;
        }
    };

    const connectProfile = async () => {
        if (connecting.value) return;
        if (!validateDraft()) return;
        const actionRevision = ++connectRequestRevision;
        const initialProfileId = String(selectedProfileId.value || '');
        const initialContextRevision = profileContextRevision;
        let targetProfileId = initialProfileId;
        let targetContextRevision = initialContextRevision;
        connecting.value = true;
        try {
            const saved = isDirty.value ? await persistProfile({ silent: true }) : selectedProfile.value || draft.value;
            if (!saved) {
                if (!profileContextMatches(initialProfileId, initialContextRevision)) return;
                throw new Error('Profile 保存失败，连接已取消');
            }
            targetProfileId = String(saved.id || '');
            targetContextRevision = profileContextRevision;
            if (!profileContextMatches(targetProfileId, targetContextRevision)) return;
            pendingProfileSwitches.set(targetProfileId, sharedProfileId.value !== targetProfileId);
            profileConnectionStatuses.set(targetProfileId, NETCONF_SESSION_STATUS.CONNECTING);
            showProfileConnectionProgress(saved);
            session.value = { ...session.value, status: NETCONF_SESSION_STATUS.CONNECTING, message: '正在连接设备' };
            const target = saved.id || clonePlain(saved);
            const { data } = await invokeBridge('netconfApi', 'connect', target);
            if (!profileContextMatches(targetProfileId, targetContextRevision)) return;
            session.value = {
                ...session.value,
                ...(data || {}),
                status: NETCONF_SESSION_STATUS.CONNECTED,
                connected: true,
                profileId: data?.profileId || saved.id
            };
            updateConnectedProfile(session.value, {
                force: true,
                reason: 'connected',
                profileChanged: pendingProfileSwitches.get(targetProfileId)
            });
        } catch (error) {
            if (!profileContextMatches(targetProfileId, targetContextRevision)) return;
            session.value = {
                ...session.value,
                status: NETCONF_SESSION_STATUS.ERROR,
                connected: false,
                message: error.message
            };
            profileConnectionStatuses.set(targetProfileId, NETCONF_SESSION_STATUS.ERROR);
            pendingProfileSwitches.delete(targetProfileId);
            showProfileConnectionFailure(targetProfileId, error);
        } finally {
            if (profileConnectionStatuses.get(targetProfileId) !== NETCONF_SESSION_STATUS.CONNECTED) {
                pendingProfileSwitches.delete(targetProfileId);
            }
            if (actionRevision === connectRequestRevision) connecting.value = false;
        }
    };

    const disconnectProfile = async () => {
        const actionRevision = ++disconnectRequestRevision;
        const profileId = String(activeProfileId.value || selectedProfileId.value || '');
        const requestContextRevision = profileContextRevision;
        disconnecting.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'disconnect', profileId || undefined);
            if (!profileContextMatches(profileId, requestContextRevision)) return;
            session.value = {
                ...(data || {}),
                status: NETCONF_SESSION_STATUS.DISCONNECTED,
                connected: false,
                capabilities: []
            };
            updateConnectedProfile(session.value);
            notify.success('NETCONF 连接已断开');
        } catch (error) {
            if (profileContextMatches(profileId, requestContextRevision)) {
                notify.error(`断开连接失败：${error.message}`);
            }
        } finally {
            if (actionRevision === disconnectRequestRevision) disconnecting.value = false;
        }
    };

    const handleSessionEvent = payload => {
        if (payload?.status === 'error') {
            session.value = { ...session.value, status: NETCONF_SESSION_STATUS.ERROR, message: payload.msg };
            return;
        }
        const data = normalizeSessionEvent(payload, session.value);
        const profileId = String(data?.profileId || data?.connectionId || '');
        const status = String(data?.status || data?.state || '').toLowerCase();
        const previousStatus = profileConnectionStatuses.get(profileId);
        const pendingExplicitConnect = pendingProfileSwitches.has(profileId);
        const connected = data?.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
        if (connected && !pendingExplicitConnect && profileId && profileId !== sharedProfileId.value) {
            profileConnectionStatuses.set(profileId, status);
            return;
        }
        if (
            status === NETCONF_SESSION_STATUS.RECONNECTING &&
            previousStatus !== NETCONF_SESSION_STATUS.RECONNECTING &&
            profileId === sharedProfileId.value &&
            !pendingExplicitConnect
        ) {
            const profile = profiles.value.find(item => item.id === profileId) || data;
            showProfileConnectionProgress(profile, '连接中断，正在重新连接设备');
        }
        if (pendingExplicitConnect && connected) {
            profileConnectionStatuses.set(profileId, NETCONF_SESSION_STATUS.CONNECTED);
        } else {
            updateConnectedProfile(data);
        }
        if (data?.profileId && data.profileId !== selectedProfileId.value) return;
        session.value = data;
        connecting.value = ['connecting', 'reconnecting'].includes(data.status || data.state);
        disconnecting.value = (data.status || data.state) === 'disconnecting';
    };

    const clearValidationErrors = () => {};

    defineExpose({
        clearValidationErrors,
        refresh: async () => {
            await loadProfiles();
            await loadSessionState({ activateSharedProfile: true });
        }
    });

    watch(sharedProfileId, profileId => {
        if (!profileId || profileId === selectedProfileId.value) return;
        const profile = profiles.value.find(item => item.id === profileId);
        if (!profile) return;
        invalidateProfileContext();
        selectedProfileId.value = profile.id;
        applyDraft(profile);
        session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
        void loadSessionState();
    });

    onMounted(async () => {
        EventBus.on(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.CONNECTION, handleSessionEvent);
        try {
            await loadProfiles();
            await loadSessionState({ activateSharedProfile: true });
        } finally {
            initialConnectionLoadSettled = true;
        }
    });

    onActivated(async () => {
        connectionPageActive.value = true;
        if (!initialConnectionLoadSettled) return;
        await loadProfiles();
        await loadSessionState({ activateSharedProfile: true });
    });

    onDeactivated(() => {
        connectionPageActive.value = false;
        if (profileDataLoad.value.visible) {
            dismissedProfileDataLoadOperationId = profileDataLoad.value.operationId;
            profileDataLoad.value = { ...profileDataLoad.value, visible: false };
        }
        capabilityDrawerOpen.value = false;
        testResultOpen.value = false;
    });

    onBeforeUnmount(() => {
        connectionPageActive.value = false;
        EventBus.off(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.CONNECTION);
        profileDataLoadRevision += 1;
    });
</script>

<style scoped>
    .yang-connection-page,
    .connection-card {
        height: 100%;
        min-height: 0;
    }

    .connection-card {
        display: flex;
        flex-direction: column;
    }

    .connection-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        gap: 8px;
        overflow-y: auto;
    }

    .connection-layout {
        display: grid;
        min-width: 0;
        min-height: 0;
        flex: 1;
        grid-template-columns: minmax(220px, 26%) minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) auto;
        grid-template-areas:
            'profile editor'
            'profile session';
        gap: 8px;
        align-items: stretch;
    }

    .connection-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .connection-panel-header {
        display: flex;
        min-width: 0;
        min-height: 42px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 6px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .connection-panel-heading {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
    }

    .connection-panel-title,
    .connection-panel-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .connection-panel-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .connection-panel-meta {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .connection-panel-body {
        min-height: 0;
        flex: 1;
        padding: 10px;
        overflow: auto;
    }

    .profile-card {
        grid-area: profile;
        min-height: 0;
    }

    .profile-editor-card {
        grid-area: editor;
        min-height: 0;
    }

    .profile-panel-body {
        overflow: hidden;
    }

    .profile-panel-body :deep(.nn-spin-nested-loading),
    .profile-panel-body :deep(.nn-spin-container) {
        height: 100%;
        min-height: 0;
    }

    .profile-list {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        gap: 5px;
        overflow-y: auto;
    }

    .profile-list-item {
        display: flex;
        width: 100%;
        min-width: 0;
        align-items: center;
        gap: 10px;
        padding: 9px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        text-align: left;
    }

    .profile-list-item:hover {
        background: var(--nn-color-bg-hover);
    }

    .profile-list-item-active {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-bg-info-subtle);
    }

    .profile-avatar {
        display: inline-flex;
        width: 32px;
        height: 32px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-primary);
        font-size: 17px;
    }

    .profile-content {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
    }

    .profile-name,
    .profile-address {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .profile-name {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 500;
    }

    .profile-address {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .profile-online-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--nn-color-success);
    }

    .profile-form {
        width: 100%;
        max-width: none;
        padding-top: 2px;
    }

    .private-key-picker {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 6px;
    }

    .private-key-picker :deep(.nn-input-affix-wrapper),
    .private-key-picker :deep(.nn-input) {
        min-width: 0;
        flex: 1;
    }

    .profile-options {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
    }

    .session-card {
        grid-area: session;
        flex: 0 0 auto;
    }

    .session-panel-header {
        min-height: 38px;
    }

    .session-panel-body {
        padding: 8px;
        overflow: hidden;
    }

    .profile-data-load {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
    }

    .profile-data-load-warning {
        border-color: var(--nn-color-warning);
    }

    .profile-data-load-failed {
        border-color: var(--nn-color-error);
    }

    .profile-data-load-header,
    .profile-data-load-heading,
    .profile-data-load-detail,
    .profile-data-load-summary {
        display: flex;
        min-width: 0;
        align-items: center;
    }

    .profile-data-load-header,
    .profile-data-load-detail {
        justify-content: space-between;
        gap: 10px;
    }

    .profile-data-load-heading,
    .profile-data-load-summary {
        flex-wrap: wrap;
        gap: 8px;
    }

    .profile-data-load-title {
        flex: none;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 600;
    }

    .profile-data-load-profile,
    .profile-data-load-detail,
    .profile-data-load-summary {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .profile-data-load-profile,
    .profile-data-load-detail > span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .profile-data-load-detail > span:last-child {
        flex: none;
        font-variant-numeric: tabular-nums;
    }

    .profile-data-load-actions {
        display: flex;
        justify-content: flex-end;
    }

    .session-table :deep(.nn-table-row) {
        cursor: default;
    }

    .session-actions {
        white-space: nowrap;
    }

    .session-offline {
        display: inline-flex;
        height: 24px;
        align-items: center;
        color: var(--nn-color-text-muted);
    }

    .capability-drawer-content {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
    }

    .capability-search {
        flex: 0 0 auto;
        margin-bottom: 10px;
    }

    .capability-list {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .capability-row {
        padding: 7px 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        overflow-wrap: anywhere;
    }

    .capability-row:last-child {
        border-bottom: 0;
    }

    .test-result-detail {
        margin-top: 12px;
    }

    @media (max-width: 980px) {
        .connection-layout {
            grid-template-columns: 1fr;
            grid-template-rows: auto minmax(0, 1fr) auto;
            grid-template-areas:
                'profile'
                'editor'
                'session';
        }

        .profile-card {
            min-height: 180px;
        }

        .profile-list {
            max-height: 220px;
        }
    }

    @media (max-width: 720px) {
        .profile-editor-header {
            align-items: flex-start;
            flex-direction: column;
        }

        .profile-editor-actions {
            width: 100%;
        }
    }

    @media (max-width: 575px) {
        .private-key-picker {
            align-items: stretch;
            flex-direction: column;
        }
    }
</style>
