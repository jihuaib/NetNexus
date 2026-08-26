const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { DEFAULT_API_SETTINGS } = require('../const/apiConst');

const BGP_ADDR_FAMILY_VALUES = new Set(Object.values(BgpConst.BGP_ADDR_FAMILY));
const BMP_RIB_TYPE_VALUES = new Set(Object.values(BmpConst.BMP_BGP_RIB_TYPE));
const BMP_ROUTE_STATE_VALUES = new Set(Object.values(BmpConst.BMP_ROUTE_STATE_FILTER));
const ROUTE_KEY_MAX_LENGTH = 2048;

class ParameterError extends Error {
    constructor(message, data = null) {
        super(message);
        this.parameterError = true;
        this.data = data;
    }
}

function apiError(code, msg, data = null, httpStatus = 400) {
    return {
        status: 'error',
        code,
        msg,
        data,
        httpStatus
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(parent, key) {
    const value = parent[key];
    if (!isPlainObject(value)) {
        throw new ParameterError(`${key}必须是对象`);
    }
    return value;
}

function hasControlCharacter(text) {
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code <= 31 || code === 127) {
            return true;
        }
    }
    return false;
}

function readString(parent, key, options = {}) {
    const { required = true, maxLength = 256, allowEmpty = false } = options;
    const value = parent[key];
    if (value === undefined || value === null) {
        if (!required) {
            return '';
        }
        throw new ParameterError(`${key}不能为空`);
    }

    const text = String(value).trim();
    if (!allowEmpty && text.length === 0) {
        throw new ParameterError(`${key}不能为空`);
    }
    if (text.length > maxLength) {
        throw new ParameterError(`${key}长度不能超过${maxLength}`);
    }
    if (hasControlCharacter(text)) {
        throw new ParameterError(`${key}不能包含控制字符`);
    }
    return text;
}

function readInteger(parent, key, options = {}) {
    const {
        required = true,
        min = Number.MIN_SAFE_INTEGER,
        max = Number.MAX_SAFE_INTEGER,
        defaultValue = null
    } = options;
    const value = parent[key];
    if (value === undefined || value === null || value === '') {
        if (!required) {
            return defaultValue;
        }
        throw new ParameterError(`${key}不能为空`);
    }

    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new ParameterError(`${key}必须是${min}到${max}之间的整数`);
    }
    return number;
}

function readOptionalBoolean(parent, key) {
    const value = parent[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new ParameterError(`${key}必须是布尔值`);
    }
    return value;
}

function normalizeClient(value) {
    if (!isPlainObject(value)) {
        throw new ParameterError('client必须是对象');
    }

    return {
        localIp: readString(value, 'localIp', { maxLength: 128 }),
        localPort: readInteger(value, 'localPort', { min: 0, max: 65535 }),
        remoteIp: readString(value, 'remoteIp', { maxLength: 128 }),
        remotePort: readInteger(value, 'remotePort', { min: 0, max: 65535 })
    };
}

function normalizeSession(value) {
    if (!isPlainObject(value)) {
        throw new ParameterError('session必须是对象');
    }

    return {
        sessionType: readInteger(value, 'sessionType', { min: 0, max: 255 }),
        sessionRd: readString(value, 'sessionRd', { maxLength: 128 }),
        sessionRdRaw: readString(value, 'sessionRdRaw', { required: false, maxLength: 32 }) || null,
        sessionIp: readString(value, 'sessionIp', { maxLength: 128 }),
        sessionAs: readInteger(value, 'sessionAs', { min: 0, max: 4294967295 })
    };
}

function normalizeInstance(value) {
    if (!isPlainObject(value)) {
        throw new ParameterError('instance必须是对象');
    }

    const addrFamilyType = readInteger(value, 'addrFamilyType', { min: 1, max: 65535 });
    if (!BGP_ADDR_FAMILY_VALUES.has(addrFamilyType)) {
        throw new ParameterError('addrFamilyType不支持');
    }

    return {
        instanceType: readInteger(value, 'instanceType', { min: 0, max: 255 }),
        instanceRd: readString(value, 'instanceRd', { maxLength: 128 }),
        instanceRdRaw: readString(value, 'instanceRdRaw', { required: false, maxLength: 32 }) || null,
        addrFamilyType
    };
}

