const SOURCE_INSTANCE_DEFAULTS = Object.freeze({
    sourceInstanceTemplate: 'h3c',
    sourceInstanceTlvType: 0,
    sourceInstanceCustomTemplate: 'bgp instance name:{instance}'
});
const INSTANCE_PLACEHOLDER = '{instance}';

function hasControlCharacters(text) {
    return Array.from(text).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

function normalizeSourceInstanceConfig(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('BGP实例识别配置格式无效');
    const template =
        config.sourceInstanceTemplate === undefined
            ? SOURCE_INSTANCE_DEFAULTS.sourceInstanceTemplate
            : config.sourceInstanceTemplate;
    if (!['h3c', 'fullValue', 'custom'].includes(template)) throw new Error('BGP实例识别模板无效');
    const rawType =
        config.sourceInstanceTlvType === undefined
            ? SOURCE_INSTANCE_DEFAULTS.sourceInstanceTlvType
            : config.sourceInstanceTlvType;
    const type = Number(rawType);
    if (
        !['number', 'string'].includes(typeof rawType) ||
        String(rawType).trim() === '' ||
        !Number.isInteger(type) ||
        type < 0 ||
        type > 65535
    )
        throw new Error('BGP实例TLV类型必须是0-65535之间的整数');
    const customTemplate =
        config.sourceInstanceCustomTemplate === undefined
            ? SOURCE_INSTANCE_DEFAULTS.sourceInstanceCustomTemplate
            : config.sourceInstanceCustomTemplate;
    if (
        template === 'custom' &&
        (typeof customTemplate !== 'string' ||
            customTemplate.length > 1024 ||
            customTemplate.split(INSTANCE_PLACEHOLDER).length !== 2 ||
            hasControlCharacters(customTemplate))
    )
        throw new Error('自定义BGP实例模板须包含且仅包含一个{instance}，长度不超过1024，且不能含控制字符');
    return {
        sourceInstanceTemplate: template,
        sourceInstanceTlvType: type,
        sourceInstanceCustomTemplate:
            typeof customTemplate === 'string' ? customTemplate : SOURCE_INSTANCE_DEFAULTS.sourceInstanceCustomTemplate
    };
}

function getSourceInstanceConfigError(config = {}) {
    try {
        normalizeSourceInstanceConfig(config);
        return null;
    } catch (error) {
        return error.message;
    }
}

function getInitiationBgpInstanceName(tlvs, config = {}) {
    const options = normalizeSourceInstanceConfig(config);
    const names = new Set();
    for (const tlv of tlvs || []) {
        const rawType = tlv.rawType ?? tlv.type | (tlv.enterprise ? 0x8000 : 0);
        if (rawType !== options.sourceInstanceTlvType) continue;
        const text = Buffer.isBuffer(tlv.value) ? tlv.value.toString('utf8') : tlv.valueText;
        if (typeof text !== 'string' || text.includes('\ufffd')) continue;
        let name;
        if (options.sourceInstanceTemplate === 'h3c') {
            name = /^\s*bgp\s+instance\s+name\s*:\s*([^\r\n]+?)\s*$/i.exec(text)?.[1];
        } else if (options.sourceInstanceTemplate === 'fullValue') {
            name = text;
        } else {
            // Literal prefix/suffix matching avoids treating device text as a regular expression.
            const [prefix, suffix] = options.sourceInstanceCustomTemplate.split(INSTANCE_PLACEHOLDER);
            if (text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length) {
                name = text.slice(prefix.length, text.length - suffix.length);
            }
        }
        name = name?.trim();
        if (name && !hasControlCharacters(name)) names.add(name);
    }
    if (names.size > 1) throw new Error('BMP Initiation包含冲突的BGP实例名称');
    return names.values().next().value || null;
}

module.exports = {
    SOURCE_INSTANCE_DEFAULTS,
    normalizeSourceInstanceConfig,
    getSourceInstanceConfigError,
    getInitiationBgpInstanceName
};
