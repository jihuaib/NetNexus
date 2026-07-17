const BmpConst = require('../const/bmpConst');

const SESSION_STATISTICS_RIB_TYPES = new Set([
    BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
    BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
    BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
]);

const PRE_POLICY_ADJ_RIB_IN_STAT_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_IN
]);

const LEGACY_ADJ_RIB_IN_STAT_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_ADJ_RIB_IN
]);

const POST_POLICY_ADJ_RIB_IN_STAT_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_IN
]);

const PRE_POLICY_ADJ_RIB_OUT_STAT_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT
]);

const POST_POLICY_ADJ_RIB_OUT_STAT_TYPES = new Set([
    BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT,
    BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT
]);

function normalizeSessionStatisticsRibType(ribType) {
    if (ribType === null || ribType === undefined || ribType === '') {
        return null;
    }
    const normalized = Number(ribType);
    return SESSION_STATISTICS_RIB_TYPES.has(normalized) ? normalized : null;
}

function normalizePeerFlags(flags) {
    if (flags === null || flags === undefined || flags === '') {
        return null;
    }
    const normalized = Number(flags);
    return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function getSessionStatisticsRibTypeByFlags(flags) {
    const normalizedFlags = normalizePeerFlags(flags);
    if (normalizedFlags === null) {
        return null;
    }

    const postPolicy = (normalizedFlags & BmpConst.BMP_SESSION_FLAGS.POST_POLICY) !== 0;
    const adjRibOut = (normalizedFlags & BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0;
    if (adjRibOut) {
        return postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT : BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
    }
    return postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN : BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
}

function getReportPeerFlags(report = {}) {
    const session = report.session && typeof report.session === 'object' ? report.session : {};
    const candidates = [
        report.effectiveSessionFlags,
        report.sessionFlags,
        report.effectiveFlags,
        session.effectiveSessionFlags,
        session.sessionFlags,
        report.rawSessionFlags,
        report.rawFlags,
        session.rawSessionFlags
    ];
    for (const candidate of candidates) {
        const flags = normalizePeerFlags(candidate);
        if (flags !== null) {
            return flags;
        }
    }
    return null;
}

function getLegacyDirectionRibType(direction) {
    if (direction === 'rib-out') {
        return BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
    }
    if (direction === 'rib-in') {
        return BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
    }
    return null;
}

function getSessionStatisticsReportFallbackRibType(report = {}) {
    return (
        normalizeSessionStatisticsRibType(report.ribType) ||
        getSessionStatisticsRibTypeByFlags(getReportPeerFlags(report)) ||
        getLegacyDirectionRibType(report.ribDirection) ||
        // Reports written before the RIB dimension was introduced implicitly
        // represented the conventional post-policy Adj-RIB-In view.
        BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
    );
}

function hasLegacyPostPolicyAdjRibInMarker(report = {}) {
    if (normalizeSessionStatisticsRibType(report.ribType) === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN) {
        return true;
    }
    return getSessionStatisticsRibTypeByFlags(getReportPeerFlags(report)) === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
}

function getStatisticRibType(statistic = {}, fallbackRibType, legacyPostPolicyAdjRibIn = false) {
    const statisticType = Number(statistic.type);
    if (PRE_POLICY_ADJ_RIB_IN_STAT_TYPES.has(statisticType)) {
        return BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
    }
    if (POST_POLICY_ADJ_RIB_IN_STAT_TYPES.has(statisticType)) {
        return BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
    }
    if (LEGACY_ADJ_RIB_IN_STAT_TYPES.has(statisticType)) {
        return legacyPostPolicyAdjRibIn
            ? BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
            : BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
    }
    if (PRE_POLICY_ADJ_RIB_OUT_STAT_TYPES.has(statisticType)) {
        return BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
    }
    if (POST_POLICY_ADJ_RIB_OUT_STAT_TYPES.has(statisticType)) {
        return BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT;
    }
    return normalizeSessionStatisticsRibType(fallbackRibType);
}

function getSessionStatisticsReportRibTypes(report = {}) {
    const fallbackRibType = getSessionStatisticsReportFallbackRibType(report);
    const legacyPostPolicyAdjRibIn = hasLegacyPostPolicyAdjRibInMarker(report);
    const ribTypes = new Set();
    if (Array.isArray(report.statistics)) {
        report.statistics.forEach(statistic =>
            ribTypes.add(getStatisticRibType(statistic, fallbackRibType, legacyPostPolicyAdjRibIn))
        );
    }
    if (ribTypes.size === 0) {
        ribTypes.add(fallbackRibType);
    }
    return Array.from(ribTypes).filter(ribType => ribType !== null);
}

function getSessionStatisticsReportRibType(report = {}) {
    const ribTypes = getSessionStatisticsReportRibTypes(report);
    return ribTypes.length === 1 ? ribTypes[0] : getSessionStatisticsReportFallbackRibType(report);
}

function splitSessionStatisticsReport(report = {}) {
    const fallbackRibType = getSessionStatisticsReportFallbackRibType(report);
    const legacyPostPolicyAdjRibIn = hasLegacyPostPolicyAdjRibInMarker(report);
    const buckets = new Map();
    const statistics = Array.isArray(report.statistics) ? report.statistics : [];
    statistics.forEach(statistic => {
        const ribType = getStatisticRibType(statistic, fallbackRibType, legacyPostPolicyAdjRibIn);
        if (!buckets.has(ribType)) {
            buckets.set(ribType, []);
        }
        buckets.get(ribType).push(statistic);
    });
    if (buckets.size === 0) {
        buckets.set(fallbackRibType, statistics);
    }

    const normalizedReport = { ...report };
    delete normalizedReport.ribDirection;
    return Array.from(buckets, ([ribType, items]) => ({
        ...normalizedReport,
        ribType,
        statistics: items
    }));
}

function getSessionStatisticsEntityIdentityParts(session = {}) {
    return [session.sessionType, session.sessionRdRaw || session.sessionRd, session.sessionIp, session.sessionAs];
}

function getSessionStatisticsReportIdentityParts(report = {}) {
    return [...getSessionStatisticsEntityIdentityParts(report.session), getSessionStatisticsReportRibType(report)];
}

module.exports = {
    SESSION_STATISTICS_RIB_TYPES,
    PRE_POLICY_ADJ_RIB_IN_STAT_TYPES,
    LEGACY_ADJ_RIB_IN_STAT_TYPES,
    POST_POLICY_ADJ_RIB_IN_STAT_TYPES,
    PRE_POLICY_ADJ_RIB_OUT_STAT_TYPES,
    POST_POLICY_ADJ_RIB_OUT_STAT_TYPES,
    normalizeSessionStatisticsRibType,
    getSessionStatisticsRibTypeByFlags,
    getSessionStatisticsReportFallbackRibType,
    hasLegacyPostPolicyAdjRibInMarker,
    getStatisticRibType,
    getSessionStatisticsReportRibTypes,
    getSessionStatisticsReportRibType,
    splitSessionStatisticsReport,
    getSessionStatisticsEntityIdentityParts,
    getSessionStatisticsReportIdentityParts
};
