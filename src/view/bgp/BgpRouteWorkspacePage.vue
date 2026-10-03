<template>
    <div class="nn-container bgp-route-page" :data-testid="`bgp-route-${profile.key}-page`">
        <nn-card :title="`${profile.title}路由配置`" class="bgp-route-card">
            <template #extra>
                <nn-space class="workspace-header-actions">
                    <span class="workspace-save-state" :class="{ 'is-dirty': workspaceDirty }">
                        <span class="save-state-dot"></span>
                        {{ workspaceDirty ? '未保存' : '已保存' }}
                    </span>
                    <nn-button
                        size="small"
                        :data-testid="`${testPrefix}-save-workspace-button`"
                        :loading="workspaceSaving"
                        :disabled="workspaceLoading || routesGenerating || groupOperationLoading || exportLoading"
                        @click="saveWorkspace"
                    >
                        保存配置
                    </nn-button>
                    <nn-button
                        class="generate-route-button"
                        type="primary"
                        size="small"
                        :data-testid="`${testPrefix}-generate-routes-button`"
                        :loading="routesGenerating"
                        :disabled="workspaceBusy"
                        @click="generateRoutes"
                    >
                        {{ activeGroupState ? '重新生成本组路由' : '生成本组路由' }}
                    </nn-button>
                </nn-space>
            </template>
            <BgpRouteTreeEditor
                ref="treeEditorRef"
                v-model:groups="routeGroups"
                :active-group-id="activeGroupId"
                :profile-key="profile.key"
                :test-prefix="testPrefix"
                :disabled="workspaceBusy"
                :remove-group-disabled="!groupStatesKnown || groupStatesLoading"
                :generation-states="groupStates"
                :generation-state-error="groupStatesError"
                :export-enabled="api.allowExport"
                :errors="validationErrors"
                @update:active-group-id="selectRouteGroup"
                @add-group="addRouteGroup"
                @copy-group="copyRouteGroup"
                @remove-group="removeRouteGroup"
                @withdraw-group="withdrawRouteGroup"
                @export-group="exportRouteGroup"
                @refresh-group-state="refreshGroupStates"
            />
        </nn-card>
        <nn-card :title="`已生成${api.routeLabel}路由列表`" class="bgp-route-list-card">
            <template #extra>
                <nn-space class="route-list-actions">
                    <nn-button v-if="api.allowImport" size="small" @click="routeViewsImportVisible = true">
                        从 RouteViews 导入
                    </nn-button>
                    <nn-button
                        v-if="api.allowExport"
                        size="small"
                        :data-testid="`${testPrefix}-export-mrt-button`"
                        title="导出当前地址族的全部已生成路由"
                        :loading="exportLoading"
                        :disabled="workspaceBusy"
                        @click="exportRoutes()"
                    >
                        导出 MRT
                    </nn-button>
                    <nn-button
                        class="route-delete-all-button"
                        :disabled="!hasRoutes || workspaceBusy"
                        :loading="deleteAllLoading"
                        danger
                        size="small"
                        @click="deleteAllRoutes"
                    >
                        <template #icon><DeleteOutlined /></template>
                        {{ isMvpn ? '删除当前类型全部' : '删除所有' }}
                    </nn-button>
                </nn-space>
            </template>
            <template v-if="isMvpn">
                <nn-tabs v-model:active-key="activeMvpnTab" type="card" class="mvpn-route-tabs">
                    <nn-tab-pane v-for="type in mvpnRouteTypes" :key="type.value" :tab="type.label">
                        <nn-table
                            :data-testid="`${testPrefix}-route-table-${type.value}`"
                            :data-source="type.value === activeMvpnTab ? sentRoutes : []"
                            :columns="getTableColumns(type.value)"
                            :pagination="pagination"
                            :loading="routeListLoading"
                            size="small"
                            :row-key="routeRowKey"
                            :scroll="{ x: 'max-content', y: '100%' }"
                            class="bgp-route-table"
                            @change="handleTableChange"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <nn-space>
                                        <nn-button size="small" @click="showRouteDetail(record)">
                                            <template #icon><FileSearchOutlined /></template>
                                            详情
                                        </nn-button>
                                        <nn-button
                                            type="primary"
                                            danger
                                            size="small"
                                            :disabled="workspaceBusy"
                                            @click="deleteSingleRoute(record)"
                                        >
                                            <template #icon><DeleteOutlined /></template>
                                            删除
                                        </nn-button>
                                    </nn-space>
                                </template>
                            </template>
                        </nn-table>
                    </nn-tab-pane>
                </nn-tabs>
            </template>
            <nn-table
                v-else
                :data-testid="`${testPrefix}-route-table`"
                :data-source="sentRoutes"
                :columns="routeColumns"
                :pagination="pagination"
                :loading="routeListLoading"
                size="small"
                :row-key="routeRowKey"
                :scroll="{ x: 'max-content', y: '100%' }"
                class="bgp-route-table"
                @change="handleTableChange"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'action'">
                        <nn-space>
                            <nn-button size="small" @click="showRouteDetail(record)">
                                <template #icon><FileSearchOutlined /></template>
                                详情
                            </nn-button>
                            <nn-button
                                type="primary"
                                danger
                                size="small"
                                :disabled="workspaceBusy"
                                @click="deleteSingleRoute(record)"
                            >
                                <template #icon><DeleteOutlined /></template>
                                删除
                            </nn-button>
                        </nn-space>
                    </template>
                    <template v-else-if="column.key === 'ip'">
                        <div>{{ record.ip }}/{{ record.mask }}</div>
                    </template>
                </template>
            </nn-table>
        </nn-card>
        <RouteViewsImportModal
            v-if="api.allowImport"
            v-model:open="routeViewsImportVisible"
            :address-family="profile.addressFamily"
            @imported="refreshRoutes"
        />
        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>
