const { getAddrFamilyType } = require('../../utils/bgpUtils');
const BmpConst = require('../../const/bmpConst');
const { DEFAULT_BMP_ROUTE_ATTR } = require('./bmpRouteAttrStore');

const DEFAULT_PATH_ID = 0;
const DEFAULT_RD = '0:0';
const EMPTY_ARRAY = Object.freeze([]);
const DEFAULT_PATH_STATUS_INFO = Object.freeze({
    pathStatus: null,
    pathStatusNames: EMPTY_ARRAY,
    pathStatusText: null,
    pathStatusUnknownBits: 0,
    pathStatusReason: null,
    pathStatusReasonName: null,
    pathStatusReasonText: null,
    pathStatusReasons: EMPTY_ARRAY,
    pathStatusTlvs: EMPTY_ARRAY
});

class BmpBgpRoute {
    constructor(BmpBgpSession, BmpBgpInstance) {
        this.BmpBgpSession = BmpBgpSession;
        this.BmpBgpInstance = BmpBgpInstance;
        this.attrId = null;
        this._inlineAttr = null;

        // key
        this.pathId = DEFAULT_PATH_ID;
        this.rd = DEFAULT_RD;
        this.ip = null;
        this.mask = null;
        this.afi = null;
        this.safi = null;

        // NLRI and per-route state
        this.labels = null;
        this.routeType = null;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;

        this.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
        this.ribEpoch = 0;
        this.staleEpoch = null;
        this.lastSeenAt = null;
        this.staleAt = null;
        this.staleReason = null;
    }

    getRouteAttrOwner() {
        return this.BmpBgpSession || this.BmpBgpInstance || null;
    }

    getInlineRouteAttr() {
        return this._inlineAttr ? { ...DEFAULT_BMP_ROUTE_ATTR, ...this._inlineAttr } : null;
    }

    getRouteAttr() {
        const owner = this.getRouteAttrOwner();
        return owner?.getRouteAttr?.(this) || this.getInlineRouteAttr() || { ...DEFAULT_BMP_ROUTE_ATTR };
    }

    getRouteAttrEntry() {
        const owner = this.getRouteAttrOwner();
        return owner?.getRouteAttrEntry?.(this) || null;
    }

    makeRouteAttr(overrides = {}) {
        return {
            ...DEFAULT_BMP_ROUTE_ATTR,
            ...this.getRouteAttr(),
            ...overrides
        };
    }

    assignRouteAttr(attr) {
        const owner = this.getRouteAttrOwner();
        if (owner?.assignRouteAttr) {
            return owner.assignRouteAttr(this, this.makeRouteAttr(attr));
        }

        this._inlineAttr = this.makeRouteAttr(attr);
        return null;
    }

    releaseRouteAttr() {
        const owner = this.getRouteAttrOwner();
        if (owner?.releaseRouteAttr) {
            owner.releaseRouteAttr(this);
        }
        this.attrId = null;
        this._inlineAttr = null;
    }

    getRouteAttrValue(field) {
        const attr = this.getRouteAttr();
        return attr[field] === undefined ? DEFAULT_BMP_ROUTE_ATTR[field] : attr[field];
    }

    setRouteAttrValue(field, value) {
        this.assignRouteAttr({ [field]: value });
    }

    get origin() {
        return this.getRouteAttrValue('origin');
    }

    set origin(value) {
        this.setRouteAttrValue('origin', value);
    }

    get asPath() {
        return this.getRouteAttrValue('asPath');
    }

    set asPath(value) {
        this.setRouteAttrValue('asPath', value);
    }

    get med() {
        return this.getRouteAttrValue('med');
    }

    set med(value) {
        this.setRouteAttrValue('med', value);
    }

    get localPref() {
        return this.getRouteAttrValue('localPref');
    }

    set localPref(value) {
        this.setRouteAttrValue('localPref', value);
    }

    get communities() {
        return this.getRouteAttrValue('communities');
    }

    set communities(value) {
        this.setRouteAttrValue('communities', value);
    }

    get otc() {
        return this.getRouteAttrValue('otc');
    }

