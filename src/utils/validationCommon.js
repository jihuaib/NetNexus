import {
    IP_TYPE,
    BGP_MVPN_ROUTE_TYPE,
    BGP_QP_ROUTE_GROWTH_MODE,
    BGP_QP_BSID_MODE,
    BGP_LABEL_MODE,
    BGP_MPLS_LABEL_MAX,
    BGP_SRV6_SID_MODE,
    BGP_SRV6_ENDPOINT_BEHAVIOR,
    BGP_ADDR_FAMILY
} from '../const/bgpConst';
import ipaddr from 'ipaddr.js';

// 通用验证工具和常量

// 正则表达式
export const REGEX = {
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    ipv6: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/,
    number: /^\d+$/
};

// 通用验证函数
export const isValidIpv4 = value => {
    return REGEX.ipv4.test(value);
};

export const isValidIpv6 = value => {
    return REGEX.ipv6.test(value);
};

export const isValidIpv4Mask = value => {
    if (!REGEX.number.test(value)) {
        return false;
    }
    const num = Number(value);
    return num >= 1 && num <= 32;
};

export const isValidIpv6Mask = value => {
    if (!REGEX.number.test(value)) {
        return false;
    }
    const num = Number(value);
    return num >= 1 && num <= 128;
};

export const isValidPort = value => {
    if (!REGEX.number.test(value)) {
        return false;
    }
    const num = Number(value);
    return num >= 1024 && num <= 65535;
};

export const isASN = value => {
    if (!REGEX.number.test(value)) {
        return false;
    }
    const num = Number(value);
    return num >= 1 && num <= 4294967295;
};

export const isNumber = value => {
    return REGEX.number.test(value);
};

export const isValidMplsLabel = value => {
    if (!REGEX.number.test(`${value}`)) {
        return false;
    }
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 && num <= BGP_MPLS_LABEL_MAX;
};

const IPV6_MAX_BIGINT = (1n << 128n) - 1n;
const ADD_PATH_GENERATION_COUNT_MAX = 255;

const ipv6ToBigIntOrNull = value => {
    try {
        const address = ipaddr.parse(`${value}`);
        if (address.kind() !== 'ipv6') {
            return null;
        }
        return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
    } catch (_) {
        return null;
    }
};

export const isValidRd = value => {
    if (!value || typeof value !== 'string') return false;

    // 分割 AS:nn 或 IP:nn
    const parts = value.split(':');
    if (parts.length !== 2) return false;

    const [part1, part2] = parts;

    // 验证第二部分是否为数字
    if (!REGEX.number.test(part2)) return false;
    const num2 = Number(part2);

    // 情况 1: IP:nn (Type 1)
    // part1 是 IPv4 地址
    if (REGEX.ipv4.test(part1)) {
        // nn 必须是 0-65535
        return num2 >= 0 && num2 <= 65535;
    }

    // 情况 2: AS:nn (Type 0) 或 AS4:nn (Type 2)
    // part1 必须是数字
    if (!REGEX.number.test(part1)) return false;
    const num1 = Number(part1);

    // AS2:nn (Type 0) -> AS (0-65535) : nn (0-4294967295)
    if (num1 >= 0 && num1 <= 65535) {
        return num2 >= 0 && num2 <= 4294967295;
    }

    // AS4:nn (Type 2) -> AS (0-4294967295) : nn (0-65535)
    if (num1 > 65535 && num1 <= 4294967295) {
        return num2 >= 0 && num2 <= 65535;
    }

    return false;
};

export const isValidRtList = value => {
    if (!value) return true;

    if (typeof value !== 'string') return false;

    const rts = value.trim().split(/\s+/);
    if (rts.length === 0) return false;

    return rts.every(rt => isValidRd(rt));
};

export const validatePacketData = value => {
    const lines = value.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const numbers = line.split(/\s+/).filter(num => num !== '');

        // 检查每个数字的格式
        for (const num of numbers) {
            if (!/^[0-9A-Fa-f]{2}$/.test(num)) {
                return {
                    status: 'error',
                    message: `第 ${i + 1} 行包含无效的16进制数字: "${num}", 请输入2位的16进制数字`
                };
            }
        }
    }

    return {
        status: 'success',
        message: ''
    };
};

/**
 * 通用验证系统
 */