<script setup>
    import { computed, nextTick, onMounted, ref, watch } from 'vue';
    import { DeleteOutlined, FileSearchOutlined } from 'netnexus-ui/icons';
    import BgpRouteTreeEditor from '../../components/BgpRouteTreeEditor.vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import RouteViewsImportModal from '../../components/RouteViewsImportModal.vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { BGP_ADDR_FAMILY, BGP_EVENT_PAGE_ID, BGP_MVPN_ROUTE_TYPE } from '../../const/bgpConst';
    import { useBgpRouteRuntime } from './useBgpRouteRuntime';
    import {
        getRouteProfile,
        createRouteGroup,
        restoreRouteWorkspace,
        serializeRouteWorkspace,
        compileRouteTreePayload,
        validateRouteConfig,
        findRouteGroupOverlap,
        getRouteResultColumns
    } from './bgpRouteWorkspace';

    defineOptions({ name: 'BgpRouteWorkspacePage' });
    const props = defineProps({ profileKey: { type: String, required: true } });
    const pageApis = {
        ipv6: {
            load: 'loadIpv6UNCRouteConfig',
            save: 'saveIpv6UNCRouteConfig',
            generate: 'generateIpv6Routes',
            delete: 'deleteIpv6Routes',
            pageId: BGP_EVENT_PAGE_ID.PAGE_ID_ROUTE_IPV6,
            routeLabel: 'IPv6',
            allowImport: true,
            allowExport: true
        },
        'ipv4-qp': {
            load: 'loadIpv4QpRouteConfig',
            save: 'saveIpv4QpRouteConfig',
            generate: 'generateIpv4QpRoutes',
            delete: 'deleteIpv4QpRoutes',
            pageId: BGP_EVENT_PAGE_ID.PAGE_ID_ROUTE_IPV4_QP,
            routeLabel: 'IPv4-QP'
        },
        'ipv6-qp': {
            load: 'loadIpv6QpRouteConfig',
            save: 'saveIpv6QpRouteConfig',
            generate: 'generateIpv6QpRoutes',
            delete: 'deleteIpv6QpRoutes',
            pageId: BGP_EVENT_PAGE_ID.PAGE_ID_ROUTE_IPV6_QP,
            routeLabel: 'IPv6-QP'
        },
        mvpn: {
            load: 'loadIpv4MvpnRouteConfig',
            save: 'saveIpv4MvpnRouteConfig',
            generate: 'generateIpv4MvpnRoutes',
            delete: 'deleteIpv4MvpnRoutes',
            pageId: BGP_EVENT_PAGE_ID.PAGE_ID_ROUTE_MVPN,
            routeLabel: 'MVPN'
        }
    };
    const profile = getRouteProfile(props.profileKey);
    const api = pageApis[profile.key];
    const testPrefix = profile.testPrefix;
    const isMvpn = profile.addressFamily === BGP_ADDR_FAMILY.IPV4_MVPN;
    const isQp = [BGP_ADDR_FAMILY.IPV4_QP, BGP_ADDR_FAMILY.IPV6_QP].includes(profile.addressFamily);
    const initialWorkspace = restoreRouteWorkspace(profile, null);
    const routeGroups = ref(initialWorkspace.groups);
    const activeGroupId = ref(initialWorkspace.activeGroupId);
    const activeRouteGroup = computed(
        () => routeGroups.value.find(group => group.id === activeGroupId.value) || routeGroups.value[0]
    );
    const activeConfig = computed(() => activeRouteGroup.value.config);
    const workspaceLoading = ref(true);
    const workspaceSaving = ref(false);
    const groupOperationLoading = ref(false);
    const routesGenerating = ref(false);
    const deleteAllLoading = ref(false);
    const routeDeleteLoading = ref(false);
    const exportLoading = ref(false);
    const groupStates = ref([]);
    const groupStatesLoading = ref(false);
    const groupStatesKnown = ref(false);
    const groupStatesError = ref('');
    const treeEditorRef = ref(null);
    const validationErrors = ref({});
    const savedWorkspaceSignature = ref('');
    const workspaceSignature = computed(() =>
        JSON.stringify(serializeRouteWorkspace(profile, routeGroups.value, activeGroupId.value))
    );
    const workspaceDirty = computed(() => savedWorkspaceSignature.value !== workspaceSignature.value);
    const workspaceBusy = computed(
        () =>
            workspaceLoading.value ||
            workspaceSaving.value ||
            groupOperationLoading.value ||
            routesGenerating.value ||
            deleteAllLoading.value ||
            routeDeleteLoading.value ||
            exportLoading.value
    );
    const activeGroupState = computed(() =>
        groupStates.value.find(state => state.groupId === activeGroupId.value && Number(state.routeCount) > 0)
    );
    const displayAddressFamily = ref(profile.addressFamily);
    const activeMvpnTab = ref(BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD);
    const mvpnRouteTypes = [
        { label: 'Intra-AS I-PMSI A-D (Type 1)', value: BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD },
        { label: 'Inter-AS I-PMSI A-D (Type 2)', value: BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD },
        { label: 'S-PMSI A-D (Type 3)', value: BGP_MVPN_ROUTE_TYPE.S_PMSI_AD },
        { label: 'Leaf A-D (Type 4)', value: BGP_MVPN_ROUTE_TYPE.LEAF_AD },
        { label: 'Source Active A-D (Type 5)', value: BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD },
        { label: 'Shared Tree Join (Type 6)', value: BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN },
        { label: 'Source Tree Join (Type 7)', value: BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN }
    ];
    const sentRoutes = ref([]);
    const routeListLoading = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);
    const routeViewsImportVisible = ref(false);
    const pagination = ref({
        current: 1,
        pageSize: 25,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条，每页 25 条`
    });
    const hasRoutes = computed(() => pagination.value.total > 0);
    let groupStatesRequestId = 0;
    let routeListRequestId = 0;
    let routeDetailRequestId = 0;
    const apiCall = (name, ...args) => {
        if (typeof window.bgpApi?.[name] !== 'function') throw new Error('请重启应用后使用路由组配置');
        return window.bgpApi[name](...args);
    };
    const getTableColumns = routeType => [
        ...getRouteResultColumns({
            ...activeConfig.value,
            addressFamily: displayAddressFamily.value,
            ...(isMvpn ? { routeType } : {})
        }),
        { title: '操作', key: 'action', width: 150, align: 'center' }
    ];
    const routeColumns = computed(() => getTableColumns());
    const routeIdentity = route => {
        if (isMvpn)
            return {
                rd: route.rd,
                routeType: route.routeType,
                sourceAs: route.sourceAs,
                sourceIp: route.sourceIp,
                groupIp: route.groupIp,
                originatingRouterIp: route.originatingRouterIp,
                leafRouteKey: route.leafRouteKey,
                pathId: route.pathId ?? 0
            };
        return {
            ip: route.ip,
            mask: route.mask,
            rd: route.rd,
            ...(isQp ? { dqpn: route.dqpn } : {}),
            pathId: route.pathId ?? 0
        };
    };
    const routeRowKey = route => `${route.routeKey || ''}:${JSON.stringify(routeIdentity(route))}`;
    const selectRouteGroup = id => {
        activeGroupId.value = id;
        validationErrors.value = {};
    };
    const addRouteGroup = () => {
        if (workspaceBusy.value) return;
        const group = createRouteGroup(profile, `路由组 ${routeGroups.value.length + 1}`);
        routeGroups.value.push(group);
        selectRouteGroup(group.id);
    };
    const copyRouteGroup = (groupId = activeGroupId.value) => {
        const source = routeGroups.value.find(group => group.id === groupId);
        if (workspaceBusy.value || !source) return;
        const group = createRouteGroup(profile, `${source.name || '路由组'} 副本`, source.config);
        routeGroups.value.push(group);
        selectRouteGroup(group.id);
    };
    const persistWorkspace = async () => {
        const snapshot = serializeRouteWorkspace(profile, routeGroups.value, activeGroupId.value);
        const result = await apiCall(api.save, snapshot);
        if (result?.status !== 'success') throw new Error(result?.msg || '路由组配置保存失败');
        savedWorkspaceSignature.value = JSON.stringify(snapshot);
    };
    const saveWorkspace = async () => {
        if (workspaceBusy.value) return;
        workspaceSaving.value = true;
        try {
            await persistWorkspace();
            notify.success('路由组配置已保存');
        } catch (error) {
            notify.error(error.message);
        } finally {
            workspaceSaving.value = false;
        }
    };
    const refreshGroupStates = async () => {
        const requestId = ++groupStatesRequestId;
        groupStatesLoading.value = true;
        groupStatesKnown.value = false;
        groupStatesError.value = '';
        try {
            const result = await apiCall('getRouteGroupStates');
            if (requestId !== groupStatesRequestId) return;
            if (result?.status !== 'success') throw new Error(result?.msg || '路由组生成状态读取失败');
            groupStates.value = result.data?.groups || [];
            groupStatesKnown.value = true;
        } catch (error) {
            if (requestId === groupStatesRequestId)
                groupStatesError.value = error.message.startsWith('请重启应用')
                    ? error.message
                    : `生成状态不可用，请启动 BGP 后刷新。${error.message}`;
        } finally {
            if (requestId === groupStatesRequestId) groupStatesLoading.value = false;
        }
    };
    const refreshRoutes = async () => {
        const groupStatesRefresh = refreshGroupStates();
        const requestId = ++routeListRequestId;
        const addressFamily = displayAddressFamily.value;
        const current = pagination.value.current;
        const pageSize = pagination.value.pageSize;
        const filters = isMvpn ? { routeType: activeMvpnTab.value } : undefined;
        routeListLoading.value = true;
        try {
            const result = filters
                ? await apiCall('getRoutes', addressFamily, current, pageSize, filters)
                : await apiCall('getRoutes', addressFamily, current, pageSize);
            if (requestId !== routeListRequestId) return;
            if (result?.status !== 'success') throw new Error(result?.msg || '路由列表读取失败');
            sentRoutes.value = result.data?.list || [];
            pagination.value.total = Number(result.data?.total) || 0;
        } catch (error) {
            if (requestId === routeListRequestId) {
                console.error(error.message);
                sentRoutes.value = [];
                pagination.value.total = 0;
            }
        } finally {
            await groupStatesRefresh;
            if (requestId === routeListRequestId) routeListLoading.value = false;
        }
    };
    const withdrawGroupRoutes = async groupId => {
        const result = await apiCall('withdrawRouteGroup', { groupId });
        if (result?.status !== 'success') throw new Error(result?.msg || '路由组撤销失败');
        await refreshRoutes();
        notify.success(`已撤销本组 ${Number(result.data?.deleted) || 0} 条路由`);
    };
    const withdrawRouteGroup = async (groupId = activeGroupId.value) => {
        if (
            workspaceBusy.value ||
            !groupStatesKnown.value ||
            groupStatesLoading.value ||
            !groupStates.value.some(state => state.groupId === groupId && Number(state.routeCount) > 0)
        )
            return;
        groupOperationLoading.value = true;
        try {
            await withdrawGroupRoutes(groupId);
        } catch (error) {
            notify.error(`本组路由撤销失败：${error.message}`);
            await refreshGroupStates();
        } finally {
            groupOperationLoading.value = false;
        }
    };
    const exportRoutes = async groupId => {
        if (!api.allowExport || workspaceBusy.value) return;
        const state =
            groupId && groupStates.value.find(item => item.groupId === groupId && Number(item.routeCount) > 0);
        if (groupId && (!groupStatesKnown.value || groupStatesLoading.value || !state)) return;
        const addressFamily = Number(state ? state.addressFamily : displayAddressFamily.value);
        if (addressFamily !== BGP_ADDR_FAMILY.IPV6_UNC) return;
        exportLoading.value = true;
        try {
            if (typeof window.bgpApi?.exportMrt !== 'function') throw new Error('请重启应用后使用 MRT 导出');
            const result = await window.bgpApi.exportMrt({ addressFamily, ...(groupId ? { groupId } : {}) });
            if (result?.data?.canceled) return;
            if (result?.status !== 'success') throw new Error(result?.msg || 'MRT 导出失败');
            notify.success(`已导出 ${Number(result.data?.routeCount) || 0} 条路由到 ${result.data?.filePath}`);
        } catch (error) {
            notify.error(`MRT 导出失败：${error.message}`);
        } finally {
            exportLoading.value = false;
        }
    };
    const exportRouteGroup = groupId => exportRoutes(groupId);
    const removeRouteGroup = async (groupId = activeGroupId.value) => {
        if (routeGroups.value.length <= 1 || workspaceBusy.value || !groupStatesKnown.value || groupStatesLoading.value)
            return;
        if (!routeGroups.value.some(group => group.id === groupId)) return;
        groupOperationLoading.value = true;
        try {
            if (groupStates.value.some(state => state.groupId === groupId && Number(state.routeCount) > 0))
                await withdrawGroupRoutes(groupId);
            const index = routeGroups.value.findIndex(group => group.id === groupId);
            routeGroups.value.splice(index, 1);
            selectRouteGroup(routeGroups.value[Math.min(index, routeGroups.value.length - 1)].id);
        } catch (error) {
            notify.error(`移除路由组失败：${error.message}`);
            await refreshGroupStates();
        } finally {
            groupOperationLoading.value = false;
        }
    };
    const clearRuntimeRoutes = () => {
        routeListRequestId += 1;
        routeDetailRequestId += 1;
        sentRoutes.value = [];
        routeListLoading.value = false;
        pagination.value.current = 1;
        pagination.value.total = 0;
        routeDetailVisible.value = false;
        routeDetailLoading.value = false;
        routeDetail.value = null;
        void refreshGroupStates();
    };
    useBgpRouteRuntime(api.pageId, { clearRoutes: clearRuntimeRoutes, refreshRoutes });
    onMounted(async () => {
        try {
            const savedConfig = await apiCall(api.load);
            if (savedConfig?.status !== 'success') throw new Error(savedConfig?.msg || '路由组配置加载失败');
            const workspace = restoreRouteWorkspace(profile, savedConfig.data);
            routeGroups.value = workspace.groups;
            activeGroupId.value = workspace.activeGroupId;
            savedWorkspaceSignature.value = workspaceSignature.value;
        } catch (error) {
            notify.error(error.message);
        } finally {
            workspaceLoading.value = false;
        }
    });
    watch(
        () => [displayAddressFamily.value, activeMvpnTab.value],
        async () => {
            pagination.value.current = 1;
            sentRoutes.value = [];
            if (!routesGenerating.value) await refreshRoutes();
        }
    );
    const handleTableChange = (pag, _filters, _sorter) => {
        pagination.value.current = pag.current;
        void refreshRoutes();
    };
    const refreshRoutesAfterSingleDelete = async () => {
        const lastPage = Math.max(1, Math.ceil(Math.max(0, pagination.value.total - 1) / pagination.value.pageSize));
        pagination.value.current = Math.min(pagination.value.current, lastPage);
        await refreshRoutes();
    };
    const generateRoutes = async () => {
        if (workspaceBusy.value) return;
        try {
            validationErrors.value = validateRouteConfig(activeConfig.value);
            if (Object.keys(validationErrors.value).length) {
                notify.error('请检查路由配置信息是否正确');
                return;
            }
            const overlap = findRouteGroupOverlap(routeGroups.value, activeGroupId.value);
            if (overlap) {
                notify.error(`与路由组“${overlap.groupName}”的 NLRI 路由键重叠，请调整后生成。`);
                return;
            }
            routesGenerating.value = true;
            await nextTick();
            const payload = compileRouteTreePayload(activeConfig.value, activeRouteGroup.value);
            await persistWorkspace();
            const result = await apiCall(api.generate, payload);
            if (result?.status !== 'success') throw new Error(result?.msg || '路由生成失败');
            notify.success(result.msg || '路由生成成功');
            pagination.value.current = 1;
            displayAddressFamily.value = payload.addressFamily;
            if (isMvpn) activeMvpnTab.value = Number(payload.routeType);
            await nextTick();
            await refreshRoutes();
        } catch (error) {
            notify.error(`${api.routeLabel}路由生成失败：${error.message}`);
        } finally {
            if (routesGenerating.value) await refreshGroupStates();
            routesGenerating.value = false;
        }
    };
    const showRouteDetail = async route => {
        const requestId = ++routeDetailRequestId;
        routeDetailVisible.value = true;
        routeDetailLoading.value = true;
        routeDetail.value = null;
        try {
            const result = await apiCall(
                'getRouteDetail',
                route.addressFamily || displayAddressFamily.value,
                routeIdentity(route)
            );
            if (requestId !== routeDetailRequestId) return;
            if (result?.status !== 'success') throw new Error(result?.msg || '路由详情查询失败');
            routeDetail.value = result.data;
        } catch (error) {
            if (requestId !== routeDetailRequestId) return;
            routeDetailVisible.value = false;
            notify.error(`路由详情查询失败：${error.message}`);
        } finally {
            if (requestId === routeDetailRequestId) routeDetailLoading.value = false;
        }
    };
    const deleteSingleRoute = async route => {
        if (workspaceBusy.value) return;
        routeDeleteLoading.value = true;
        try {
            const config = {
                ...routeIdentity(route),
                addressFamily: route.addressFamily || displayAddressFamily.value,
                count: 1,
                ...(isMvpn ? {} : { prefix: route.ip, mask: Number(route.mask) }),
                ...(isQp ? { startDqpn: route.dqpn, bsid: route.nextHop || '' } : {})
            };
            const result = await apiCall(api.delete, config);
            if (result?.status !== 'success') throw new Error(result?.msg || '路由删除失败');
            notify.success(result.msg || '路由删除成功');
            await refreshRoutesAfterSingleDelete();
        } catch (error) {
            notify.error(`路由删除失败：${error.message}`);
        } finally {
            routeDeleteLoading.value = false;
        }
    };
    const deleteAllRoutes = () => {
        if (workspaceBusy.value || !hasRoutes.value) return;
        const filters = isMvpn ? { routeType: activeMvpnTab.value } : undefined;
        const addressFamily = displayAddressFamily.value;
        const label = isMvpn ? '当前类型的 MVPN' : api.routeLabel;
        dialog.confirm({
            title: '确认删除',
            content: `确定要删除全部 ${pagination.value.total} 条${label}路由吗？此操作不可恢复。`,
            okText: '确定',
            cancelText: '取消',
            okType: 'danger',
            onOk: async () => {
                if (workspaceBusy.value) return;
                deleteAllLoading.value = true;
                try {
                    const result = filters
                        ? await apiCall('deleteAllRoutesByFamily', addressFamily, filters)
                        : await apiCall('deleteAllRoutesByFamily', addressFamily);
                    if (result?.status !== 'success') throw new Error(result?.msg || '批量删除失败');
                    notify.success(result.msg || '成功删除所有路由');
                    pagination.value.current = 1;
                    await refreshRoutes();
                } catch (error) {
                    notify.error(`批量删除失败：${error.message}`);
                } finally {
                    deleteAllLoading.value = false;
                }
            }
        });
    };
    defineExpose({
        clearValidationErrors: () => {
            validationErrors.value = {};
        }
    });
</script>
<style scoped>
    .bgp-route-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .bgp-route-card {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-list-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-card :deep(.nn-card-body) {
        min-height: 0;
        overflow: visible;
        display: flex;
        flex-direction: column;
        padding: 0 !important;
    }

    .bgp-route-list-card :deep(.nn-card-body) {
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 8px 10px !important;
    }

    .workspace-header-actions {
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .workspace-save-state {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-right: 4px;
        color: var(--nn-color-text-secondary);
        font-size: 11px;
        white-space: nowrap;
    }

    .save-state-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--nn-color-text-success);
    }

    .workspace-save-state.is-dirty .save-state-dot {
        background: var(--nn-color-text-warning);
    }

    .route-list-actions {
        justify-content: flex-end;
    }

    .route-display-toolbar {
        flex: 0 0 auto;
        padding-bottom: 8px;
    }

    .route-delete-all-button:disabled,
    .route-delete-all-button.nn-button-disabled {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
        opacity: 1 !important;
    }

    .route-delete-all-button:disabled:hover,
    .route-delete-all-button.nn-button-disabled:hover,
    .route-delete-all-button:disabled:focus,
    .route-delete-all-button.nn-button-disabled:focus {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
    }

    .route-display-switch {
        display: inline-flex;
        flex-shrink: 0;
        flex-wrap: nowrap;
        gap: 0;
        white-space: nowrap;
    }

    .route-display-switch :deep(.nn-radio-button) {
        min-width: 104px;
        text-align: center;
    }

    .bgp-route-table,
    .bgp-route-table :deep(.nn-spin-nested-loading),
    .bgp-route-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .bgp-route-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-route-table :deep(.nn-table-container),
    .bgp-route-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .bgp-route-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .bgp-route-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .bgp-route-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .bgp-route-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    @media (max-width: 720px) {
        .bgp-route-page {
            overflow-y: auto;
        }

        .bgp-route-card :deep(.nn-card-head-wrapper) {
            flex-wrap: wrap;
            gap: 8px;
        }

        .workspace-header-actions {
            gap: 6px;
        }

        .workspace-save-state {
            display: none;
        }

        .bgp-route-list-card {
            flex: 0 0 360px;
        }
    }
    .mvpn-route-tabs,
    .mvpn-route-tabs :deep(.nn-tabs-content-holder),
    .mvpn-route-tabs :deep(.nn-tabs-content),
    .mvpn-route-tabs :deep(.nn-tabs-tabpane-active) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .mvpn-route-tabs :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
    }
</style>
