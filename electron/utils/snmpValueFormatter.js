function hasOnlyDisplayableText(text) {
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === 0xfffd) {
            return false;
        }
        if (codePoint === 9 || codePoint === 10 || codePoint === 13) {
            continue;
        }
        if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) {
            return false;
        }
    }
    return true;
}

function isValidDisplayableUtf8(buffer, text) {
    if (!Buffer.from(text, 'utf8').equals(buffer)) {
        return false;
    }
    return hasOnlyDisplayableText(text);
}

function formatSnmpBuffer(buffer) {
    const valueHex = buffer.toString('hex');
    const utf8Value = buffer.toString('utf8');
    const valueEncoding = isValidDisplayableUtf8(buffer, utf8Value) ? 'utf8' : 'hex';

    return {
        value: valueEncoding === 'utf8' ? utf8Value : valueHex,
        valueEncoding,
        valueHex,
        rawValueLength: buffer.length
    };
}

function formatSnmpValue(value) {
    if (value === null || value === undefined) {
        return {
            value: ''
        };
    }

    if (Buffer.isBuffer(value)) {
        return formatSnmpBuffer(value);
    }

    if (typeof value === 'bigint') {
        return {
            value: value.toString()
        };
    }

    if (typeof value === 'object') {
        try {
            return {
                value: JSON.stringify(value)
            };
        } catch (error) {
            return {
                value: String(value)
            };
        }
    }

    return {
        value: String(value)
    };
}

module.exports = {
    formatSnmpBuffer,
    formatSnmpValue,
    hasOnlyDisplayableText,
    isValidDisplayableUtf8
};
