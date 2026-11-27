import { validators } from '../validationCommon';

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
        threadCount: [
            {
                required: true,
                message: '请输入处理线程数'
            },
            {
                validator: value => {
                    const isNumericValue =
                        typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
                    const count = isNumericValue ? Number(value) : Number.NaN;
                    return Number.isInteger(count) && count >= 1 && count <= 16;
                },
                message: '请输入1-16之间的整数'
            }
        ],
        sourceInstanceTemplate: [
            {
                validator: value => value === undefined || ['h3c', 'fullValue', 'custom'].includes(value),
                message: '请选择有效的BGP进程识别模板'
            }
        ],
        sourceInstanceTlvType: [
            {
                validator: value => {
                    if (value === undefined) return true;
                    const isNumericValue =
                        typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
                    const type = isNumericValue ? Number(value) : Number.NaN;
                    return Number.isInteger(type) && type >= 0 && type <= 65535;
                },
                message: '请输入0-65535之间的整数'
            }
        ],
        sourceInstanceCustomTemplate: [
            {
                validator: (value, formData) =>
                    formData.sourceInstanceTemplate !== 'custom' ||
                    (typeof value === 'string' &&
                        value.length <= 1024 &&
                        value.split('{instance}').length === 2 &&
                        Array.from(value).every(character => {
                            const code = character.charCodeAt(0);
                            return code >= 32 && code !== 127;
                        })),
                message: '模板最多1024字符，必须包含且只包含一个{instance}，且不能包含控制字符'
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
