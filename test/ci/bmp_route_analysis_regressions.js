const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const {
    buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync,
    buildBmpRouteAssuranceAnalysisFromRowStreamAsync,
    paginateBmpRouteAssuranceAnalysis,
    refreshBmpRouteAssuranceStreamRun
} = require('../../electron/utils/bmp/bmpRouteAssurance');
const { buildBmpRouteLensFromPersistedRoutes } = require('../../electron/utils/bmp/bmpRouteLens');
const { routeAttributesEqual } = require('../../electron/utils/bmp/bmpRouteAttributeCompare');

const PRE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const POST = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
const POST_OUT = BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT;

function row(ip, options = {}) {
    const { afi = 1, safi = 1, ribType = PRE, peerIp = '192.0.2.1', pathId = 0, ...attributes } = options;
    return {
        persistentSourceId: 'source-a',
        persistentScopeId: `scope-${ribType}-${peerIp}`,
        persistentRouteId: `${ip}-${ribType}-${peerIp}-${pathId}`,
        source: { id: 'source-a', sysName: 'router-a' },
        scopeKind: 'peer',
        ownerKey: `owner-${peerIp}`,
        peer: { ip: peerIp, type: 0, rd: '0:0', as: 65000 },
        ribType,
        afi,
        safi,
        rd: '0:0',
        ip,
        mask: afi === 1 ? 24 : 64,
        pathId,
        routeState: 'active',
        routeKey: `${pathId}|0:0|${afi}:${safi}:${ip}`,
        ...attributes
    };
}

async function* chunks(rows) {
    // Runs may cross transport chunks; retention and evidence accounting must
    // remain exact regardless of chunk boundaries.
    for (const value of rows) yield [value];
}

async function analyze(rows, options = {}) {
    return buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync(rows, options);
}

async function verifyAddressFamilyFilters() {
    const rows = [
        row('203.0.113.0'),
        row('2001:db8::', { afi: 2 }),
        row('198.51.100.0', { safi: 128 }),
        row('192.0.2.0', { safi: 133 })
    ];
    for (const builder of [
        buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync,
        (values, options) => buildBmpRouteAssuranceAnalysisFromRowStreamAsync(chunks(values), options)
    ]) {
        const ipv4 = paginateBmpRouteAssuranceAnalysis(await builder(rows, { af: '1' }));
        assert.equal(ipv4.summary.uniqueNlriCount, 1);
        assert.deepEqual(
            ipv4.issues.map(issue => [issue.nlri.afi, issue.nlri.safi]),
            [[1, 1]]
        );
        const ipv6 = paginateBmpRouteAssuranceAnalysis(await builder(rows, { af: '2' }));
        assert.deepEqual(
            ipv6.issues.map(issue => [issue.nlri.afi, issue.nlri.safi]),
            [[2, 1]]
        );
        for (const af of ['1|128', '1/128']) {
            const vpn = paginateBmpRouteAssuranceAnalysis(await builder(rows, { af }));
            assert.deepEqual(
                vpn.issues.map(issue => [issue.nlri.afi, issue.nlri.safi]),
                [[1, 128]]
            );
        }
        const label = ipv4.issues[0].nlri.afLabel;
        assert.equal((await builder(rows, { af: label })).summary.uniqueNlriCount, 1);
    }
}