function normalizeRouteQuery(body, settings) {
    const af = readInteger(body, 'af', { min: 1, max: 65535 });
    if (!BGP_ADDR_FAMILY_VALUES.has(af)) {
        throw new ParameterError('af不支持');
    }

    const ribType = readInteger(body, 'ribType', { min: 0, max: 255 });
    if (!BMP_RIB_TYPE_VALUES.has(ribType)) {
        throw new ParameterError('ribType不支持');
    }

    return {
        client: normalizeClient(readObject(body, 'client')),
        session: normalizeSession(readObject(body, 'session')),
        af,
        ribType,
        ...normalizePageFilter(body, settings)
    };
}

function normalizePageFilter(body, settings) {
    const maxPageSize = Math.max(1, Number(settings.maxPageSize) || DEFAULT_API_SETTINGS.maxPageSize);
    const page = readInteger(body, 'page', { required: false, min: 1, max: 1000000, defaultValue: 1 });
    const pageSize = readInteger(body, 'pageSize', {
        required: false,
        min: 1,
        max: maxPageSize,
        defaultValue: Math.min(20, maxPageSize)
    });
    const routeState =
        readString(body, 'routeState', {
            required: false,
            maxLength: 16,
            allowEmpty: true
        }) || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
    if (!BMP_ROUTE_STATE_VALUES.has(routeState)) {
        throw new ParameterError('routeState不支持');
    }

    const prefixFilter = readString(body, 'prefixFilter', {
        required: false,
        maxLength: 128,
        allowEmpty: true
    });

    return {
        page,
        pageSize,
        routeState,
        prefixFilter
    };
}

function normalizeInstanceRouteQuery(body, settings) {
    return {
        client: normalizeClient(readObject(body, 'client')),
        instance: normalizeInstance(readObject(body, 'instance')),
        ...normalizePageFilter(body, settings)
    };
}

function normalizeRouteDetailQuery(body) {
    const af = readInteger(body, 'af', { min: 1, max: 65535 });
    if (!BGP_ADDR_FAMILY_VALUES.has(af)) {
        throw new ParameterError('af不支持');
    }

    const ribType = readInteger(body, 'ribType', { min: 0, max: 255 });
    if (!BMP_RIB_TYPE_VALUES.has(ribType)) {
        throw new ParameterError('ribType不支持');
    }

    return {
        client: normalizeClient(readObject(body, 'client')),
        session: normalizeSession(readObject(body, 'session')),
        af,
        ribType,
        routeKey: readString(body, 'routeKey', { maxLength: ROUTE_KEY_MAX_LENGTH })
    };
}

function normalizeInstanceRouteDetailQuery(body) {
    return {
        client: normalizeClient(readObject(body, 'client')),
        instance: normalizeInstance(readObject(body, 'instance')),
        routeKey: readString(body, 'routeKey', { maxLength: ROUTE_KEY_MAX_LENGTH })
    };
}

function normalizePersistenceQuery(body, settings, includeState = true) {
    if (!isPlainObject(body)) {
        throw new ParameterError('请求体必须是对象');
    }
    const pageFilter = normalizePageFilter(
        {
            ...body,
            routeState: includeState ? body.routeState : 'all',
            prefixFilter: body.prefix || body.prefixFilter || ''
        },
        settings
    );
    const optionalString = (key, maxLength = 256) =>
        readString(body, key, { required: false, allowEmpty: true, maxLength }) || undefined;
    const optionalInteger = (key, min, max) =>
        readInteger(body, key, { required: false, min, max, defaultValue: undefined });

    return {
        page: pageFilter.page,
        pageSize: pageFilter.pageSize,
        cursor: optionalString('cursor', 512),
        includeTotal: readOptionalBoolean(body, 'includeTotal'),
        routeState: includeState ? pageFilter.routeState : undefined,
        prefix: pageFilter.prefixFilter || undefined,
        sourceId: optionalString('sourceId', 64),
        scopeId: optionalString('scopeId', 64),
        routeId: optionalString('routeId', 64),
        routeKey: optionalString('routeKey', ROUTE_KEY_MAX_LENGTH),
        scopeKind: optionalString('scopeKind', 32),
        ribType: optionalString('ribType', 32),
        eventType: optionalString('eventType', 32),
        afi: optionalInteger('afi', 0, 65535),
        safi: optionalInteger('safi', 0, 255),
        fromMs: optionalInteger('fromMs', 0, Number.MAX_SAFE_INTEGER),
        toMs: optionalInteger('toMs', 0, Number.MAX_SAFE_INTEGER)
    };
}

