const FACILITY_NAMES = {
    0: 'kernel',
    1: 'user',
    2: 'mail',
    3: 'daemon',
    4: 'auth',
    5: 'syslog',
    6: 'lpr',
    7: 'news',
    8: 'uucp',
    9: 'clock',
    10: 'authpriv',
    11: 'ftp',
    12: 'ntp',
    13: 'audit',
    14: 'alert',
    15: 'clock2',
    16: 'local0',
    17: 'local1',
    18: 'local2',
    19: 'local3',
    20: 'local4',
    21: 'local5',
    22: 'local6',
    23: 'local7'
};

const SEVERITY_NAMES = {
    0: 'emergency',
    1: 'alert',
    2: 'critical',
    3: 'error',
    4: 'warning',
    5: 'notice',
    6: 'info',
    7: 'debug'
};

const RFC3164_MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

function normalizeNilValue(value) {
    return value === '-' || value === undefined || value === null ? '-' : String(value);
}

function createBaseResult(text) {
    return {
        rawMessage: text,
        priority: null,
        facilityCode: null,
        facilityName: '-',
        severityCode: null,
        severityName: '-',
        format: 'RAW',
        version: '-',
        timestamp: '-',
        hostname: '-',
        appName: '-',
        procId: '-',
        msgId: '-',
        structuredData: '-',
        tag: '-',
        message: text,
        parseError: ''
    };
}

function cleanSyslogText(input) {
    return String(input || '')
        .replace(/^\uFEFF/, '')
        .replace(/\0+$/g, '')
        .replace(/\r?\n$/g, '');
}

function applyPriority(result, priority) {
    result.priority = priority;

    if (!Number.isInteger(priority) || priority < 0 || priority > 191) {
        result.parseError = 'PRI范围应为0-191';
        return result;
    }

    const facilityCode = Math.floor(priority / 8);
    const severityCode = priority % 8;
    result.facilityCode = facilityCode;
    result.facilityName = FACILITY_NAMES[facilityCode] || `facility-${facilityCode}`;
    result.severityCode = severityCode;
    result.severityName = SEVERITY_NAMES[severityCode] || `severity-${severityCode}`;
    return result;
}

function takeToken(source) {
    const trimmed = String(source || '').replace(/^\s+/, '');
    if (!trimmed) {
        return { token: null, rest: '' };
    }

    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match) {
        return { token: trimmed, rest: '' };
    }

    return {
        token: match[1],
        rest: match[2] || ''
    };
}

function extractStructuredData(source) {
    const text = String(source || '').replace(/^\s+/, '');
    if (!text) {
        return { structuredData: '-', message: '', parseError: '' };
    }

    if (text[0] === '-') {
        return {
            structuredData: '-',
            message: text.slice(1).replace(/^\s+/, ''),
            parseError: ''
        };
    }

    if (text[0] !== '[') {
        return {
            structuredData: '-',
            message: text,
            parseError: 'RFC5424结构化数据缺失'
        };
    }

    let pos = 0;
    while (text[pos] === '[') {
        let closed = false;
        let escaped = false;

        for (let i = pos + 1; i < text.length; i++) {
            const char = text[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === ']') {
                pos = i + 1;
                closed = true;
                break;
            }
        }

        if (!closed) {
            return {
                structuredData: '-',
                message: text,
                parseError: 'RFC5424结构化数据不完整'
            };
        }

        while (text[pos] === ' ') {
            pos += 1;
        }
    }

    return {
        structuredData: text.slice(0, pos).trim(),
        message: text.slice(pos).replace(/^\s+/, ''),
        parseError: ''
    };
}

function parseRfc5424(rest, baseResult) {
    let remaining = rest;
    const fields = [];

    for (let i = 0; i < 6; i++) {
        const next = takeToken(remaining);
        if (!next.token) {
            return {
                ...baseResult,
                format: 'RFC5424',
                message: rest,
                parseError: 'RFC5424字段不足'
            };
        }
        fields.push(next.token);
        remaining = next.rest;
    }

    const version = Number(fields[0]);
    const structured = extractStructuredData(remaining);

    return {
        ...baseResult,
        format: 'RFC5424',
        version,
        timestamp: normalizeNilValue(fields[1]),
        hostname: normalizeNilValue(fields[2]),
        appName: normalizeNilValue(fields[3]),
        procId: normalizeNilValue(fields[4]),
        msgId: normalizeNilValue(fields[5]),
        structuredData: structured.structuredData,
        message: structured.message,
        parseError: structured.parseError || baseResult.parseError
    };
}

function parseRfc3164(rest, baseResult) {
    const match = /^([A-Z][a-z]{2})\s+([ 0-3]\d)\s+(\d{2}:\d{2}:\d{2})(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(rest);
    if (!match || !RFC3164_MONTHS.has(match[1])) {
        return null;
    }

    let message = match[5] || '';
    let tag = '-';
    let procId = '-';
    const tagMatch = /^([A-Za-z0-9_./-]{1,64})(?:\[(\d{1,10})\])?:\s*([\s\S]*)$/.exec(message);
    if (tagMatch) {
        tag = tagMatch[1];
        procId = tagMatch[2] || '-';
        message = tagMatch[3] || '';
    }

    return {
        ...baseResult,
        format: 'RFC3164',
        timestamp: `${match[1]} ${match[2].trim()} ${match[3]}`,
        hostname: normalizeNilValue(match[4]),
        appName: tag,
        procId,
        tag,
        message
    };
}

function parseSyslogMessage(input) {
    const text = cleanSyslogText(input);
    const result = createBaseResult(text);
    const priMatch = /^<(\d{1,3})>/.exec(text);

    if (!priMatch) {
        return {
            ...result,
            parseError: '缺少PRI字段'
        };
    }

    const priority = Number(priMatch[1]);
    applyPriority(result, priority);

    const rest = text.slice(priMatch[0].length);
    result.message = rest;

    const versionMatch = /^(\d{1,3})\s+/.exec(rest);
    if (versionMatch && Number(versionMatch[1]) > 0) {
        return parseRfc5424(rest, result);
    }

    const rfc3164Result = parseRfc3164(rest, result);
    if (rfc3164Result) {
        return rfc3164Result;
    }

    return result;
}

function parseSyslogBuffer(buffer, encoding = 'utf8') {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), encoding);
    return parseSyslogMessage(source.toString(encoding));
}

module.exports = {
    FACILITY_NAMES,
    SEVERITY_NAMES,
    cleanSyslogText,
    parseSyslogMessage,
    parseSyslogBuffer
};
