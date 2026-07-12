const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { getAddrFamilyType, getBgpAfiName, getBgpSafiName } = require('./bgpUtils');

const DEFAULT_RESULT_LIMIT = 500;
const MAX_RESULT_LIMIT = 2000;
const LOC_RIB_TYPE = 'loc-rib';
const STAGE_NAMES = ['preIn', 'postIn', 'locRib', 'preOut', 'postOut'];
const RIB_STAGE_MAP = new Map([
    [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, 'preIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, 'postIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, 'preOut'],
    [BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, 'postOut']
]);
const POLICY_DIFF_FIELDS = [
    'origin',
    'asPath',
    'nextHop',
    'localPref',
    'med',
    'communities',
    'otc',
    'prefixSid',
    'labels'
];

function stableId(parts) {
    return crypto
        .createHash('sha256')
        .update(parts.map(part => String(part ?? '')).join('\u001f'))
        .digest('hex')
        .slice(0, 24);
}

function normalizeRouteState(routeState) {
    const state = String(routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE).toLowerCase();
    return Object.values(BmpConst.BMP_ROUTE_STATE_FILTER).includes(state)
        ? state
        : BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
}

function getQueryValue(query) {
    if (query && typeof query === 'object') {
        return query.value ?? query.input ?? query.prefix ?? query.ip ?? query.query;
    }
    return query;
}

function normalizeNetworkAddress(address, prefixLength) {
    return address.constructor.networkAddressFromCIDR(`${address.toString()}/${prefixLength}`).toString();
}

function normalizeText(value) {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
}

function startsWithIpCidr(input) {
    const slashIndex = input.indexOf('/');
    return slashIndex > 0 && ipaddr.isValid(input.slice(0, slashIndex).trim());
}

function isExplicitIpAddress(input) {
    return (input.includes('.') || input.includes(':')) && ipaddr.isValid(input);
}

function parseRouteLensQuery(query) {
    const rawValue = getQueryValue(query);
    const input = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
    if (!input) {
        throw new Error('请输入有效的 Prefix、IP 或 NLRI 标识');
    }

    if (startsWithIpCidr(input)) {
        let parsedCidr;
        try {
            parsedCidr = ipaddr.parseCIDR(input);
        } catch (_error) {
            throw new Error('CIDR 前缀格式无效');
        }

        const [address, prefixLength] = parsedCidr;
        const network = normalizeNetworkAddress(address, prefixLength);
        return {
            input,
            mode: 'exact',
            matchType: 'exact',
            addressFamily: address.kind(),
            normalized: `${network}/${prefixLength}`,
            address,
            network,
            prefixLength,
            indexKeys: [`cidr:${network}/${prefixLength}`]
        };
    }

    if (isExplicitIpAddress(input)) {
        const address = ipaddr.parse(input);
        const maxPrefixLength = address.kind() === 'ipv4' ? 32 : 128;
        const indexKeys = [];
        for (let prefixLength = maxPrefixLength; prefixLength >= 0; prefixLength -= 1) {
            const network = normalizeNetworkAddress(address, prefixLength);
            indexKeys.push(`cidr:${network}/${prefixLength}`);
        }

        return {
            input,
            mode: 'covering',
            matchType: 'covering',
            addressFamily: address.kind(),
            normalized: address.toString(),
            address,
            network: null,
            prefixLength: null,
            indexKeys
        };
    }

    return {
        input,
        mode: 'text',
        matchType: 'text',
        addressFamily: null,
        normalized: normalizeText(input),
        address: null,
        network: null,
        prefixLength: null,
        indexKeys: []
    };
}

function getResultLimit(options, query) {
    const requested = Number(options?.maxResults ?? (query && typeof query === 'object' ? query.maxResults : null));
    if (!Number.isFinite(requested) || requested <= 0) {
        return DEFAULT_RESULT_LIMIT;
    }
    return Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.floor(requested)));
}

