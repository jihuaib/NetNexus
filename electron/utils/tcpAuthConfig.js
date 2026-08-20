const net = require('node:net');
const ipaddr = require('ipaddr.js');

const AUTH_PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const RPKI_AUTH_TYPES = Object.freeze({
    NONE: 'none',
    TCP_AO: 'tcp-ao',
    TCP_MD5: 'tcp-md5'
});

const BMP_AUTH_TYPES = Object.freeze({ ...RPKI_AUTH_TYPES });

function normalizeAuthenticationType(value, supportedTypes, protocolName) {
    const requested = String(value || supportedTypes.NONE)
        .trim()
        .toLowerCase();
    // Accept the early-development spelling at the input boundary only. All
    // persisted and runtime values use the unambiguous tcp-md5 spelling.
    const authType = requested === 'md5' ? supportedTypes.TCP_MD5 : requested;
    if (!Object.values(supportedTypes).includes(authType)) {
        throw new Error(`不支持的${protocolName}认证方式`);
    }
    return authType;
}

function normalizeAuthenticationProfileId(value) {
    const id = String(value || '').trim();
    if (!AUTH_PROFILE_ID_PATTERN.test(id)) {
        throw new Error('认证Profile配置ID格式无效');
    }
    return id;
}

function normalizeAuthenticationPeer(value, authenticationName = 'TCP认证') {
    const peer = String(value || '').trim();
    if (!peer) {
        throw new Error(`请输入${authenticationName}对端地址或网段`);
    }

    const slashIndex = peer.lastIndexOf('/');
    const address = slashIndex === -1 ? peer : peer.slice(0, slashIndex);
    const prefixText = slashIndex === -1 ? '' : peer.slice(slashIndex + 1);
    if (!address || address.includes('/') || (slashIndex !== -1 && !/^\d+$/.test(prefixText))) {
        throw new Error(`${authenticationName}对端地址格式无效`);
    }

    const family = net.isIP(address);
    if (!family) {
        throw new Error(`${authenticationName}对端必须是IPv4、IPv6地址或CIDR网段`);
    }
    if (address.includes('%')) {
        throw new Error(`${authenticationName}对端不支持带zone或scope的IPv6地址`);
    }
    const parsedAddress = ipaddr.parse(address);
    if (family === 6 && parsedAddress.isIPv4MappedAddress?.()) {
        throw new Error(`${authenticationName}对端不支持IPv4映射IPv6地址`);
    }

    const maximumPrefix = family === 4 ? 32 : 128;
    const prefixLength = slashIndex === -1 ? maximumPrefix : Number(prefixText);
    if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maximumPrefix) {
        throw new Error(`${authenticationName}前缀长度必须是0-${maximumPrefix}之间的整数`);
    }
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
        throw new Error(`${authenticationName} CIDR必须填写规范网络地址，不能包含主机位`);
    }

    return {
        peer: `${address}/${prefixLength}`,
        address,
        prefixLength,
        family
    };
}

function normalizeRpkiAuthenticationSelection(config = {}) {
    const authType = normalizeAuthenticationType(config.authType, RPKI_AUTH_TYPES, 'RPKI');
    const tcpAoProfileId =
        authType === RPKI_AUTH_TYPES.TCP_AO ? normalizeAuthenticationProfileId(config.tcpAoProfileId) : '';
    const tcpMd5ProfileId =
        authType === RPKI_AUTH_TYPES.TCP_MD5 ? normalizeAuthenticationProfileId(config.tcpMd5ProfileId) : '';
    return { authType, tcpAoProfileId, tcpMd5ProfileId };
}

function normalizeBmpProfileIds(pluralValue, singularValue, authenticationName) {
    const inputIds = Array.isArray(pluralValue) ? pluralValue : singularValue ? [singularValue] : [];
    if (inputIds.length === 0 || inputIds.length > 32) {
        throw new Error(`BMP ${authenticationName}必须选择1-32个Profile`);
    }
    const ids = inputIds.map(normalizeAuthenticationProfileId);
    if (new Set(ids).size !== ids.length) {
        throw new Error(`BMP ${authenticationName} Profile不能重复选择`);
    }
    return ids;
}

function normalizeBmpAuthenticationSelection(config = {}) {
    const authType = normalizeAuthenticationType(config.authType, BMP_AUTH_TYPES, 'BMP');
    let tcpAoProfileIds = [];
    let tcpMd5ProfileIds = [];
    if (authType === BMP_AUTH_TYPES.TCP_AO) {
        tcpAoProfileIds = normalizeBmpProfileIds(config.tcpAoProfileIds, config.tcpAoProfileId, 'TCP-AO');
    } else if (authType === BMP_AUTH_TYPES.TCP_MD5) {
        tcpMd5ProfileIds = normalizeBmpProfileIds(config.tcpMd5ProfileIds, config.tcpMd5ProfileId, 'TCP MD5');
    }
    return { authType, tcpAoProfileIds, tcpMd5ProfileIds };
}

function redactAuthenticationConfig(config = {}) {
    if (Array.isArray(config)) return config.map(item => redactAuthenticationConfig(item));
    if (!config || typeof config !== 'object' || Buffer.isBuffer(config)) return config;
    const output = {};
    for (const [field, value] of Object.entries(config)) {
        if (field === 'key' || field === 'keyEncrypted') {
            output[field] = '<redacted>';
        } else {
            output[field] = redactAuthenticationConfig(value);
        }
    }
    return output;
}

module.exports = {
    RPKI_AUTH_TYPES,
    BMP_AUTH_TYPES,
    normalizeAuthenticationProfileId,
    normalizeAuthenticationPeer,
    normalizeRpkiAuthenticationSelection,
    normalizeBmpAuthenticationSelection,
    redactAuthenticationConfig
};
