const net = require('node:net');
const ipaddr = require('ipaddr.js');

const RPKI_AUTH_TYPES = Object.freeze({
    NONE: 'none',
    TCP_AO: 'tcp-ao'
});

// TCP-AO is shared by the protocol servers. Keep the original RPKI export for
// compatibility with the first consumer, while giving BMP its own semantic
// alias and normalizer below.
const BMP_AUTH_TYPES = RPKI_AUTH_TYPES;

const TCP_AO_ALGORITHMS = Object.freeze({
    HMAC_SHA1: 'hmac(sha1)',
    AES_CMAC: 'cmac(aes)',
    HMAC_SHA256: 'hmac(sha256)'
});

const TCP_AO_ALGORITHM_VALUES = new Set(Object.values(TCP_AO_ALGORITHMS));
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_PROFILE_NAME_LENGTH = 64;
const MAX_TCP_AO_KEY_BYTES = 80;
const MAX_TCP_AO_KEYS_PER_PROFILE = 16;
const ISO_8601_WITH_TIMEZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeInteger(value, field, minimum, maximum, fallback) {
    const candidate = value === '' || value === null || value === undefined ? fallback : Number(value);
    if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
        throw new Error(`${field}必须是${minimum}-${maximum}之间的整数`);
    }
    return candidate;
}

function normalizeProfileId(value) {
    const id = String(value || '').trim();
    if (!PROFILE_ID_PATTERN.test(id)) {
        throw new Error('TCP-AO配置ID格式无效');
    }
    return id;
}

function normalizeProfileName(value) {
    const name = String(value || '').trim();
    if (!name || name.length > MAX_PROFILE_NAME_LENGTH) {
        throw new Error(`TCP-AO配置名称长度必须为1-${MAX_PROFILE_NAME_LENGTH}个字符`);
    }
    return name;
}

function normalizePeer(value) {
    const peer = String(value || '').trim();
    if (!peer) {
        throw new Error('请输入TCP-AO对端地址或网段');
    }

    const slashIndex = peer.lastIndexOf('/');
    const address = slashIndex === -1 ? peer : peer.slice(0, slashIndex);
    const prefixText = slashIndex === -1 ? '' : peer.slice(slashIndex + 1);
    if (!address || address.includes('/') || (slashIndex !== -1 && !/^\d+$/.test(prefixText))) {
        throw new Error('TCP-AO对端地址格式无效');
    }

    const family = net.isIP(address);
    if (!family) {
        throw new Error('TCP-AO对端必须是IPv4、IPv6地址或CIDR网段');
    }
    if (address.includes('%')) {
        throw new Error('TCP-AO对端不支持带zone或scope的IPv6地址');
    }
    const parsedAddress = ipaddr.parse(address);
    if (family === 6 && parsedAddress.isIPv4MappedAddress?.()) {
        throw new Error('TCP-AO对端不支持IPv4映射IPv6地址');
    }

    const maximumPrefix = family === 4 ? 32 : 128;
    const prefixLength =
        slashIndex === -1 ? maximumPrefix : normalizeInteger(prefixText, 'TCP-AO前缀长度', 0, maximumPrefix);
    const addressBytes = parsedAddress.toByteArray();
    const wholeBytes = Math.floor(prefixLength / 8);
    const remainingBits = prefixLength % 8;
    const hasHostBits = addressBytes.some((byte, index) => {
        if (index < wholeBytes) return false;
        if (index > wholeBytes || remainingBits === 0) return byte !== 0;
        const hostMask = (1 << (8 - remainingBits)) - 1;
        return (byte & hostMask) !== 0;
    });
    if (hasHostBits) {
        throw new Error('TCP-AO CIDR必须填写规范网络地址，不能包含主机位');
    }

    return {
        peer: `${address}/${prefixLength}`,
        address,
        prefixLength,
        family
    };
}

function normalizeAlgorithm(value) {
    const algorithm = String(value || '')
        .trim()
        .toLowerCase();
    if (!TCP_AO_ALGORITHM_VALUES.has(algorithm)) {
        throw new Error('不支持的TCP-AO算法');
    }
    return algorithm;
}

function getAlgorithmMacLengthMaximum(algorithm) {
    if (algorithm === TCP_AO_ALGORITHMS.AES_CMAC) return 16;
    if (algorithm === TCP_AO_ALGORITHMS.HMAC_SHA1) return 20;
    return 32;
}