export class FormValidator {
    constructor(validationErrors, autoClearTimeout = 3000) {
        this.validationErrors = validationErrors;
        this.rules = {};
        this.autoClearTimeout = autoClearTimeout; // 默认3秒后自动清空
        this.clearTimers = {}; // 存储每个字段的清空定时器
    }

    /**
     * 添加验证规则
     * @param {string} field 字段名
     * @param {Array} rules 验证规则数组
     */
    addRule(field, rules) {
        this.rules[field] = rules;
        return this;
    }

    /**
     * 批量添加验证规则
     * @param {Object} rulesConfig 规则配置对象
     */
    addRules(rulesConfig) {
        Object.assign(this.rules, rulesConfig);
        return this;
    }

    /**
     * 执行验证
     * @param {Object} formData 表单数据
     * @returns {boolean} 是否有验证错误
     */
    validate(formData) {
        // 清空之前的验证错误
        this.clearErrors();

        for (const [field, rules] of Object.entries(this.rules)) {
            const value = formData[field];

            for (const rule of rules) {
                const result = this.executeRule(rule, value, formData, field);
                if (result.hasError) {
                    this.validationErrors.value[field] = result.message;
                    // 启动自动清空定时器
                    if (this.autoClearTimeout > 0) {
                        this.startAutoClearTimer(field);
                    }
                    return true; // 遇到第一个错误就立即返回
                }
            }
        }

        return false; // 没有任何错误
    }

    /**
     * 执行单个验证规则
     * @param {Object|Function} rule 验证规则
     * @param {any} value 字段值
     * @param {Object} formData 完整表单数据
     * @param {string} field 字段名
     * @returns {Object} 验证结果
     */
    executeRule(rule, value, formData, field) {
        if (typeof rule === 'function') {
            // 简单函数验证
            const isValid = rule(value, formData);
            return {
                hasError: !isValid,
                message: `${field} 验证失败`
            };
        }

        if (typeof rule === 'object') {
            const { validator, message, required = false } = rule;

            // 必填验证
            if (required && (value === '' || value === null || value === undefined)) {
                return {
                    hasError: true,
                    message: message || `请输入${field}`
                };
            }

            // 执行自定义验证器
            if (validator) {
                const isValid = validator(value, formData);
                return {
                    hasError: !isValid,
                    message: message || `${field} 验证失败`
                };
            }
        }

        return { hasError: false };
    }

    /**
     * 清空验证错误
     */
    clearErrors() {
        Object.keys(this.validationErrors.value).forEach(key => {
            this.validationErrors.value[key] = '';
        });
        // 清除所有定时器
        this.cancelAllTimers();
    }

    /**
     * 启动自动清空定时器
     * @param {string} field 字段名
     */
    startAutoClearTimer(field) {
        // 先清除之前的定时器
        this.cancelTimer(field);

        // 设置新的定时器
        this.clearTimers[field] = setTimeout(() => {
            if (this.validationErrors.value[field]) {
                this.validationErrors.value[field] = '';
            }
        }, this.autoClearTimeout);
    }

    /**
     * 取消单个字段的定时器
     * @param {string} field 字段名
     */
    cancelTimer(field) {
        if (this.clearTimers[field]) {
            clearTimeout(this.clearTimers[field]);
            delete this.clearTimers[field];
        }
    }

    /**
     * 取消所有定时器
     */
    cancelAllTimers() {
        Object.keys(this.clearTimers).forEach(field => {
            this.cancelTimer(field);
        });
    }

    /**
     * 验证单个字段
     * @param {string} field 字段名
     * @param {any} value 字段值
     * @param {Object} formData 完整表单数据
     * @returns {boolean} 是否有错误
     */
    validateField(field, value, formData) {
        if (!this.rules[field]) {
            return false;
        }

        // 清空该字段的错误
        this.validationErrors.value[field] = '';

        const rules = this.rules[field];
        for (const rule of rules) {
            const result = this.executeRule(rule, value, formData, field);
            if (result.hasError) {
                this.validationErrors.value[field] = result.message;
                return true;
            }
        }

        return false;
    }
}

/**
 * 常用验证器函数
 */
