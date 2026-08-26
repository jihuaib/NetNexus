import {
    GRPC_METHOD_KIND,
    GRPC_METHOD_KIND_LABELS,
    GRPC_MESSAGE_STATUS,
    GRPC_STREAM_STATE
} from '../../const/grpcConst';

export const methodKindLabel = kind => GRPC_METHOD_KIND_LABELS[kind] || kind || '-';

export const methodKindColor = kind => {
    switch (kind) {
        case GRPC_METHOD_KIND.UNARY:
            return 'blue';
        case GRPC_METHOD_KIND.SERVER_STREAM:
            return 'purple';
        case GRPC_METHOD_KIND.CLIENT_STREAM:
            return 'cyan';
        case GRPC_METHOD_KIND.BIDI_STREAM:
            return 'geekblue';
        default:
            return 'default';
    }
};

export const messageStatusColor = status => {
    switch (status) {
        case GRPC_MESSAGE_STATUS.DECODED:
            return 'success';
        case GRPC_MESSAGE_STATUS.SENT:
            return 'processing';
        case GRPC_MESSAGE_STATUS.PARTIAL:
            return 'warning';
        case GRPC_MESSAGE_STATUS.ERROR:
            return 'error';
        default:
            return 'default';
    }
};

export const messageStatusText = status => {
    switch (status) {
        case GRPC_MESSAGE_STATUS.DECODED:
            return '已解码';
        case GRPC_MESSAGE_STATUS.SENT:
            return '已发送';
        case GRPC_MESSAGE_STATUS.PARTIAL:
            return '部分解码';
        case GRPC_MESSAGE_STATUS.ERROR:
            return '解码失败';
        default:
            return status || '-';
    }
};

export const streamStateColor = state => {
    switch (state) {
        case GRPC_STREAM_STATE.OPEN:
            return 'green';
        case GRPC_STREAM_STATE.ERROR:
            return 'red';
        default:
            return 'default';
    }
};

export const streamStateText = state => {
    switch (state) {
        case GRPC_STREAM_STATE.OPEN:
            return '进行中';
        case GRPC_STREAM_STATE.CLOSED:
            return '已结束';
        case GRPC_STREAM_STATE.ERROR:
            return '异常';
        default:
            return state || '-';
    }
};

/**
 * 解析界面输入的 JSON 文本。空文本视为空对象。
 * @returns {{ value: Object|null, error: string }}
 */
export const parseJsonObject = text => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
        return { value: {}, error: '' };
    }
    try {
        const value = JSON.parse(trimmed);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { value: null, error: 'JSON 顶层必须是对象' };
        }
        return { value, error: '' };
    } catch (error) {
        return { value: null, error: `JSON 格式错误: ${error.message}` };
    }
};

export const formatJson = value => {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch (_error) {
        return '{}';
    }
};

/**
 * 把 proto 目录展开为方法选项列表。
 */
export const catalogMethodOptions = catalog => {
    if (!catalog || !Array.isArray(catalog.services)) {
        return [];
    }
    return catalog.services.flatMap(service =>
        service.methods.map(method => ({
            value: method.fullName,
            label: `${method.fullName} (${methodKindLabel(method.kind)})`,
            method,
            service
        }))
    );
};

export const findCatalogMethod = (catalog, fullName) =>
    catalogMethodOptions(catalog).find(option => option.value === fullName)?.method || null;

export const formatBytes = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return '-';
    }
    if (number >= 1024 * 1024) {
        return `${(number / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (number >= 1024) {
        return `${(number / 1024).toFixed(1)} KB`;
    }
    return `${number} B`;
};
