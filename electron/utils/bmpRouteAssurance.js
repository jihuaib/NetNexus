const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { getAddrFamilyType, getBgpAfiName, getBgpSafiName } = require('./bgpUtils');
const { parseRouteLensQuery } = require('./bmpRouteLens');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const GLOBAL_VRF = '__global__';
const STAGES = ['preIn', 'postIn', 'locRib', 'preOut', 'postOut'];
const CATEGORIES = ['inbound-gap', 'not-selected', 'not-exported', 'outbound-gap', 'multi-egress-inconsistent'];
const CATEGORY_LABELS = {
    'inbound-gap': '入站阶段缺口',
    'not-selected': '未进入 Loc-RIB',
    'not-exported': '未生成出站路由',
    'outbound-gap': '出站阶段缺口',
    'multi-egress-inconsistent': '多出口属性不一致'
};
const RIB_STAGE_MAP = new Map([
    [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, 'preIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, 'postIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, 'preOut'],
    [BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, 'postOut']
]);
const EGRESS_COMPARE_FIELDS = [
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

function normalizedText(value) {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
}

function normalizedRouteState(value) {
    const state = normalizedText(value || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE);
    return Object.values(BmpConst.BMP_ROUTE_STATE_FILTER).includes(state)
        ? state
        : BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
}

function routeStateMatches(route, routeState) {
    return (
        routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ALL ||
        (route?.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE) === routeState
    );
}

function normalizeNetworkAddress(address, prefixLength) {
    return address.constructor.networkAddressFromCIDR(`${address.toString()}/${prefixLength}`).toString();
}

function getRouteNetwork(route) {
    const rawIp = route?.ip;
    const rawMask = route?.mask;
    const prefixLength = Number(rawMask);
    if (!ipaddr.isValid(String(rawIp || '')) || !Number.isInteger(prefixLength)) {
        return null;
    }
    const address = ipaddr.parse(String(rawIp));
    const maxLength = address.kind() === 'ipv4' ? 32 : 128;
    if (prefixLength < 0 || prefixLength > maxLength) {
        return null;
    }
    const network = normalizeNetworkAddress(address, prefixLength);
    return {
        address,
        family: address.kind(),
        network,
        prefixLength,
        displayPrefix: `${network}/${prefixLength}`
    };
}

function getRouteBaseIdentity(route) {
    const network = getRouteNetwork(route);
    if (network) {
        return network.displayPrefix;
    }
    return String(route?.nlriDetail?.prefix || route?.ip || route?.routeKey || '').trim();
}

function getMvpnRouteTypeName(routeType) {
    return Object.entries(BgpConst.BGP_MVPN_ROUTE_TYPE || {}).find(
        ([, value]) => Number(value) === Number(routeType)
    )?.[0];
}

function getRouteIdentity(route) {
    const baseIdentity = getRouteBaseIdentity(route);
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType;
    if (Number(route?.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        return `mvpn:type=${routeType}${routeTypeName ? `:${routeTypeName.toLowerCase()}` : ''}:0x${baseIdentity}`;
    }
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn;
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const network = getRouteNetwork(route);
        return `${network ? network.address.toString() : baseIdentity}|dqpn=${dqpn}`;
    }
    return baseIdentity;
}

function getRouteDisplayPrefix(route) {
    const baseDisplay = getRouteBaseIdentity(route) || '-';
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType;
    if (Number(route?.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        return `MVPN ${routeTypeName || `type=${routeType}`} · 0x${baseDisplay}`;
    }
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn;
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const dqpnBits = route?.nlriDetail?.dqpnBits ?? route?.dqpnBits;
        return `${baseDisplay} · DQPN ${dqpn}${dqpnBits !== null && dqpnBits !== undefined ? `/${dqpnBits}` : ''}`;
    }
    return baseDisplay;
}

function getRouteLensQuery(route) {
    return getRouteIdentity(route);
}

function makeNlriKey(route, vrfTableNames = []) {
    const rd = route?.nlriDetail?.rd || route?.rd || '0:0';
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn ?? '';
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType ?? '';
    const vrf = vrfTableNames.map(normalizedText).sort().join(',') || '-';
    return [route?.afi ?? '', route?.safi ?? '', rd, vrf, getRouteIdentity(route), dqpn, routeType].join('|');
}

function getVrfNames(route, owner) {
    const routeNames = (Array.isArray(route?.routeTlvs) ? route.routeTlvs : [])
        .filter(tlv => tlv?.name === 'VRF/Table Name')
        .map(tlv => tlv.valueText ?? tlv.value)
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim());
    const ownerNames = Array.isArray(owner?.vrfTableNames) ? owner.vrfTableNames.filter(Boolean) : [];
    return Array.from(new Set(routeNames.length > 0 ? routeNames : ownerNames));
}

