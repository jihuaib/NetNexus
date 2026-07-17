<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-session-statistics-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="BGP会话统计" class="bmp-full-card">
                    <div v-if="clientList.length > 0" class="bmp-tabs-shell">
                        <nn-tabs
                            v-model:active-key="activeClientKey"
                            tab-position="left"
                            class="client-tabs"
                            :tab-bar-style="clientTabBarStyle"
                        >
                            <nn-tab-pane v-for="client in clientList" :key="getClientKey(client)">
                                <template #tab>
                                    <span class="client-tab-label" data-testid="bmp-statistics-client-tab-label">
                                        <nn-tooltip
                                            class="client-tab-tooltip"
                                            :title="formatClientTab(client)"
                                            placement="right"
                                        >
                                            <span
                                                class="client-tab-address"
                                                data-testid="bmp-statistics-client-address"
                                            >
                                                {{ formatClientTab(client) }}
                                            </span>
                                        </nn-tooltip>
                                        <span
                                            class="client-connection-state"
                                            :class="isRecordOnline(client) ? 'is-online' : 'is-offline'"
                                            data-testid="bmp-statistics-client-status"
                                        >
                                            {{ formatConnectionState(client) }}
                                        </span>
                                    </span>
                                </template>
                                <div v-if="getClientSessionGroups(client).length > 0" class="bmp-inner-tabs-shell">
                                    <nn-tabs class="bmp-inner-tabs">
                                        <nn-tab-pane
                                            v-for="group in getClientSessionGroups(client)"
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
                                                :row-key="
                                                    record => `${record.type}|${record.afi || ''}|${record.safi || ''}`
                                                "
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
                                    <nn-empty description="暂无统计数据" />
                                </div>
                            </nn-tab-pane>
                        </nn-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <nn-empty description="暂无数据" />
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
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import EventBus from '../../utils/eventBus';
    import { BMP_BGP_RIB_TYPE, BMP_EVENT_PAGE_ID, BMP_SESSION_FLAGS, BMP_STATS_TYPE } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../../const/bgpConst';

    defineOptions({
        name: 'BgpSessionStatisReport'
    });

    const formatAddrFamily = record => {
        if (record.afi === null || record.afi === undefined || record.safi === null || record.safi === undefined) {
            return '-';
        }
        const addrFamilyType = getAddrFamilyType(Number(record.afi), Number(record.safi));
        const name = ADDRESS_FAMILY_NAME[addrFamilyType] || `AFI ${record.afi} / SAFI ${record.safi}`;
        return `${name} (${record.afi}/${record.safi})`;
    };

    const formatClientTab = client => {
        return formatBmpClientLabel(client);
    };

    const getRecordOnlineState = record => {
        if (typeof record?.isOnline === 'boolean') return record.isOnline;
        if (typeof record?.online === 'boolean') return record.online;
        const state = String(record?.connectionState || '').toLowerCase();
        if (['offline', 'disconnected', 'closed', 'down'].includes(state)) return false;
        if (['online', 'connected', 'open', 'up'].includes(state)) return true;
        return null;
    };

    const isRecordOnline = record => getRecordOnlineState(record) ?? true;

    const formatConnectionState = record => (isRecordOnline(record) ? '在线' : '已断开');

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

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const clientTabBarStyle = { width: '148px', flex: '0 0 148px' };
    const reportMap = ref(new Map());
    const activeRibTypeMap = ref(new Map());
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const getClientSourceId = client => client?.persistentSourceId || client?.sourceId || null;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = getClientSourceId(client);
        return sourceId ? `source:${sourceId}` : `connection:${getClientTransportKey(client)}`;
    };

    const isSameClient = (left, right) => {
        if (!left || !right) return false;
        const leftSourceId = getClientSourceId(left);
        const rightSourceId = getClientSourceId(right);
        if (leftSourceId && rightSourceId) return leftSourceId === rightSourceId;
        return getClientTransportKey(left) === getClientTransportKey(right);
    };

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

    const getClientReports = client => {
        const clientKey = getClientKey(client);
        return Array.from(reportMap.value.values()).filter(report => report.clientKey === clientKey);
    };

    const getClientSessionGroups = client => {
        const clientKey = getClientKey(client);
        const groups = new Map();
        getClientReports(client).forEach(report => {
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
    };

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
        if (data && data.client && data.session && data.statistics) {
            const sourceId = getClientSourceId(data.client) || getClientSourceId(fallbackClient);
            const client = {
                ...(fallbackClient || {}),
                ...data.client,
                ...(sourceId ? { persistentSourceId: sourceId, sourceId } : {})
            };
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
        splitReportByRibType(data).forEach(report => upsertSingleReport(report, fallbackClient));
    };

    const onStatisticsReport = result => {
        if (result.status === 'success') {
            upsertReport(result.data);
        }
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                const existingIndex = clientList.value.findIndex(client => isSameClient(client, data));
                if (existingIndex !== -1) {
                    const existingClient = clientList.value[existingIndex];
                    const clientKey = getClientKey(existingClient);
                    Object.assign(existingClient, data, { isOnline: false, connectionState: 'closed' });
                    updateReportsForClient(clientKey, existingClient);
                }
            } else {
                for (const client of clientList.value) {
                    const clientKey = getClientKey(client);
                    Object.assign(client, { isOnline: false, connectionState: 'closed' });
                    updateReportsForClient(clientKey, client);
                }
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            const existingIndex = clientList.value.findIndex(client => isSameClient(client, result.data));
            if (existingIndex !== -1) {
                const existingClient = clientList.value[existingIndex];
                const previousClientKey = getClientKey(existingClient);
                const wasActive = previousClientKey === activeClientKey.value;
                Object.assign(existingClient, result.data, { isOnline: true, connectionState: 'open' });
                updateReportsForClient(previousClientKey, existingClient);
                if (wasActive) activeClientKey.value = getClientKey(existingClient);
            } else {
                clientList.value.push({ ...result.data, isOnline: true, connectionState: 'open' });
            }
            if (clientList.value.length > 0 && !activeClientKey.value) {
                activeClientKey.value = getClientKey(clientList.value[0]);
            }
        } else {
            notify.error('客户端列表获取失败');
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.bmpApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;

                if (clientList.value.length > 0) {
                    const activeClientExists = clientList.value.some(
                        client => getClientKey(client) === activeClientKey.value
                    );
                    if (!activeClientKey.value || !activeClientExists) {
                        activeClientKey.value = getClientKey(clientList.value[0]);
                    }
                } else {
                    activeClientKey.value = '';
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    const loadStatisticsReports = async () => {
        try {
            for (const client of clientList.value) {
                const result = await window.bmpApi.getBgpStatisticsReports(toPlainClient(client));
                if (result.status === 'success') {
                    (result.data || []).forEach(report => upsertReport(report, client));
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载统计数据失败');
        }
    };

    onActivated(async () => {
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onTerminationHandler);
        EventBus.on(
            'bmp:statisticsReport',
            BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT,
            onStatisticsReport
        );
        await loadClientList();
        await loadStatisticsReports();
    });

    onDeactivated(() => {
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:statisticsReport', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
    });
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

    .bmp-tabs-shell,
    .bmp-inner-tabs-shell {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .client-tabs,
    .bmp-inner-tabs {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        overflow: hidden;
    }

    .client-tabs > :deep(.nn-tabs-content-holder),
    .client-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content),
    .client-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane),
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

    .client-tab-label {
        display: flex;
        width: 100%;
        max-width: 132px;
        min-width: 0;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        font-size: 14px;
        line-height: 22px;
        overflow: hidden;
    }

    .client-tab-address {
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .client-tab-tooltip {
        width: 100%;
        max-width: 100%;
        min-width: 0;
    }

    .client-tab-tooltip :deep(.nn-tooltip-trigger) {
        max-width: 100%;
        min-width: 0;
    }

    .client-connection-state {
        font-size: 12px;
        line-height: 1;
    }

    .client-connection-state.is-online {
        color: #389e0d;
    }

    .client-connection-state.is-offline {
        color: #d46b08;
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab) {
        justify-content: center;
        padding: 8px;
        text-align: center;
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab > .nn-tabs-tab-button) {
        width: 100%;
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
