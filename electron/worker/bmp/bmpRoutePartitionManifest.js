const BMP_ROUTE_SCOPE_KINDS = Object.freeze({
    PEER: 'peer',
    LOC_RIB: 'loc-rib'
});

const BMP_ROUTE_FAMILIES = Object.freeze([
    Object.freeze({ familyId: 1, familyKey: 'ipv4-unicast', token: 'ipv4_unicast', afi: 1, safi: 1 }),
    Object.freeze({ familyId: 2, familyKey: 'ipv6-unicast', token: 'ipv6_unicast', afi: 2, safi: 1 }),
    Object.freeze({ familyId: 3, familyKey: 'ipv4-multicast', token: 'ipv4_multicast', afi: 1, safi: 2 }),
    Object.freeze({ familyId: 4, familyKey: 'ipv6-multicast', token: 'ipv6_multicast', afi: 2, safi: 2 }),
    Object.freeze({ familyId: 5, familyKey: 'ipv4-labeled-unicast', token: 'ipv4_labeled_unicast', afi: 1, safi: 4 }),
    Object.freeze({ familyId: 6, familyKey: 'ipv6-labeled-unicast', token: 'ipv6_labeled_unicast', afi: 2, safi: 4 }),
    Object.freeze({ familyId: 7, familyKey: 'ipv4-mvpn', token: 'ipv4_mvpn', afi: 1, safi: 5 }),
    Object.freeze({ familyId: 8, familyKey: 'ipv6-mvpn', token: 'ipv6_mvpn', afi: 2, safi: 5 }),
    Object.freeze({ familyId: 9, familyKey: 'l2vpn-evpn', token: 'l2vpn_evpn', afi: 25, safi: 70 }),
    Object.freeze({ familyId: 10, familyKey: 'vpnv4', token: 'vpnv4', afi: 1, safi: 128 }),
    Object.freeze({ familyId: 11, familyKey: 'vpnv6', token: 'vpnv6', afi: 2, safi: 128 }),
    Object.freeze({ familyId: 12, familyKey: 'ipv4-flowspec', token: 'ipv4_flowspec', afi: 1, safi: 133 }),
    Object.freeze({ familyId: 13, familyKey: 'ipv6-flowspec', token: 'ipv6_flowspec', afi: 2, safi: 133 }),
    Object.freeze({ familyId: 14, familyKey: 'ipv4-qp', token: 'ipv4_qp', afi: 1, safi: 241 }),
    Object.freeze({ familyId: 15, familyKey: 'ipv6-qp', token: 'ipv6_qp', afi: 2, safi: 241 }),
    Object.freeze({ familyId: 16, familyKey: 'bgp-ls', token: 'bgp_ls', afi: 16388, safi: 71 }),
    Object.freeze({ familyId: 17, familyKey: 'bgp-ls-vpn', token: 'bgp_ls_vpn', afi: 16388, safi: 72 }),
    Object.freeze({ familyId: 18, familyKey: 'other', token: 'other', afi: null, safi: null, fallback: true })
]);

const familyByPair = new Map(
    BMP_ROUTE_FAMILIES.filter(family => family.fallback !== true).map(family => [
        `${family.afi}|${family.safi}`,
        family
    ])
);
if (
    new Set(BMP_ROUTE_FAMILIES.map(family => family.familyId)).size !== BMP_ROUTE_FAMILIES.length ||
    familyByPair.size !== BMP_ROUTE_FAMILIES.filter(family => family.fallback !== true).length ||
    BMP_ROUTE_FAMILIES.filter(family => family.fallback === true).length !== 1
) {
    throw new Error(
        'BMP route family manifest contains duplicate IDs, duplicate AFI/SAFI pairs, or invalid fallback entries'
    );
}

const scopeKinds = [BMP_ROUTE_SCOPE_KINDS.PEER, BMP_ROUTE_SCOPE_KINDS.LOC_RIB];
const partitions = [];
scopeKinds.forEach((scopeKind, scopeIndex) => {
    BMP_ROUTE_FAMILIES.forEach(family => {
        const ownerToken = scopeKind === BMP_ROUTE_SCOPE_KINDS.PEER ? 'peer' : 'loc_rib';
        const tableName = `bmp_current_routes_${ownerToken}_${family.token}`;
        if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
            throw new Error(`Unsafe BMP route partition table name: ${tableName}`);
        }
        partitions.push(
            Object.freeze({
                partitionId: (scopeIndex + 1) * 100 + family.familyId,
                key: `${scopeKind}:${family.familyKey}`,
                scopeKind,
                familyKey: family.familyKey,
                afi: family.afi,
                safi: family.safi,
                fallback: family.fallback === true,
                tableName,
                quotedTableName: `"${tableName}"`
            })
        );
    });
});

const BMP_ROUTE_PARTITIONS = Object.freeze(partitions);
if (new Set(BMP_ROUTE_PARTITIONS.map(partition => partition.partitionId)).size !== BMP_ROUTE_PARTITIONS.length) {
    throw new Error('BMP route partition manifest contains duplicate partition IDs');
}
const partitionByKey = new Map(BMP_ROUTE_PARTITIONS.map(partition => [partition.key, partition]));
const partitionById = new Map(BMP_ROUTE_PARTITIONS.map(partition => [partition.partitionId, partition]));