function getRouteNetwork(route) {
    const routeIp = route?.ip;
    const useRouteIp = routeIp !== null && routeIp !== undefined && ipaddr.isValid(String(routeIp));
    const rawPrefix = useRouteIp ? routeIp : route?.nlriDetail?.ipPrefix;
    const rawMask = useRouteIp ? route?.mask : route?.nlriDetail?.prefixLength;
    const prefixLength = Number(rawMask);
    if (!rawPrefix || !Number.isInteger(prefixLength) || !ipaddr.isValid(String(rawPrefix))) {
        return null;
    }

    const address = ipaddr.parse(String(rawPrefix));
    const maxPrefixLength = address.kind() === 'ipv4' ? 32 : 128;
    if (prefixLength < 0 || prefixLength > maxPrefixLength) {
        return null;
    }

    return {
        address,
        addressFamily: address.kind(),
        network: normalizeNetworkAddress(address, prefixLength),
        prefixLength,
        displayPrefix: `${rawPrefix}/${prefixLength}`
    };
}

function getRouteNlriValue(route, field) {
    return route?.[field] ?? route?.nlriDetail?.[field];
}

function getMvpnRouteTypeName(routeType) {
    return Object.entries(BgpConst.BGP_MVPN_ROUTE_TYPE || {}).find(
        ([, value]) => Number(value) === Number(routeType)
    )?.[0];
}

function getBaseRouteIdentity(route) {
    const routeIp = route?.ip;
    if (routeIp !== null && routeIp !== undefined && String(routeIp).trim()) {
        return String(routeIp).trim();
    }
    const nlriPrefix = route?.nlriDetail?.prefix;
    if (nlriPrefix !== null && nlriPrefix !== undefined && String(nlriPrefix).trim()) {
        return String(nlriPrefix).trim();
    }
    const routeKey = route?.routeKey || route?.getRouteKey?.();
    return routeKey === null || routeKey === undefined ? '' : String(routeKey).trim();
}

function getRouteIdentity(route) {
    const baseIdentity = getBaseRouteIdentity(route);
    const rd = getRouteNlriValue(route, 'rd');
    const includeRd = rd && rd !== '0:0' && !normalizeText(baseIdentity).includes(normalizeText(rd));
    let identity = baseIdentity;
    const safi = Number(route?.safi);
    const routeType = getRouteNlriValue(route, 'routeType');
    if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        identity = `mvpn:type=${routeType}${routeTypeName ? `:${routeTypeName.toLowerCase()}` : ''}:0x${baseIdentity}`;
    }
    if (includeRd) {
        identity = `${identity}|rd=${rd}`;
    }

    const dqpn = getRouteNlriValue(route, 'dqpn');
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        identity = `${identity}|dqpn=${dqpn}`;
    }

    return identity;
}

function getRouteDisplayPrefix(route) {
    const routeNetwork = getRouteNetwork(route);
    const hasIpIdentity = route?.ip !== null && route?.ip !== undefined && ipaddr.isValid(String(route.ip));
    const baseDisplay = routeNetwork && hasIpIdentity ? routeNetwork.displayPrefix : getBaseRouteIdentity(route) || '-';
    const safi = Number(route?.safi);
    const routeType = getRouteNlriValue(route, 'routeType');
    let display = baseDisplay;
    if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        display = `MVPN ${routeTypeName || `type=${routeType}`} · 0x${baseDisplay}`;
    }

    const rd = getRouteNlriValue(route, 'rd');
    if (rd && rd !== '0:0' && !normalizeText(baseDisplay).includes(normalizeText(rd))) {
        display = `${display} · RD ${rd}`;
    }

    const dqpn = getRouteNlriValue(route, 'dqpn');
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const dqpnBits = getRouteNlriValue(route, 'dqpnBits');
        display = `${display} · DQPN ${dqpn}${dqpnBits !== null && dqpnBits !== undefined ? `/${dqpnBits}` : ''}`;
    }

    return display;
}

