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
                                        使用系统安全存储保存凭据
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
    import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
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
    import { ApiOutlined, CloudServerOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from '../../ui/icons';
    import {
        clonePlain,
        formatDateTime,
        invokeBridge,
        normalizeCapability,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';

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

    const normalizeProfile = profile => ({
        ...clonePlain(DEFAULT_NETCONF_PROFILE),
        ...(profile || {}),
        id: profile?.id || profile?.profileId || '',
        port: Number(profile?.port || 830),
        connectTimeout: Number(profile?.connectTimeout || 15000),
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

    const loadProfiles = async ({ preserveSelection = true } = {}) => {
        profileLoading.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'listProfiles');
            profiles.value = unwrapArray(data, ['profiles', 'items']).map(normalizeProfile);
            const existing = preserveSelection
                ? profiles.value.find(profile => profile.id === selectedProfileId.value)
                : null;
            const nextProfile = existing || profiles.value[0];
            if (nextProfile) {
                selectedProfileId.value = nextProfile.id;
                applyDraft(nextProfile);
            } else {
                selectedProfileId.value = '';
                applyDraft(DEFAULT_NETCONF_PROFILE);
            }
        } catch (error) {
            notify.error(`加载连接 Profile 失败：${error.message}`);
        } finally {
            profileLoading.value = false;
        }
    };

    const loadSessionState = async () => {
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState');
            session.value = { ...session.value, ...(data || {}) };
        } catch (error) {
            console.warn('Unable to load NETCONF session state:', error.message);
        }
    };

    const selectProfile = profile => {
        selectedProfileId.value = profile.id;
        applyDraft(profile);
    };

    const addProfile = () => {
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
        saving.value = true;
        try {
            const payload = normalizeProfile(draft.value);
            if (String(payload.id).startsWith('draft-')) delete payload.id;
            const { data } = await invokeBridge('netconfApi', 'saveProfile', clonePlain(payload));
            const returned = data?.profile || data || { ...payload, id: draft.value.id };
            const saved = normalizeProfile({
                ...draft.value,
                ...returned,
                password: returned.password || draft.value.password,
                passphrase: returned.passphrase || draft.value.passphrase
            });
            const oldId = selectedProfileId.value;
            const existingIndex = profiles.value.findIndex(profile => profile.id === oldId);
            if (existingIndex >= 0) profiles.value.splice(existingIndex, 1, saved);
            else profiles.value.push(saved);
            selectedProfileId.value = saved.id;
            applyDraft(saved);
            if (!silent) notify.success('连接 Profile 已保存');
            return saved;
        } catch (error) {
            notify.error(`保存失败：${error.message}`);
            return null;
        } finally {
            saving.value = false;
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
                    profiles.value = profiles.value.filter(item => item.id !== profile.id);
                    const next = profiles.value[0];
                    selectedProfileId.value = next?.id || '';
                    applyDraft(next || DEFAULT_NETCONF_PROFILE);
                    notify.success('连接 Profile 已删除');
                } catch (error) {
                    notify.error(`删除失败：${error.message}`);
                }
            }
        });
    };

    const testConnection = async () => {
        if (!validateDraft()) return;
        testing.value = true;
        try {
            const startedAt = Date.now();
            const { data } = await invokeBridge('netconfApi', 'testConnection', clonePlain(draft.value));
            testResult.value = {
                success: true,
                latency: data?.latency ?? Date.now() - startedAt,
                ...(data || {})
            };
            testResultOpen.value = true;
        } catch (error) {
            testResult.value = { success: false, message: error.message };
            testResultOpen.value = true;
        } finally {
            testing.value = false;
        }
    };

    const selectPrivateKey = async () => {
        privateKeySelecting.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'selectPrivateKey');
            const filePath = typeof data === 'string' ? data : data?.filePath || data?.path || '';
            if (filePath) draft.value.privateKeyPath = filePath;
        } catch (error) {
            notify.error(`选择私钥失败：${error.message}`);
        } finally {
            privateKeySelecting.value = false;
        }
    };

    const connectProfile = async () => {
        if (!validateDraft()) return;
        connecting.value = true;
        session.value = { ...session.value, status: NETCONF_SESSION_STATUS.CONNECTING, message: '正在连接设备' };
        try {
            const saved = isDirty.value ? await persistProfile({ silent: true }) : selectedProfile.value || draft.value;
            if (!saved) throw new Error('Profile 保存失败，连接已取消');
            const target = saved.id || clonePlain(saved);
            const { data } = await invokeBridge('netconfApi', 'connect', target);
            session.value = {
                ...session.value,
                ...(data || {}),
                status: NETCONF_SESSION_STATUS.CONNECTED,
                connected: true,
                profileId: data?.profileId || saved.id
            };
            notify.success(`已连接 ${saved.name || saved.host}`);
        } catch (error) {
            session.value = {
                ...session.value,
                status: NETCONF_SESSION_STATUS.ERROR,
                connected: false,
                message: error.message
            };
            notify.error(`连接失败：${error.message}`);
        } finally {
            connecting.value = false;
        }
    };

    const disconnectProfile = async () => {
        disconnecting.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'disconnect', activeProfileId.value || undefined);
            session.value = {
                ...(data || {}),
                status: NETCONF_SESSION_STATUS.DISCONNECTED,
                connected: false,
                capabilities: []
            };
            notify.success('NETCONF 连接已断开');
        } catch (error) {
            notify.error(`断开连接失败：${error.message}`);
        } finally {
            disconnecting.value = false;
        }
    };

    const handleSessionEvent = payload => {
        if (payload?.status === 'error') {
            session.value = { ...session.value, status: NETCONF_SESSION_STATUS.ERROR, message: payload.msg };
            return;
        }
        const data = normalizeSessionEvent(payload, session.value);
        session.value = data;
        connecting.value = ['connecting', 'reconnecting'].includes(data.status || data.state);
        disconnecting.value = (data.status || data.state) === 'disconnecting';
    };

    const clearValidationErrors = () => {};

    defineExpose({ clearValidationErrors, refresh: () => Promise.all([loadProfiles(), loadSessionState()]) });

    onMounted(async () => {
        EventBus.on(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.CONNECTION, handleSessionEvent);
        await Promise.all([loadProfiles(), loadSessionState()]);
    });

    onActivated(loadSessionState);

    onBeforeUnmount(() => {
        EventBus.off(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.CONNECTION);
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