function normalizeKey(value, algorithm, required) {
    const key = typeof value === 'string' ? value : '';
    const keyLength = Buffer.byteLength(key, 'utf8');
    if (required && keyLength === 0) {
        throw new Error('请输入TCP-AO密钥');
    }
    if (keyLength > MAX_TCP_AO_KEY_BYTES) {
        throw new Error(`TCP-AO密钥不能超过${MAX_TCP_AO_KEY_BYTES}字节`);
    }
    if (key.includes('\u0000')) {
        throw new Error('TCP-AO密钥不能包含NUL字符');
    }
    if (keyLength > 0 && algorithm === TCP_AO_ALGORITHMS.AES_CMAC && keyLength !== 16) {
        throw new Error('AES-128-CMAC密钥必须正好为16字节');
    }
    return key;
}

function normalizeTimestamp(value, field) {
    if (value === '' || value === null || value === undefined || value === 0 || value === '0') {
        return null;
    }

    let seconds;
    const text = String(value).trim();
    if (typeof value === 'number' || /^\d+$/.test(text)) {
        const numeric = Number(value);
        if (!Number.isSafeInteger(numeric) || numeric <= 0) {
            throw new Error(`${field}格式无效`);
        }
        seconds = numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
    } else {
        if (!ISO_8601_WITH_TIMEZONE_PATTERN.test(text)) {
            throw new Error(`${field}必须是带时区的ISO 8601时间`);
        }
        const components =
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
        const year = Number(components[1]);
        const month = Number(components[2]);
        const day = Number(components[3]);
        const hour = Number(components[4]);
        const minute = Number(components[5]);
        const second = Number(components[6] || 0);
        const fractionMilliseconds = Number(String(components[7] || '').padEnd(3, '0') || 0);
        const calendar = new Date(0);
        calendar.setUTCHours(hour, minute, second, fractionMilliseconds);
        calendar.setUTCFullYear(year, month - 1, day);
        if (
            calendar.getUTCFullYear() !== year ||
            calendar.getUTCMonth() !== month - 1 ||
            calendar.getUTCDate() !== day ||
            calendar.getUTCHours() !== hour ||
            calendar.getUTCMinutes() !== minute ||
            calendar.getUTCSeconds() !== second
        ) {
            throw new Error(`${field}格式无效`);
        }
        const parsedMilliseconds = Date.parse(text);
        seconds = Math.floor(parsedMilliseconds / 1000);
    }
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new Error(`${field}格式无效`);
    }
    return seconds;
}

function lowerBound(value) {
    return value === null ? Number.NEGATIVE_INFINITY : value;
}

function upperBound(value) {
    return value === null ? Number.POSITIVE_INFINITY : value;
}

function validateKeyLifetime(key) {
    const acceptStart = lowerBound(key.acceptStart);
    const sendStart = lowerBound(key.sendStart);
    const sendEnd = upperBound(key.sendEnd);
    const acceptEnd = upperBound(key.acceptEnd);
    if (acceptStart > sendStart || sendStart >= sendEnd || sendEnd > acceptEnd) {
        throw new Error('TCP-AO密钥时间必须满足：接收开始 ≤ 发送开始 < 发送结束 ≤ 接收结束');
    }
}

function normalizeTcpAoKey(keyConfig = {}, options = {}) {
    if (!keyConfig || typeof keyConfig !== 'object' || Array.isArray(keyConfig)) {
        throw new Error('TCP-AO密钥配置格式无效');
    }
    const id = normalizeProfileId(keyConfig.id);
    const algorithm = normalizeAlgorithm(keyConfig.algorithm || TCP_AO_ALGORITHMS.HMAC_SHA1);
    const sndId = normalizeInteger(keyConfig.sndId, 'TCP-AO发送Key ID', 0, 255, 1);
    const rcvId = normalizeInteger(keyConfig.rcvId, 'TCP-AO接收Key ID', 0, 255, 1);
    const macLength = normalizeInteger(
        keyConfig.macLength,
        'TCP-AO MAC长度',
        4,
        getAlgorithmMacLengthMaximum(algorithm),
        12
    );
    const key = normalizeKey(keyConfig.key, algorithm, Boolean(options.requireKey));
    const output = {
        id,
        algorithm,
        sndId,
        rcvId,
        macLength,
        key,
        acceptStart: normalizeTimestamp(keyConfig.acceptStart, 'TCP-AO接收开始时间'),
        sendStart: normalizeTimestamp(keyConfig.sendStart, 'TCP-AO发送开始时间'),
        sendEnd: normalizeTimestamp(keyConfig.sendEnd, 'TCP-AO发送结束时间'),
        acceptEnd: normalizeTimestamp(keyConfig.acceptEnd, 'TCP-AO接收结束时间')
    };
    validateKeyLifetime(output);
    return output;
}