    set otc(value) {
        this.setRouteAttrValue('otc', value);
    }

    get nextHop() {
        return this.getRouteAttrValue('nextHop');
    }

    set nextHop(value) {
        this.setRouteAttrValue('nextHop', value);
    }

    get prefixSid() {
        return this.getRouteAttrValue('prefixSid');
    }

    set prefixSid(value) {
        this.setRouteAttrValue('prefixSid', value);
    }

    static normalizePathId(pathId) {
        if (pathId === null || pathId === undefined || pathId === '') {
            return DEFAULT_PATH_ID;
        }
        const numericPathId = Number(pathId);
        return Number.isInteger(numericPathId) ? numericPathId : DEFAULT_PATH_ID;
    }

    static normalizeRd(rd) {
        if (rd === null || rd === undefined || rd === '') {
            return DEFAULT_RD;
        }
        return String(rd);
    }

    static makeKey(pathId, rd, ip, mask) {
        return `${BmpBgpRoute.normalizePathId(pathId)}|${BmpBgpRoute.normalizeRd(rd)}|${ip}|${mask}`;
    }

    static parseKey(key) {
        const [pathId, rd, ip, mask] = key.split('|');
        return {
            pathId: BmpBgpRoute.normalizePathId(pathId),
            rd: BmpBgpRoute.normalizeRd(rd),
            ip,
            mask
        };
    }

    static getKnownPathStatusMask() {
        return Object.keys(BmpConst.BMP_PATH_STATUS_NAME || {}).reduce((mask, flag) => {
            return (mask | Number(flag)) >>> 0;
        }, 0);
    }

    static getPathStatusNames(status) {
        if (status === null || status === undefined) {
            return [];
        }

        const numericStatus = Number(status) >>> 0;
        return Object.entries(BmpConst.BMP_PATH_STATUS_NAME || {})
            .filter(([flag]) => (numericStatus & Number(flag)) !== 0)
            .map(([, name]) => name);
    }

    static getPathStatusUnknownBits(status) {
        if (status === null || status === undefined) {
            return 0;
        }

        const numericStatus = Number(status) >>> 0;
        return (numericStatus & (~BmpBgpRoute.getKnownPathStatusMask() >>> 0)) >>> 0;
    }

    static formatPathStatus(status, names = null, unknownBits = null) {
        if (status === null || status === undefined) {
            return null;
        }

        const statusNames = Array.isArray(names) ? names : BmpBgpRoute.getPathStatusNames(status);
        const unrecognizedBits =
            unknownBits === null || unknownBits === undefined
                ? BmpBgpRoute.getPathStatusUnknownBits(status)
                : Number(unknownBits) >>> 0;
        const labels = [...statusNames];
        if (unrecognizedBits !== 0) {
            labels.push(`Unknown(0x${unrecognizedBits.toString(16).padStart(8, '0')})`);
        }

        return labels.length > 0 ? labels.join(', ') : 'None';
    }

    getRouteKey() {
        return BmpBgpRoute.makeKey(this.pathId, this.rd, this.ip, this.mask);
    }

    getAddrFamilyType() {
        if (this.afi && this.safi) {
            return getAddrFamilyType(this.afi, this.safi);
        } else if (this.BmpBgpSession) {
            return getAddrFamilyType(this.BmpBgpSession.afi, this.BmpBgpSession.safi);
        } else if (this.BmpBgpInstance) {
            return getAddrFamilyType(this.BmpBgpInstance.afi, this.BmpBgpInstance.safi);
        }
        return null;
    }