function makeClientInfo(clientKey, bmpSession) {
    const info = bmpSession?.getClientInfo?.() || bmpSession?.client || {};
    return {
        key: String(clientKey),
        sysName: info.sysName || '',
        localIp: info.localIp || '',
        localPort: info.localPort ?? null,
        remoteIp: info.remoteIp || '',
        remotePort: info.remotePort ?? null
    };
}

function makePeerInfo(sessionKey, session) {
    return {
        key: String(sessionKey),
        ip: session?.sessionIp || '',
        as: session?.sessionAs ?? null,
        rd: session?.sessionRd || '0:0',
        type: session?.sessionType ?? null
    };
}

function makeEntry({ clientKey, client, ownerKey, owner, stage, ribType, route, session }) {
    const routeInfo = typeof route?.getRouteInfo === 'function' ? route.getRouteInfo() : { ...route };
    const afi = Number(routeInfo.afi);
    const safi = Number(routeInfo.safi);
    const af = routeInfo.addrFamilyType ?? getAddrFamilyType(afi, safi);
    const afLabel = `${getBgpAfiName(afi)} ${getBgpSafiName(safi)}`;
    const vrfTableNames = getVrfNames(routeInfo, owner);
    const nlriKey = makeNlriKey(routeInfo, vrfTableNames);
    const peer = session ? makePeerInfo(ownerKey, owner) : null;
    return {
        id: `assurance-route-${stableId([clientKey, ownerKey, stage, ribType, nlriKey, routeInfo.pathId || 0])}`,
        stage,
        ribType,
        client,
        peer,
        ownerKey: String(ownerKey),
        afi,
        safi,
        af,
        afLabel,
        nlriKey,
        displayPrefix: getRouteDisplayPrefix(routeInfo),
        routeLensQuery: getRouteLensQuery(routeInfo),
        vrfTableNames,
        route: routeInfo
    };
}

function entryMatchesClient(entry, clientFilter) {
    const filter = normalizedText(clientFilter);
    if (!filter) {
        return true;
    }
    return [
        entry.client.key,
        entry.client.sysName,
        entry.client.localIp,
        entry.client.remoteIp,
        `${entry.client.localIp}:${entry.client.localPort}`,
        `${entry.client.remoteIp}:${entry.client.remotePort}`
    ].some(value => normalizedText(value).includes(filter));
}

function entryMatchesVrf(entry, vrfFilter) {
    const filter = normalizedText(vrfFilter);
    if (!filter) {
        return true;
    }
    if (filter === GLOBAL_VRF) {
        return entry.vrfTableNames.length === 0;
    }
    return entry.vrfTableNames.some(value => normalizedText(value).includes(filter));
}

function entryMatchesAf(entry, afFilter) {
    const filter = normalizedText(afFilter);
    if (!filter) {
        return true;
    }
    return [entry.af, `${entry.afi}|${entry.safi}`, `${entry.afi}/${entry.safi}`, entry.afLabel].some(
        value => normalizedText(value) === filter || normalizedText(value).includes(filter)
    );
}

