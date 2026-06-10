const { getAddrFamilyType } = require('../utils/bgpUtils');
const { getBgpPacketSummary } = require('../utils/bgpPacketParser');
const BmpConst = require('../const/bmpConst');

class BmpBgpRoute {
    constructor(BmpBgpSession, BmpBgpInstance) {
        this.BmpBgpSession = BmpBgpSession;
        this.BmpBgpInstance = BmpBgpInstance;

        // key
        this.pathId = null;
        this.rd = null;
        this.ip = null;
        this.mask = null;
        this.afi = null;
        this.safi = null;

        // attributes
        this.origin = null;
        this.asPath = null;
        this.med = 0;
        this.localPref = 0;
        this.communities = null;
        this.otc = null;
        this.nextHop = null;
        this.labels = null;
        this.routeType = null;
        this.rawNlri = null;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;
        this.pathStatus = null;
        this.pathStatusNames = [];
        this.pathStatusText = null;
        this.pathStatusUnknownBits = 0;
        this.pathStatusReason = null;
        this.pathStatusReasonName = null;
        this.pathStatusReasonText = null;
        this.pathStatusReasons = [];
        this.pathStatusTlvs = [];

        // bgp packet
        this.bgpPacket = [];

        this.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
        this.ribEpoch = 0;
        this.staleEpoch = null;
        this.lastSeenAt = null;
        this.staleAt = null;
        this.staleReason = null;
    }

    static makeKey(pathId, rd, ip, mask) {
        return `${pathId}|${rd}|${ip}|${mask}`;
    }

    static parseKey(key) {
        const [pathId, rd, ip, mask] = key.split('|');
        return { pathId, rd, ip, mask };
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

    getPacketSummary() {
        if (this.bgpPacket && !Array.isArray(this.bgpPacket)) {
            return getBgpPacketSummary(this.bgpPacket);
        }
        return null;
    }

    getRouteListInfo() {
        return {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: this.rd,
            origin: this.origin,
            asPath: this.asPath,
            med: this.med,
            nextHop: this.nextHop,
            pathId: this.pathId,
            labels: this.labels,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            pathStatus: this.pathStatus,
            pathStatusNames: this.pathStatusNames,
            pathStatusText: this.pathStatusText,
            pathStatusUnknownBits: this.pathStatusUnknownBits,
            pathStatusReason: this.pathStatusReason,
            pathStatusReasonName: this.pathStatusReasonName,
            pathStatusReasonText: this.pathStatusReasonText,
            routeState: this.routeState
        };
    }

    getRouteInfo(options = {}) {
        const { includeSummary = true } = options;
        const routeInfo = {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: this.rd,
            origin: this.origin,
            asPath: this.asPath,
            med: this.med,
            nextHop: this.nextHop,
            localPref: this.localPref,
            communities: this.communities,
            otc: this.otc,
            pathId: this.pathId,
            labels: this.labels,
            routeType: this.routeType,
            rawNlri: this.rawNlri,
            nlriDetail: this.nlriDetail,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            pathStatus: this.pathStatus,
            pathStatusNames: this.pathStatusNames,
            pathStatusText: this.pathStatusText,
            pathStatusUnknownBits: this.pathStatusUnknownBits,
            pathStatusReason: this.pathStatusReason,
            pathStatusReasonName: this.pathStatusReasonName,
            pathStatusReasonText: this.pathStatusReasonText,
            pathStatusReasons: this.pathStatusReasons,
            pathStatusTlvs: this.pathStatusTlvs,
            routeState: this.routeState,
            ribEpoch: this.ribEpoch,
            staleEpoch: this.staleEpoch,
            lastSeenAt: this.lastSeenAt,
            staleAt: this.staleAt,
            staleReason: this.staleReason
        };
        if (includeSummary) {
            routeInfo.summary = this.getPacketSummary();
        }
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
        this.pathStatus = null;
        this.pathStatusNames = [];
        this.pathStatusText = null;
        this.pathStatusUnknownBits = 0;
        this.pathStatusReason = null;
        this.pathStatusReasonName = null;
        this.pathStatusReasonText = null;
        this.pathStatusReasons = [];
        this.pathStatusTlvs = [];
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
                    marking.reasonCode === null || marking.reasonCode === undefined
                        ? null
                        : Number(marking.reasonCode);
                const reasonName =
                    reasonCode === null ? null : BmpConst.BMP_PATH_STATUS_REASON_NAME?.[reasonCode] || null;
                const reasonText =
                    reasonCode === null
                        ? null
                        : reasonName || `Unknown(0x${reasonCode.toString(16).padStart(4, '0')})`;

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
        this.origin = null;
        this.asPath = null;
        this.med = 0;
        this.nextHop = null;
        this.localPref = 0;
        this.communities = null;
        this.otc = null;
        this.labels = null;
        this.routeType = null;
        this.rawNlri = null;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;
        this.clearPathStatus();

        this.bgpPacket = [];
    }
}

module.exports = BmpBgpRoute;