    getPathStatusInfo() {
        return {
            pathStatus: this.pathStatus === undefined ? DEFAULT_PATH_STATUS_INFO.pathStatus : this.pathStatus,
            pathStatusNames:
                this.pathStatusNames === undefined ? DEFAULT_PATH_STATUS_INFO.pathStatusNames : this.pathStatusNames,
            pathStatusText:
                this.pathStatusText === undefined ? DEFAULT_PATH_STATUS_INFO.pathStatusText : this.pathStatusText,
            pathStatusUnknownBits:
                this.pathStatusUnknownBits === undefined
                    ? DEFAULT_PATH_STATUS_INFO.pathStatusUnknownBits
                    : this.pathStatusUnknownBits,
            pathStatusReason:
                this.pathStatusReason === undefined ? DEFAULT_PATH_STATUS_INFO.pathStatusReason : this.pathStatusReason,
            pathStatusReasonName:
                this.pathStatusReasonName === undefined
                    ? DEFAULT_PATH_STATUS_INFO.pathStatusReasonName
                    : this.pathStatusReasonName,
            pathStatusReasonText:
                this.pathStatusReasonText === undefined
                    ? DEFAULT_PATH_STATUS_INFO.pathStatusReasonText
                    : this.pathStatusReasonText,
            pathStatusReasons:
                this.pathStatusReasons === undefined
                    ? DEFAULT_PATH_STATUS_INFO.pathStatusReasons
                    : this.pathStatusReasons,
            pathStatusTlvs:
                this.pathStatusTlvs === undefined ? DEFAULT_PATH_STATUS_INFO.pathStatusTlvs : this.pathStatusTlvs
        };
    }

    getRouteListInfo() {
        const routeAttr = this.getRouteAttr();
        const pathStatusInfo = this.getPathStatusInfo();
        return {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: BmpBgpRoute.normalizeRd(this.rd),
            origin: routeAttr.origin,
            asPath: routeAttr.asPath,
            med: routeAttr.med,
            nextHop: routeAttr.nextHop,
            pathId: BmpBgpRoute.normalizePathId(this.pathId),
            labels: this.labels,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            pathStatus: pathStatusInfo.pathStatus,
            pathStatusNames: pathStatusInfo.pathStatusNames,
            pathStatusText: pathStatusInfo.pathStatusText,
            pathStatusUnknownBits: pathStatusInfo.pathStatusUnknownBits,
            pathStatusReason: pathStatusInfo.pathStatusReason,
            pathStatusReasonName: pathStatusInfo.pathStatusReasonName,
            pathStatusReasonText: pathStatusInfo.pathStatusReasonText,
            routeState: this.routeState
        };
    }

    getRouteInfo() {
        const routeAttr = this.getRouteAttr();
        const attrEntry = this.getRouteAttrEntry();
        const pathStatusInfo = this.getPathStatusInfo();
        const routeInfo = {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: BmpBgpRoute.normalizeRd(this.rd),
            origin: routeAttr.origin,
            asPath: routeAttr.asPath,
            med: routeAttr.med,
            nextHop: routeAttr.nextHop,
            localPref: routeAttr.localPref,
            communities: routeAttr.communities,
            otc: routeAttr.otc,
            prefixSid: routeAttr.prefixSid,
            attrId: this.attrId || '',
            attrRefCount: attrEntry?.refCount || 0,
            pathId: BmpBgpRoute.normalizePathId(this.pathId),
            labels: this.labels,
            routeType: this.routeType,
            rawNlri: this.nlriDetail?.rawNlri || null,
            nlriDetail: this.nlriDetail,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            pathStatus: pathStatusInfo.pathStatus,
            pathStatusNames: pathStatusInfo.pathStatusNames,
            pathStatusText: pathStatusInfo.pathStatusText,
            pathStatusUnknownBits: pathStatusInfo.pathStatusUnknownBits,
            pathStatusReason: pathStatusInfo.pathStatusReason,
            pathStatusReasonName: pathStatusInfo.pathStatusReasonName,
            pathStatusReasonText: pathStatusInfo.pathStatusReasonText,
            pathStatusReasons: pathStatusInfo.pathStatusReasons,
            pathStatusTlvs: pathStatusInfo.pathStatusTlvs,
            routeState: this.routeState,
            ribEpoch: this.ribEpoch,
            staleEpoch: this.staleEpoch,
            lastSeenAt: this.lastSeenAt,
            staleAt: this.staleAt,
            staleReason: this.staleReason
        };
        return routeInfo;
    }