function getRouteTextIdentities(route) {
    const identities = [];
    const seen = new Set();
    const addIdentity = (field, value) => {
        if (value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value))) {
            return;
        }
        const text = Array.isArray(value) ? value.join(', ') : String(value).trim();
        const normalized = normalizeText(text);
        if (!normalized || seen.has(`${field}\u001f${normalized}`)) {
            return;
        }
        seen.add(`${field}\u001f${normalized}`);
        identities.push({ field, value: text, normalized });
    };

    addIdentity('ip', route?.ip);
    addIdentity('nlriDetail.prefix', route?.nlriDetail?.prefix);
    addIdentity('routeIdentity', getRouteIdentity(route));
    addIdentity('routeKey', route?.routeKey || route?.getRouteKey?.());
    addIdentity('routeType', route?.routeType);
    addIdentity('routeTypeName', route?.routeTypeName);

    const nlriDetail = route?.nlriDetail || {};
    [
        'routeType',
        'routeTypeName',
        'nlriType',
        'nlriTypeName',
        'protocolId',
        'protocol',
        'protocolName',
        'identifier',
        'componentType',
        'componentTypeName'
    ].forEach(field => addIdentity(`nlriDetail.${field}`, nlriDetail[field]));

    const afiName = getBgpAfiName(route?.afi);
    const safiName = getBgpSafiName(route?.safi);
    addIdentity('addressFamily', `${afiName} ${safiName}`);
    addIdentity('safiName', safiName);

    const routeType = getRouteNlriValue(route, 'routeType');
    if (routeType !== null && routeType !== undefined && routeType !== '') {
        addIdentity('routeTypeLabel', `route-type=${routeType}`);
        if (Number(route?.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
            const routeTypeName = getMvpnRouteTypeName(routeType);
            addIdentity('mvpnRouteType', `MVPN type=${routeType}`);
            addIdentity('mvpnRouteTypeName', routeTypeName && `MVPN ${routeTypeName}`);
        }
    }

    const dqpn = getRouteNlriValue(route, 'dqpn');
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const dqpnBits = getRouteNlriValue(route, 'dqpnBits');
        addIdentity('nlriDetail.dqpn', dqpn);
        addIdentity('nlriDetail.dqpnLabel', `DQPN=${dqpn}`);
        if (dqpnBits !== null && dqpnBits !== undefined) {
            addIdentity('nlriDetail.dqpnWithBits', `DQPN=${dqpn}/${dqpnBits}`);
        }
    }

    const rd = getRouteNlriValue(route, 'rd');
    if (rd && rd !== '0:0') {
        addIdentity('rd', rd);
        addIdentity('rdLabel', `RD=${rd}`);
    }
    if (route?.labels) {
        addIdentity('labels', route.labels);
        addIdentity('labelsLabel', `Labels=${route.labels}`);
    }
    addIdentity('nlriDetail.rawNlri', nlriDetail.rawNlri);

    return identities;
}

function matchTextRoute(route, query) {
    const identities = getRouteTextIdentities(route);
    const exactIdentity = identities.find(identity => identity.normalized === query.normalized);
    const matchedIdentity =
        exactIdentity || identities.find(identity => identity.normalized.includes(query.normalized));
    if (!matchedIdentity) {
        return null;
    }

    const routeIdentity = getRouteIdentity(route) || matchedIdentity.value;
    return {
        matchType: exactIdentity ? 'text-exact' : 'text-contains',
        exact: Boolean(exactIdentity),
        covering: false,
        query: query.input,
        normalized: query.normalized,
        routeIdentity,
        displayPrefix: getRouteDisplayPrefix(route),
        matchedField: matchedIdentity.field,
        matchedValue: matchedIdentity.value,
        normalizedRouteIdentity: normalizeText(routeIdentity)
    };
}

function matchRoute(route, query) {
    if (query.mode === 'text') {
        return matchTextRoute(route, query);
    }

    const routeNetwork = getRouteNetwork(route);
    if (!routeNetwork || routeNetwork.addressFamily !== query.addressFamily) {
        return null;
    }

    if (query.mode === 'exact') {
        if (routeNetwork.network !== query.network || routeNetwork.prefixLength !== query.prefixLength) {
            return null;
        }
        return {
            matchType: 'exact',
            exact: true,
            covering: false,
            query: query.normalized,
            routeIdentity: getRouteIdentity(route),
            displayPrefix: getRouteDisplayPrefix(route),
            routePrefix: routeNetwork.displayPrefix,
            normalizedRoutePrefix: `${routeNetwork.network}/${routeNetwork.prefixLength}`,
            prefixLength: routeNetwork.prefixLength
        };
    }

    const networkAddress = ipaddr.parse(routeNetwork.network);
    if (!query.address.match(networkAddress, routeNetwork.prefixLength)) {
        return null;
    }

    const hostPrefixLength = query.addressFamily === 'ipv4' ? 32 : 128;
    return {
        matchType: routeNetwork.prefixLength === hostPrefixLength ? 'exact' : 'covering',
        exact: routeNetwork.prefixLength === hostPrefixLength,
        covering: true,
        query: query.normalized,
        routeIdentity: getRouteIdentity(route),
        displayPrefix: getRouteDisplayPrefix(route),
        routePrefix: routeNetwork.displayPrefix,
        normalizedRoutePrefix: `${routeNetwork.network}/${routeNetwork.prefixLength}`,
        prefixLength: routeNetwork.prefixLength
    };
}