function entryMatchesQuery(entry, queryFilter) {
    const input = String(
        queryFilter && typeof queryFilter === 'object' ? queryFilter.value || '' : queryFilter || ''
    ).trim();
    if (!input) {
        return true;
    }

    const query = queryFilter?.parsed || parseRouteLensQuery(input);

    if (query.mode === 'text') {
        const haystack = [
            entry.displayPrefix,
            entry.route.routeKey,
            entry.route.routeType,
            entry.route.nlriDetail?.routeTypeName,
            entry.route.nlriDetail?.nlriTypeName,
            entry.client.sysName,
            entry.client.remoteIp,
            entry.peer?.ip
        ]
            .map(normalizedText)
            .join('\u001f');
        return haystack.includes(query.normalized);
    }

    const network = getRouteNetwork(entry.route);
    if (!network || network.family !== query.addressFamily) {
        return false;
    }
    if (query.mode === 'exact') {
        return network.network === query.network && network.prefixLength === query.prefixLength;
    }
    return query.address.match(ipaddr.parse(network.network), network.prefixLength);
}

function collectEntries(bmpSessionMap, filters) {
    const entries = [];
    let scannedPathCount = 0;
    const sourceMap = bmpSessionMap instanceof Map ? bmpSessionMap : new Map();
    for (const [clientKey, bmpSession] of sourceMap) {
        const client = makeClientInfo(clientKey, bmpSession);
        for (const [sessionKey, bgpSession] of bmpSession?.bgpSessionMap || []) {
            const session = bgpSession?.getSessionInfo?.() || bgpSession || {};
            for (const [, ribTypeRouteMap] of bgpSession?.bgpRoutes || []) {
                if (!(ribTypeRouteMap instanceof Map)) {
                    continue;
                }
                for (const [ribType, routeMap] of ribTypeRouteMap) {
                    const stage = RIB_STAGE_MAP.get(Number(ribType));
                    if (!stage || !(routeMap instanceof Map)) {
                        continue;
                    }
                    for (const route of routeMap.values()) {
                        scannedPathCount += 1;
                        if (!route || !routeStateMatches(route, filters.routeState)) {
                            continue;
                        }
                        entries.push(
                            makeEntry({
                                clientKey,
                                client,
                                ownerKey: sessionKey,
                                owner: session,
                                session: true,
                                stage,
                                ribType: Number(ribType),
                                route
                            })
                        );
                    }
                }
            }
        }

        for (const [instanceKey, bgpInstance] of bmpSession?.bgpInstanceMap || []) {
            const instance = bgpInstance?.getInstanceInfo?.() || bgpInstance || {};
            if (!(bgpInstance?.bgpRoutes instanceof Map)) {
                continue;
            }
            for (const route of bgpInstance.bgpRoutes.values()) {
                scannedPathCount += 1;
                if (!route || !routeStateMatches(route, filters.routeState)) {
                    continue;
                }
                entries.push(
                    makeEntry({
                        clientKey,
                        client,
                        ownerKey: instanceKey,
                        owner: instance,
                        session: false,
                        stage: 'locRib',
                        ribType: 'loc-rib',
                        route
                    })
                );
            }
        }
    }

    return {
        scannedPathCount,
        entries: entries.filter(
            entry =>
                entryMatchesClient(entry, filters.client) &&
                entryMatchesVrf(entry, filters.vrf) &&
                entryMatchesAf(entry, filters.af) &&
                entryMatchesQuery(entry, { value: filters.query, parsed: filters.parsedQuery })
        )
    };
}

function makeStagePresence(group) {
    return Object.fromEntries(STAGES.map(stage => [stage, group[stage].length]));
}

