const DEFAULT_BMP_THREAD_COUNT = 4;
const MAX_BMP_THREAD_COUNT = 16;

function normalizeBmpThreadCount(value) {
    if (value === undefined || value === null) return DEFAULT_BMP_THREAD_COUNT;

    const isNumericValue = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
    const threadCount = isNumericValue ? Number(value) : Number.NaN;
    if (!Number.isInteger(threadCount) || threadCount < 1 || threadCount > MAX_BMP_THREAD_COUNT) {
        throw new Error(`BMP处理线程数必须是1-${MAX_BMP_THREAD_COUNT}之间的整数`);
    }
    return threadCount;
}

module.exports = {
    DEFAULT_BMP_THREAD_COUNT,
    MAX_BMP_THREAD_COUNT,
    normalizeBmpThreadCount
};