function routeStateMatches(route, routeState) {
    if (routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ALL) {
        return true;
    }
    return (route?.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE) === routeState;
}

function getIndexedCandidates(routeMap, query, getRouteKeys, prefixIndex) {
    if (query.mode === 'text') {
        return Array.from(routeMap.values()).sort((left, right) => {
            const leftMatch = matchTextRoute(left, query);
            const rightMatch = matchTextRoute(right, query);
            const leftRank = leftMatch?.matchType === 'text-exact' ? 0 : leftMatch ? 1 : 2;
            const rightRank = rightMatch?.matchType === 'text-exact' ? 0 : rightMatch ? 1 : 2;
            return leftRank - rightRank || getRouteIdentity(left).localeCompare(getRouteIdentity(right));
        });
    }

    const hasUsableIndex =
        typeof getRouteKeys === 'function' &&
        prefixIndex instanceof Map &&
        (prefixIndex.size > 0 || routeMap.size === 0);
    if (!hasUsableIndex) {
        return routeMap.values();
    }

    const routeKeys = new Set();
    query.indexKeys.forEach(prefixKey => {
        const indexedKeys = getRouteKeys(prefixKey);
        if (indexedKeys instanceof Set || Array.isArray(indexedKeys)) {
            indexedKeys.forEach(routeKey => routeKeys.add(routeKey));
        } else if (indexedKeys !== null && indexedKeys !== undefined && indexedKeys !== '') {
            routeKeys.add(indexedKeys);
        }
    });

    return Array.from(routeKeys, routeKey => routeMap.get(routeKey)).filter(Boolean);
}

function routeCoreKey(routeInfo) {
    const routeNetwork = getRouteNetwork(routeInfo);
    const hasIpIdentity = routeInfo?.ip !== null && routeInfo?.ip !== undefined && ipaddr.isValid(String(routeInfo.ip));
    const prefix =
        routeNetwork && hasIpIdentity
            ? `${routeNetwork.network}/${routeNetwork.prefixLength}`
            : getRouteIdentity(routeInfo) || routeInfo.routeKey;
    return [
        routeInfo.afi ?? '',
        routeInfo.safi ?? '',
        routeInfo.rd ?? '0:0',
        prefix,
        getRouteNlriValue(routeInfo, 'dqpn') ?? '',
        routeInfo.pathId ?? 0
    ].join('|');
}

function getEntryVrfTableNames(routeInfo, owner) {
    const routeScopedNames = (Array.isArray(routeInfo?.routeTlvs) ? routeInfo.routeTlvs : [])
        .filter(tlv => tlv?.name === 'VRF/Table Name')
        .map(tlv => tlv.valueText ?? tlv.value)
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim());
    const ownerNames = Array.isArray(owner?.vrfTableNames) ? owner.vrfTableNames.filter(Boolean) : [];
    return Array.from(new Set(routeScopedNames.length > 0 ? routeScopedNames : ownerNames));
}

function stableValue(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableValue).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function valuesEqual(left, right) {
    return stableValue(left) === stableValue(right);
}

function diffSnapshot(entry) {
    if (!entry) {
        return null;
    }
    const snapshot = { entryId: entry.id };
    POLICY_DIFF_FIELDS.forEach(field => {
        snapshot[field] = entry.route?.[field] ?? null;
    });
    return snapshot;
}

