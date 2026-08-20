<template>
    <nn-settings class="tcp-md5-settings" data-testid="tcp-md5-settings">
        <nn-settings-section
            title="TCP MD5 Profiles"
            description="集中管理 BMP 与 RPKI-RTR 共用的 TCP MD5 对端和密钥。密钥在本机加密保存，加载时不会返回明文。"
        >
            <nn-alert
                type="info"
                message="一个 Profile 对应一个 IPv4/IPv6 对端地址或 CIDR 前缀及一把 TCP MD5 密钥。"
                description="TCP MD5 用于兼容旧设备，新部署优先使用 TCP-AO。BMP 可选择多个互不重叠的 Profile，RPKI 选择一个；修改后需重启对应服务。"
                show-icon
                variant="subtle"
                class="tcp-md5-guidance"
            />

            <div v-if="loading" class="tcp-md5-empty">正在加载 TCP MD5 配置…</div>
            <div v-else-if="profiles.length === 0" class="tcp-md5-empty" data-testid="tcp-md5-empty-state">
                尚未配置 TCP MD5 Profile。添加并保存后，可在 BMP 或 RPKI 服务器配置中选择。
            </div>

            <div v-else class="tcp-md5-profile-list">
                <section
                    v-for="(profile, profileIndex) in profiles"
                    :key="profile.id"
                    class="tcp-md5-profile"
                    :aria-label="`TCP MD5 Profile ${profileIndex + 1}`"
                    :data-testid="`tcp-md5-profile-${profileIndex}`"
                >
                    <div class="tcp-md5-profile-header">
                        <div>
                            <strong>Profile {{ profileIndex + 1 }}</strong>
                            <nn-tag :color="savedKeyStatusColor(profile)">
                                {{ savedKeyStatusLabel(profile) }}
                            </nn-tag>
                            <nn-tag v-for="consumer in profile.usedBy" :key="consumer" color="blue">
                                {{ consumer }} 使用中
                            </nn-tag>
                        </div>
                        <nn-tooltip :title="profileDeleteDisabledReason(profile)">
                            <span>
                                <nn-button
                                    danger
                                    size="small"
                                    :disabled="isProfileInUse(profile)"
                                    :aria-label="`删除 TCP MD5 Profile ${profileIndex + 1}`"
                                    :data-testid="`tcp-md5-delete-profile-${profileIndex}`"
                                    @click="removeProfile(profileIndex)"
                                >
                                    删除 Profile
                                </nn-button>
                            </span>
                        </nn-tooltip>
                    </div>

                    <div class="tcp-md5-profile-grid">
                        <div class="tcp-md5-field">
                            <label :for="profileFieldId(profile, 'name')">Profile 名称</label>
                            <nn-input
                                :id="profileFieldId(profile, 'name')"
                                v-model:value="profile.name"
                                :status="profileFieldError(profile, 'name') ? 'error' : ''"
                                :data-testid="`tcp-md5-profile-name-${profileIndex}`"
                                maxlength="64"
                                placeholder="例如：核心路由器"
                            />
                            <span v-if="profileFieldError(profile, 'name')" class="tcp-md5-field-error" role="alert">
                                {{ profileFieldError(profile, 'name') }}
                            </span>
                        </div>

                        <div class="tcp-md5-field">
                            <label :for="profileFieldId(profile, 'peer')">对端地址/前缀</label>
                            <nn-input
                                :id="profileFieldId(profile, 'peer')"
                                v-model:value="profile.peer"
                                :status="profileFieldError(profile, 'peer') ? 'error' : ''"
                                :data-testid="`tcp-md5-profile-peer-${profileIndex}`"
                                placeholder="192.0.2.1、192.0.2.0/24 或 2001:db8::/64"
                            />
                            <span class="tcp-md5-field-hint">
                                CIDR 必须填写网络地址；BMP 同一监听器选择的范围不能重叠。
                            </span>
                            <span v-if="profileFieldError(profile, 'peer')" class="tcp-md5-field-error" role="alert">
                                {{ profileFieldError(profile, 'peer') }}
                            </span>
                        </div>

                        <div class="tcp-md5-field tcp-md5-field-secret">
                            <label :for="profileFieldId(profile, 'key')">
                                {{ profile.hasSavedKey ? '替换密钥（可选）' : '密钥' }}
                            </label>
                            <nn-input-password
                                :id="profileFieldId(profile, 'key')"
                                v-model:value="profile.key"
                                :status="profileFieldError(profile, 'key') ? 'error' : ''"
                                :data-testid="`tcp-md5-key-secret-${profileIndex}`"
                                autocomplete="new-password"
                                placeholder="明文仅在本次保存时提交"
                            />
                            <span class="tcp-md5-field-hint">1–80 个 UTF-8 字节，不能包含 NUL 字符。</span>
                            <span v-if="profileFieldError(profile, 'key')" class="tcp-md5-field-error" role="alert">
                                {{ profileFieldError(profile, 'key') }}
                            </span>
                        </div>
                    </div>
                </section>
            </div>

            <div class="tcp-md5-list-actions">
                <nn-button
                    data-testid="tcp-md5-add-profile-button"
                    :disabled="profiles.length >= MAX_PROFILE_COUNT"
                    @click="addProfile"
                >
                    添加 Profile
                </nn-button>
                <span>{{ profiles.length }} / {{ MAX_PROFILE_COUNT }}</span>
            </div>
        </nn-settings-section>

        <div class="settings-page-actions">
            <nn-button
                type="primary"
                data-testid="tcp-md5-save-button"
                :loading="saving"
                :disabled="loading"
                @click="saveSettings"
            >
                保存设置
            </nn-button>
        </div>
    </nn-settings>