function normalizeBmpRouteScopeKind(value) {
    if (value !== BMP_ROUTE_SCOPE_KINDS.PEER && value !== BMP_ROUTE_SCOPE_KINDS.LOC_RIB) {
        throw new Error(`Unsupported BMP route scope kind: ${value}`);
    }
    return value;
}

function normalizeBmpAfiSafi(afi, safi) {
    const normalizedAfi = Number(afi);
    const normalizedSafi = Number(safi);
    if (!Number.isInteger(normalizedAfi) || normalizedAfi < 0 || normalizedAfi > 0xffff) {
        throw new Error(`BMP route AFI must be an integer between 0 and 65535: ${afi}`);
    }
    if (!Number.isInteger(normalizedSafi) || normalizedSafi < 0 || normalizedSafi > 0xff) {
        throw new Error(`BMP route SAFI must be an integer between 0 and 255: ${safi}`);
    }
    return { afi: normalizedAfi, safi: normalizedSafi };
}

function resolveBmpRoutePartition({ scopeKind, afi, safi }) {
    const normalizedScopeKind = normalizeBmpRouteScopeKind(scopeKind);
    const normalized = normalizeBmpAfiSafi(afi, safi);
    const family = familyByPair.get(`${normalized.afi}|${normalized.safi}`) || BMP_ROUTE_FAMILIES.at(-1);
    const partition = partitionByKey.get(`${normalizedScopeKind}:${family.familyKey}`);
    if (!partition) {
        throw new Error(
            `BMP route partition is not registered for ${normalizedScopeKind} AFI ${normalized.afi} SAFI ${normalized.safi}`
        );
    }
    return partition;
}

function getBmpRoutePartitionById(partitionId) {
    const normalized = Number(partitionId);
    const partition = partitionById.get(normalized);
    if (!partition) {
        throw new Error(`Unknown BMP route partition ID: ${partitionId}`);
    }
    return partition;
}

function selectBmpRoutePartitions(query = {}) {
    const hasScopeKind = query.scopeKind !== undefined && query.scopeKind !== null && query.scopeKind !== '';
    const hasAfi = query.afi !== undefined && query.afi !== null && query.afi !== '';
    const hasSafi = query.safi !== undefined && query.safi !== null && query.safi !== '';
    const normalizedScopeKind = hasScopeKind ? normalizeBmpRouteScopeKind(query.scopeKind) : null;
    const normalizedAfi = hasAfi ? Number(query.afi) : null;
    const normalizedSafi = hasSafi ? Number(query.safi) : null;
    if (hasAfi && (!Number.isInteger(normalizedAfi) || normalizedAfi < 0 || normalizedAfi > 0xffff)) {
        throw new Error(`BMP route AFI must be an integer between 0 and 65535: ${query.afi}`);
    }
    if (hasSafi && (!Number.isInteger(normalizedSafi) || normalizedSafi < 0 || normalizedSafi > 0xff)) {
        throw new Error(`BMP route SAFI must be an integer between 0 and 255: ${query.safi}`);
    }
    const normalized = hasAfi && hasSafi ? { afi: normalizedAfi, safi: normalizedSafi } : null;

    if (normalized) {
        const kinds = normalizedScopeKind ? [normalizedScopeKind] : scopeKinds;
        return Object.freeze(
            kinds.map(scopeKind => resolveBmpRoutePartition({ scopeKind, afi: normalized.afi, safi: normalized.safi }))
        );
    }

    return Object.freeze(
        BMP_ROUTE_PARTITIONS.filter(partition => {
            if (normalizedScopeKind && partition.scopeKind !== normalizedScopeKind) {
                return false;
            }
            if (hasAfi && !partition.fallback && partition.afi !== normalizedAfi) {
                return false;
            }
            if (hasSafi && !partition.fallback && partition.safi !== normalizedSafi) {
                return false;
            }
            return true;
        })
    );
}

function assertBmpRouteMatchesScope(route, scope) {
    if (!route || !scope) {
        throw new Error('BMP route and scope are required for partition validation');
    }
    const scopePartition = resolveBmpRoutePartition({
        scopeKind: scope.kind,
        afi: scope.afi,
        safi: scope.safi
    });
    const routeFamily = normalizeBmpAfiSafi(route.afi, route.safi);
    if (routeFamily.afi !== Number(scope.afi) || routeFamily.safi !== Number(scope.safi)) {
        throw new Error(
            `BMP route AFI/SAFI ${routeFamily.afi}/${routeFamily.safi} does not match scope ${scope.afi}/${scope.safi}`
        );
    }
    return scopePartition;
}

module.exports = {
    BMP_ROUTE_SCOPE_KINDS,
    BMP_ROUTE_FAMILIES,
    BMP_ROUTE_PARTITIONS,
    normalizeBmpRouteScopeKind,
    normalizeBmpAfiSafi,
    resolveBmpRoutePartition,
    getBmpRoutePartitionById,
    selectBmpRoutePartitions,
    assertBmpRouteMatchesScope
};
