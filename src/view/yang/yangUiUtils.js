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

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const DEFAULT_XML_DISPLAY_LIMIT = 2 * 1024 * 1024;

const indentXmlElement = (element, depth = 0, inheritedPreserve = false) => {
    const xmlSpace = element.getAttributeNS?.(XML_NAMESPACE, 'space') || element.getAttribute?.('xml:space') || '';
    const preserveWhitespace = xmlSpace === 'preserve' || (xmlSpace !== 'default' && inheritedPreserve);
    if (preserveWhitespace) return;

    const children = Array.from(element.childNodes || []);
    const hasCdata = children.some(node => node.nodeType === 4);
    const hasDirectText = children.some(node => node.nodeType === 3 && node.nodeValue?.trim());
    if (hasCdata || hasDirectText) return;

    const structuralChildren = children.filter(node => [1, 7, 8].includes(node.nodeType));
    if (structuralChildren.length === 0) return;

    structuralChildren.forEach(child => {
        if (child.nodeType === 1) indentXmlElement(child, depth + 1, preserveWhitespace);
    });
    children.forEach(child => {
        if (child.nodeType === 3 && !child.nodeValue?.trim()) element.removeChild(child);
    });

    structuralChildren.forEach(child => {
        element.insertBefore(element.ownerDocument.createTextNode(`\n${'  '.repeat(depth + 1)}`), child);
    });
    element.appendChild(element.ownerDocument.createTextNode(`\n${'  '.repeat(depth)}`));
};

export const formatXmlForDisplay = (value, { maxLength = DEFAULT_XML_DISPLAY_LIMIT } = {}) => {
    const raw = String(value ?? '');
    const input = raw.trim();
    if (
        !input.startsWith('<') ||
        input.length > maxLength ||
        typeof DOMParser === 'undefined' ||
        typeof XMLSerializer === 'undefined'
    ) {
        return raw;
    }

    try {
        const documentNode = new DOMParser().parseFromString(input, 'application/xml');
        const parserError = documentNode.getElementsByTagName('parsererror')[0];
        if (!documentNode.documentElement || parserError) return raw;

        const declaration = input.match(/^<\?xml[\s\S]*?\?>/u)?.[0] || '';
        indentXmlElement(documentNode.documentElement);
        let formatted = new XMLSerializer().serializeToString(documentNode);
        if (declaration && !formatted.startsWith('<?xml')) formatted = `${declaration}\n${formatted}`;
        return formatted;
    } catch (_error) {
        return raw;
    }
};

export const getTaskId = progress => progress?.jobId || progress?.taskId || progress?.progressId || '';

export const isTaskTerminal = phase => ['completed', 'failed', 'cancelled'].includes(phase);