async function verifyAttributeSemantics() {
    assert.equal(routeAttributesEqual('communities', '65000:1 65000:2', '65000:2 65000:1 65000:2'), true);
    assert.equal(routeAttributesEqual('communities', ['65000:2', '65000:1'], '65000:1 65000:2'), true);
    assert.equal(routeAttributesEqual('communities', [{ value: 4259840001, formatted: '65000:1' }], '65000:1'), true);
    assert.equal(routeAttributesEqual('labels', [100, 200], [200, 100]), false);
    assert.equal(routeAttributesEqual('asPath', '65000 65001', '65001 65000'), false);
    const before = row('203.0.113.0', { communities: '65000:1 65000:2', labels: [100, 200] });
    const after = row('203.0.113.0', { ribType: POST, communities: '65000:2 65000:1', labels: [200, 100] });
    const lens = buildBmpRouteLensFromPersistedRoutes([before, after], { query: '203.0.113.0/24' });
    assert.deepEqual(lens.policyDiffs.inbound[0].changedFields, ['labels']);
    const egress = [
        row('203.0.113.0', { ribType: POST_OUT, communities: before.communities, labels: before.labels }),
        row('203.0.113.0', {
            ribType: POST_OUT,
            peerIp: '192.0.2.2',
            communities: after.communities,
            labels: after.labels
        })
    ];
    const issue = paginateBmpRouteAssuranceAnalysis(await analyze(egress)).issues[0];
    assert.equal(issue.category, 'multi-egress-inconsistent');
    assert.deepEqual(
        issue.differences.map(difference => difference.field),
        ['labels']
    );
    egress[1].labels = [100, 200];
    assert.equal((await analyze(egress)).summary.totalIssueCount, 0);
}

async function verifyCappedIncrementalEvidence() {
    const reported = row('203.0.113.0', { pathStatus: BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY });
    const omitted = row('203.0.114.0');
    const analysis = await buildBmpRouteAssuranceAnalysisFromRowStreamAsync(
        chunks([reported, omitted]),
        {},
        {
            maxRetainedIssuesPerCategory: 1
        }
    );
    const counts = () => Object.fromEntries(analysis.facets.evidenceTypes.map(facet => [facet.value, facet.count]));
    assert.deepEqual(counts(), { reported: 1, inferred: 1 });
    assert.equal(analysis.summary.retainedIssueCount, 1);
    for (const method of [Symbol.iterator, 'keys', 'values', 'entries', 'forEach']) {
        analysis._stream.runRecords[method] = () => {
            throw new Error('incremental refresh must not traverse the full RIB run index');
        };
    }
    const replacement = { ...omitted, pathStatus: reported.pathStatus };
    refreshBmpRouteAssuranceStreamRun(analysis, omitted, [replacement]);
    assert.deepEqual(counts(), { reported: 2 });
    // Replacing a discarded issue repeatedly must neither leak counters nor
    // require retaining all of its evidence objects.
    refreshBmpRouteAssuranceStreamRun(analysis, omitted, [replacement]);
    assert.deepEqual(counts(), { reported: 2 });
    refreshBmpRouteAssuranceStreamRun(analysis, omitted, []);
    assert.deepEqual(counts(), { reported: 1 });
    assert.equal(analysis.summary.categoryCounts['inbound-gap'], 1);
    assert.deepEqual(analysis.summary.truncatedCategories, []);
    refreshBmpRouteAssuranceStreamRun(analysis, reported, []);
    assert.deepEqual(counts(), {});
    assert.equal(analysis.summary.totalIssueCount, 0);
}

async function verifyRetainedPagination() {
    const rows = [row('203.0.113.0'), row('203.0.114.0'), row('203.0.115.0'), row('203.0.116.0', { ribType: POST })];
    const analysis = await buildBmpRouteAssuranceAnalysisFromRowStreamAsync(
        chunks(rows),
        {},
        {
            maxRetainedIssuesPerCategory: 1
        }
    );
    const page = paginateBmpRouteAssuranceAnalysis(analysis, { page: 999, pageSize: 1 });
    assert.equal(page.summary.issueCount, 4, 'summary still reports all anomalies');
    assert.equal(page.pagination.total, 2, 'only retained details create navigable pages');
    assert.equal(page.pagination.totalIssueCount, 4);
    assert.equal(page.pagination.truncated, true);
    assert.equal(page.pagination.page, 2);
    assert.equal(page.issues.length, 1);
    const selected = paginateBmpRouteAssuranceAnalysis(analysis, { category: 'inbound-gap', page: 999, pageSize: 1 });
    assert.equal(selected.summary.issueCount, 3);
    assert.equal(selected.pagination.total, 1);
    assert.equal(selected.pagination.page, 1);
    assert.equal(selected.issues.length, 1);
}

