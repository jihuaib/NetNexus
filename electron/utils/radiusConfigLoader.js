const fs = require('fs');
const path = require('path');
const { DEFAULT_RADIUS_CONFIG } = require('../const/radiusConst');

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function getDefaultRadiusConfigFilePath(userDataPath) {
    if (!userDataPath) {
        throw new Error('缺少应用用户数据目录');
    }
    return path.join(userDataPath, 'radius', 'radius-config.json');
}

function buildDefaultRadiusFileConfig() {
    return {
        sharedSecret: DEFAULT_RADIUS_CONFIG.sharedSecret,
        rejectUnknownClients: false,
        clients: [
            {
                name: 'local-nas',
                ipAddress: '127.0.0.1',
                secret: DEFAULT_RADIUS_CONFIG.sharedSecret,
                enabled: true
            },
            {
                name: 'local-nas-v6',
                ipAddress: '::1',
                secret: DEFAULT_RADIUS_CONFIG.sharedSecret,
                enabled: true
            }
        ],
        users: cloneJson(DEFAULT_RADIUS_CONFIG.users)
    };
}

async function ensureRadiusDefaultConfigFile(userDataPath) {
    const configFilePath = getDefaultRadiusConfigFilePath(userDataPath);
    await fs.promises.mkdir(path.dirname(configFilePath), { recursive: true });

    try {
        await fs.promises.access(configFilePath, fs.constants.F_OK);
        return configFilePath;
    } catch (_) {
        const defaultConfig = buildDefaultRadiusFileConfig();
        await fs.promises.writeFile(configFilePath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
        return configFilePath;
    }
}

async function loadRadiusRuntimeConfig(config = {}, options = {}) {
    const baseConfig = { ...(config || {}) };
    const configFilePath = String(options.configFilePath || baseConfig.configFilePath || '').trim();
    if (!configFilePath) {
        return baseConfig;
    }

    const content = await fs.promises.readFile(configFilePath, 'utf8');
    let fileConfig;
    try {
        fileConfig = JSON.parse(content);
    } catch (error) {
        throw new Error(`RADIUS配置文件不是有效JSON: ${error.message}`);
    }

    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) {
        throw new Error('RADIUS配置文件顶层必须是对象');
    }
    if (fileConfig.clients !== undefined && !Array.isArray(fileConfig.clients)) {
        throw new Error('RADIUS配置文件中的 clients 必须是数组');
    }
    if (fileConfig.users !== undefined && !Array.isArray(fileConfig.users)) {
        throw new Error('RADIUS配置文件中的 users 必须是数组');
    }

    return {
        ...baseConfig,
        ...fileConfig,
        configFilePath
    };
}

module.exports = {
    buildDefaultRadiusFileConfig,
    ensureRadiusDefaultConfigFile,
    getDefaultRadiusConfigFilePath,
    loadRadiusRuntimeConfig
};