    markActive(ribEpoch = 0) {
        this.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
        this.ribEpoch = ribEpoch;
        this.lastSeenAt = new Date().toISOString();
        this.staleAt = null;
        this.staleReason = null;
        this.staleEpoch = null;
    }

    markStale(reason, staleEpoch = null) {
        this.routeState = BmpConst.BMP_ROUTE_STATE.STALE;
        this.staleReason = reason;
        this.staleEpoch = staleEpoch;
        this.staleAt = new Date().toISOString();
    }

    clearPathStatus() {
        delete this.pathStatus;
        delete this.pathStatusNames;
        delete this.pathStatusText;
        delete this.pathStatusUnknownBits;
        delete this.pathStatusReason;
        delete this.pathStatusReasonName;
        delete this.pathStatusReasonText;
        delete this.pathStatusReasons;
        delete this.pathStatusTlvs;
    }

    setPathStatusMarkings(markings) {
        this.clearPathStatus();
        if (!Array.isArray(markings) || markings.length === 0) {
            return;
        }

        const normalizedMarkings = markings
            .filter(marking => marking && marking.pathStatus !== null && marking.pathStatus !== undefined)
            .map(marking => {
                const pathStatus = Number(marking.pathStatus) >>> 0;
                const statusNames = BmpBgpRoute.getPathStatusNames(pathStatus);
                const statusUnknownBits = BmpBgpRoute.getPathStatusUnknownBits(pathStatus);
                const reasonCode =
                    marking.reasonCode === null || marking.reasonCode === undefined ? null : Number(marking.reasonCode);
                const reasonName =
                    reasonCode === null ? null : BmpConst.BMP_PATH_STATUS_REASON_NAME?.[reasonCode] || null;
                const reasonText =
                    reasonCode === null ? null : reasonName || `Unknown(0x${reasonCode.toString(16).padStart(4, '0')})`;

                return {
                    type: marking.type,
                    enterprise: marking.enterprise,
                    enterpriseNumber: marking.enterpriseNumber,
                    rawIndex: marking.rawIndex,
                    index: marking.index,
                    group: marking.group,
                    pathStatus,
                    pathStatusNames: statusNames,
                    pathStatusText: BmpBgpRoute.formatPathStatus(pathStatus, statusNames, statusUnknownBits),
                    pathStatusUnknownBits: statusUnknownBits,
                    reasonCode,
                    reasonName,
                    reasonText
                };
            });

        if (normalizedMarkings.length === 0) {
            return;
        }

        const pathStatus = normalizedMarkings.reduce((status, marking) => {
            return (status | marking.pathStatus) >>> 0;
        }, 0);
        const pathStatusNames = BmpBgpRoute.getPathStatusNames(pathStatus);
        const pathStatusUnknownBits = BmpBgpRoute.getPathStatusUnknownBits(pathStatus);
        const reasons = normalizedMarkings
            .filter(marking => marking.reasonCode !== null)
            .map(marking => ({
                reasonCode: marking.reasonCode,
                reasonName: marking.reasonName,
                reasonText: marking.reasonText
            }));
        const reasonTexts = Array.from(new Set(reasons.map(reason => reason.reasonText).filter(Boolean)));

        this.pathStatus = pathStatus;
        this.pathStatusNames = pathStatusNames;
        this.pathStatusText = BmpBgpRoute.formatPathStatus(pathStatus, pathStatusNames, pathStatusUnknownBits);
        this.pathStatusUnknownBits = pathStatusUnknownBits;
        this.pathStatusReason = reasons.length > 0 ? reasons[0].reasonCode : null;
        this.pathStatusReasonName = reasons.length > 0 ? reasons[0].reasonName : null;
        this.pathStatusReasonText = reasonTexts.length > 0 ? reasonTexts.join(', ') : null;
        this.pathStatusReasons = reasons;
        this.pathStatusTlvs = normalizedMarkings;
    }

    clearAttributes() {
        this.releaseRouteAttr();
        this.labels = null;
        this.routeType = null;
        delete this.rawNlri;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;
        this.clearPathStatus();
    }
}

module.exports = BmpBgpRoute;