async function verifyEgressPayloadBounds() {
    const rows = Array.from({ length: 30 }, (_, index) =>
        row('203.0.113.0', {
            ribType: POST_OUT,
            peerIp: `192.0.2.${index + 1}`,
            nextHop: '198.51.100.1'
        })
    );
    for (let pathId = 1; pathId <= 30; pathId += 1) {
        rows.push(row('203.0.113.0', { ribType: POST_OUT, pathId, nextHop: `198.51.100.${pathId + 1}` }));
    }
    const issue = paginateBmpRouteAssuranceAnalysis(await analyze(rows)).issues[0];
    assert.equal(issue.peerCount, 30);
    assert.equal(issue.peers.length, 25);
    assert.equal(issue.evidence.length, 25);
    const difference = issue.differences.find(value => value.field === 'nextHop');
    assert.equal(difference.peerCount, 30);
    assert.equal(difference.valuesTruncated, true);
    assert.equal(difference.values.length, 25);
    assert.equal(difference.values[0].pathCount, 31);
    assert.equal(difference.values[0].valueCount, 31);
    assert.equal(difference.values[0].pathValues.length, 25);
    assert.equal(difference.values[0].value.length, 25);
    const lastPeerConflict = rows.slice(0, 30).map((value, index) => ({
        ...value,
        nextHop: index === 29 ? '198.51.100.99' : '198.51.100.1'
    }));
    const bounded = paginateBmpRouteAssuranceAnalysis(await analyze(lastPeerConflict)).issues[0];
    assert.equal(bounded.differences[0].values.length, 25);
    assert.equal(
        bounded.differences[0].values.some(value => value.peerIp === '192.0.2.30'),
        true,
        'a bounded payload retains a witness even when the conflict is past the first 25 peers'
    );
}

async function verifyEgressPathDifferenceWitnesses() {
    const rows = [];
    for (const peerIp of ['192.0.2.1', '192.0.2.2']) {
        for (let pathId = 0; pathId < 26; pathId += 1) {
            rows.push(
                row('203.0.113.0', {
                    ribType: POST_OUT,
                    peerIp,
                    pathId,
                    nextHop:
                        pathId < 25 ? `198.51.100.${pathId + 1}` : `198.51.100.${peerIp.endsWith('.1') ? 100 : 200}`
                })
            );
        }
    }
    const issue = paginateBmpRouteAssuranceAnalysis(await analyze(rows)).issues[0];
    const difference = issue.differences.find(value => value.field === 'nextHop');
    assert.equal(difference.values.length, 2);
    assert.equal(difference.valuesTruncated, false, 'only per-peer detail, not peers, was capped');
    for (const peer of difference.values) {
        const witness = `198.51.100.${peer.peerIp.endsWith('.1') ? 100 : 200}`;
        assert.equal(peer.valueCount, 26);
        assert.equal(peer.pathCount, 26);
        assert.equal(peer.valueTruncated, true);
        assert.equal(peer.pathValuesTruncated, true);
        assert.equal(peer.value.length, 25);
        assert.equal(peer.pathValues.length, 25);
        assert.ok(peer.value.includes(witness), 'bounded unique values retain the actual difference');
        assert.ok(
            peer.pathValues.some(path => path.pathId === 25 && path.value === witness),
            'bounded path values retain a path proving the actual difference'
        );
    }
    assert.notDeepEqual(difference.values[0].value, difference.values[1].value);
    assert.notDeepEqual(difference.values[0].pathValues, difference.values[1].pathValues);
}

async function main() {
    await verifyAddressFamilyFilters();
    await verifyAttributeSemantics();
    await verifyCappedIncrementalEvidence();
    await verifyRetainedPagination();
    await verifyEgressPayloadBounds();
    await verifyEgressPathDifferenceWitnesses();
    console.log('BMP route analysis filter, attribute, retention and incremental regressions passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