</template>

<script setup>
    import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
    import ipaddr from 'ipaddr.js';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';

    const TCP_MD5_SETTINGS_CHANGED_EVENT = 'tcp-md5:settingsChanged';
    const MAX_PROFILE_COUNT = 32;
    const MAX_KEY_BYTES = 80;
    const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

    const profiles = ref([]);
    const profileErrors = ref({});
    const loading = ref(false);
    const saving = ref(false);
    let generatedIdSequence = 0;
    let settingsLoaded = false;
    let loadRequestId = 0;
    let profileUsageRequestId = 0;

    const createId = prefix => {
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
        generatedIdSequence += 1;
        return `${prefix}-${Date.now().toString(36)}-${generatedIdSequence.toString(36)}`;
    };

    const normalizeProfileConsumers = source =>
        Array.isArray(source) ? [...new Set(source.filter(consumer => consumer === 'BMP' || consumer === 'RPKI'))] : [];

    const createProfile = (source = {}) => {
        const savedKeyStatus = ['available', 'unavailable', 'missing'].includes(source.savedKeyStatus)
            ? source.savedKeyStatus
            : source.hasSavedKey === true
              ? 'available'
              : 'missing';
        return {
            id: String(source.id || createId('tcp-md5-profile')),
            name: String(source.name || ''),
            peer: String(source.peer || ''),
            key: '',
            hasSavedKey: source.hasSavedKey === true && savedKeyStatus !== 'unavailable',
            savedKeyStatus,
            usedBy: normalizeProfileConsumers(source.usedBy)
        };
    };

    const profileFieldId = (profile, field) => `tcp-md5-${profile.id}-${field}`;
    const profileFieldError = (profile, field) => profileErrors.value[profile.id]?.[field] || '';
    const isProfileInUse = profile => profile.usedBy.length > 0;
    const profileDeleteDisabledReason = profile =>
        isProfileInUse(profile) ? `正在被 ${profile.usedBy.join('、')} 配置引用，解除引用后才能删除` : '';
    const savedKeyStatusColor = profile =>
        profile.savedKeyStatus === 'unavailable' ? 'red' : profile.hasSavedKey ? 'green' : 'orange';
    const savedKeyStatusLabel = profile =>
        profile.savedKeyStatus === 'unavailable'
            ? '密钥不可用，需重新输入'
            : profile.hasSavedKey
              ? '已保存到本机'
              : '尚未保存';

    const normalizePeer = value => {
        const text = String(value || '').trim();
        if (!text) throw new Error('请输入对端地址或前缀');
        let address;
        let prefixLength;
        if (text.includes('/')) {
            [address, prefixLength] = ipaddr.parseCIDR(text);
            const networkAddress =
                address.kind() === 'ipv4'
                    ? ipaddr.IPv4.networkAddressFromCIDR(text)
                    : ipaddr.IPv6.networkAddressFromCIDR(text);
            if (networkAddress.toString() !== address.toString()) {
                throw new Error('CIDR 前缀必须使用网络地址，主机位应为 0');
            }
        } else {
            address = ipaddr.parse(text);
            prefixLength = address.kind() === 'ipv4' ? 32 : 128;
        }
        return `${address.toString()}/${prefixLength}`;
    };

    const keyByteLength = value => new TextEncoder().encode(String(value || '')).length;

    const validateProfiles = () => {
        const errors = {};
        const ids = new Set();
        const names = new Map();
        profiles.value.forEach((profile, profileIndex) => {
            const itemErrors = {};
            const id = String(profile.id || '');
            if (!PROFILE_ID_PATTERN.test(id) || ids.has(id))
                itemErrors.name = 'Profile 标识无效或重复，请删除后重新添加';
            ids.add(id);

            const name = String(profile.name || '').trim();
            if (!name) {
                itemErrors.name = '请输入 Profile 名称';
            } else if (name.length > 64) {
                itemErrors.name = 'Profile 名称不能超过 64 个字符';
            } else {
                const nameKey = name.toLocaleLowerCase();
                if (names.has(nameKey)) itemErrors.name = `Profile 名称与第 ${names.get(nameKey) + 1} 条重复`;
                else names.set(nameKey, profileIndex);
            }

            try {
                normalizePeer(profile.peer);
            } catch (error) {
                itemErrors.peer =
                    error.message === 'CIDR 前缀必须使用网络地址，主机位应为 0'
                        ? error.message
                        : '请输入有效的 IPv4、IPv6 地址或 CIDR 前缀';
            }

            const key = String(profile.key || '');
            if (!key && !profile.hasSavedKey) {
                itemErrors.key = '请输入 TCP MD5 密钥';
            } else if (key.includes('\0')) {
                itemErrors.key = '密钥不能包含 NUL 字符';
            } else if (keyByteLength(key) > MAX_KEY_BYTES) {
                itemErrors.key = `密钥不能超过 ${MAX_KEY_BYTES} 个 UTF-8 字节`;
            }
            if (Object.keys(itemErrors).length > 0) errors[id] = itemErrors;
        });
        profileErrors.value = errors;
        return Object.keys(errors).length === 0;
    };

    const normalizeProfileForSave = profile => ({
        id: String(profile.id),
        name: String(profile.name).trim(),
        peer: normalizePeer(profile.peer),
        key: String(profile.key || ''),
        hasSavedKey: profile.hasSavedKey === true
    });

    const sanitizeProfilesForRenderer = source =>
        (Array.isArray(source) ? source : []).slice(0, MAX_PROFILE_COUNT).map(createProfile);

    const profilesForEvent = () =>
        profiles.value.map(profile => ({
            id: profile.id,
            name: profile.name,
            peer: profile.peer,
            hasSavedKey: profile.hasSavedKey,
            savedKeyStatus: profile.savedKeyStatus,
            usedBy: [...profile.usedBy]
        }));

    const emitProfilesChanged = () => EventBus.emit(TCP_MD5_SETTINGS_CHANGED_EVENT, profilesForEvent());

    const wipePlaintextKeys = () => {
        profiles.value.forEach(profile => {
            profile.key = '';
        });
    };

    const requestStoredSettings = async () => {
        if (typeof window.rpkiApi?.loadTcpMd5Settings !== 'function') {
            throw new Error('当前后端未提供 TCP MD5 设置接口');
        }
        const result = await window.rpkiApi.loadTcpMd5Settings();
        if (result?.status !== 'success') throw new Error(result?.msg || '加载 TCP MD5 设置失败');
        return result.data || {};
    };

    const profilesFromSettings = data => (Array.isArray(data) ? data : data?.profiles);

    const reconcileProfileUsage = (source, { restoreReferencedProfiles = false } = {}) => {
        const storedProfiles = Array.isArray(source) ? source.slice(0, MAX_PROFILE_COUNT) : [];
        const storedById = new Map(storedProfiles.map(item => [String(item?.id || ''), item]));
        const localIds = new Set(profiles.value.map(profile => profile.id));

        profiles.value.forEach(profile => {
            const stored = storedById.get(profile.id);
            if (!stored) return;
            profile.usedBy = normalizeProfileConsumers(stored.usedBy);
            profile.savedKeyStatus = ['available', 'unavailable', 'missing'].includes(stored.savedKeyStatus)
                ? stored.savedKeyStatus
                : stored.hasSavedKey === true
                  ? 'available'
                  : 'missing';
            profile.hasSavedKey = stored.hasSavedKey === true && profile.savedKeyStatus !== 'unavailable';
        });

        if (!restoreReferencedProfiles) return;
        storedProfiles.forEach(stored => {
            const id = String(stored?.id || '');
            if (!id || localIds.has(id) || normalizeProfileConsumers(stored.usedBy).length === 0) return;
            profiles.value.push(createProfile(stored));
            localIds.add(id);
        });
    };

    const refreshProfileUsage = async ({ restoreReferencedProfiles = false, notifyFailure = true } = {}) => {
        if (!settingsLoaded || loading.value) return false;
        const requestId = ++profileUsageRequestId;
        try {
            const data = await requestStoredSettings();
            if (requestId !== profileUsageRequestId) return false;
            reconcileProfileUsage(profilesFromSettings(data), { restoreReferencedProfiles });
            emitProfilesChanged();
            return true;
        } catch (error) {
            if (requestId !== profileUsageRequestId) return false;
            console.error('刷新 TCP MD5 Profile 使用状态失败', error);
            if (notifyFailure) notify.error(error.message || '刷新 TCP MD5 Profile 使用状态失败');
            return false;
        }
    };

    const loadSettings = async ({ notifyFailure = true } = {}) => {
        if (loading.value) return;
        const requestId = ++loadRequestId;
        profileUsageRequestId += 1;
        loading.value = true;
        try {
            const data = await requestStoredSettings();
            if (requestId !== loadRequestId) return;
            profiles.value = sanitizeProfilesForRenderer(profilesFromSettings(data));
            profileErrors.value = {};
            settingsLoaded = true;
            emitProfilesChanged();
        } catch (error) {
            if (requestId !== loadRequestId) return;
            console.error('加载 TCP MD5 设置失败', error);
            if (notifyFailure) notify.error(error.message || '加载 TCP MD5 设置失败');
        } finally {
            if (requestId === loadRequestId) loading.value = false;
        }
    };

    const addProfile = () => {
        if (profiles.value.length < MAX_PROFILE_COUNT) profiles.value.push(createProfile());
    };

    const removeProfile = index => {
        const profile = profiles.value[index];
        if (profile && isProfileInUse(profile)) {
            notify.warning(profileDeleteDisabledReason(profile));
            return;
        }
        const [removed] = profiles.value.splice(index, 1);
        if (!removed) return;
        const nextErrors = { ...profileErrors.value };
        delete nextErrors[removed.id];
        profileErrors.value = nextErrors;
    };

    const saveSettings = async () => {
        if (!validateProfiles()) {
            notify.error('请修正 TCP MD5 Profile 配置');
            return;
        }
        saving.value = true;
        try {
            if (typeof window.rpkiApi?.saveTcpMd5Settings !== 'function') {
                throw new Error('当前后端未提供 TCP MD5 设置接口');
            }
            const payloadProfiles = profiles.value.map(normalizeProfileForSave);
            const previousUsage = new Map(profiles.value.map(profile => [profile.id, [...profile.usedBy]]));
            const result = await window.rpkiApi.saveTcpMd5Settings({ profiles: payloadProfiles });
            if (result?.status !== 'success') throw new Error(result?.msg || '保存 TCP MD5 设置失败');

            const returnedProfiles = profilesFromSettings(result.data);
            if (Array.isArray(returnedProfiles)) {
                profiles.value = sanitizeProfilesForRenderer(returnedProfiles);
            } else {
                profiles.value = payloadProfiles.map(profile =>
                    createProfile({
                        ...profile,
                        hasSavedKey: profile.hasSavedKey || Boolean(profile.key),
                        savedKeyStatus: 'available',
                        usedBy: previousUsage.get(profile.id) || []
                    })
                );
                await refreshProfileUsage({ notifyFailure: false });
            }
            profileErrors.value = {};
            settingsLoaded = true;
            emitProfilesChanged();
            notify.success('TCP MD5 设置已保存');
        } catch (error) {
            console.error('保存 TCP MD5 设置失败', error);
            await refreshProfileUsage({ restoreReferencedProfiles: true, notifyFailure: false });
            notify.error(error.message || '保存 TCP MD5 设置失败');
        } finally {
            saving.value = false;
        }
    };

    const resumeBackgroundWork = () => {
        if (loading.value) return;
        if (settingsLoaded) void refreshProfileUsage();
        else void loadSettings();
    };

    onMounted(loadSettings);
    onActivated(resumeBackgroundWork);
    onDeactivated(wipePlaintextKeys);
    onBeforeUnmount(wipePlaintextKeys);

    defineExpose({
        wipePlaintextKeys,
        pauseBackgroundWork: wipePlaintextKeys,
        resumeBackgroundWork
    });
