const {
    normalizeTcpAoKey,
    normalizeTcpAoProfile,
    sanitizeTcpAoProfile,
    assertContinuousRotationSchedule
} = require('./tcpAoConfig');

const TCP_AO_SETTINGS_VERSION = 1;
const MAX_TCP_AO_PROFILES = 32;
const TCP_AO_AUTH_TYPE = 'tcp-ao';
const TCP_AO_PROFILE_CONSUMERS = Object.freeze({
    BMP: 'BMP',
    RPKI: 'RPKI'
});

class TcpAoSettingsStore {
    constructor(store, credentialStore, options = {}) {
        this.store = store;
        this.credentialStore = credentialStore;
        this.storageKey = options.storageKey || 'rpki-tcp-ao-settings';
    }

    getStoredSettings() {
        const settings = this.store?.get?.(this.storageKey);
        if (!settings || typeof settings !== 'object' || !Array.isArray(settings.profiles)) {
            return { version: TCP_AO_SETTINGS_VERSION, profiles: [] };
        }
        return settings;
    }

    getStoredKeyStatus(key, credentialAvailable = true) {
        if (!key?.keyEncrypted) return 'missing';
        if (!credentialAvailable) return 'unavailable';
        try {
            const plaintext = this.credentialStore.decrypt(key.keyEncrypted);
            normalizeTcpAoKey({ ...key, key: plaintext }, { requireKey: true });
            return 'available';
        } catch (_error) {
            return 'unavailable';
        }
    }

    getProfileUsage() {
        const usage = new Map();
        const addUsage = (profileId, consumer) => {
            const id = String(profileId || '').trim();
            if (!id) return;
            if (!usage.has(id)) usage.set(id, []);
            const consumers = usage.get(id);
            if (!consumers.includes(consumer)) consumers.push(consumer);
        };

        const bmpConfig = this.store?.get?.('bmp-config');
        if (bmpConfig?.authType === TCP_AO_AUTH_TYPE) {
            const profileIds = Array.isArray(bmpConfig.tcpAoProfileIds)
                ? bmpConfig.tcpAoProfileIds
                : bmpConfig.tcpAoProfileId
                  ? [bmpConfig.tcpAoProfileId]
                  : [];
            profileIds.forEach(profileId => addUsage(profileId, TCP_AO_PROFILE_CONSUMERS.BMP));
        }

        const rpkiConfig = this.store?.get?.('rpki-config');
        if (rpkiConfig?.authType === TCP_AO_AUTH_TYPE) {
            addUsage(rpkiConfig.tcpAoProfileId, TCP_AO_PROFILE_CONSUMERS.RPKI);
        }

        return usage;
    }

    assertReferencedProfilesNotRemoved(inputProfiles) {
        const submittedIds = new Set(
            inputProfiles.map(profile => String(profile?.id || '').trim()).filter(profileId => profileId.length > 0)
        );
        const removedProfiles = this.getStoredSettings().profiles.filter(profile => !submittedIds.has(profile.id));
        if (removedProfiles.length === 0) return;

        const usage = this.getProfileUsage();
        const referencedRemovals = removedProfiles
            .map(profile => ({ profile, consumers: usage.get(profile.id) || [] }))
            .filter(item => item.consumers.length > 0);
        if (referencedRemovals.length === 0) return;

        const details = referencedRemovals
            .map(({ profile, consumers }) => `“${profile.name || profile.id}”正被${consumers.join('、')}使用`)
            .join('；');
        throw new Error(`TCP-AO配置${details}，不能删除；请先在对应服务配置中取消引用`);
    }

    assertProfilesExist(profileIds) {
        const requestedIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
            .map(profileId => String(profileId || '').trim())
            .filter(profileId => profileId.length > 0);
        const storedIds = new Set(this.getStoredSettings().profiles.map(profile => profile.id));
        const missingIds = requestedIds.filter(profileId => !storedIds.has(profileId));
        if (missingIds.length > 0) {
            throw new Error(`选择的TCP-AO配置不存在: ${missingIds.join('、')}`);
        }
        return requestedIds;
    }