function makeDiffContext(entry) {
    if (!entry) {
        return null;
    }

    const route = entry.route || {};
    const prefix = getRouteDisplayPrefix(route);
    const session = entry.session || {};
    const client = entry.client || {};
    return {
        entryId: entry.id,
        prefix,
        rd: route.rd || session.sessionRd || '0:0',
        pathId: route.pathId ?? 0,
        af: entry.af,
        clientName: client.sysName || '',
        clientIp: client.remoteIp || client.localIp || '',
        peerIp: session.sessionIp || '',
        peerAs: session.sessionAs ?? null,
        vrfTableNames: Array.isArray(entry.vrfTableNames) ? entry.vrfTableNames : []
    };
}

function makePolicyDiff(direction, correlationKey, beforeEntry, afterEntry) {
    const before = diffSnapshot(beforeEntry);
    const after = diffSnapshot(afterEntry);
    const context = makeDiffContext(beforeEntry || afterEntry);
    const changes = {};
    if (beforeEntry && afterEntry) {
        POLICY_DIFF_FIELDS.forEach(field => {
            const beforeValue = before?.[field] ?? null;
            const afterValue = after?.[field] ?? null;
            if (!valuesEqual(beforeValue, afterValue)) {
                changes[field] = { before: beforeValue, after: afterValue };
            }
        });
    }

    let status;
    let confidence;
    let evidenceType;
    let description;
    if (beforeEntry && afterEntry) {
        status = Object.keys(changes).length > 0 ? 'modified' : 'unchanged';
        confidence = 'high';
        evidenceType = 'observed';
        description =
            status === 'modified'
                ? 'BMP 前后策略阶段均有观测，且路由属性发生变化。'
                : 'BMP 前后策略阶段均有观测，路由属性未变化。';
    } else if (beforeEntry) {
        status = 'missing-after';
        const filterStatus =
            direction === 'inbound'
                ? BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY
                : BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY;
        const pathStatus = beforeEntry.route?.pathStatus;
        const hasReportedFilter =
            pathStatus !== null && pathStatus !== undefined && (Number(pathStatus) & filterStatus) !== 0;
        confidence = hasReportedFilter ? 'high' : 'low';
        evidenceType = hasReportedFilter ? 'reported' : 'inferred';
        description = hasReportedFilter
            ? `设备 Path Marking 明确上报该路由在${direction === 'inbound' ? '入站' : '出站'}策略中被过滤。`
            : '当前 BMP 快照中未观察到对应的 Post-Policy 路由；这是观测缺失，不能据此确定路由被策略过滤。';
    } else {
        status = 'post-only';
        confidence = 'medium';
        evidenceType = 'observed';
        description = '当前 BMP 快照中仅观察到 Post-Policy 路由，未观察到对应的 Pre-Policy 路由。';
    }

    return {
        id: `diff-${stableId([direction, correlationKey])}`,
        title: [context?.prefix, context?.peerIp ? `Peer ${context.peerIp}` : ''].filter(Boolean).join(' · '),
        context,
        direction,
        status,
        confidence,
        evidenceType,
        observationType:
            status === 'missing-after'
                ? evidenceType === 'reported'
                    ? 'reported-policy-filter'
                    : 'observational-missing-after'
                : status === 'post-only'
                  ? 'observational-pre-missing'
                  : 'observed-pair',
        before,
        after,
        changes,
        changedFields: Object.keys(changes),
        description
    };
}

function buildPolicyDiffs(entries) {
    const pairs = {
        inbound: ['preIn', 'postIn'],
        outbound: ['preOut', 'postOut']
    };
    const result = { inbound: [], outbound: [] };

    Object.entries(pairs).forEach(([direction, [beforeStage, afterStage]]) => {
        const grouped = new Map();
        entries
            .filter(entry => entry.stage === beforeStage || entry.stage === afterStage)
            .forEach(entry => {
                if (!grouped.has(entry.correlationKey)) {
                    grouped.set(entry.correlationKey, {});
                }
                grouped.get(entry.correlationKey)[entry.stage] = entry;
            });

        grouped.forEach((pair, correlationKey) => {
            result[direction].push(
                makePolicyDiff(direction, correlationKey, pair[beforeStage] || null, pair[afterStage] || null)
            );
        });
        result[direction].sort((left, right) => left.id.localeCompare(right.id));
    });

    const allDiffs = [...result.inbound, ...result.outbound];
    result.summary = {
        total: allDiffs.length,
        modified: allDiffs.filter(diff => diff.status === 'modified').length,
        unchanged: allDiffs.filter(diff => diff.status === 'unchanged').length,
        missingAfter: allDiffs.filter(diff => diff.status === 'missing-after').length,
        missingAfterReported: allDiffs.filter(
            diff => diff.status === 'missing-after' && diff.evidenceType === 'reported'
        ).length,
        missingAfterInferred: allDiffs.filter(
            diff => diff.status === 'missing-after' && diff.evidenceType === 'inferred'
        ).length,
        postOnly: allDiffs.filter(diff => diff.status === 'post-only').length
    };
    return result;
}

