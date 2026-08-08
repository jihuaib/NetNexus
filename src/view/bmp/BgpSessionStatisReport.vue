<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-session-statistics-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card class="bmp-full-card">
                    <div v-if="monitoredClient && sessionGroups.length > 0" class="bmp-inner-tabs-shell">
                        <nn-tabs class="bmp-inner-tabs">
                            <nn-tab-pane
                                v-for="group in sessionGroups"
                                :key="group.key"
                                :tab="formatSessionTab(group.session)"
                            >
                                <div class="report-header">
                                    <nn-select
                                        :value="group.activeRibType"
                                        style="width: 220px"
                                        data-testid="bmp-statistics-rib-type-select"
                                        @update:value="value => setActiveRibType(group.key, value)"
                                    >
                                        <nn-select-option
                                            v-for="report in group.reports"
                                            :key="report.ribType"
                                            :value="report.ribType"
                                        >
                                            {{ formatRibType(report.ribType) }}
                                        </nn-select-option>
                                    </nn-select>
                                    <nn-space v-if="group.activeReport">
                                        <nn-tag color="blue">{{ group.session.sessionIp }}</nn-tag>
                                        <nn-tag>AS {{ group.session.sessionAs }}</nn-tag>
                                        <nn-tag
                                            :color="getRibTypeColor(group.activeReport.ribType)"
                                            data-testid="bmp-statistics-rib-type"
                                        >
                                            {{ formatRibType(group.activeReport.ribType) }}
                                        </nn-tag>
                                        <nn-tag>TLV {{ getReportTlvCount(group.activeReport) }}</nn-tag>
                                        <nn-button
                                            type="link"
                                            size="small"
                                            @click="viewReportDetails(group.activeReport)"
                                        >
                                            详情
                                        </nn-button>
                                    </nn-space>
                                </div>
                                <nn-table
                                    v-if="group.activeReport"
                                    class="report-table"
                                    :columns="columns"
                                    :data-source="group.activeReport.statistics"
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :row-key="record => `${record.type}|${record.afi || ''}|${record.safi || ''}`"
                                    size="small"
                                    bordered
                                    :scroll="{ y: '100%' }"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'typeName'">
                                            {{ record.typeName }}
                                        </template>
                                        <template v-if="column.key === 'value'">
                                            {{ record.value }}
                                        </template>
                                    </template>
                                </nn-table>
                            </nn-tab-pane>
                        </nn-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <nn-empty :description="emptyDescription" />
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="520px"
            @close="closeDetailsDrawer"
        >
            <nn-json-viewer v-if="currentDetails" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, watch, onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
    import { useRoute } from 'vue-router';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import { BMP_BGP_RIB_TYPE, BMP_EVENT_PAGE_ID, BMP_SESSION_FLAGS, BMP_STATS_TYPE } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../../const/bgpConst';

    defineOptions({
        name: 'BgpSessionStatisReport'
    });

    const props = defineProps({
        clientKey: {
            type: String,
            default: ''
        }
    });

    const route = useRoute();

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
        });

    const getClientKeyInput = value => {
        const candidate = Array.isArray(value) ? value[0] : value;
        if (typeof candidate !== 'string') return '';
        const input = candidate.trim();
        if (input.length === 0 || input.length > 512 || hasControlCharacter(input)) return '';
        if (input.startsWith('source:')) {
            const sourceId = input.slice('source:'.length).trim().toLowerCase();
            return sourceId ? `source:${sourceId}` : '';
        }
        return input.startsWith('connection:') ? input : '';
    };

    const lockedClientKey = computed(
        () => getClientKeyInput(props.clientKey) || getClientKeyInput(route.query.clientKey)
    );

    const formatAddrFamily = record => {
        if (record.afi === null || record.afi === undefined || record.safi === null || record.safi === undefined) {
            return '-';
        }
        const addrFamilyType = getAddrFamilyType(Number(record.afi), Number(record.safi));
        const name = ADDRESS_FAMILY_NAME[addrFamilyType] || `AFI ${record.afi} / SAFI ${record.safi}`;
        return `${name} (${record.afi}/${record.safi})`;
    };

    const columns = [
        {
            title: 'Type',
            dataIndex: 'type',
            key: 'type',
            width: 80
        },
        {
            title: '统计类型',
            dataIndex: 'typeName',
            key: 'typeName',
            width: 320
        },
        {
            title: '地址族',
            key: 'addrFamily',
            width: 180,
            customRender: ({ record }) => formatAddrFamily(record)
        },
        {
            title: '数值',
            dataIndex: 'value',
            key: 'value',
            width: 120,
            align: 'right'
        }
    ];

    const monitoredClient = ref(null);
    const reportMap = ref(new Map());
    const activeRibTypeMap = ref(new Map());
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);
    let clientLoadRequestId = 0;
    let reportLoadRequestId = 0;
    let pageActive = false;

    const getClientSourceId = client => client?.persistentSourceId || client?.sourceId || null;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = getClientSourceId(client);
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(client)}`;
    };

    const monitoredClientKey = computed(() => (monitoredClient.value ? getClientKey(monitoredClient.value) : ''));

    const clientMatchesKey = (client, clientKey) => {
        if (!client || !clientKey) return false;
        if (clientKey.startsWith('source:')) {
            const sourceId = getClientSourceId(client) || '';
            return `source:${String(sourceId).trim().toLowerCase()}` === clientKey;
        }
        if (clientKey.startsWith('connection:')) {
            return `connection:${getClientTransportKey(client)}` === clientKey;
        }
        return false;
    };

    const isSameClient = (left, right) => {
        if (!left || !right) return false;
        const leftSourceId = getClientSourceId(left);
        const rightSourceId = getClientSourceId(right);
        if (leftSourceId && rightSourceId) {
            return String(leftSourceId).trim().toLowerCase() === String(rightSourceId).trim().toLowerCase();
        }
        return getClientTransportKey(left) === getClientTransportKey(right);
    };

    const getClientConnectionId = client => client?.persistentConnectionId || client?.connectionId || null;

    const hasCompleteClientTransport = client =>
        [client?.localIp, client?.localPort, client?.remoteIp, client?.remotePort].every(
            value => value !== null && value !== undefined && value !== ''
        );

    const isSameClientConnection = (left, right) => {
        if (!isSameClient(left, right)) return false;
        const leftConnectionId = getClientConnectionId(left);
        const rightConnectionId = getClientConnectionId(right);
        if (leftConnectionId && rightConnectionId) return leftConnectionId === rightConnectionId;
        if (hasCompleteClientTransport(left) && hasCompleteClientTransport(right)) {
            return getClientTransportKey(left) === getClientTransportKey(right);
        }
        return true;
    };

    const emptyDescription = computed(() => {
        if (!lockedClientKey.value) return '未指定监控 Client';
        return monitoredClient.value ? '当前 Client 暂无统计数据' : '未找到指定 Client';
    });

    const toPlainClient = client => {
        const sourceId = getClientSourceId(client);
        return {
            localIp: client.localIp,
            localPort: client.localPort,
            remoteIp: client.remoteIp,
            remotePort: client.remotePort,
            persistentSourceId: sourceId,
            sourceId,
            persistentConnectionId: client.persistentConnectionId || client.connectionId || null,
            connectionId: client.connectionId || client.persistentConnectionId || null
        };
    };

    const getSessionKey = session => {
        return `${session.sessionType}|${session.sessionRdRaw || session.sessionRd}|${session.sessionIp}|${session.sessionAs}`;
    };

    const SESSION_RIB_TYPES = [
        BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
        BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
    ];
    const SESSION_RIB_TYPE_SET = new Set(SESSION_RIB_TYPES);
    const SESSION_RIB_TYPE_ORDER = new Map(SESSION_RIB_TYPES.map((ribType, index) => [ribType, index]));
    const SESSION_RIB_TYPE_NAME = {
        [BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN]: 'Pre Adj RIB In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_IN]: 'Post Adj RIB In',
        [BMP_BGP_RIB_TYPE.ADJ_RIB_OUT]: 'Pre Adj RIB Out',
        [BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT]: 'Post Adj RIB Out'
    };

    const makeStatTypeSet = values => new Set(values.filter(Number.isInteger));
    const EXPLICIT_PRE_RIB_IN_STAT_TYPES = makeStatTypeSet([
        BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN,
        BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_IN
    ]);
    const EXPLICIT_POST_RIB_IN_STAT_TYPES = makeStatTypeSet([
        BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN,
        BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_IN
    ]);
    const PRE_RIB_OUT_STAT_TYPES = makeStatTypeSet([
        BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT,
        BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT
    ]);
    const POST_RIB_OUT_STAT_TYPES = makeStatTypeSet([
        BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT,
        BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT
    ]);

    const normalizeRibType = ribType => {
        const normalized = Number(ribType);
        return SESSION_RIB_TYPE_SET.has(normalized) ? normalized : null;
    };

    const getReportPeerFlags = report => {
        const candidates = [
            report?.statisticsFlags,
            report?.effectiveSessionFlags,
            report?.sessionFlags,
            report?.effectivePeerFlags,
            report?.peerFlags,
            report?.rawSessionFlags,
            report?.rawPeerFlags,
            report?.session?.sessionFlags,
            report?.session?.rawSessionFlags
        ];
        for (const candidate of candidates) {
            if (candidate === null || candidate === undefined || candidate === '') continue;
            const flags = Number(candidate);
            if (Number.isInteger(flags)) return flags;
        }
        return 0;
    };

    const getReportFallbackRibType = report => {
        const explicitRibType = normalizeRibType(report?.ribType);
        if (explicitRibType !== null) return explicitRibType;

        const flags = getReportPeerFlags(report);
        const postPolicy = (flags & BMP_SESSION_FLAGS.POST_POLICY) !== 0;
        const adjRibOut = (flags & BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0;
        if (report?.ribDirection === 'rib-out' || adjRibOut) {
            return postPolicy ? BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT : BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
        }
        return postPolicy ? BMP_BGP_RIB_TYPE.ADJ_RIB_IN : BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
    };

    const getStatisticRibType = (statistic, fallbackRibType) => {
        const statType = Number(statistic?.type);
        if (EXPLICIT_PRE_RIB_IN_STAT_TYPES.has(statType)) return BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
        if (EXPLICIT_POST_RIB_IN_STAT_TYPES.has(statType)) return BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
        if (PRE_RIB_OUT_STAT_TYPES.has(statType)) return BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
        if (POST_RIB_OUT_STAT_TYPES.has(statType)) return BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT;
        return fallbackRibType;
    };

    const getReportRibType = report => normalizeRibType(report?.ribType) ?? getReportFallbackRibType(report);

    const splitReportByRibType = report => {
        const statistics = Array.isArray(report?.statistics) ? report.statistics : [];
        const fallbackRibType = getReportFallbackRibType(report);
        if (statistics.length === 0) {
            return [{ ...report, ribType: fallbackRibType, statistics }];
        }

        const groups = new Map();
        statistics.forEach(statistic => {
            const ribType = getStatisticRibType(statistic, fallbackRibType);
            if (!groups.has(ribType)) groups.set(ribType, []);
            groups.get(ribType).push(statistic);
        });

        return Array.from(groups, ([ribType, groupedStatistics]) => ({
            ...report,
            ribType,
            statistics: groupedStatistics
        }));
    };

    const getReportKey = (clientKey, report) =>
        `${clientKey}|${getSessionKey(report.session)}|${getReportRibType(report)}`;

    const sessionGroups = computed(() => {
        const clientKey = monitoredClientKey.value;
        if (!clientKey) return [];
        const groups = new Map();
        Array.from(reportMap.value.values())
            .filter(report => report.clientKey === clientKey)
            .forEach(report => {
                const sessionKey = getSessionKey(report.session);
                const groupKey = `${clientKey}|${sessionKey}`;
                if (!groups.has(groupKey)) {
                    groups.set(groupKey, { key: groupKey, session: report.session, reports: [] });
                }
                groups.get(groupKey).reports.push(report);
            });

        return Array.from(groups.values())
            .sort((left, right) => getSessionKey(left.session).localeCompare(getSessionKey(right.session)))
            .map(group => {
                group.reports.sort(
                    (left, right) =>
                        (SESSION_RIB_TYPE_ORDER.get(getReportRibType(left)) ?? Number.MAX_SAFE_INTEGER) -
                        (SESSION_RIB_TYPE_ORDER.get(getReportRibType(right)) ?? Number.MAX_SAFE_INTEGER)
                );
                const requestedRibType = normalizeRibType(activeRibTypeMap.value.get(group.key));
                const activeReport =
                    group.reports.find(report => getReportRibType(report) === requestedRibType) || group.reports[0];
                return {
                    ...group,
                    activeRibType: getReportRibType(activeReport),
                    activeReport
                };
            });
    });

    const setActiveRibType = (groupKey, ribType) => {
        const normalized = normalizeRibType(ribType);
        if (normalized === null) return;
        const nextMap = new Map(activeRibTypeMap.value);
        nextMap.set(groupKey, normalized);
        activeRibTypeMap.value = nextMap;
    };

    const getSessionVrfTableNames = session =>
        Array.isArray(session?.vrfTableNames) ? session.vrfTableNames.filter(Boolean) : [];

    const formatSessionVrfOrRd = session => {
        const vrfTableNames = getSessionVrfTableNames(session);
        if (vrfTableNames.length > 0) return vrfTableNames.join(', ');
        return session?.sessionRd === '0:0' ? 'global' : session?.sessionRd || '-';
    };

    const formatSessionTab = session => {
        return `${formatSessionVrfOrRd(session)} | ${session.sessionIp} | ${session.sessionAs}`;
    };

    const formatRibType = ribType => SESSION_RIB_TYPE_NAME[normalizeRibType(ribType)] || `RIB ${ribType}`;

    const getRibTypeColor = ribType =>
        [BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT].includes(normalizeRibType(ribType))
            ? 'orange'
            : 'green';

    const getReportTlvCount = report => {
        return (report.tlvs || []).length;
    };

    const viewReportDetails = report => {
        currentDetails.value = report;
        detailsDrawerTitle.value = `统计详情: ${report.session.sessionIp} · ${formatRibType(report.ribType)}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const updateReportsForClient = (previousClientKey, client) => {
        const nextClientKey = getClientKey(client);
        const nextMap = new Map(reportMap.value);
        for (const [key, report] of Array.from(nextMap.entries())) {
            if (report.clientKey !== previousClientKey) continue;
            const nextKey = getReportKey(nextClientKey, report);
            nextMap.delete(key);
            nextMap.set(nextKey, {
                ...report,
                key: nextKey,
                clientKey: nextClientKey,
                client: { ...report.client, ...client }
            });
        }
        reportMap.value = nextMap;

        if (previousClientKey !== nextClientKey) {
            const nextActiveRibTypes = new Map(activeRibTypeMap.value);
            for (const [groupKey, ribType] of Array.from(nextActiveRibTypes.entries())) {
                const previousPrefix = `${previousClientKey}|`;
                if (!groupKey.startsWith(previousPrefix)) continue;
                nextActiveRibTypes.delete(groupKey);
                nextActiveRibTypes.set(`${nextClientKey}|${groupKey.slice(previousPrefix.length)}`, ribType);
            }
            activeRibTypeMap.value = nextActiveRibTypes;
        }
    };

    const upsertSingleReport = (data, fallbackClient = null) => {
        const reportClient = data?.client || fallbackClient;
        if (data && reportClient && data.session && Array.isArray(data.statistics)) {
            const sourceId = getClientSourceId(reportClient) || getClientSourceId(fallbackClient);
            const client = {
                ...(fallbackClient || {}),
                ...reportClient,
                ...(sourceId ? { persistentSourceId: sourceId, sourceId } : {})
            };
            if (!clientMatchesKey(client, lockedClientKey.value)) return;
            const clientKey = getClientKey(client);
            const key = getReportKey(clientKey, data);
            const nextMap = new Map(reportMap.value);
            nextMap.set(key, {
                key,
                clientKey,
                client,
                session: data.session,
                ribType: getReportRibType(data),
                statistics: data.statistics,
                tlvs: data.tlvs || [],
                updatedAt: data.updatedAt || new Date().toISOString()
            });
            reportMap.value = nextMap;

            const groupKey = `${clientKey}|${getSessionKey(data.session)}`;
            if (!activeRibTypeMap.value.has(groupKey)) {
                const nextActiveRibTypes = new Map(activeRibTypeMap.value);
                nextActiveRibTypes.set(groupKey, getReportRibType(data));
                activeRibTypeMap.value = nextActiveRibTypes;
            }
        }
    };

    const upsertReport = (data, fallbackClient = null) => {
        if (!data) return;
        splitReportByRibType(data).forEach(report => upsertSingleReport(report, fallbackClient));
    };

    const onStatisticsReport = result => {
        if (result.status !== 'success' || !result.data) return;
        const eventClient = result.data.client;
        if (!clientMatchesKey(eventClient, lockedClientKey.value)) return;
        if (monitoredClient.value && !isSameClientConnection(eventClient, monitoredClient.value)) return;
        upsertReport(result.data, monitoredClient.value);
    };

    const onTerminationHandler = result => {
        if (result.status !== 'success') {
            console.error('termination handler error', result.msg);
            return;
        }

        const data = result.data;
        if (data && !clientMatchesKey(data, lockedClientKey.value)) return;
        if (data && monitoredClient.value && !isSameClientConnection(data, monitoredClient.value)) return;

        clientLoadRequestId += 1;
        const previousClientKey = monitoredClientKey.value;
        const offlineClient = {
            ...(monitoredClient.value || {}),
            ...(data || {}),
            isOnline: false,
            connectionState: 'closed'
        };
        if (!clientMatchesKey(offlineClient, lockedClientKey.value)) return;
        monitoredClient.value = offlineClient;
        updateReportsForClient(previousClientKey || getClientKey(offlineClient), offlineClient);
    };

    const onMonitoredClientUpdate = result => {
        if (result.status !== 'success') {
            notify.error('Client 信息更新失败');
            return;
        }

        const client = result.data;
        if (!clientMatchesKey(client, lockedClientKey.value)) return;

        clientLoadRequestId += 1;
        const previousClient = monitoredClient.value;
        const previousClientKey = monitoredClientKey.value;
        monitoredClient.value = { ...client, isOnline: true, connectionState: 'open' };
        if (previousClientKey && previousClientKey !== monitoredClientKey.value) {
            reportMap.value = new Map();
            activeRibTypeMap.value = new Map();
        } else {
            updateReportsForClient(previousClientKey || monitoredClientKey.value, monitoredClient.value);
        }
        if (!previousClient || !isSameClientConnection(previousClient, monitoredClient.value)) {
            loadStatisticsReports();
        }
    };

    const getClientFromResponse = response => {
        if (response?.status === 'success') return response.data || null;
        if (response?.status) throw new Error(response.msg || '获取 Client 失败');
        return response || null;
    };

    const loadMonitoredClient = async () => {
        const requestClientKey = lockedClientKey.value;
        const requestId = ++clientLoadRequestId;
        if (!requestClientKey) {
            monitoredClient.value = null;
            return null;
        }

        try {
            const response = await window.bmpApi.getClient(requestClientKey);
            if (!pageActive || requestId !== clientLoadRequestId || requestClientKey !== lockedClientKey.value) {
                return null;
            }

            const client = getClientFromResponse(response);
            const nextClient = client && clientMatchesKey(client, requestClientKey) ? client : null;
            const previousClientKey = monitoredClientKey.value;
            monitoredClient.value = nextClient;
            if (!nextClient) {
                reportMap.value = new Map();
                activeRibTypeMap.value = new Map();
            } else if (previousClientKey && previousClientKey !== monitoredClientKey.value) {
                reportMap.value = new Map();
                activeRibTypeMap.value = new Map();
            } else {
                updateReportsForClient(previousClientKey || monitoredClientKey.value, nextClient);
            }
            return nextClient;
        } catch (error) {
            if (!pageActive || requestId !== clientLoadRequestId || requestClientKey !== lockedClientKey.value) {
                return null;
            }
            console.error(error);
            notify.error('加载 Client 失败');
            return null;
        }
    };

    const loadStatisticsReports = async () => {
        const client = monitoredClient.value;
        if (!client) return;
        const requestId = ++reportLoadRequestId;
        const requestClientKey = lockedClientKey.value;
        try {
            const result = await window.bmpApi.getBgpStatisticsReports(toPlainClient(client));
            if (
                !pageActive ||
                requestId !== reportLoadRequestId ||
                requestClientKey !== lockedClientKey.value ||
                !isSameClientConnection(client, monitoredClient.value)
            ) {
                return;
            }
            if (result.status === 'success') {
                (result.data || []).forEach(report => upsertReport(report, client));
            } else {
                notify.error('加载统计数据失败');
            }
        } catch (error) {
            if (
                !pageActive ||
                requestId !== reportLoadRequestId ||
                requestClientKey !== lockedClientKey.value ||
                !isSameClientConnection(client, monitoredClient.value)
            ) {
                return;
            }
            console.error(error);
            notify.error('加载统计数据失败');
        }
    };

    watch(lockedClientKey, async (clientKey, previousClientKey) => {
        if (clientKey === previousClientKey) return;
        clientLoadRequestId += 1;
        reportLoadRequestId += 1;
        monitoredClient.value = null;
        reportMap.value = new Map();
        activeRibTypeMap.value = new Map();
        closeDetailsDrawer();
        if (!pageActive) return;
        const client = await loadMonitoredClient();
        if (client && pageActive) await loadStatisticsReports();
    });

    const activatePage = async () => {
        if (pageActive) return;
        pageActive = true;
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onMonitoredClientUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onTerminationHandler);
        EventBus.on(
            'bmp:statisticsReport',
            BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT,
            onStatisticsReport
        );
        const client = await loadMonitoredClient();
        if (client && pageActive) await loadStatisticsReports();
    };

    const deactivatePage = () => {
        if (!pageActive) return;
        pageActive = false;
        clientLoadRequestId += 1;
        reportLoadRequestId += 1;
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:statisticsReport', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
    };

    onMounted(activatePage);
    onActivated(activatePage);
    onDeactivated(deactivatePage);
    onBeforeUnmount(deactivatePage);
</script>

<style scoped>
    .bmp-full-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .bmp-full-row,
    .bmp-full-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .bmp-full-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .bmp-full-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .bmp-inner-tabs-shell {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        overflow: hidden;
    }

    .bmp-inner-tabs > :deep(.nn-tabs-content-holder),
    .bmp-inner-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content),
    .bmp-inner-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs > :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .report-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
    }

    .report-table,
    .report-table :deep(.nn-spin-nested-loading),
    .report-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .report-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .report-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .report-table :deep(.nn-table-container) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .report-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow: auto !important;
    }

    .report-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .report-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .no-result-message {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        width: 100%;
        color: var(--nn-color-text-muted);
        overflow: auto;
    }
</style>
