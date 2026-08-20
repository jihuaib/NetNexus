const ipaddr = require('ipaddr.js');
const { normalizeAuthenticationPeer, normalizeAuthenticationProfileId } = require('./tcpAuthConfig');

const MAX_PROFILE_NAME_LENGTH = 64;
const MAX_TCP_MD5_KEY_BYTES = 80;
const MAX_TCP_MD5_PROFILES = 32;

function normalizeTcpMd5ProfileName(value) {
    const name = String(value || '').trim();
    if (!name || name.length > MAX_PROFILE_NAME_LENGTH) {
        throw new Error(`TCP MD5配置名称长度必须为1-${MAX_PROFILE_NAME_LENGTH}个字符`);
    }
    return name;
}

function normalizeTcpMd5Peer(value) {
    return normalizeAuthenticationPeer(value, 'TCP MD5');
}

function normalizeTcpMd5Key(value, options = {}) {
    const key = typeof value === 'string' ? value : '';
    const keyLength = Buffer.byteLength(key, 'utf8');
    if (options.required !== false && keyLength === 0) {
        throw new Error('请输入TCP MD5密钥');
    }
    if (keyLength > MAX_TCP_MD5_KEY_BYTES) {
        throw new Error(`TCP MD5密钥不能超过${MAX_TCP_MD5_KEY_BYTES}字节`);
    }
    if (key.includes('\u0000')) {
        throw new Error('TCP MD5密钥不能包含NUL字符');
    }
    return key;
}

function normalizeTcpMd5Profile(profile = {}, options = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('TCP MD5配置格式无效');
    }
    const peer = normalizeTcpMd5Peer(profile.peer);
    return {
        id: normalizeAuthenticationProfileId(profile.id),
        name: normalizeTcpMd5ProfileName(profile.name),
        peer: peer.peer,
        key: normalizeTcpMd5Key(profile.key, { required: options.requireKey !== false })
    };
}

function sanitizeTcpMd5Profile(profile = {}) {
    const hasSavedKey = typeof profile.hasSavedKey === 'boolean' ? profile.hasSavedKey : Boolean(profile.keyEncrypted);
    const savedKeyStatus = ['available', 'unavailable', 'missing'].includes(profile.savedKeyStatus)
        ? profile.savedKeyStatus
        : hasSavedKey
          ? 'available'
          : 'missing';
    return {
        id: profile.id,
        name: profile.name,
        peer: profile.peer,
        hasSavedKey: savedKeyStatus === 'available',
        savedKeyStatus,
        usedBy: Array.isArray(profile.usedBy) ? [...profile.usedBy] : []
    };
}

function assertNonOverlappingTcpMd5Profiles(profiles = []) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new Error('TCP MD5至少需要一个运行时Profile');
    }
    const normalized = profiles.map(profile => {
        const peer = normalizeTcpMd5Peer(profile?.peer);
        return { profile, peer, network: ipaddr.parse(peer.address) };
    });
    for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
            const left = normalized[leftIndex];
            const right = normalized[rightIndex];
            if (left.peer.family !== right.peer.family) continue;
            const shorterPrefix = Math.min(left.peer.prefixLength, right.peer.prefixLength);
            if (left.network.match(right.network, shorterPrefix)) {
                const leftName = left.profile?.name || left.profile?.id || left.peer.peer;
                const rightName = right.profile?.name || right.profile?.id || right.peer.peer;
                throw new Error(`TCP MD5 Profile对端网段不能重叠: ${leftName} / ${rightName}`);
            }
        }
    }
    return profiles;
}

module.exports = {
    MAX_TCP_MD5_KEY_BYTES,
    MAX_TCP_MD5_PROFILES,
    normalizeTcpMd5ProfileName,
    normalizeTcpMd5Peer,
    normalizeTcpMd5Key,
    normalizeTcpMd5Profile,
    sanitizeTcpMd5Profile,
    assertNonOverlappingTcpMd5Profiles
};
