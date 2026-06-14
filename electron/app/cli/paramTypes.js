const ipaddr = require('ipaddr.js');

function parseNumericRange(range, defaultMin, defaultMax) {
    if (!range) {
        return [defaultMin, defaultMax];
    }

    const parts = range.split('-').map(item => Number(item.trim()));
    if (parts.length === 1 && Number.isFinite(parts[0])) {
        return [parts[0], parts[0]];
    }
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        return [parts[0], parts[1]];
    }
    return [defaultMin, defaultMax];
}

class ParamType {
    constructor(typeStr = '') {
        this.typeStr = typeStr;
        this.name = 'unknown';
        this.min = null;
        this.max = null;
        this.choices = [];
        this.parse(typeStr);
    }

    parse(typeStr) {
        const source = String(typeStr || '').trim();
        const open = source.indexOf('(');
        const close = open >= 0 ? source.lastIndexOf(')') : -1;
        this.name = (open >= 0 ? source.slice(0, open) : source).trim().toLowerCase();
        const range = open >= 0 && close > open ? source.slice(open + 1, close) : '';

        if (this.name === 'string') {
            [this.min, this.max] = parseNumericRange(range, 0, 255);
        } else if (this.name === 'uint') {
            [this.min, this.max] = parseNumericRange(range, 0, 0xffffffff);
        } else if (this.name === 'int') {
            [this.min, this.max] = parseNumericRange(range, -0x80000000, 0x7fffffff);
        } else if (this.name === 'enum') {
            this.choices = range
                .split(',')
                .map(item => item.trim().toLowerCase())
                .filter(Boolean);
        }
    }

    validate(value) {
        const text = String(value ?? '');
        if (this.name === 'enum') {
            return this.choices.includes(text.toLowerCase());
        }
        if (this.name === 'string') {
            return text.length >= this.min && text.length <= this.max;
        }
        if (this.name === 'uint' || this.name === 'int') {
            if (!/^-?\d+$/u.test(text)) {
                return false;
            }
            const number = Number(text);
            return Number.isInteger(number) && number >= this.min && number <= this.max;
        }
        if (this.name === 'ipv4') {
            return ipaddr.isValid(text) && ipaddr.parse(text).kind() === 'ipv4';
        }
        if (this.name === 'ipv6') {
            return ipaddr.isValid(text) && ipaddr.parse(text).kind() === 'ipv6';
        }
        if (this.name === 'ip') {
            return ipaddr.isValid(text);
        }
        if (this.name === 'mac') {
            return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(text);
        }
        return true;
    }

    completionCandidates(prefix = '') {
        if (this.name !== 'enum') {
            return [];
        }
        const normalized = String(prefix || '').toLowerCase();
        return this.choices.filter(choice => choice.startsWith(normalized));
    }

    matchesPrefix(prefix = '') {
        if (this.name === 'enum') {
            return this.completionCandidates(prefix).length > 0;
        }
        return this.validate(prefix);
    }

    displayName() {
        if (this.name === 'enum' && this.choices.length > 0) {
            return this.choices.join('|');
        }
        return this.typeStr || this.name || 'parameter';
    }
}

module.exports = ParamType;