function requireBmpRunning(bmpApp) {
    if (!bmpApp.getBmpRunning()) {
        return apiError('BMP_NOT_RUNNING', 'BMP未启动', null, 409);
    }
    return null;
}

async function runBmpQuery(bmpApp, query) {
    const runningError = requireBmpRunning(bmpApp);
    if (runningError) {
        return runningError;
    }

    try {
        const result = await query();
        if (result && result.status === 'success' && result.msg === 'BMP未启动') {
            return apiError('BMP_NOT_RUNNING', 'BMP未启动', null, 409);
        }
        return result;
    } catch (error) {
        return apiError('BMP_QUERY_FAILED', error.message || '查询失败');
    }
}

function wrap(handler) {
    return async context => {
        try {
            return await handler(context);
        } catch (error) {
            if (error && error.parameterError) {
                return apiError('INVALID_PARAMETER', error.message, error.data);
            }
            throw error;
        }
    };
}

function createBmpApiRoutes(bmpApp) {
    return [
        {
            method: 'GET',
            path: '/api/v1/bmp/status',
            handler: wrap(async () => ({
                status: 'success',
                msg: '获取BMP状态成功',
                data: {
                    running: bmpApp.getBmpRunning()
                }
            }))
        },
        {
            method: 'GET',
            path: '/api/v1/bmp/clients',
            handler: wrap(async () => runBmpQuery(bmpApp, () => bmpApp.queryClientList()))
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/sessions',
            handler: wrap(async ({ body }) => {
                const client = normalizeClient(readObject(body, 'client'));
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpSessions(client));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/instances',
            handler: wrap(async ({ body }) => {
                const client = normalizeClient(readObject(body, 'client'));
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpInstances(client));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/routes',
            handler: wrap(async ({ body, settings }) => {
                const payload = normalizeRouteQuery(body, settings);
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpRoutes(payload));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/routes/detail',
            handler: wrap(async ({ body }) => {
                const payload = normalizeRouteDetailQuery(body);
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpRouteDetail(payload));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/instances/routes',
            handler: wrap(async ({ body, settings }) => {
                const payload = normalizeInstanceRouteQuery(body, settings);
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpInstanceRoutes(payload));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/instances/routes/detail',
            handler: wrap(async ({ body }) => {
                const payload = normalizeInstanceRouteDetailQuery(body);
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpInstanceRouteDetail(payload));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/statistics/session',
            handler: wrap(async ({ body }) => {
                const client = normalizeClient(readObject(body, 'client'));
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpStatisticsReports(client));
            })
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/statistics/instance',
            handler: wrap(async ({ body }) => {
                const client = normalizeClient(readObject(body, 'client'));
                return runBmpQuery(bmpApp, () => bmpApp.queryBgpInstanceStatisticsReports(client));
            })
        },
        {
            method: 'GET',
            path: '/api/v1/bmp/persistence/status',
            handler: wrap(async () => bmpApp.queryPersistenceStatus())
        },
        {
            method: 'POST',
            path: '/api/v1/bmp/persistence/routes',
            handler: wrap(async ({ body, settings }) => {
                const payload = normalizePersistenceQuery(body, settings, true);
                return bmpApp.queryPersistedRoutes(payload);
            })
        }
    ];
}

module.exports = createBmpApiRoutes;