export const validators = {
    required: value => value !== '' && value !== null && value !== undefined,
    number: value => isNumber(value),
    port: value => isValidPort(value),
    ipv4: value => isValidIpv4(value),
    ipv6: value => isValidIpv6(value),
    ipv4Mask: value => isValidIpv4Mask(value),
    ipv6Mask: value => isValidIpv6Mask(value),
    asn: value => isASN(value),
    range: (min, max) => value => {
        const num = parseInt(value);
        return num >= min && num <= max;
    },
    compareNumbers:
        (compareField, operator = '<=') =>
        (value, formData) => {
            const currentNum = parseInt(value);
            const compareNum = parseInt(formData[compareField]);

            if (isNaN(currentNum) || isNaN(compareNum)) {
                return false;
            }

            switch (operator) {
                case '<=':
                    return currentNum <= compareNum;
                case '>=':
                    return currentNum >= compareNum;
                case '<':
                    return currentNum < compareNum;
                case '>':
                    return currentNum > compareNum;
                case '==':
                    return currentNum === compareNum;
                default:
                    return true;
            }
        },

    minLength: minLen => value => value && value.length >= minLen,
    arrayNotEmpty: value => Array.isArray(value) && value.length > 0,
    conditionalRequired: condition => (value, formData) => {
        if (condition(formData)) {
            return value !== '' && value !== null && value !== undefined;
        }
        return true;
    }
};

/**
 * 创建字符串生成器验证规则
 */
export const createStringGeneratorValidationRules = () => {
    return {
        template: [
            {
                required: true,
                message: '请输入字符串模板'
            }
        ],
        placeholder: [
            {
                required: true,
                message: '请输入占位符'
            }
        ],
        start: [
            {
                required: true,
                message: '请输入开始数值'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            },
            {
                validator: validators.compareNumbers('end', '<='),
                message: '开始值必须小于或等于结束值'
            }
        ],
        end: [
            {
                required: true,
                message: '请输入结束数值'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            },
            {
                validator: validators.compareNumbers('start', '>='),
                message: '结束值必须大于或等于开始值'
            }
        ]
    };
};

/**
 * 创建报文数据验证规则
 */
export const createPacketDataValidationRules = () => {
    return {
        packetData: [
            {
                required: true,
                message: '请输入报文数据'
            },
            {
                validator: value => {
                    const result = validatePacketData(value);
                    return result.status === 'success';
                },
                message: '请输入有效的16进制报文数据'
            }
        ],
        protocolPort: [
            {
                validator: value => value === '' || validators.range(1, 65535)(value),
                message: '请输入1-65535之间的数字'
            }
        ]
    };
};

/**
 * 创建FTP配置验证规则
 */
export const createFtpConfigValidationRules = () => {
    return {
        port: [
            {
                required: true,
                message: '请输入端口号'
            },
            {
                validator: value => validators.range(1, 65535)(value),
                message: '请输入1-65535之间的数字'
            }
        ]
    };
};

/**
 * 创建FTP用户验证规则
 */
export const createFtpUserValidationRules = () => {
    return {
        rootDir: [
            {
                required: true,
                message: '请输入根目录'
            }
        ],
        username: [
            {
                required: true,
                message: '请输入用户名'
            }
        ],
        password: [
            {
                required: true,
                message: '请输入密码'
            }
        ]
    };
};

/**
 * 创建BGP配置验证规则
 */
