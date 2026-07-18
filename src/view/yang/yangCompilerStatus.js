import { computed, readonly, ref } from 'vue';
import { apiAvailable, invokeBridge } from './yangUiUtils';

const DEFAULT_INSTALL_HINT = '请修复或重新安装 NetNexus；开发环境可用 NETNEXUS_YANGLINT_PATH 指向 yanglint 后重启。';

const compilerStatus = ref({
    available: false,
    checking: true,
    required: true,
    engine: 'libyang',
    executable: 'yanglint',
    version: '',
    path: '',
    message: '正在检查 libyang/yanglint…',
    installHint: DEFAULT_INSTALL_HINT
});

let pendingRequest = null;

const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() || '';

export const normalizeYangCompilerStatus = input => {
    const raw = input?.compiler || input?.compilerStatus || input?.runtime || input || {};
    const engineObject = raw.engine && typeof raw.engine === 'object' ? raw.engine : {};
    const status = String(raw.status || raw.state || '').toLowerCase();
    const available = Boolean(
        raw.available ?? raw.ready ?? raw.usable ?? ['ready', 'available', 'healthy', 'ok'].includes(status)
    );
    const version = firstText(
        raw.libyangVersion,
        engineObject.version,
        raw.version,
        raw.yanglintVersion,
        raw.toolVersion
    );
    const executable = firstText(raw.executable, raw.command, raw.binary, engineObject.executable, 'yanglint');
    const path = firstText(raw.path, raw.executablePath, raw.compilerPath, engineObject.path);
    const reason = firstText(raw.reason, raw.error?.message, raw.error, raw.message, raw.detail);
    const installHint = firstText(raw.installHint, raw.configurationHint, raw.hint, DEFAULT_INSTALL_HINT);

    return {
        ...raw,
        available,
        checking: false,
        required: raw.required !== false,
        engine: firstText(engineObject.name, raw.engine, raw.name, 'libyang'),
        executable,
        version,
        path,
        message: available ? reason : reason || '未检测到内置 libyang/yanglint 权威编译器。',
        installHint
    };
};

const readCompilerStatus = async options => {
    if (apiAvailable('yangApi', 'getCompilerStatus')) {
        const { data } = await invokeBridge('yangApi', 'getCompilerStatus', options);
        return normalizeYangCompilerStatus(data);
    }

    // Compatibility for backends that expose the same status on the workspace payload.
    const { data } = await invokeBridge('yangApi', 'getWorkspace');
    const workspace = data?.workspace || data || {};
    if (!workspace.compiler && !workspace.compilerStatus) {
        throw new Error('后端未提供 libyang 编译器状态接口');
    }
    return normalizeYangCompilerStatus(workspace);
};

export const refreshYangCompilerStatus = async ({ force = false } = {}) => {
    if (pendingRequest && !force) return pendingRequest;
    compilerStatus.value = {
        ...compilerStatus.value,
        checking: true,
        message: compilerStatus.value.available ? compilerStatus.value.message : '正在检查 libyang/yanglint…'
    };
    pendingRequest = readCompilerStatus({ force })
        .then(status => {
            compilerStatus.value = status;
            return status;
        })
        .catch(error => {
            compilerStatus.value = normalizeYangCompilerStatus({
                available: false,
                error: error?.message || String(error),
                installHint: DEFAULT_INSTALL_HINT
            });
            return compilerStatus.value;
        })
        .finally(() => {
            pendingRequest = null;
        });
    return pendingRequest;
};

export const useYangCompilerStatus = () => {
    const unavailableReason = computed(() => {
        if (compilerStatus.value.checking) return '正在检查 libyang/yanglint，请稍候';
        if (compilerStatus.value.available) return '';
        return [compilerStatus.value.message, compilerStatus.value.installHint].filter(Boolean).join(' ');
    });
    const displayName = computed(() => {
        const name = compilerStatus.value.engine || 'libyang';
        return compilerStatus.value.version ? `${name} ${compilerStatus.value.version}` : name;
    });

    return {
        compilerStatus: readonly(compilerStatus),
        compilerAvailable: computed(() => compilerStatus.value.available && !compilerStatus.value.checking),
        compilerUnavailableReason: unavailableReason,
        compilerDisplayName: displayName,
        refreshCompilerStatus: refreshYangCompilerStatus
    };
};