function uniquePeers(entries) {
    const peers = new Map();
    entries.forEach(entry => {
        if (entry.peer && !peers.has(entry.peer.key)) {
            peers.set(entry.peer.key, entry.peer);
        }
    });
    return Array.from(peers.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function makeBaseIssue(category, group, evidence) {
    const representative = STAGES.flatMap(stage => group[stage])[0];
    const stagePresence = makeStagePresence(group);
    const peers = uniquePeers(STAGES.flatMap(stage => group[stage]));
    const rd = representative.route?.nlriDetail?.rd || representative.route?.rd || '0:0';
    const nlri = {
        key: representative.nlriKey,
        displayPrefix: representative.displayPrefix,
        afi: representative.afi,
        safi: representative.safi,
        af: representative.af,
        afLabel: representative.afLabel,
        rd
    };
    return {
        id: `assurance-issue-${stableId([category, representative.client.key, representative.nlriKey])}`,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        severity: category === 'multi-egress-inconsistent' ? 'info' : 'warning',
        title: `${CATEGORY_LABELS[category]} · ${representative.displayPrefix}`,
        description: evidence.description,
        evidenceType: evidence.evidenceType,
        confidence: evidence.confidence,
        nlri,
        prefix: representative.displayPrefix,
        client: representative.client,
        vrfTableNames: Array.from(new Set(STAGES.flatMap(stage => group[stage].flatMap(entry => entry.vrfTableNames)))),
        stagePresence,
        peers,
        differences: [],
        evidence: Array.isArray(evidence.entries)
            ? evidence.entries.map(entry => ({
                  entryId: entry.id,
                  stage: entry.stage,
                  peer: entry.peer,
                  pathId: entry.route?.pathId ?? 0,
                  pathStatus: entry.route?.pathStatus ?? null,
                  pathStatusText: entry.route?.pathStatusText || null
              }))
            : [],
        routeLensQuery: representative.routeLensQuery
    };
}

function hasStatus(entries, statusFlag) {
    return entries.some(entry => {
        const status = entry.route?.pathStatus;
        return status !== null && status !== undefined && (Number(status) & statusFlag) !== 0;
    });
}

function gapEvidence(entries, filterStatus, description) {
    if (hasStatus(entries, filterStatus)) {
        return {
            evidenceType: 'reported',
            confidence: 'high',
            description: `设备 Path Marking 明确上报该路由被策略过滤。${description}`,
            entries
        };
    }
    return {
        evidenceType: 'inferred',
        confidence: 'low',
        description: `当前 BMP 快照中未观察到对应下一阶段；这是可见性缺口，不能据此确定路由被策略过滤。${description}`,
        entries
    };
}

function peerPathKey(entry) {
    return `${entry.peer?.key || ''}\u001f${entry.route?.pathId ?? 0}`;
}

function missingPeerPaths(beforeEntries, afterEntries) {
    const afterKeys = new Set(afterEntries.map(peerPathKey));
    return beforeEntries.filter(entry => !afterKeys.has(peerPathKey(entry)));
}

function comparableValue(value) {
    if (Array.isArray(value)) {
        return `[${value.map(comparableValue).sort().join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${comparableValue(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function findEgressDifferences(entriesByPeer) {
    const differences = [];
    EGRESS_COMPARE_FIELDS.forEach(field => {
        const valuesByPeer = Array.from(entriesByPeer.values(), peerEntries => {
            const pathValues = peerEntries
                .map(entry => ({ pathId: entry.route?.pathId ?? 0, value: entry.route?.[field] ?? null }))
                .sort(
                    (left, right) =>
                        left.pathId - right.pathId ||
                        comparableValue(left.value).localeCompare(comparableValue(right.value))
                );
            const distinctValues = [];
            const seen = new Set();
            pathValues.forEach(item => {
                const key = comparableValue(item.value);
                if (!seen.has(key)) {
                    seen.add(key);
                    distinctValues.push(item.value);
                }
            });
            const peer = peerEntries[0].peer;
            return {
                peerKey: peer.key,
                peerIp: peer.ip,
                peerAs: peer.as,
                value: distinctValues.length === 1 ? distinctValues[0] : distinctValues,
                pathValues,
                comparableSet: Array.from(seen).sort().join('\u001e')
            };
        });
        const distinctPeerSets = new Set(valuesByPeer.map(item => item.comparableSet));
        if (distinctPeerSets.size > 1) {
            differences.push({
                field,
                values: valuesByPeer.map(({ comparableSet: _comparableSet, ...item }) => item)
            });
        }
    });
    return differences;
}

function buildIssues(entries) {
    const grouped = new Map();
    entries.forEach(entry => {
        const key = `${entry.client.key}\u001f${entry.nlriKey}`;
        if (!grouped.has(key)) {
            grouped.set(key, Object.fromEntries(STAGES.map(stage => [stage, []])));
        }
        grouped.get(key)[entry.stage].push(entry);
    });

    const issues = [];
    grouped.forEach(group => {
        const missingPostIn = missingPeerPaths(group.preIn, group.postIn);
        if (missingPostIn.length > 0) {
            issues.push(
                makeBaseIssue(
                    'inbound-gap',
                    group,
                    gapEvidence(
                        missingPostIn,
                        BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY,
                        `缺口涉及 ${uniquePeers(missingPostIn).length} 个 Peer。`
                    )
                )
            );
        }
        if (group.postIn.length > 0 && group.locRib.length === 0) {
            const reportedNonselected = hasStatus(group.postIn, BmpConst.BMP_PATH_STATUS.NONSELECTED);
            issues.push(
                makeBaseIssue('not-selected', group, {
                    evidenceType: reportedNonselected ? 'reported' : 'inferred',
                    confidence: reportedNonselected ? 'high' : 'low',
                    description: reportedNonselected
                        ? '设备 Path Marking 明确上报该路径未被选中。'
                        : '在 Post Adj-RIB-In 中可见，但未在 Loc-RIB 快照中观察到；这不等同于设备明确上报未选中。',
                    entries: group.postIn
                })
            );
        }
        if (group.locRib.length > 0 && group.preOut.length === 0) {
            const reportedFilter = hasStatus(group.locRib, BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY);
            issues.push(
                makeBaseIssue('not-exported', group, {
                    evidenceType: reportedFilter ? 'reported' : 'inferred',
                    confidence: reportedFilter ? 'high' : 'low',
                    description: reportedFilter
                        ? '设备 Path Marking 明确上报该路由在出站策略中被过滤。'
                        : '在 Loc-RIB 中可见，但未在任何 Pre Adj-RIB-Out 快照中观察到；不能据此确定设备未生成出站路由。',
                    entries: group.locRib
                })
            );
        }
        const missingPostOut = missingPeerPaths(group.preOut, group.postOut);
        if (missingPostOut.length > 0) {
            issues.push(
                makeBaseIssue(
                    'outbound-gap',
                    group,
                    gapEvidence(
                        missingPostOut,
                        BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY,
                        `缺口涉及 ${uniquePeers(missingPostOut).length} 个 Peer。`
                    )
                )
            );
        }

        const postOutByPeer = new Map();
        group.postOut.forEach(entry => {
            if (!entry.peer) {
                return;
            }
            if (!postOutByPeer.has(entry.peer.key)) {
                postOutByPeer.set(entry.peer.key, []);
            }
            postOutByPeer.get(entry.peer.key).push(entry);
        });
        if (postOutByPeer.size >= 2) {
            const differences = findEgressDifferences(postOutByPeer);
            if (differences.length > 0) {
                const issue = makeBaseIssue('multi-egress-inconsistent', group, {
                    evidenceType: 'observed',
                    confidence: 'high',
                    description: `BMP Post Adj-RIB-Out 在 ${postOutByPeer.size} 个出口 Peer 上观察到 ${differences.length} 类属性差异。`,
                    entries: group.postOut
                });
                issue.differences = differences;
                issue.peers = Array.from(postOutByPeer.values(), peerEntries => peerEntries[0].peer).sort(
                    (left, right) => left.key.localeCompare(right.key)
                );
                issue.severity = 'warning';
                issues.push(issue);
            }
        }
    });

    return issues.sort(
        (left, right) =>
            CATEGORIES.indexOf(left.category) - CATEGORIES.indexOf(right.category) ||
            left.nlri.displayPrefix.localeCompare(right.nlri.displayPrefix) ||
            left.id.localeCompare(right.id)
    );
}

function normalizeFilters(options = {}) {
    const page = Math.max(1, Math.floor(Number(options.page)) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(options.pageSize)) || DEFAULT_PAGE_SIZE));
    const rawCategory = options.category;
    const categories = Array.isArray(rawCategory)
        ? rawCategory
        : String(rawCategory || '')
              .split(',')
              .filter(Boolean);
    const query = String(options.query || '').trim();
    const filters = {
        client: String(options.client || '').trim(),
        vrf: String(options.vrf || '').trim(),
        af: String(options.af || '').trim(),
        query,
        category: categories.filter(category => CATEGORIES.includes(category)),
        routeState: normalizedRouteState(options.routeState),
        page,
        pageSize
    };
    Object.defineProperty(filters, 'parsedQuery', {
        value: query ? parseRouteLensQuery(query) : null,
        enumerable: false
    });
    return filters;
}

function countBy(values, keyGetter) {
    const counts = new Map();
    values.forEach(value => {
        const key = keyGetter(value);
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
}

function buildFacets(entries, issues, categoryCounts) {
    const clients = new Map();
    const vrfs = new Map();
    const addressFamilies = new Map();
    entries.forEach(entry => {
        if (!clients.has(entry.client.key)) {
            clients.set(entry.client.key, {
                value: entry.client.key,
                label: entry.client.sysName || entry.client.remoteIp || entry.client.localIp || entry.client.key,
                count: 0
            });
        }
        clients.get(entry.client.key).count += 1;
        if (entry.vrfTableNames.length === 0) {
            vrfs.set(GLOBAL_VRF, (vrfs.get(GLOBAL_VRF) || 0) + 1);
        } else {
            entry.vrfTableNames.forEach(vrf => vrfs.set(vrf, (vrfs.get(vrf) || 0) + 1));
        }
        const afValue = entry.af === undefined ? `${entry.afi}|${entry.safi}` : String(entry.af);
        if (!addressFamilies.has(afValue)) {
            addressFamilies.set(afValue, { value: afValue, label: entry.afLabel, count: 0 });
        }
        addressFamilies.get(afValue).count += 1;
    });
    return {
        clients: Array.from(clients.values()).sort((left, right) => left.label.localeCompare(right.label)),
        vrfs: Array.from(vrfs, ([value, count]) => ({
            value,
            label: value === GLOBAL_VRF ? 'Global' : value,
            count
        })).sort((left, right) => left.label.localeCompare(right.label)),
        addressFamilies: Array.from(addressFamilies.values()).sort((left, right) =>
            left.label.localeCompare(right.label)
        ),
        categories: CATEGORIES.map(category => ({
            value: category,
            label: CATEGORY_LABELS[category],
            count: categoryCounts[category] || 0
        })),
        evidenceTypes: Array.from(
            countBy(issues, issue => issue.evidenceType),
            ([value, count]) => ({
                value,
                label: value,
                count
            })
        )
    };
}

function buildBmpRouteAssurance(bmpSessionMap, options = {}) {
    const startedAt = Date.now();
    const filters = normalizeFilters(options);
    const collection = collectEntries(bmpSessionMap, filters);
    const { entries, scannedPathCount } = collection;
    const stagePathCounts = Object.fromEntries(
        STAGES.map(stage => [stage, entries.filter(entry => entry.stage === stage).length])
    );
    const stageCounts = Object.fromEntries(
        STAGES.map(stage => [
            stage,
            new Set(
                entries.filter(entry => entry.stage === stage).map(entry => `${entry.client.key}\u001f${entry.nlriKey}`)
            ).size
        ])
    );
    const allIssues = buildIssues(entries);
    const categoryCounts = Object.fromEntries(
        CATEGORIES.map(category => [category, allIssues.filter(issue => issue.category === category).length])
    );
    const selectedIssues =
        filters.category.length > 0 ? allIssues.filter(issue => filters.category.includes(issue.category)) : allIssues;
    const total = selectedIssues.length;
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, totalPages);
    const offset = (page - 1) * filters.pageSize;
    const uniqueNlri = new Set(entries.map(entry => `${entry.client.key}\u001f${entry.nlriKey}`));
    const clientCount = new Set(entries.map(entry => entry.client.key)).size;

    return {
        filters: { ...filters, category: filters.category.length === 1 ? filters.category[0] : filters.category },
        funnel: { ...stageCounts },
        summary: {
            stageCounts,
            stagePathCounts,
            uniqueNlriCount: uniqueNlri.size,
            issueCount: total,
            totalIssueCount: allIssues.length,
            categoryCounts,
            clientCount,
            scannedPathCount,
            filteredPathCount: entries.length,
            scanDurationMs: Date.now() - startedAt
        },
        facets: buildFacets(entries, allIssues, categoryCounts),
        issues: selectedIssues.slice(offset, offset + filters.pageSize),
        pagination: {
            page,
            pageSize: filters.pageSize,
            total,
            totalPages
        },
        generatedAt: new Date().toISOString()
    };
}

module.exports = {
    CATEGORIES,
    CATEGORY_LABELS,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    STAGES,
    buildBmpRouteAssurance
};