export const createBgpConfigValidationRules = () => {
    return {
        localAs: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        routerId: [
            {
                required: true,
                message: '请输入Router ID'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        port: [
            {
                required: true,
                message: '请输入监听端口'
            },
            {
                validator: value => {
                    const normalized = String(value ?? '').trim();
                    if (!/^\d+$/.test(normalized)) {
                        return false;
                    }
                    const port = Number(normalized);
                    return port >= 1 && port <= 65535;
                },
                message: '端口范围 1-65535'
            }
        ]
    };
};

export const createBgpPeerIpv4ConfigValidationRules = () => {
    return {
        peerIp: [
            {
                required: true,
                message: '请输入Peer IP'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        peerAs: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        holdTime: [
            {
                required: true,
                message: '请输入Hold Time'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            }
        ]
    };
};

export const createBgpPeerIpv6ConfigValidationRules = () => {
    return {
        peerIpv6: [
            {
                required: true,
                message: '请输入Peer IP'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        peerIpv6As: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        holdTimeIpv6: [
            {
                required: true,
                message: '请输入Hold Time'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            }
        ]
    };
};

export const createBgpIpv4RouteConfigValidationRules = () => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: validators.ipv4Mask,
                message: '请输入有效的IPv4掩码'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            }
        ],
        addPathCount: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.addPathEnabled) {
                        return true;
                    }
                    const count = Number(value);
                    return REGEX.number.test(`${value}`) && count > 0 && count <= ADD_PATH_GENERATION_COUNT_MAX;
                },
                message: `ADD-PATH数量范围为 1 ~ ${ADD_PATH_GENERATION_COUNT_MAX}`
            }
        ],
        rt: [
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值)'
            }
        ],
        labelMode: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    return Object.values(BGP_LABEL_MODE).includes(value);
                },
                message: '请选择标签模式'
            }
        ],
        labelStart: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    return isValidMplsLabel(value);
                },
                message: `标签范围为 0 ~ ${BGP_MPLS_LABEL_MAX}`
            }
        ],
        labelStep: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    if (formData.labelMode !== BGP_LABEL_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && Number(value) > 0;
                },
                message: '标签步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    if (formData.labelMode !== BGP_LABEL_MODE.INCREMENT) return true;
                    const start = Number(formData.labelStart);
                    const step = Number(value);
                    const count = Number(formData.count);
                    if (![start, step, count].every(Number.isFinite) || count <= 0) return true;
                    return start + (Math.floor(count) - 1) * step <= BGP_MPLS_LABEL_MAX;
                },
                message: '标签递增超出20bit范围'
            }
        ],
        srv6SidMode: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return Object.values(BGP_SRV6_SID_MODE).includes(value);
                },
                message: '请选择SRv6 SID模式'
            }
        ],
        srv6Sid: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return ipv6ToBigIntOrNull(value) !== null;
                },
                message: '请输入有效的SRv6 SID IPv6地址'
            }
        ],
        srv6SidStep: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && BigInt(value) > 0n;
                },
                message: 'SRv6 SID步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    const sidBase = ipv6ToBigIntOrNull(formData.srv6Sid);
                    if (sidBase === null || !REGEX.number.test(`${value}`)) return true;
                    const addPathCount =
                        formData.addPathEnabled && REGEX.number.test(`${formData.addPathCount}`)
                            ? Number(formData.addPathCount)
                            : 1;
                    const count = Number(formData.count) * addPathCount;
                    if (!Number.isFinite(count) || count <= 0) return true;
                    return sidBase + BigInt(Math.floor(count) - 1) * BigInt(value) <= IPV6_MAX_BIGINT;
                },
                message: 'SRv6 SID递增超出IPv6地址范围'
            }
        ],
        srv6EndpointBehavior: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return Object.values(BGP_SRV6_ENDPOINT_BEHAVIOR).includes(Number(value));
                },
                message: '请选择SRv6 Endpoint Behavior'
            }
        ]
    };
};

export const createBgpIpv6RouteConfigValidationRules = () => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: validators.ipv6Mask,
                message: '请输入有效的IPv6掩码'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            }
        ],
        addPathCount: [
            {
                validator: (value, formData) => {
                    if (!formData.addPathEnabled) return true;
                    const count = Number(value);
                    return REGEX.number.test(`${value}`) && count > 0 && count <= ADD_PATH_GENERATION_COUNT_MAX;
                },
                message: `ADD-PATH数量范围为 1 ~ ${ADD_PATH_GENERATION_COUNT_MAX}`
            }
        ],
        rt: [
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值)'
            }
        ],
        srv6SidMode: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return Object.values(BGP_SRV6_SID_MODE).includes(value);
                },
                message: '请选择SRv6 SID模式'
            }
        ],
        srv6Sid: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return ipv6ToBigIntOrNull(value) !== null;
                },
                message: '请输入有效的SRv6 SID IPv6地址'
            }
        ],
        srv6SidStep: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && BigInt(value) > 0n;
                },
                message: 'SRv6 SID步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    const sidBase = ipv6ToBigIntOrNull(formData.srv6Sid);
                    if (sidBase === null || !REGEX.number.test(`${value}`)) return true;
                    const addPathCount =
                        formData.addPathEnabled && REGEX.number.test(`${formData.addPathCount}`)
                            ? Number(formData.addPathCount)
                            : 1;
                    const count = Number(formData.count) * addPathCount;
                    if (!Number.isFinite(count) || count <= 0) return true;
                    return sidBase + BigInt(Math.floor(count) - 1) * BigInt(value) <= IPV6_MAX_BIGINT;
                },
                message: 'SRv6 SID递增超出IPv6地址范围'
            }
        ],
        srv6EndpointBehavior: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return Object.values(BGP_SRV6_ENDPOINT_BEHAVIOR).includes(Number(value));
                },
                message: '请选择SRv6 Endpoint Behavior'
            }
        ]
    };
};

