export const clonePlain = value => JSON.parse(JSON.stringify(value));

export const responseData = response => {
    if (response?.status !== 'success') {
        throw new Error(response?.msg || '操作失败');
    }
    return response.data;
};

export const unwrapArray = (data, keys = []) => {
    if (Array.isArray(data)) return data;
    for (const key of keys) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    return [];
};

export const apiAvailable = (namespace, method) =>
    typeof window !== 'undefined' && typeof window[namespace]?.[method] === 'function';

export const invokeBridge = async (namespace, method, payload) => {
    if (!apiAvailable(namespace, method)) {
        throw new Error(`${namespace}.${method} 尚未注册`);
    }
    const response =
        payload === undefined ? await window[namespace][method]() : await window[namespace][method](payload);
    return {
        response,
        data: responseData(response)
    };
};

export const normalizeCapability = capability => {
    if (typeof capability === 'string') return capability;
    return capability?.uri || capability?.capability || capability?.value || '';
};

export const normalizeSessionEvent = (payload, current = {}) => {
    const raw = payload?.status === 'success' ? payload.data : payload?.data || payload;
    if (!raw || typeof raw !== 'object') return { ...current };
    const data = raw.session && typeof raw.session === 'object' ? { ...raw, ...raw.session } : raw;
    const eventType = String(data.event || data.type || '').toLowerCase();
    const next = { ...current, ...data };
    if (['connected', 'connect'].includes(eventType)) {
        next.status = 'connected';
        next.connected = true;
    } else if (['close', 'closed', 'disconnected', 'disconnect'].includes(eventType)) {
        next.status = 'disconnected';
        next.connected = false;
        next.capabilities = [];
    } else if (['protocol-error', 'error'].includes(eventType)) {
        next.status = 'error';
        next.connected = false;
        next.message = data.message || data.error?.message || current.message;
    }
    return next;
};

export const formatDateTime = value => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

export const fileBaseName = value => {
    const text = String(value || '');
    return text.split(/[\\/]/).pop() || text;
};

export const getTaskId = progress => progress?.jobId || progress?.taskId || progress?.progressId || '';

export const isTaskTerminal = phase => ['completed', 'failed', 'cancelled'].includes(phase);