    listProfiles() {
        const settings = this.getStoredSettings();
        const usage = this.getProfileUsage();
        const credentialAvailable =
            typeof this.credentialStore.isAvailable === 'function' ? this.credentialStore.isAvailable() : true;
        return {
            version: TCP_AO_SETTINGS_VERSION,
            profiles: settings.profiles.map(profile => ({
                ...sanitizeTcpAoProfile({
                    ...profile,
                    keys: (profile.keys || []).map(key => {
                        const savedKeyStatus = this.getStoredKeyStatus(key, credentialAvailable);
                        return {
                            ...key,
                            hasSavedKey: savedKeyStatus === 'available',
                            savedKeyStatus
                        };
                    })
                }),
                usedBy: [...(usage.get(profile.id) || [])]
            }))
        };
    }

    saveSettings(settings = {}) {
        const inputProfiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
        if (inputProfiles.length > MAX_TCP_AO_PROFILES) {
            throw new Error(`TCP-AO配置最多保存${MAX_TCP_AO_PROFILES}条`);
        }
        this.assertReferencedProfilesNotRemoved(inputProfiles);

        const previousProfiles = new Map(this.getStoredSettings().profiles.map(profile => [profile.id, profile]));
        const seenIds = new Set();
        const seenNames = new Set();
        const storedProfiles = inputProfiles.map(profile => {
            const previous = previousProfiles.get(String(profile?.id || '').trim());
            const normalized = normalizeTcpAoProfile(profile, { requireKey: false });
            assertContinuousRotationSchedule(normalized);

            const normalizedName = normalized.name.toLocaleLowerCase();
            if (seenIds.has(normalized.id)) {
                throw new Error(`TCP-AO配置ID重复: ${normalized.id}`);
            }
            if (seenNames.has(normalizedName)) {
                throw new Error(`TCP-AO配置名称重复: ${normalized.name}`);
            }
            seenIds.add(normalized.id);
            seenNames.add(normalizedName);

            const previousKeys = new Map((previous?.keys || []).map(key => [key.id, key]));
            const keys = normalized.keys.map(key => {
                const previousKey = previousKeys.get(key.id);
                const hasNewKey = Buffer.byteLength(key.key, 'utf8') > 0;
                let keyEncrypted = previousKey?.keyEncrypted || '';
                if (!hasNewKey && keyEncrypted && previousKey?.algorithm !== key.algorithm) {
                    throw new Error(`TCP-AO配置“${normalized.name}”中的Key ID ${key.sndId}更换算法时必须重新输入密钥`);
                }
                if (!hasNewKey && keyEncrypted && this.getStoredKeyStatus(previousKey) !== 'available') {
                    throw new Error(`TCP-AO配置“${normalized.name}”中的Key ID ${key.sndId}无法读取，请重新输入密钥`);
                }
                if (hasNewKey) keyEncrypted = this.credentialStore.encrypt(key.key);
                if (!keyEncrypted) {
                    throw new Error(`TCP-AO配置“${normalized.name}”中的Key ID ${key.sndId}缺少密钥`);
                }
                return {
                    id: key.id,
                    algorithm: key.algorithm,
                    sndId: key.sndId,
                    rcvId: key.rcvId,
                    macLength: key.macLength,
                    acceptStart: key.acceptStart,
                    sendStart: key.sendStart,
                    sendEnd: key.sendEnd,
                    acceptEnd: key.acceptEnd,
                    keyEncrypted
                };
            });

            return {
                id: normalized.id,
                name: normalized.name,
                peer: normalized.peer,
                keys
            };
        });

        const output = { version: TCP_AO_SETTINGS_VERSION, profiles: storedProfiles };
        this.store.set(this.storageKey, output);
        return this.listProfiles();
    }

    getRuntimeProfile(profileId) {
        const profile = this.getStoredSettings().profiles.find(item => item.id === profileId);
        if (!profile) {
            throw new Error('选择的TCP-AO配置不存在，请在设置中重新选择');
        }
        const keys = profile.keys.map(key => {
            if (!key.keyEncrypted) {
                throw new Error(`TCP-AO配置“${profile.name}”中的Key ID ${key.sndId}没有保存密钥`);
            }
            return { ...key, key: this.credentialStore.decrypt(key.keyEncrypted) };
        });
        const runtimeProfile = normalizeTcpAoProfile({ ...profile, keys }, { requireKey: true });
        assertContinuousRotationSchedule(runtimeProfile);
        return runtimeProfile;
    }
}

module.exports = TcpAoSettingsStore;
