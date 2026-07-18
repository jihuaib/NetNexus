import { readonly, ref } from 'vue';

const MAX_HISTORY_RECORDS = 100;
const MAX_HISTORY_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_XML_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 256 * 1024;
const MAX_ERRORS_BYTES = 1024 * 1024;
const MAX_METADATA_FIELD_BYTES = 32 * 1024;
const ESTIMATED_RECORD_OVERHEAD_BYTES = 1024;

const records = ref([]);
const readonlyRecords = readonly(records);
let recordSequence = 0;

const textValue = value => String(value ?? '');

const truncateText = (value, maxBytes) => {
    const text = textValue(value);
    const maxCharacters = Math.max(0, Math.floor(maxBytes / 2));
    if (text.length <= maxCharacters) return { value: text, truncated: false };
    if (maxCharacters === 0) return { value: '', truncated: true };

    const omittedCharacters = text.length - maxCharacters;
    const marker = `\n<!-- NetNexus：执行记录已截断 ${omittedCharacters} 个字符 -->\n`;
    if (marker.length >= maxCharacters) {
        return { value: marker.slice(0, maxCharacters), truncated: true };
    }

    const retainedCharacters = maxCharacters - marker.length;
    const headLength = Math.ceil(retainedCharacters * 0.75);
    const tailLength = retainedCharacters - headLength;
    return {
        value: `${text.slice(0, headLength)}${marker}${tailLength ? text.slice(-tailLength) : ''}`,
        truncated: true
    };
};

const serializedValue = value => {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return textValue(value);
    }
};

const metadataValue = value => truncateText(value, MAX_METADATA_FIELD_BYTES).value;

const normalizeErrors = errors => {
    if (!Array.isArray(errors)) return { value: [], truncated: false };
    const serializedErrors = serializedValue(errors);
    if (serializedErrors.length * 2 <= MAX_ERRORS_BYTES) {
        try {
            const clonedErrors = JSON.parse(serializedErrors);
            if (Array.isArray(clonedErrors)) return { value: clonedErrors, truncated: false };
        } catch (_error) {
            // Circular or otherwise non-serializable errors use the bounded summary below.
        }
    }

    const firstError = errors[0];
    const summary = {};
    if (firstError && typeof firstError === 'object' && !Array.isArray(firstError)) {
        for (const [rawKey, rawValue] of Object.entries(firstError).slice(0, 32)) {
            const key = truncateText(rawKey, 512).value;
            const value = typeof rawValue === 'string' ? rawValue : serializedValue(rawValue);
            summary[key] = truncateText(value, 8 * 1024).value;
        }
    } else if (firstError !== undefined) {
        summary.message = truncateText(firstError, 8 * 1024).value;
    }
    summary.historyTruncated = true;
    summary.historyOriginalErrorCount = errors.length;
    return { value: [summary], truncated: true };
};

const estimateRecordBytes = record => {
    return serializedValue(record).length * 2 + ESTIMATED_RECORD_OVERHEAD_BYTES;
};

const metadataOnlyRecord = record => ({
    ...record,
    requestXml: record.requestXml ? '<!-- NetNexus：请求过大，执行历史仅保留元数据 -->' : '',
    replyXml: record.replyXml ? '<!-- NetNexus：响应过大，执行历史仅保留元数据 -->' : '',
    requestTruncated: Boolean(record.requestXml) || Boolean(record.requestTruncated),
    replyTruncated: Boolean(record.replyXml) || Boolean(record.replyTruncated),
    errors: [],
    errorsTruncated: Boolean(record.errors?.length) || Boolean(record.errorsTruncated),
    errorMessage: truncateText(record.errorMessage, MAX_ERROR_MESSAGE_BYTES).value
});