export const createBgpMvpnRouteConfigValidationRules = () => {
    return {
        rd: [
            {
                required: true,
                message: '请输入RD'
            },
            {
                validator: value => isValidRd(value),
                message: 'RD格式错误(支持 IP:nn, AS2:nn, AS4:nn)'
            }
        ],
        rt: [
            {
                required: true,
                message: '请输入RT'
            },
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值, 格式同RD)'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            },
            {
                validator: validators.number,
                message: '请输入有效的数字'
            }
        ],
        originatingRouterIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.LEAF_AD
                    ].includes(formData.routeType)
                ),
                message: '请输入Originating Router IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.LEAF_AD
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ],
        sourceAs: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Source AS'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.asn(value);
                    }
                    return true;
                },
                message: '请输入有效的ASN'
            }
        ],
        sourceIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Source IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ],
        groupIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Group IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ]
    };
};

const QP_MAX_DQPN = 0xffffff;

const isPositiveInteger = value => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0;
};

const isNonNegativeIntegerInRange = (value, max) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= max;
};

const qpRouteGrowthIncludesDqpn = formData =>
    !formData.routeGrowthMode ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.DQPN ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;

const qpRouteGrowthIncludesIp = formData =>
    !formData.routeGrowthMode ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;

const createBgpQpRouteConfigValidationRules = (prefixValidator, maskValidator, prefixMessage, maskMessage) => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: prefixValidator,
                message: prefixMessage
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: maskValidator,
                message: maskMessage
            }
        ],
        count: [
            {
                validator: isPositiveInteger,
                message: '请输入数量'
            }
        ],
        ipStep: [
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesIp(formData)) return true;
                    return isPositiveInteger(value);
                },
                message: 'IP步长必须为正整数'
            }
        ],
        startDqpn: [
            {
                required: true,
                message: '请输入起始DQPN'
            },
            {
                validator: value => isNonNegativeIntegerInRange(value, QP_MAX_DQPN),
                message: 'DQPN范围为 0 ~ 16777215（24bit）'
            }
        ],
        dqpnStep: [
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesDqpn(formData)) return true;
                    return isPositiveInteger(value);
                },
                message: 'DQPN步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesDqpn(formData)) return true;
                    const count = Number(formData.count);
                    const start = Number(formData.startDqpn);
                    const step = Number(value);
                    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(start) || !Number.isInteger(step)) {
                        return false;
                    }
                    return start + (count - 1) * step <= QP_MAX_DQPN;
                },
                message: 'DQPN连续生成超出 24bit 范围'
            }
        ],
        bsid: [
            {
                required: true,
                message: '请输入BSID'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        bsidStep: [
            {
                validator: (value, formData) => {
                    if (formData.bsidMode !== BGP_QP_BSID_MODE.CONTINUOUS) return true;
                    return isPositiveInteger(value);
                },
                message: 'BSID步长必须为正整数'
            }
        ]
    };
};

export const createBgpIpv4QpRouteConfigValidationRules = () =>
    createBgpQpRouteConfigValidationRules(
        validators.ipv4,
        validators.ipv4Mask,
        '请输入有效的IPv4地址',
        '请输入有效的IPv4掩码'
    );

export const createBgpIpv6QpRouteConfigValidationRules = () =>
    createBgpQpRouteConfigValidationRules(
        validators.ipv6,
        validators.ipv6Mask,
        '请输入有效的IPv6地址',
        '请输入有效的IPv6掩码'
    );

/**
 * 创建BMP工具验证规则
 */
export const createBmpConfigValidationRules = () => {
    return {
        port: [
            {
                required: true,
                message: '请输入端口号'
            },
            {
                validator: validators.port,
                message: '请输入1024-65535之间的数字'
            }
        ],
        pathMarkingTlvType: [
            {
                required: true,
                message: '请输入Path TLV类型'
            },
            {
                validator: value => {
                    const type = Number(value);
                    return Number.isInteger(type) && type >= 1 && type <= 0x3fff;
                },
                message: '请输入1-16383之间的整数'
            }
        ]
    };
};

/**
 * 创建RPKI配置验证规则
 */