function buildInsights(entries, policyDiffs) {
    const markingEvidence = entries
        .filter(entry => entry.route?.pathStatus !== null && entry.route?.pathStatus !== undefined)
        .map(entry => ({
            entryId: entry.id,
            stage: entry.stage,
            pathStatus: entry.route.pathStatus,
            pathStatusText: entry.route.pathStatusText,
            pathStatusReason: entry.route.pathStatusReason,
            pathStatusReasonText: entry.route.pathStatusReasonText
        }));
    const locRibEntries = entries.filter(entry => entry.stage === 'locRib');
    const inferredMissingAfter = [...policyDiffs.inbound, ...policyDiffs.outbound].filter(
        diff => diff.status === 'missing-after' && diff.evidenceType === 'inferred'
    );
    const missingAfterCount = inferredMissingAfter.length;
    const insights = [];

    insights.push({
        id: markingEvidence.length > 0 ? 'path-marking-reported' : 'path-marking-not-observed',
        severity: markingEvidence.length > 0 ? 'info' : 'warning',
        evidenceType: markingEvidence.length > 0 ? 'reported' : 'observational',
        title: markingEvidence.length > 0 ? '设备上报了 Path Marking' : '未观察到 Path Marking',
        description:
            markingEvidence.length > 0
                ? `共 ${markingEvidence.length} 条匹配路由包含设备上报的 Path Marking，可直接用于解释路径状态。`
                : '匹配路由中没有 Path Marking，不能把界面推测当作设备真实的选路或过滤结论。',
        stage: 'all',
        count: markingEvidence.length,
        evidence: markingEvidence
    });

    insights.push({
        id: locRibEntries.length > 0 ? 'loc-rib-observed' : 'loc-rib-not-observed',
        severity: locRibEntries.length > 0 ? 'info' : 'warning',
        evidenceType: 'observational',
        title: locRibEntries.length > 0 ? '观察到 Loc-RIB 路由' : '未观察到 Loc-RIB 路由',
        description:
            locRibEntries.length > 0
                ? `Loc-RIB 阶段观察到 ${locRibEntries.length} 条匹配路由。`
                : '当前 BMP 快照中没有匹配的 Loc-RIB 路由；观测缺失不等同于设备未选中或未安装。',
        stage: 'locRib',
        count: locRibEntries.length,
        evidence: locRibEntries.map(entry => ({ entryId: entry.id, stage: entry.stage }))
    });

    if (markingEvidence.length === 0) {
        insights.push({
            id: 'selection-state-inferred',
            severity: 'warning',
            evidenceType: 'inferred',
            title: '选路说明仅为推测',
            description:
                '由于没有 Path Marking，关于 Best、Backup、Filtered 或 Non-installed 的说明只能基于阶段可见性推测，并非设备上报事实。',
            stage: 'all',
            count: entries.length,
            evidence: []
        });
    }

    if (missingAfterCount > 0) {
        insights.push({
            id: 'post-policy-observation-missing',
            severity: 'warning',
            evidenceType: 'inferred',
            title: 'Post-Policy 对应观测缺失',
            description: `有 ${missingAfterCount} 组路由仅在 Pre-Policy 阶段可见；这不能证明它们已被策略过滤。`,
            stage: 'post-policy',
            count: missingAfterCount,
            evidence: inferredMissingAfter.map(diff => ({ diffId: diff.id, direction: diff.direction }))
        });
    }

    return { insights, markingEvidenceCount: markingEvidence.length, locRibObservedCount: locRibEntries.length };
}

