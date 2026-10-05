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
