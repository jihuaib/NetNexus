<template>
    <div class="mt-container bmp-full-page" data-testid="bmp-loc-rib-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="BGP Loc-RIB" class="bmp-full-card">
                    <div v-if="clientList.length > 0" class="bmp-tabs-shell">
                        <nn-tabs
                            v-model:active-key="activeClientKey"
                            tab-position="left"
                            class="client-tabs"
                            :tab-bar-style="clientTabBarStyle"
                        >
                            <nn-tab-pane
                                v-for="client in clientList"
                                :key="`${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`"
                            >
                                <template #tab>
                                    <span class="client-tab-label">{{ formatClientTab(client) }}</span>
                                </template>
                                <div v-if="bgpInstances.length > 0" class="bmp-inner-tabs-shell">
                                    <nn-tabs v-model:active-key="activeInstanceKey" class="bmp-inner-tabs">
                                        <nn-tab-pane
                                            v-for="instance in bgpInstances"
                                            :key="`${instance.instanceType}|${instance.instanceRd}|${instance.addrFamilyType}`"
                                            :tab="`${formatVrfTableName(instance)} | ${ADDRESS_FAMILY_NAME[instance.addrFamilyType]}`"
                                        >
                                            <a-table
                                                class="detail-table"
                                                data-testid="bmp-loc-rib-instance-table"
                                                :columns="bgpInstanceColumns"
                                                :data-source="[instance]"
                                                :pagination="false"
                                                size="small"
                                                style="margin-bottom: 8px"
                                                row-key="peerIp"
                                                :scroll="{ x: 1290 }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'addPath'">
                                                        <nn-tag v-if="record.isAddPath" color="green">Yes</nn-tag>
                                                        <nn-tag v-else color="red">No</nn-tag>
                                                    </template>
                                                    <template v-else-if="column.key === 'instanceFlags'">
                                                        <nn-tooltip :title="getBmpLocRibFlagsName(record.instanceFlags)">
                                                            <span>
                                                                {{ getBmpLocRibFlagsName(record.instanceFlags) }}
                                                            </span>
                                                        </nn-tooltip>
                                                    </template>
                                                    <template v-else-if="column.key === 'rawInstanceFlags'">
                                                        <span>{{ formatRawFlags(record.rawInstanceFlags) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'tlvCount'">
                                                        <span>{{ getInstanceTlvCount(record) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'action'">
                                                        <nn-button
                                                            type="link"
                                                            size="small"
                                                            @click="viewInstanceDetails(record)"
                                                        >
                                                            详情
                                                        </nn-button>
                                                    </template>
                                                </template>
                                            </a-table>
                                            <div class="route-toolbar">
                                                <div class="route-toolbar-query">
                                                    <nn-radio-group v-model:value="routeStateFilter" size="small">
                                                        <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.ACTIVE">
                                                            当前
                                                        </nn-radio-button>
                                                        <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.ALL">
                                                            全部
                                                        </nn-radio-button>
                                                        <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.STALE">
                                                            过期
                                                        </nn-radio-button>
                                                    </nn-radio-group>
                                                    <a-input
                                                        v-model:value="routePrefixFilter"
                                                        allow-clear
                                                        placeholder="Prefix 或 Prefix/Mask"
                                                        style="width: 220px"
                                                        @press-enter="searchInstanceRoutes"
                                                    />
                                                    <nn-button type="primary" @click="searchInstanceRoutes">
                                                        查询
                                                    </nn-button>
                                                </div>
                                                <div class="route-toolbar-status">
                                                    <nn-tag color="green">当前 {{ routeSummary.active }}</nn-tag>
                                                    <nn-tag color="orange">过期 {{ routeSummary.stale }}</nn-tag>
                                                    <nn-button
                                                        danger
                                                        :disabled="routeSummary.stale === 0"
                                                        @click="purgeStaleInstanceRoutes"
                                                    >
                                                        清理过期
                                                    </nn-button>
                                                </div>
                                            </div>
                                            <a-table
                                                class="route-table"
                                                data-testid="bmp-loc-rib-route-table"
                                                :columns="bgpRouteColumns"
                                                :data-source="bgpRouteList"
                                                :pagination="bgpRoutePagination"
                                                :row-key="getRouteRowKey"
                                                :row-class-name="
                                                    record =>
                                                        getRouteParseStatusRowClass(record.parseStatus) ||
                                                        (record.routeState === BMP_ROUTE_STATE.STALE
                                                            ? 'route-stale-row'
                                                            : '')
                                                "
                                                size="small"
                                                :scroll="{ x: 1490, y: '100%' }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'routeAction'">
                                                        <nn-space size="small">
                                                            <nn-tooltip title="查询路由detail">
                                                                <nn-button
                                                                    type="text"
                                                                    size="small"
                                                                    @click="viewRouteDetailJson(record)"
                                                                >
                                                                    <template #icon><ProfileOutlined /></template>
                                                                </nn-button>
                                                            </nn-tooltip>
                                                        </nn-space>
                                                    </template>
                                                    <template v-else-if="column.key === 'parseStatus'">
                                                        <nn-tag :color="getRouteParseStatusColor(record.parseStatus)">
                                                            {{ getRouteParseStatusText(record.parseStatus) }}
                                                        </nn-tag>
                                                    </template>
                                                </template>
                                            </a-table>
                                        </nn-tab-pane>
                                    </nn-tabs>
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

        <a-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <template v-if="currentDetails">
                <pre>{{ JSON.stringify(currentDetails, null, 2) }}</pre>
            </template>
        </a-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { ProfileOutlined } from '../../ui/icons';
    import {
        BMP_SESSION_TYPE_NAME,
        BMP_SESSION_STATE_NAME,
        BMP_EVENT_PAGE_ID,
        BMP_ROUTE_STATE,
        BMP_ROUTE_STATE_FILTER,
        getBmpLocRibFlagsName
    } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import {
        getRouteParseStatusColor,
        getRouteParseStatusRowClass,
        getRouteParseStatusText
    } from '../../utils/routeParseStatus';
    import EventBus from '../../utils/eventBus';
    defineOptions({
        name: 'BgpLocRib'
    });

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const clientTabBarStyle = { width: '128px', flex: '0 0 128px' };

    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };

    const normalizeRoutePathId = pathId => {
        const numericPathId = Number(pathId);
        return Number.isInteger(numericPathId) ? numericPathId : 0;
    };

    const normalizeRouteRd = rd => (rd === null || rd === undefined || rd === '' ? '0:0' : String(rd));

    const getRouteKey = record => {
        if (record.routeKey) {
            return record.routeKey;
        }
        return `${normalizeRoutePathId(record.pathId)}|${normalizeRouteRd(record.rd)}|${record.ip}|${record.mask}`;
    };

    const getRouteRowKey = record => `${record.addrFamilyType}|${getRouteKey(record)}`;

    const formatClientTab = client => {
        return client.remoteIp || '-';
    };

    const formatVrfTableName = instance => {
        return Array.isArray(instance.vrfTableNames) && instance.vrfTableNames.length > 0
            ? instance.vrfTableNames.join(', ')
            : `${instance.instanceType} | ${instance.instanceRd}`;
    };

    const getInstanceTlvCount = record => {
        return (record.peerUpTlvs || []).length + (record.lastRouteMonitoringTlvs || []).length;
    };

    const bgpInstanceColumns = [
        {
            title: 'Instance Type',
            dataIndex: 'instanceType',
            key: 'instanceType',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => {
                return BMP_SESSION_TYPE_NAME[text] || text;
            }
        },
        {
            title: 'VRF/Table',
            dataIndex: 'vrfTableNames',
            key: 'vrfTableNames',
            width: 100,
            ellipsis: true,
            customRender: ({ text }) => {
                return Array.isArray(text) && text.length > 0 ? text.join(', ') : '-';
            }
        },
        {
            title: 'Instance IP',
            dataIndex: 'instanceIp',
            key: 'instanceIp',
            width: 100,
            ellipsis: true
        },
        {
            title: 'AS',
            dataIndex: 'instanceAs',
            key: 'instanceAs',
            width: 100,
            ellipsis: true
        },
        {
            title: 'RD',
            dataIndex: 'instanceRd',
            key: 'instanceRd',
            width: 100,
            ellipsis: true
        },
        {
            title: 'Router ID',
            dataIndex: 'instanceRouterId',
            key: 'instanceRouterId',
            width: 100,
            ellipsis: true
        },
        {
            title: 'ADD-PATH',
            key: 'addPath',
            ellipsis: true,
            width: 80
        },
        {
            title: 'Flags',
            dataIndex: 'instanceFlags',
            key: 'instanceFlags',
            ellipsis: true,
            width: 140
        },
        {
            title: 'Raw Flags',
            dataIndex: 'rawInstanceFlags',
            key: 'rawInstanceFlags',
            ellipsis: true,
            width: 90
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 80,
            align: 'right'
        },
        {
            title: 'Instance状态',
            dataIndex: 'instanceState',
            key: 'instanceState',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => {
                return BMP_SESSION_STATE_NAME[text] || text;
            }
        },
        {
            title: '操作',
            key: 'action',
            fixed: 'right',
            width: 200
        }
    ];

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    // Close details drawer
    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                // 特定客户端终止的情况
                const existingIndex = clientList.value.findIndex(
                    client =>
                        `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                        `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
                );
                if (existingIndex !== -1) {
                    clientList.value.splice(existingIndex, 1);

                    if (clientList.value.length > 0 && !activeClientKey.value) {
                        activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
                    }
                }
            } else {
                // BMP 服务停止，清空所有数据
                clientList.value = [];
                activeClientKey.value = '';
                bgpInstances.value = [];
            }

            if (clientList.value.length === 0) {
                activeClientKey.value = '';
                bgpInstances.value = [];
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onInstanceRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const update = result.data;

        const clientKey = `${update.client.localIp}|${update.client.localPort}|${update.client.remoteIp}|${update.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;

        const instKey = `${update.instance.instanceType}|${update.instance.instanceRd}|${update.instance.addrFamilyType}`;

        if (instKey === activeInstanceKey.value) {
            scheduleRouteRefresh();
        }
    };

    const onInstanceUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const data = result.data;

        const clientKey = `${data.client.localIp}|${data.client.localPort}|${data.client.remoteIp}|${data.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;

        loadBgpInstances();
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(
                client =>
                    `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                    `${result.data.localIp || ''}-${result.data.localPort || ''}-${result.data.remoteIp || ''}-${result.data.remotePort || ''}`
            );
            if (existingIndex !== -1) {
                clientList.value[existingIndex] = result.data;
            } else {
                clientList.value.push(result.data);
            }
            if (clientList.value.length > 0 && !activeClientKey.value) {
                activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
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

                // 设置默认选中第一个客户端
                if (clientList.value.length > 0 && !activeClientKey.value) {
                    activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    const bgpRouteList = ref([]);
    const routeStateFilter = ref(BMP_ROUTE_STATE_FILTER.ALL);
    const routePrefixFilter = ref('');
    const appliedRoutePrefixFilter = ref('');
    const routeSummary = ref({ active: 0, stale: 0, total: 0 });
    const ROUTE_AUTO_REFRESH_INTERVAL_MS = 1500;
    let routeAutoRefreshTimer = null;
    let lastRouteAutoRefreshAt = 0;

    const clearScheduledRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            clearTimeout(routeAutoRefreshTimer);
            routeAutoRefreshTimer = null;
        }
    };

    const scheduleRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            return;
        }

        const delay = Math.max(0, ROUTE_AUTO_REFRESH_INTERVAL_MS - (Date.now() - lastRouteAutoRefreshAt));
        routeAutoRefreshTimer = setTimeout(() => {
            routeAutoRefreshTimer = null;
            lastRouteAutoRefreshAt = Date.now();
            bgpRoutePagination.value.current = 1;
            loadInstanceRoutes();
        }, delay);
    };

    // Instance Logic
    const bgpInstances = ref([]);
    const activeInstanceKey = ref('');

    const loadBgpInstances = async () => {
        if (!activeClientKey.value) return;
        try {
            const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
            const clientInfo = { localIp, localPort, remoteIp, remotePort };
            const res = await window.bmpApi.getBgpInstances(clientInfo);
            if (res.status === 'success') {
                bgpInstances.value = res.data || [];
                if (bgpInstances.value.length > 0) {
                    const first = bgpInstances.value[0];
                    const key = `${first.instanceType}|${first.instanceRd}|${first.addrFamilyType}`;
                    activeInstanceKey.value = key;
                    bgpRoutePagination.value.current = 1;
                    loadInstanceRoutes();
                } else {
                    bgpRouteList.value = [];
                    activeInstanceKey.value = '';
                }
            } else {
                bgpInstances.value = [];
                activeInstanceKey.value = '';
            }
        } catch (error) {
            console.error(error);
            bgpInstances.value = [];
            notify.error('Load BMP instances failed');
        }
    };

    const searchInstanceRoutes = () => {
        appliedRoutePrefixFilter.value = (routePrefixFilter.value || '').trim();
        bgpRoutePagination.value.current = 1;
        loadInstanceRoutes();
    };

    const loadInstanceRoutes = async () => {
        if (!activeClientKey.value) return;

        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const client = { localIp, localPort, remoteIp, remotePort };

        const instance = {
            instanceType: activeInstanceKey.value.split('|')[0],
            instanceRd: activeInstanceKey.value.split('|')[1],
            addrFamilyType: activeInstanceKey.value.split('|')[2]
        };

        const page = bgpRoutePagination.value.current;
        const pageSize = bgpRoutePagination.value.pageSize;

        try {
            const res = await window.bmpApi.getBgpInstanceRoutes(
                client,
                instance,
                page,
                pageSize,
                routeStateFilter.value,
                appliedRoutePrefixFilter.value
            );
            if (res.status === 'success' && res.data) {
                bgpRouteList.value = res.data.list;
                bgpRoutePagination.value.total = res.data.total;
                routeSummary.value = res.data.summary || { active: 0, stale: 0, total: 0 };
            } else {
                bgpRouteList.value = [];
                bgpRoutePagination.value.total = 0;
                routeSummary.value = { active: 0, stale: 0, total: 0 };
            }
        } catch (e) {
            console.error(e);
            notify.error('Load instance routes failed');
        }
    };

    const purgeStaleInstanceRoutes = async () => {
        if (!activeClientKey.value || !activeInstanceKey.value) return;

        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const client = { localIp, localPort, remoteIp, remotePort };

        const instance = {
            instanceType: activeInstanceKey.value.split('|')[0],
            instanceRd: activeInstanceKey.value.split('|')[1],
            addrFamilyType: activeInstanceKey.value.split('|')[2]
        };

        try {
            const res = await window.bmpApi.purgeStaleBgpInstanceRoutes(client, instance);
            if (res.status === 'success') {
                notify.success(`已清理 ${res.data?.deleted || 0} 条过期路由`);
                bgpRoutePagination.value.current = 1;
                loadInstanceRoutes();
            } else {
                notify.error('清理过期路由失败');
            }
        } catch (e) {
            console.error(e);
            notify.error('清理过期路由失败');
        }
    };

    const viewInstanceDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `Instance 详情: ${record.instanceRd}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetailJson = async record => {
        detailsDrawerTitle.value = `路由detail: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        currentDetails.value = null;

        if (!activeClientKey.value || !activeInstanceKey.value) {
            currentDetails.value = record;
            return;
        }

        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const client = { localIp, localPort, remoteIp, remotePort };
        const instance = {
            instanceType: activeInstanceKey.value.split('|')[0],
            instanceRd: activeInstanceKey.value.split('|')[1],
            addrFamilyType: activeInstanceKey.value.split('|')[2]
        };
        const routeKey = getRouteKey(record);

        try {
            const res = await window.bmpApi.getBgpInstanceRouteDetail(client, instance, routeKey);
            if (res.status === 'success' && res.data) {
                currentDetails.value = res.data;
            } else {
                currentDetails.value = record;
                notify.error('查询路由detail失败');
            }
        } catch (error) {
            console.error(error);
            currentDetails.value = record;
            notify.error('查询路由detail失败');
        }
    };

    // 监听activeClientKey变化，加载对应的peer列表 AND instances
    watch(activeClientKey, _newKey => {
        clearScheduledRouteRefresh();
        activeInstanceKey.value = '';
        bgpRouteList.value = [];
        bgpInstances.value = [];
        loadBgpInstances();
    });

    onActivated(async () => {
        clientList.value = [];
        activeClientKey.value = '';
        bgpInstances.value = [];

        EventBus.on('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onTerminationHandler);
        EventBus.on('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceRouteUpdate);

        await loadClientList();
        // 如果有选中的客户端，则加载对应的BGP会话列表
        if (activeClientKey.value) {
            await loadBgpInstances();
        }
    });

    onDeactivated(() => {
        clearScheduledRouteRefresh();
        EventBus.off('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
    });

    const bgpRoutePagination = ref({
        current: 1,
        pageSize: 25,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => '共 ' + total + ' 条，每页 25 条',
        onChange: page => {
            bgpRoutePagination.value.current = page;
            loadInstanceRoutes();
        }
    });

    const bgpRouteColumns = [
        { title: 'Prefix', dataIndex: 'ip', key: 'ip', ellipsis: true, width: 120 },
        { title: 'Mask', dataIndex: 'mask', key: 'mask', ellipsis: true, width: 60 },
        { title: 'Next Hop', dataIndex: 'nextHop', key: 'nextHop', ellipsis: true, width: 120 },
        { title: 'AS Path', dataIndex: 'asPath', key: 'asPath', ellipsis: true, width: 180 },
        { title: 'RD', dataIndex: 'rd', key: 'rd', ellipsis: true, width: 100 },
        { title: 'Path ID', dataIndex: 'pathId', key: 'pathId', ellipsis: true, width: 100 },
        { title: 'Labels', dataIndex: 'labels', key: 'labels', ellipsis: true, width: 100 },
        { title: '解析', dataIndex: 'parseStatus', key: 'parseStatus', width: 90, align: 'center' },
        {
            title: 'TLV数量',
            dataIndex: 'routeTlvCount',
            key: 'routeTlvCount',
            width: 80,
            align: 'right',
            customRender: ({ text }) => text || 0
        },
        { title: 'Origin', dataIndex: 'origin', key: 'origin', ellipsis: true, width: 80 },
        { title: 'MED', dataIndex: 'med', key: 'med', ellipsis: true, width: 80 },
        { title: 'Path Status', dataIndex: 'pathStatusText', key: 'pathStatusText', ellipsis: true, width: 160 },
        {
            title: 'Reason',
            dataIndex: 'pathStatusReasonText',
            key: 'pathStatusReasonText',
            ellipsis: true,
            width: 180
        },
        { title: '详情', key: 'routeAction', fixed: 'right', width: 96, align: 'center' }
    ];

    watch(activeInstanceKey, newKey => {
        if (newKey) {
            bgpRoutePagination.value.current = 1;
            loadInstanceRoutes();
        }
    });

    watch(routeStateFilter, () => {
        bgpRoutePagination.value.current = 1;
        loadInstanceRoutes();
    });
</script>

<style scoped>
    .bmp-full-page {
        height: calc(100vh - 70px);
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

    .client-tab-label {
        display: block;
        max-width: 112px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .client-tabs,
    .bmp-inner-tabs {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        overflow: hidden;
    }

    .client-tabs :deep(.nn-tabs-content-holder),
    .client-tabs :deep(.nn-tabs-content),
    .client-tabs :deep(.nn-tabs-tabpane),
    .bmp-inner-tabs :deep(.nn-tabs-content-holder),
    .bmp-inner-tabs :deep(.nn-tabs-content),
    .bmp-inner-tabs :deep(.nn-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .bmp-inner-tabs :deep(.nn-tabs-tab) {
        padding: 8px 0 !important;
    }

    .client-tabs :deep(.nn-tabs-tab) {
        justify-content: flex-start;
        padding: 8px;
        text-align: left;
    }

    .client-tabs :deep(.nn-tabs-tab-button) {
        width: 100%;
    }

    .route-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px 16px;
        flex-wrap: wrap;
        margin-bottom: 8px;
    }

    .route-toolbar-query,
    .route-toolbar-status {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
    }

    .route-toolbar-query {
        flex: 1 1 auto;
    }

    .route-toolbar-status {
        flex: 0 0 auto;
        margin-left: auto;
    }

    .route-toolbar-status :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .bgp-peer-info-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding: 8px;
        background-color: var(--nn-color-bg-muted);
        border-radius: 4px;
    }

    .bgp-peer-info-header-text {
        margin-right: 8px;
        font-weight: 500;
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

    :deep(.route-stale-row) {
        color: var(--nn-color-text-stale);
        background-color: var(--nn-color-bg-stale);
    }

    :deep(.route-parse-warning-row) {
        background-color: var(--nn-color-bg-warning-subtle);
    }

    :deep(.route-parse-error-row) {
        background-color: var(--nn-color-bg-danger-subtle);
    }

    .detail-table {
        flex: 0 0 auto;
        min-width: 0;
    }

    .route-table,
    .route-table :deep(.ant-spin-nested-loading),
    .route-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .route-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .route-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .route-table :deep(.ant-table-container),
    .route-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .route-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .route-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .route-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .route-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