export const createRpkiConfigValidationRules = () => {
    return {
        port: [
            {
                required: true,
                message: '请输入端口号'
            },
            {
                validator: validators.port,
                message: '请输入1024-65535之间的数字'
            }
        ]
    };
};

/**
 * 创建RPKI ROA配置验证规则
 */
export const createRpkiRoaConfigValidationRules = () => {
    return {
        ip: [
            {
                required: true,
                message: '请输入IP地址'
            },
            {
                validator: (value, formData) => {
                    if (formData.ipType === IP_TYPE.IPV4) {
                        return validators.ipv4(value);
                    } else {
                        return validators.ipv6(value);
                    }
                },
                message: '请输入有效的IP地址'
            }
        ],
        asn: [
            {
                required: true,
                message: '请输入ASN'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: (value, formData) => {
                    const maxRange = formData.ipType === IP_TYPE.IPV4 ? 32 : 128;
                    return validators.range(0, maxRange)(value);
                },
                message: '请输入有效的掩码值'
            },
            {
                validator: (value, formData) => {
                    const maskNum = parseInt(value);
                    const maxLengthNum = parseInt(formData.maxLength);
                    if (isNaN(maskNum) || isNaN(maxLengthNum)) {
                        return true; // 让其他验证器处理数值验证
                    }
                    return maskNum <= maxLengthNum;
                },
                message: '掩码值不能大于最大前缀长度'
            }
        ],
        maxLength: [
            {
                required: true,
                message: '请输入最大前缀长度'
            },
            {
                validator: (value, formData) => {
                    const maxRange = formData.ipType === IP_TYPE.IPV4 ? 32 : 128;
                    return validators.range(0, maxRange)(value);
                },
                message: '请输入有效的最大前缀长度'
            },
            {
                validator: (value, formData) => {
                    const maskNum = parseInt(formData.mask);
                    const maxLengthNum = parseInt(value);
                    if (isNaN(maskNum) || isNaN(maxLengthNum)) {
                        return true; // 让其他验证器处理数值验证
                    }
                    return maxLengthNum >= maskNum;
                },
                message: '最大前缀长度不能小于掩码值'
            }
        ]
    };
};

/**
 * 创建 RPKI Router Key (v1+) 验证规则
 */
export const createRpkiRouterKeyValidationRules = () => {
    return {
        ski: [
            { required: true, message: '请输入 SKI (Subject Key Identifier)' },
            {
                validator: value => {
                    if (!value) return false;
                    return /^[0-9a-fA-F]{40}$/.test(value);
                },
                message: 'SKI 必须是 40 位十六进制字符（20 字节）'
            }
        ],
        asn: [
            { required: true, message: '请输入 ASN' },
            { validator: validators.asn, message: '请输入有效的 ASN' }
        ],
        spki: [
            { required: true, message: '请输入 SPKI (Subject Public Key Info)' },
            {
                validator: value => {
                    if (!value) return false;
                    return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
                },
                message: 'SPKI 必须是十六进制字符串，长度必须为偶数'
            }
        ]
    };
};

/**
 * 创建 RPKI ASPA (v2+) 验证规则
 */
export const createRpkiAspaValidationRules = () => {
    return {
        customerAsn: [
            { required: true, message: '请输入 Customer ASN' },
            { validator: validators.asn, message: '请输入有效的 Customer ASN' }
        ],
        providerAsnsRaw: [
            {
                validator: value => {
                    if (!value || String(value).trim() === '') return true;
                    const parts = value
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                    const providerAsns = parts.map(p => Number(p));
                    const hasInvalidAsn = providerAsns.some(
                        asn => !Number.isInteger(asn) || asn < 0 || asn > 4294967295
                    );
                    return !hasInvalidAsn;
                },
                message: 'Provider ASN 必须是逗号分隔的 0-4294967295 整数列表'
            }
        ],
        afiFlags: [
            { required: true, message: '请选择 AFI Flags' },
            {
                validator: value => {
                    const n = parseInt(value, 10);
                    return n === 1 || n === 2 || n === 3;
                },
                message: 'AFI Flags 必须为 1(IPv4) / 2(IPv6) / 3(BOTH)'
            }
        ]
    };
};

/**
 * 创建SNMP配置验证规则
 */