function keySendRange(key) {
    return [lowerBound(key.sendStart), upperBound(key.sendEnd)];
}

function validateKeyRing(keys) {
    const ids = new Set();
    const sndIds = new Set();
    const rcvIds = new Set();
    for (const key of keys) {
        if (ids.has(key.id)) throw new Error(`TCP-AO密钥配置ID重复: ${key.id}`);
        if (sndIds.has(key.sndId)) throw new Error(`TCP-AO发送Key ID重复: ${key.sndId}`);
        if (rcvIds.has(key.rcvId)) throw new Error(`TCP-AO接收Key ID重复: ${key.rcvId}`);
        ids.add(key.id);
        sndIds.add(key.sndId);
        rcvIds.add(key.rcvId);
    }

    const bySendStart = [...keys].sort((left, right) => keySendRange(left)[0] - keySendRange(right)[0]);
    for (let index = 1; index < bySendStart.length; index += 1) {
        const previousEnd = keySendRange(bySendStart[index - 1])[1];
        const currentStart = keySendRange(bySendStart[index])[0];
        if (currentStart < previousEnd) {
            throw new Error('同一TCP-AO配置中的密钥发送时间不能重叠');
        }
    }
}

function normalizeTcpAoProfile(profile = {}, options = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('TCP-AO配置格式无效');
    }

    const id = normalizeProfileId(profile.id);
    const name = normalizeProfileName(profile.name);
    const peer = normalizePeer(profile.peer);
    const inputKeys = Array.isArray(profile.keys) ? profile.keys : [];
    if (inputKeys.length === 0 || inputKeys.length > MAX_TCP_AO_KEYS_PER_PROFILE) {
        throw new Error(`每个TCP-AO配置必须包含1-${MAX_TCP_AO_KEYS_PER_PROFILE}把密钥`);
    }
    const keys = inputKeys.map(keyConfig => normalizeTcpAoKey(keyConfig, options));
    validateKeyRing(keys);

    return {
        id,
        name,
        peer: peer.peer,
        address: peer.address,
        prefixLength: peer.prefixLength,
        family: peer.family,
        keys
    };
}

function sanitizeTcpAoProfile(profile = {}) {
    const output = {
        id: profile.id,
        name: profile.name,
        peer: profile.peer,
        keys: Array.isArray(profile.keys)
            ? profile.keys.map(key => {
                  const hasSavedKey =
                      typeof key.hasSavedKey === 'boolean' ? key.hasSavedKey : Boolean(key.keyEncrypted);
                  const savedKeyStatus = ['available', 'unavailable', 'missing'].includes(key.savedKeyStatus)
                      ? key.savedKeyStatus
                      : hasSavedKey
                        ? 'available'
                        : 'missing';
                  return {
                      id: key.id,
                      algorithm: key.algorithm,
                      sndId: key.sndId,
                      rcvId: key.rcvId,
                      macLength: key.macLength,
                      acceptStart: key.acceptStart ?? null,
                      sendStart: key.sendStart ?? null,
                      sendEnd: key.sendEnd ?? null,
                      acceptEnd: key.acceptEnd ?? null,
                      hasSavedKey,
                      savedKeyStatus
                  };
              })
            : []
    };
    return output;
}

function isKeySendActive(key, nowSeconds = Math.floor(Date.now() / 1000)) {
    const start = lowerBound(key.sendStart);
    const end = upperBound(key.sendEnd);
    return nowSeconds >= start && nowSeconds < end;
}

function assertCurrentSendKey(profile, nowSeconds = Math.floor(Date.now() / 1000)) {
    const activeKeys = profile.keys.filter(key => isKeySendActive(key, nowSeconds));
    if (activeKeys.length !== 1) {
        throw new Error(
            activeKeys.length === 0 ? '当前时间没有可用于发送的TCP-AO密钥' : '当前时间存在多把发送有效的TCP-AO密钥'
        );
    }
    return activeKeys[0];
}