const trimHistory = history => {
    const retained = [];
    let retainedBytes = 0;

    for (const record of history.slice(0, MAX_HISTORY_RECORDS)) {
        const recordBytes = estimateRecordBytes(record);
        if (retainedBytes + recordBytes > MAX_HISTORY_PAYLOAD_BYTES) {
            // The newest execution must keep its metadata, even if a future caller
            // adds an unexpectedly large payload field that bypasses normalization.
            if (retained.length === 0) retained.push(metadataOnlyRecord(record));
            break;
        }
        retained.push(record);
        retainedBytes += recordBytes;
    }

    return retained;
};

export const beginNetconfExecution = (record = {}) => {
    const startedAt = metadataValue(record.startedAt || new Date().toISOString());
    const id = `netconf-execution-${Date.now()}-${++recordSequence}`;
    const request = truncateText(record.requestXml, MAX_XML_PAYLOAD_BYTES);
    const nextRecord = {
        id,
        operation: metadataValue(record.operation || 'rpc'),
        operationLabel: metadataValue(record.operationLabel || record.operation || 'RPC'),
        category: metadataValue(record.category || 'read'),
        origin: metadataValue(record.origin || 'manual'),
        status: 'pending',
        startedAt,
        finishedAt: '',
        duration: null,
        profileId: metadataValue(record.profileId),
        profileName: metadataValue(record.profileName),
        host: metadataValue(record.host),
        port: typeof record.port === 'number' ? record.port : metadataValue(record.port),
        sessionId: metadataValue(record.sessionId),
        contextPath: metadataValue(record.contextPath),
        contextName: metadataValue(record.contextName),
        messageId: '',
        requestXml: request.value,
        requestTruncated: request.truncated || Boolean(record.requestTruncated),
        replyXml: '',
        replyTruncated: false,
        errors: [],
        errorsTruncated: false,
        errorMessage: ''
    };

    records.value = trimHistory([nextRecord, ...records.value]);
    return id;
};

export const completeNetconfExecution = (id, patch = {}) => {
    const recordIndex = records.value.findIndex(record => record.id === id);
    if (recordIndex < 0) return;

    const current = records.value[recordIndex];
    const hasRequest = Object.prototype.hasOwnProperty.call(patch, 'requestXml');
    const hasReply = Object.prototype.hasOwnProperty.call(patch, 'replyXml');
    const request = hasRequest
        ? truncateText(patch.requestXml, MAX_XML_PAYLOAD_BYTES)
        : { value: current.requestXml, truncated: Boolean(current.requestTruncated) };
    const reply = hasReply
        ? truncateText(patch.replyXml, MAX_XML_PAYLOAD_BYTES)
        : { value: current.replyXml, truncated: Boolean(current.replyTruncated) };
    const normalizedErrors = Object.prototype.hasOwnProperty.call(patch, 'errors')
        ? normalizeErrors(patch.errors)
        : { value: current.errors, truncated: Boolean(current.errorsTruncated) };
    const errorMessage = truncateText(patch.errorMessage ?? current.errorMessage, MAX_ERROR_MESSAGE_BYTES);
    const nextRecord = {
        ...current,
        id: current.id,
        status: metadataValue(patch.status || current.status || 'failed'),
        finishedAt: metadataValue(patch.finishedAt || new Date().toISOString()),
        duration: Number.isFinite(Number(patch.duration)) ? Math.max(0, Math.round(Number(patch.duration))) : null,
        messageId: metadataValue(patch.messageId ?? current.messageId),
        requestXml: request.value,
        requestTruncated: request.truncated || Boolean(hasRequest && patch.requestTruncated),
        replyXml: reply.value,
        replyTruncated: reply.truncated || Boolean(hasReply && patch.replyTruncated),
        errors: normalizedErrors.value,
        errorsTruncated: normalizedErrors.truncated || Boolean(patch.errorsTruncated),
        errorMessage: errorMessage.value
    };
    const nextHistory = [...records.value];
    nextHistory.splice(recordIndex, 1, nextRecord);
    records.value = trimHistory(nextHistory);
};

export const clearNetconfExecutionHistory = () => {
    records.value = [];
};

export const useNetconfExecutionHistory = () => ({
    records: readonlyRecords,
    clearHistory: clearNetconfExecutionHistory
});