function makeEntry({ clientKey, client, scopeKey, session, instance, stage, ribType, route, match }) {
    const routeInfo = route.getRouteInfo();
    const coreKey = routeCoreKey(routeInfo);
    const scopeType = session ? 'session' : 'instance';
    const id = `route-${stableId([clientKey, scopeType, scopeKey, stage, ribType, coreKey])}`;
    const correlationKey = session
        ? [clientKey, scopeKey, coreKey, routeInfo.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE].join('\u001f')
        : null;
    const vrfTableNames = getEntryVrfTableNames(routeInfo, session || instance);

    return {
        id,
        stage,
        matchType: match.matchType,
        client,
        ...(session ? { session } : {}),
        ...(instance ? { instance } : {}),
        vrfTableNames,
        af: routeInfo.addrFamilyType || getAddrFamilyType(routeInfo.afi, routeInfo.safi),
        afi: routeInfo.afi,
        safi: routeInfo.safi,
        ribType,
        route: routeInfo,
        match,
        correlationKey
    };
}

function buildBmpRouteLens(bmpSessionMap, options = {}, routeStateArgument = null) {
    const normalizedOptions =
        options && typeof options === 'object' && !Array.isArray(options) ? options : { query: options };
    const queryInput = normalizedOptions.query ?? options;
    const query = parseRouteLensQuery(queryInput);
    const routeState = normalizeRouteState(routeStateArgument ?? normalizedOptions.routeState);
    const resultLimit = getResultLimit(normalizedOptions, queryInput);
    const stages = Object.fromEntries(STAGE_NAMES.map(stage => [stage, []]));
    const entries = [];
    let truncated = false;

    const appendRoutes = ({ routeMap, candidates, context }) => {
        if (!(routeMap instanceof Map)) {
            return;
        }
        for (const route of candidates) {
            if (!route || !routeStateMatches(route, routeState)) {
                continue;
            }
            const match = matchRoute(route, query);
            if (!match) {
                continue;
            }
            if (entries.length >= resultLimit) {
                truncated = true;
                return;
            }
            const entry = makeEntry({ ...context, route, match });
            entries.push(entry);
            stages[entry.stage].push(entry);
        }
    };

    const sourceMap = bmpSessionMap instanceof Map ? bmpSessionMap : new Map();
    outer: for (const [clientKey, bmpSession] of sourceMap) {
        const client = bmpSession?.getClientInfo?.() || bmpSession?.client || {};
        for (const [sessionKey, bgpSession] of bmpSession?.bgpSessionMap || []) {
            const session = bgpSession?.getSessionInfo?.() || {};
            for (const [afKey, ribTypeRouteMap] of bgpSession?.bgpRoutes || []) {
                if (!(ribTypeRouteMap instanceof Map)) {
                    continue;
                }
                const [afi, safi] = String(afKey).split('|').map(Number);
                for (const [ribType, routeMap] of ribTypeRouteMap) {
                    const stage = RIB_STAGE_MAP.get(Number(ribType));
                    if (!stage || !(routeMap instanceof Map)) {
                        continue;
                    }
                    const tableKey = `${afi}|${safi}|${ribType}`;
                    const prefixIndex = bgpSession.routePrefixIndexes?.get(tableKey);
                    const candidates = getIndexedCandidates(
                        routeMap,
                        query,
                        prefixKey => bgpSession.getRouteKeysByPrefix?.(afi, safi, ribType, prefixKey) || [],
                        prefixIndex
                    );
                    appendRoutes({
                        routeMap,
                        candidates,
                        context: { clientKey, client, scopeKey: sessionKey, session, stage, ribType: Number(ribType) }
                    });
                    if (truncated) {
                        break outer;
                    }
                }
            }
        }

        for (const [instanceKey, bgpInstance] of bmpSession?.bgpInstanceMap || []) {
            const instance = bgpInstance?.getInstanceInfo?.() || {};
            const routeMap = bgpInstance?.bgpRoutes;
            if (!(routeMap instanceof Map)) {
                continue;
            }
            const candidates = getIndexedCandidates(
                routeMap,
                query,
                prefixKey => bgpInstance.getRouteKeysByPrefix?.(prefixKey) || [],
                bgpInstance.routePrefixIndex
            );
            appendRoutes({
                routeMap,
                candidates,
                context: {
                    clientKey,
                    client,
                    scopeKey: instanceKey,
                    instance,
                    stage: 'locRib',
                    ribType: LOC_RIB_TYPE
                }
            });
            if (truncated) {
                break outer;
            }
        }
    }

    STAGE_NAMES.forEach(stage => {
        stages[stage].sort((left, right) => {
            const textRank = match =>
                match?.matchType === 'text-exact' ? 0 : match?.matchType === 'text-contains' ? 1 : 0;
            const textOrder = textRank(left.match) - textRank(right.match);
            const prefixOrder = (right.match?.prefixLength || 0) - (left.match?.prefixLength || 0);
            return textOrder || prefixOrder || left.id.localeCompare(right.id);
        });
    });

    const policyDiffs = truncated
        ? {
              inbound: [],
              outbound: [],
              summary: {
                  total: 0,
                  modified: 0,
                  unchanged: 0,
                  missingAfter: 0,
                  missingAfterReported: 0,
                  missingAfterInferred: 0,
                  postOnly: 0,
                  incomplete: true
              }
          }
        : buildPolicyDiffs(entries);
    const insightResult = truncated
        ? {
              markingEvidenceCount: entries.filter(
                  entry => entry.route?.pathStatus !== null && entry.route?.pathStatus !== undefined
              ).length,
              locRibObservedCount: entries.filter(entry => entry.stage === 'locRib').length,
              insights: [
                  {
                      id: 'analysis-suppressed-by-truncation',
                      severity: 'warning',
                      evidenceType: 'observational',
                      title: '结果截断，已停止跨阶段判断',
                      description:
                          '当前仅展示部分匹配路由。为避免把尚未遍历的阶段误判为缺失，属性差异和选路推测已暂停；请缩小查询范围后重试。',
                      stage: 'all',
                      count: entries.length,
                      evidence: []
                  }
              ]
          }
        : buildInsights(entries, policyDiffs);
    const clientIds = new Set(
        entries.map(entry =>
            stableId([entry.client?.localIp, entry.client?.localPort, entry.client?.remoteIp, entry.client?.remotePort])
        )
    );
    const peerIds = new Set(
        entries
            .filter(entry => entry.session)
            .map(entry =>
                stableId([
                    entry.client?.localIp,
                    entry.client?.localPort,
                    entry.client?.remoteIp,
                    entry.client?.remotePort,
                    entry.session?.sessionType,
                    entry.session?.sessionRd,
                    entry.session?.sessionIp,
                    entry.session?.sessionAs
                ])
            )
    );
    const instanceIds = new Set(
        entries
            .filter(entry => entry.instance)
            .map(entry =>
                stableId([
                    entry.client?.localIp,
                    entry.client?.localPort,
                    entry.client?.remoteIp,
                    entry.client?.remotePort,
                    entry.instance?.instanceType,
                    entry.instance?.instanceRd,
                    entry.afi,
                    entry.safi
                ])
            )
    );
    const inferredCount = truncated
        ? 0
        : policyDiffs.summary.missingAfterInferred + (insightResult.markingEvidenceCount === 0 ? 1 : 0);
    const stageCounts = Object.fromEntries(STAGE_NAMES.map(stage => [stage, stages[stage].length]));

    return {
        query: {
            input: query.input,
            mode: query.mode,
            matchType: query.matchType,
            addressFamily: query.addressFamily,
            normalized: query.normalized
        },
        routeState,
        stages,
        policyDiffs,
        insights: insightResult.insights,
        summary: {
            total: entries.length,
            clientCount: clientIds.size,
            peerCount: peerIds.size,
            instanceCount: instanceIds.size,
            reportedCount: insightResult.markingEvidenceCount,
            observedCount: entries.length,
            inferredCount,
            locRibObservedCount: insightResult.locRibObservedCount,
            stageCounts,
            resultLimit,
            truncated
        },
        generatedAt: new Date().toISOString()
    };
}

function createEmptyRouteLensResult(query, routeState = BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE) {
    return buildBmpRouteLens(new Map(), { query, routeState });
}

module.exports = {
    DEFAULT_RESULT_LIMIT,
    MAX_RESULT_LIMIT,
    POLICY_DIFF_FIELDS,
    STAGE_NAMES,
    buildBmpRouteLens,
    createEmptyRouteLensResult,
    parseRouteLensQuery
};