function assertContinuousRotationSchedule(profile, nowSeconds = Math.floor(Date.now() / 1000)) {
    const current = assertCurrentSendKey(profile, nowSeconds);
    const currentAndFuture = profile.keys
        .filter(key => upperBound(key.sendEnd) > nowSeconds)
        .sort((left, right) => lowerBound(left.sendStart) - lowerBound(right.sendStart));
    const currentIndex = currentAndFuture.findIndex(key => key.id === current.id);
    if (currentIndex < 0) throw new Error('无法确定当前TCP-AO发送密钥');
    const schedule = currentAndFuture.slice(currentIndex);
    for (let index = 1; index < schedule.length; index += 1) {
        const previousEnd = upperBound(schedule[index - 1].sendEnd);
        const nextStart = lowerBound(schedule[index].sendStart);
        if (previousEnd !== nextStart) {
            throw new Error('TCP-AO发送密钥轮换时间必须连续，不能存在空档');
        }
    }
    return current;
}

function normalizeRpkiAuthSelection(config = {}) {
    const authType = String(config.authType || RPKI_AUTH_TYPES.NONE)
        .trim()
        .toLowerCase();
    if (!Object.values(RPKI_AUTH_TYPES).includes(authType)) {
        throw new Error('不支持的RPKI认证方式');
    }

    const tcpAoProfileId = authType === RPKI_AUTH_TYPES.TCP_AO ? normalizeProfileId(config.tcpAoProfileId) : '';
    return { authType, tcpAoProfileId };
}

function normalizeBmpAuthSelection(config = {}) {
    const authType = String(config.authType || BMP_AUTH_TYPES.NONE)
        .trim()
        .toLowerCase();
    if (!Object.values(BMP_AUTH_TYPES).includes(authType)) {
        throw new Error('不支持的BMP认证方式');
    }

    if (authType !== BMP_AUTH_TYPES.TCP_AO) {
        return { authType, tcpAoProfileIds: [] };
    }

    // Accept the singular field as a migration aid for early development
    // builds, but always persist and return the plural BMP representation.
    const inputIds = Array.isArray(config.tcpAoProfileIds)
        ? config.tcpAoProfileIds
        : config.tcpAoProfileId
          ? [config.tcpAoProfileId]
          : [];
    if (inputIds.length === 0 || inputIds.length > 32) {
        throw new Error('BMP TCP-AO必须选择1-32个Profile');
    }

    const tcpAoProfileIds = inputIds.map(normalizeProfileId);
    if (new Set(tcpAoProfileIds).size !== tcpAoProfileIds.length) {
        throw new Error('BMP TCP-AO Profile不能重复选择');
    }
    return { authType, tcpAoProfileIds };
}

function assertNonOverlappingTcpAoProfiles(profiles = []) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new Error('BMP TCP-AO至少需要一个运行时Profile');
    }

    const normalized = profiles.map(profile => {
        const peer = normalizePeer(profile?.peer);
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
                throw new Error(`BMP TCP-AO Profile对端网段不能重叠: ${leftName} / ${rightName}`);
            }
        }
    }
    return profiles;
}

function redactTcpAoConfig(config = {}) {
    if (!config || typeof config !== 'object') return config;
    const output = { ...config };
    if (output.key !== undefined) output.key = '<redacted>';
    if (Array.isArray(output.keys)) output.keys = output.keys.map(item => redactTcpAoConfig(item));
    return output;
}

module.exports = {
    RPKI_AUTH_TYPES,
    BMP_AUTH_TYPES,
    TCP_AO_ALGORITHMS,
    MAX_TCP_AO_KEY_BYTES,
    MAX_TCP_AO_KEYS_PER_PROFILE,
    normalizePeer,
    normalizeTimestamp,
    normalizeTcpAoKey,
    normalizeTcpAoProfile,
    sanitizeTcpAoProfile,
    isKeySendActive,
    assertCurrentSendKey,
    assertContinuousRotationSchedule,
    normalizeRpkiAuthSelection,
    normalizeBmpAuthSelection,
    assertNonOverlappingTcpAoProfiles,
    redactTcpAoConfig
};