export const createSnmpConfigValidationRules = () => {
    return {
        targetHost: [
            {
                validator: value => validators.required(String(value || '').trim()),
                message: '请输入目标地址'
            }
        ],
        port: [
            {
                required: true,
                message: '请输入监听端口'
            },
            {
                validator: value => validators.range(1, 65535)(value),
                message: '端口范围1-65535'
            }
        ],
        queryPort: [
            {
                required: true,
                message: '请输入查询端口'
            },
            {
                validator: value => validators.range(1, 65535)(value),
                message: '查询端口范围1-65535'
            }
        ],
        supportedVersions: [
            {
                validator: value => Array.isArray(value) && value.length === 1,
                message: '请选择一个SNMP版本'
            }
        ],
        community: [
            {
                validator: (value, formData) => {
                    if (
                        formData.supportedVersions &&
                        (formData.supportedVersions.includes('v1') || formData.supportedVersions.includes('v2c'))
                    ) {
                        return validators.required(value);
                    }
                    return true;
                },
                message: '请输入Community字符串'
            }
        ],
        v3Username: [
            {
                validator: validators.conditionalRequired(
                    formData => formData.supportedVersions && formData.supportedVersions.includes('v3')
                ),
                message: '请输入SNMPv3用户名'
            }
        ],
        authPassword: [
            {
                validator: (value, formData) => {
                    if (formData.supportedVersions.includes('v3') && formData.securityLevel !== 'noAuthNoPriv') {
                        return validators.minLength(8)(value);
                    }
                    return true;
                },
                message: '认证密码至少8位'
            }
        ],
        privPassword: [
            {
                validator: (value, formData) => {
                    if (formData.supportedVersions.includes('v3') && formData.securityLevel === 'authPriv') {
                        return validators.minLength(8)(value);
                    }
                    return true;
                },
                message: '加密密码至少8位'
            }
        ]
    };
};

/**
 * 创建 TCP-AO MAC 计算验证规则
 */
export const createTcpAoMacValidationRules = () => {
    const isValidHex = str => {
        const cleaned = str.replace(/\s+/g, '').replace(/:/g, '');
        return cleaned.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(cleaned);
    };
    const isValidUint32Input = value => {
        if (!value || !String(value).trim()) return true;
        const text = String(value).trim();
        let num;
        if (/^0x[0-9a-fA-F]+$/.test(text)) {
            num = Number.parseInt(text.slice(2), 16);
        } else if (/^\d+$/.test(text)) {
            num = Number.parseInt(text, 10);
        } else {
            return false;
        }
        return Number.isInteger(num) && num >= 0 && num <= 4294967295;
    };

    return {
        key: [
            {
                required: true,
                message: '密钥不能为空'
            }
        ],
        sne: [
            {
                validator: value => {
                    if (!value || !value.trim()) return true;
                    return isValidHex(value);
                },
                message: '必须为合法的十六进制字符串'
            }
        ],
        ipPacket: [
            {
                required: true,
                message: 'IP 报文不能为空'
            },
            {
                validator: value => isValidHex(value),
                message: '必须为合法的十六进制字符串'
            }
        ],
        isnA: [
            {
                validator: isValidUint32Input,
                message: '必须是十进制或0x十六进制的32位无符号整数'
            }
        ],
        isnB: [
            {
                validator: isValidUint32Input,
                message: '必须是十进制或0x十六进制的32位无符号整数'
            }
        ]
    };
};

/**
 * 创建网络信息验证规则
 */
export const createNetworkInfoValidationRules = () => {
    return {
        ip: [
            {
                required: true,
                message: '请输入IP地址'
            },
            {
                validator: (value, formData) => {
                    if (formData.family === 'ipv6') {
                        return validators.ipv6(value);
                    }
                    return validators.ipv4(value);
                },
                message: '请输入有效的IP地址'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码/前缀长度'
            },
            {
                validator: (value, formData) => {
                    if (formData.family === 'ipv6') {
                        // IPv6 prefix length 1-128
                        return validators.range(1, 128)(value);
                    }

                    if (value.includes('.')) {
                        return validators.ipv4(value); // Rough check for mask format
                    }
                    return validators.range(1, 32)(value);
                },
                message: '请输入有效的子网掩码或前缀长度'
            }
        ],
        gateway: [
            {
                validator: (value, formData) => {
                    if (!value) return true; // Optional
                    if (formData.family === 'ipv6') {
                        return validators.ipv6(value);
                    }
                    return validators.ipv4(value);
                },
                message: '请输入有效的网关地址'
            }
        ]
    };
};
