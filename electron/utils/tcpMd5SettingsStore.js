const {
    MAX_TCP_MD5_PROFILES,
    normalizeTcpMd5Key,
    normalizeTcpMd5Profile,
    sanitizeTcpMd5Profile
} = require('./tcpMd5Config');
const { RPKI_AUTH_TYPES, normalizeAuthenticationProfileId } = require('./tcpAuthConfig');

const TCP_MD5_SETTINGS_VERSION = 1;
const TCP_MD5_PROFILE_CONSUMERS = Object.freeze({
    BMP: 'BMP',
    RPKI: 'RPKI'
});

function isTcpMd5AuthType(value) {
    const authType = String(value || '')
        .trim()
        .toLowerCase();
    return authType === RPKI_AUTH_TYPES.TCP_MD5 || authType === 'md5';
}

class TcpMd5SettingsStore {
    constructor(store, credentialStore, options = {}) {
        this.store = store;
        this.credentialStore = credentialStore;
        this.storageKey = options.storageKey || 'tcp-md5-settings';
    }

    getStoredSettings() {
        const settings = this.store?.get?.(this.storageKey);
        if (!settings || typeof settings !== 'object' || !Array.isArray(settings.profiles)) {
            return { version: TCP_MD5_SETTINGS_VERSION, profiles: [] };
        }
        return settings;
    }

    getStoredKeyStatus(profile, credentialAvailable = true) {
        if (!profile?.keyEncrypted) return 'missing';
        if (!credentialAvailable) return 'unavailable';
        try {
            const plaintext = this.credentialStore.decrypt(profile.keyEncrypted);
            normalizeTcpMd5Key(plaintext);
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
        if (isTcpMd5AuthType(bmpConfig?.authType)) {
            const profileIds = Array.isArray(bmpConfig.tcpMd5ProfileIds)
                ? bmpConfig.tcpMd5ProfileIds
                : bmpConfig.tcpMd5ProfileId
                  ? [bmpConfig.tcpMd5ProfileId]
                  : [];
            profileIds.forEach(profileId => addUsage(profileId, TCP_MD5_PROFILE_CONSUMERS.BMP));
        }

        const rpkiConfig = this.store?.get?.('rpki-config');
        if (isTcpMd5AuthType(rpkiConfig?.authType)) {
            addUsage(rpkiConfig.tcpMd5ProfileId, TCP_MD5_PROFILE_CONSUMERS.RPKI);
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
        throw new Error(`TCP MD5配置${details}，不能删除；请先在对应服务配置中取消引用`);
    }

    assertProfilesExist(profileIds) {
        const requestedIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
            .map(profileId => String(profileId || '').trim())
            .filter(profileId => profileId.length > 0);
        const storedIds = new Set(this.getStoredSettings().profiles.map(profile => profile.id));
        const missingIds = requestedIds.filter(profileId => !storedIds.has(profileId));
        if (missingIds.length > 0) {
            throw new Error(`选择的TCP MD5配置不存在: ${missingIds.join('、')}`);
        }
        return requestedIds;
    }

    listProfiles() {
        const settings = this.getStoredSettings();
        const usage = this.getProfileUsage();
        const credentialAvailable =
            typeof this.credentialStore?.isAvailable === 'function' ? this.credentialStore.isAvailable() : true;
        return {
            version: TCP_MD5_SETTINGS_VERSION,
            profiles: settings.profiles.map(profile => {
                const savedKeyStatus = this.getStoredKeyStatus(profile, credentialAvailable);
                return sanitizeTcpMd5Profile({
                    ...profile,
                    hasSavedKey: savedKeyStatus === 'available',
                    savedKeyStatus,
                    usedBy: [...(usage.get(profile.id) || [])]
                });
            })
        };
    }

    saveSettings(settings = {}) {
        const inputProfiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
        if (inputProfiles.length > MAX_TCP_MD5_PROFILES) {
            throw new Error(`TCP MD5配置最多保存${MAX_TCP_MD5_PROFILES}条`);
        }
        this.assertReferencedProfilesNotRemoved(inputProfiles);

        const previousProfiles = new Map(this.getStoredSettings().profiles.map(profile => [profile.id, profile]));
        const seenIds = new Set();
        const seenNames = new Set();
        const storedProfiles = inputProfiles.map(profile => {
            const previous = previousProfiles.get(String(profile?.id || '').trim());
            const normalized = normalizeTcpMd5Profile(profile, { requireKey: false });
            const normalizedName = normalized.name.toLocaleLowerCase();
            if (seenIds.has(normalized.id)) {
                throw new Error(`TCP MD5配置ID重复: ${normalized.id}`);
            }
            if (seenNames.has(normalizedName)) {
                throw new Error(`TCP MD5配置名称重复: ${normalized.name}`);
            }
            seenIds.add(normalized.id);
            seenNames.add(normalizedName);

            const hasNewKey = Buffer.byteLength(normalized.key, 'utf8') > 0;
            let keyEncrypted = previous?.keyEncrypted || '';
            if (!hasNewKey && keyEncrypted && this.getStoredKeyStatus(previous) !== 'available') {
                throw new Error(`TCP MD5配置“${normalized.name}”的密钥无法读取，请重新输入密钥`);
            }
            if (hasNewKey) keyEncrypted = this.credentialStore.encrypt(normalized.key);
            if (!keyEncrypted) {
                throw new Error(`TCP MD5配置“${normalized.name}”缺少密钥`);
            }
            return {
                id: normalized.id,
                name: normalized.name,
                peer: normalized.peer,
                keyEncrypted
            };
        });

        const output = { version: TCP_MD5_SETTINGS_VERSION, profiles: storedProfiles };
        this.store.set(this.storageKey, output);
        return this.listProfiles();
    }

    getRuntimeProfile(profileId) {
        const id = normalizeAuthenticationProfileId(profileId);
        const profile = this.getStoredSettings().profiles.find(item => item.id === id);
        if (!profile) {
            throw new Error('选择的TCP MD5配置不存在，请在设置中重新选择');
        }
        if (!profile.keyEncrypted) {
            throw new Error(`TCP MD5配置“${profile.name}”没有保存密钥`);
        }
        const key = this.credentialStore.decrypt(profile.keyEncrypted);
        return normalizeTcpMd5Profile({ ...profile, key }, { requireKey: true });
    }
}

module.exports = TcpMd5SettingsStore;
module.exports.TCP_MD5_SETTINGS_VERSION = TCP_MD5_SETTINGS_VERSION;
module.exports.TCP_MD5_PROFILE_CONSUMERS = TCP_MD5_PROFILE_CONSUMERS;
