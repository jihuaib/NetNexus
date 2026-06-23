import { BMP_ROUTE_PARSE_STATUS } from '../const/bmpConst';

export const normalizeRouteParseStatus = parseStatus => {
    const status = Number(parseStatus);
    return Number.isInteger(status) ? status : BMP_ROUTE_PARSE_STATUS.OK;
};

export const hasRouteParseError = parseStatus =>
    (normalizeRouteParseStatus(parseStatus) & BMP_ROUTE_PARSE_STATUS.ERROR) !== 0;

export const hasRouteParseWarning = parseStatus =>
    (normalizeRouteParseStatus(parseStatus) & BMP_ROUTE_PARSE_STATUS.WARNING) !== 0;

export const getRouteParseStatusText = parseStatus => {
    const status = normalizeRouteParseStatus(parseStatus);
    if (status === BMP_ROUTE_PARSE_STATUS.OK) return 'OK';
    if (hasRouteParseError(status)) return '解析失败';
    if (hasRouteParseWarning(status)) return '告警';
    return '未知';
};

export const getRouteParseStatusColor = parseStatus => {
    if (hasRouteParseError(parseStatus)) return 'red';
    if (hasRouteParseWarning(parseStatus)) return 'orange';
    return 'green';
};

export const getRouteParseStatusRowClass = parseStatus => {
    if (hasRouteParseError(parseStatus)) return 'route-parse-error-row';
    if (hasRouteParseWarning(parseStatus)) return 'route-parse-warning-row';
    return '';
};