</script>

<style scoped>
    .tcp-md5-settings {
        max-width: 100%;
    }

    .tcp-md5-guidance {
        margin-bottom: 12px;
    }

    .tcp-md5-empty {
        padding: 24px 16px;
        border: 1px dashed var(--nn-color-border);
        border-radius: 4px;
        color: var(--nn-color-text-secondary);
        text-align: center;
    }

    .tcp-md5-profile-list {
        display: grid;
        gap: 12px;
    }

    .tcp-md5-profile {
        padding: 14px;
        border: 1px solid var(--nn-color-border);
        border-radius: 4px;
        background: var(--nn-color-bg-surface);
    }

    .tcp-md5-profile-header,
    .tcp-md5-profile-header > div,
    .tcp-md5-list-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
    }

    .tcp-md5-profile-header {
        margin-bottom: 12px;
    }

    .tcp-md5-profile-header > div {
        flex-wrap: wrap;
        justify-content: flex-start;
    }

    .tcp-md5-profile-grid {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) minmax(280px, 2fr);
        gap: 12px;
    }

    .tcp-md5-field {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
    }

    .tcp-md5-field-secret {
        grid-column: 1 / -1;
    }

    .tcp-md5-field > label {
        color: var(--nn-color-text);
        font-size: 13px;
        font-weight: 500;
    }

    .tcp-md5-field-hint,
    .tcp-md5-list-actions > span {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .tcp-md5-field-error {
        color: var(--nn-color-error);
        font-size: 12px;
    }

    .tcp-md5-list-actions {
        justify-content: flex-start;
        margin-top: 12px;
    }

    .settings-page-actions {
        display: flex;
        justify-content: flex-end;
        padding-top: 12px;
    }

    @media (max-width: 900px) {
        .tcp-md5-profile-grid {
            grid-template-columns: 1fr;
        }

        .tcp-md5-field-secret {
            grid-column: auto;
        }
    }
</style>
