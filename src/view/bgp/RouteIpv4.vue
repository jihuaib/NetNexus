<template>
    <div class="nn-container bgp-route-page" data-testid="bgp-route-ipv4-page">
        <nn-card :title="routeCardTitle" class="bgp-route-card">
            <template #extra>
                <nn-space class="workspace-header-actions">
                    <span class="workspace-save-state" :class="{ 'is-dirty': workspaceDirty }">
                        <span class="save-state-dot"></span>
                        {{ workspaceDirty ? '未保存' : '已保存' }}
                    </span>
                    <nn-button
                        size="small"
                        data-testid="bgp-ipv4-save-workspace-button"
                        :loading="workspaceSaving"
                        :disabled="workspaceLoading || routesGenerating || groupOperationLoading || exportLoading"
                        @click="saveWorkspace"
                    >
                        保存配置
                    </nn-button>
                    <nn-button
                        class="generate-route-button"
                        data-testid="bgp-generate-ipv4-routes-button"
                        type="primary"
                        size="small"
                        :loading="routesGenerating"
                        :disabled="workspaceLoading || workspaceSaving || groupOperationLoading || exportLoading"
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
                :disabled="workspaceBusy"
                :remove-group-disabled="!groupStatesKnown || groupStatesLoading"
                :generation-states="groupStates"
                :generation-state-error="groupStatesError"
                :export-enabled="true"
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

        <nn-card :title="`已生成${displayRouteTitle}路由列表`" class="bgp-route-list-card">
            <template #extra>
                <nn-space class="route-list-actions">
                    <nn-button v-if="!isDisplayLabelRoute" size="small" @click="showRouteViewsImport">
                        从 RouteViews 导入
                    </nn-button>
                    <nn-button
                        size="small"
                        data-testid="bgp-ipv4-export-mrt-button"
                        title="导出当前地址族的全部已生成路由"
                        :loading="exportLoading"
                        :disabled="workspaceBusy"
                        @click="exportRoutes()"
                    >
                        导出 MRT
                    </nn-button>
                    <nn-button
                        class="route-delete-all-button"
                        :disabled="!hasRoutes || deleteAllLoading"
                        :loading="deleteAllLoading"
                        danger
                        size="small"
                        @click="deleteAllRoutes"
                    >
                        <template #icon><DeleteOutlined /></template>
                        删除所有
                    </nn-button>
                </nn-space>
            </template>

            <div class="route-display-toolbar">
                <nn-radio-group
                    v-model:value="displayAddressFamily"
                    button-style="solid"
                    size="small"
                    class="route-display-switch"
                >
                    <nn-radio-button :value="BGP_ADDR_FAMILY.IPV4_UNC">IPv4-UNC</nn-radio-button>
                    <nn-radio-button :value="BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST">IPv4 Label</nn-radio-button>
                </nn-radio-group>
            </div>

            <nn-table
                data-testid="bgp-ipv4-route-table"
                :data-source="sentRoutes"
                :columns="routeColumns"
                :pagination="pagination"
                :loading="routeListLoading"
                size="small"
                :row-key="record => `${record.rd || '0:0'}-${record.pathId ?? 0}-${record.ip}-${record.mask}`"
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
                            <nn-button type="primary" danger size="small" @click="deleteSingleRoute(record)">
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
            v-model:open="routeViewsImportVisible"
            :address-family="BGP_ADDR_FAMILY.IPV4_UNC"
            @imported="refreshRoutes"
        />

        <BgpRouteDetailDrawer v-model:open="routeDetailVisible" :loading="routeDetailLoading" :route="routeDetail" />
    </div>
</template>

<script setup>
    import { onMounted, ref, computed, nextTick, watch } from 'vue';
    import RouteViewsImportModal from '../../components/RouteViewsImportModal.vue';
    import BgpRouteDetailDrawer from '../../components/BgpRouteDetailDrawer.vue';
    import BgpRouteTreeEditor from '../../components/BgpRouteTreeEditor.vue';
    import { getAttributeResultColumns, compileRouteRulePayload } from './bgpAttributeRules';
    import { getVisibleRouteSections } from './ipv4RouteSchema';
    import {
        createIpv4RouteGroup,
        restoreIpv4RouteWorkspace,
        serializeIpv4RouteWorkspace,
        findIpv4RouteGroupOverlap
    } from './ipv4RouteWorkspace';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { DeleteOutlined, FileSearchOutlined } from 'netnexus-ui/icons';
    import { useBgpRouteRuntime } from './useBgpRouteRuntime';

    import { BGP_ADDR_FAMILY, BGP_EVENT_PAGE_ID } from '../../const/bgpConst';
    import { FormValidator, createBgpIpv4RouteConfigValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'RouteIpv4'
    });

    const initialWorkspace = restoreIpv4RouteWorkspace(null);
    const routeGroups = ref(initialWorkspace.groups);
    const activeGroupId = ref(initialWorkspace.activeGroupId);
    const activeRouteGroup = computed(
        () => routeGroups.value.find(group => group.id === activeGroupId.value) || routeGroups.value[0]
    );
    const ipv4Data = computed({
        get: () => activeRouteGroup.value.config,
        set: value => {
            activeRouteGroup.value.config = value;
        }
    });
    const workspaceLoading = ref(true);
    const workspaceSaving = ref(false);
    const groupOperationLoading = ref(false);
    const exportLoading = ref(false);
    const groupStates = ref([]);
    const groupStatesLoading = ref(false);
    const groupStatesKnown = ref(false);
    const groupStatesError = ref('');
    let groupStatesRequestId = 0;
    const activeGroupState = computed(() =>
        groupStates.value.find(state => state.groupId === activeGroupId.value && Number(state.routeCount) > 0)
    );
    const savedWorkspaceSignature = ref('');
    const workspaceSignature = computed(() =>
        JSON.stringify(serializeIpv4RouteWorkspace(routeGroups.value, activeGroupId.value))
    );
    const workspaceDirty = computed(() => savedWorkspaceSignature.value !== workspaceSignature.value);
    const workspaceBusy = computed(
        () =>
            workspaceLoading.value ||
            workspaceSaving.value ||
            routesGenerating.value ||
            groupOperationLoading.value ||
            exportLoading.value
    );
    const treeEditorRef = ref(null);
    const validationErrors = ref({});

    const validator = new FormValidator(validationErrors);
    const editableFields = new Set(
        getVisibleRouteSections(ipv4Data.value).flatMap(section => section.fields.map(field => field.key))
    );
    const routeValidationRules = Object.fromEntries(
        Object.entries(createBgpIpv4RouteConfigValidationRules()).filter(([key]) => editableFields.has(key))
    );
    routeValidationRules.count.push({
        validator: value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0,
        message: '数量必须为正整数'
    });
    routeValidationRules.ipStep = [
        {
            validator: value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0,
            message: 'IP 步长必须为正整数'
        }
    ];
    validator.addRules(routeValidationRules);

    // 暴露给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    const sentRoutes = ref([]);
    const routeListLoading = ref(false);
    let routeListRequestId = 0;
    let routeDetailRequestId = 0;
    const displayAddressFamily = ref(BGP_ADDR_FAMILY.IPV4_UNC);
    const hasRoutes = computed(() => pagination.value.total > 0);
    const routesGenerating = ref(false);
    const deleteAllLoading = ref(false);
    const isLabelRoute = computed(() => ipv4Data.value.addressFamily === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST);
    const isDisplayLabelRoute = computed(() => displayAddressFamily.value === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST);
    const routeCardTitle = computed(() => (isLabelRoute.value ? 'IPv4 Label路由配置' : 'IPv4-UNC路由配置'));
    const displayRouteTitle = computed(() => (isDisplayLabelRoute.value ? 'IPv4 Label' : 'IPv4-UNC'));

    const selectRouteGroup = id => {
        activeGroupId.value = id;
        validator.clearErrors();
    };
    const addRouteGroup = () => {
        const group = createIpv4RouteGroup(`路由组 ${routeGroups.value.length + 1}`);
        routeGroups.value.push(group);
        selectRouteGroup(group.id);
    };
    const copyRouteGroup = (groupId = activeGroupId.value) => {
        const source = routeGroups.value.find(group => group.id === groupId);
        if (workspaceBusy.value || !source) return;
        const group = createIpv4RouteGroup(`${source.name || '路由组'} 副本`, source.config);
        routeGroups.value.push(group);
        selectRouteGroup(group.id);
    };
    const removeRouteGroup = async (groupId = activeGroupId.value) => {
        if (routeGroups.value.length <= 1 || workspaceBusy.value || !groupStatesKnown.value || groupStatesLoading.value)
            return;
        if (!routeGroups.value.some(group => group.id === groupId)) return;
        groupOperationLoading.value = true;
        try {
            if (groupStates.value.some(state => state.groupId === groupId && Number(state.routeCount) > 0)) {
                await withdrawGroupRoutes(groupId);
            }
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
    const persistWorkspace = async () => {
        const snapshot = serializeIpv4RouteWorkspace(routeGroups.value, activeGroupId.value);
        const result = await window.bgpApi.saveIpv4UNCRouteConfig(snapshot);
        if (result.status !== 'success') throw new Error(result.msg || '路由组配置保存失败');
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

    const routeViewsImportVisible = ref(false);
    const routeDetailVisible = ref(false);
    const routeDetailLoading = ref(false);
    const routeDetail = ref(null);

    const showRouteViewsImport = () => {
        routeViewsImportVisible.value = true;
    };

    const routeColumns = computed(() => {
        const columns = [
            {
                title: '前缀',
                dataIndex: 'ip',
                key: 'ip',
                width: 140
            }
        ];

        columns.push(...getAttributeResultColumns(ipv4Data.value));
        columns.push({
            title: '操作',
            key: 'action',
            width: 150,
            align: 'center'
        });

        return columns;
    });

    const pagination = ref({
        current: 1,
        pageSize: 25,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条，每页 25 条`
    });

    const refreshGroupStates = async () => {
        const requestId = ++groupStatesRequestId;
        groupStatesLoading.value = true;
        groupStatesKnown.value = false;
        groupStatesError.value = '';
        try {
            if (typeof window.bgpApi?.getRouteGroupStates !== 'function') {
                throw new Error('请重启应用后查看路由组生成状态');
            }
            const result = await window.bgpApi.getRouteGroupStates();
            if (requestId !== groupStatesRequestId) return;
            if (result?.status !== 'success') {
                throw new Error(result?.msg || '路由组生成状态读取失败');
            }
            groupStates.value = result.data?.groups || [];
            groupStatesKnown.value = true;
        } catch (error) {
            if (requestId === groupStatesRequestId) {
                groupStatesError.value = error.message.startsWith('请重启应用')
                    ? error.message
                    : `生成状态不可用，请启动 BGP 后刷新。${error.message}`;
            }
        } finally {
            if (requestId === groupStatesRequestId) groupStatesLoading.value = false;
        }
    };

    const withdrawGroupRoutes = async groupId => {
        if (typeof window.bgpApi?.withdrawRouteGroup !== 'function') {
            throw new Error('请重启应用后撤销路由组');
        }
        const result = await window.bgpApi.withdrawRouteGroup({ groupId });
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
        if (workspaceBusy.value) return;
        const state =
            groupId && groupStates.value.find(item => item.groupId === groupId && Number(item.routeCount) > 0);
        if (groupId && (!groupStatesKnown.value || groupStatesLoading.value || !state)) return;
        const addressFamily = Number(state ? state.addressFamily : displayAddressFamily.value);
        if (![BGP_ADDR_FAMILY.IPV4_UNC, BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST].includes(addressFamily)) return;
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
    onMounted(async () => {
        try {
            const savedConfig = await window.bgpApi.loadIpv4UNCRouteConfig();
            if (savedConfig.status !== 'success') throw new Error(savedConfig.msg || 'IPv4 路由组配置加载失败');
            const workspace = restoreIpv4RouteWorkspace(savedConfig.data);
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
        () => displayAddressFamily.value,
        async () => {
            pagination.value.current = 1;
            await refreshRoutes();
        }
    );

    const handleTableChange = (pag, _filters, _sorter) => {
        pagination.value.current = pag.current;
        refreshRoutes();
    };

    const refreshRoutes = async () => {
        const groupStatesRefresh = refreshGroupStates();
        const requestId = ++routeListRequestId;
        const addressFamily = displayAddressFamily.value;
        const current = pagination.value.current;
        const pageSize = pagination.value.pageSize;
        routeListLoading.value = true;

        try {
            const result = await window.bgpApi.getRoutes(addressFamily, current, pageSize);
            if (requestId !== routeListRequestId) {
                return;
            }

            if (result.status === 'success') {
                sentRoutes.value = result.data.list;
                pagination.value.total = result.data.total;
            } else {
                console.error(result.msg);
                sentRoutes.value = [];
                pagination.value.total = 0;
            }
        } catch (e) {
            if (requestId === routeListRequestId) {
                console.error(e);
                sentRoutes.value = [];
                pagination.value.total = 0;
            }
        } finally {
            await groupStatesRefresh;
            if (requestId === routeListRequestId) {
                routeListLoading.value = false;
            }
        }
    };

    useBgpRouteRuntime(BGP_EVENT_PAGE_ID.PAGE_ID_ROUTE_IPV4, {
        clearRoutes: clearRuntimeRoutes,
        refreshRoutes
    });

    const refreshRoutesAfterSingleDelete = async () => {
        const remainingTotal = Math.max(0, pagination.value.total - 1);
        const lastPage = Math.max(1, Math.ceil(remainingTotal / pagination.value.pageSize));
        pagination.value.current = Math.min(pagination.value.current, lastPage);
        await refreshRoutes();
    };

    const generateRoutes = async () => {
        if (workspaceBusy.value) {
            return;
        }

        try {
            const hasErrors = validator.validate(ipv4Data.value);
            if (hasErrors) {
                notify.error('请检查IPv4路由配置信息是否正确');
                return;
            }

            const overlap = findIpv4RouteGroupOverlap(routeGroups.value, activeGroupId.value);
            if (overlap) {
                notify.error(
                    `与路由组“${overlap.groupName}”的 ${overlap.prefix}/${overlap.mask} 前缀范围重叠，请调整后生成。`
                );
                return;
            }

            routesGenerating.value = true;
            await nextTick();

            const payload = compileRouteRulePayload(ipv4Data.value, activeRouteGroup.value);
            await persistWorkspace();

            const result = await window.bgpApi.generateIpv4Routes(payload);
            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                pagination.value.current = 1;
                if (displayAddressFamily.value !== payload.addressFamily) {
                    displayAddressFamily.value = payload.addressFamily;
                } else {
                    await refreshRoutes();
                }
            } else {
                notify.error(`${result.msg}`);
            }
        } catch (e) {
            notify.error(`IPv4路由生成失败: ${e.message}`);
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
            const result = await window.bgpApi.getRouteDetail(route.addressFamily || displayAddressFamily.value, {
                ip: route.ip,
                mask: route.mask,
                rd: route.rd,
                pathId: route.pathId
            });
            if (requestId !== routeDetailRequestId) return;

            if (result.status === 'success') {
                routeDetail.value = result.data;
            } else {
                routeDetailVisible.value = false;
                notify.error(`路由详情查询失败: ${result.msg}`);
            }
        } catch (e) {
            if (requestId !== routeDetailRequestId) return;
            routeDetailVisible.value = false;
            notify.error(`路由详情查询失败: ${e.message}`);
        } finally {
            if (requestId === routeDetailRequestId) {
                routeDetailLoading.value = false;
            }
        }
    };

    const deleteSingleRoute = async route => {
        try {
            const config = {
                prefix: route.ip,
                mask: parseInt(route.mask),
                rd: route.rd || '0:0',
                pathId: route.pathId ?? 0,
                count: 1,
                customAttr: route.customAttr || '',
                addressFamily: route.addressFamily
            };

            const result = await window.bgpApi.deleteIpv4Routes(config);

            if (result.status === 'success') {
                notify.success(`${result.msg}`);
                await refreshRoutesAfterSingleDelete();
            } else {
                notify.error(`路由删除失败: ${result.msg}`);
            }
        } catch (e) {
            notify.error(`路由删除失败: ${e.message}`);
        }
    };

    const deleteAllRoutes = async () => {
        try {
            // 显示确认对话框
            dialog.confirm({
                title: '确认删除',
                content: `确定要删除所有 ${pagination.value.total} 条${displayRouteTitle.value}路由吗？此操作不可恢复。`,
                okText: '确定',
                cancelText: '取消',
                okType: 'danger',
                onOk: async () => {
                    deleteAllLoading.value = true;
                    try {
                        // 调用新的批量删除API，只传地址族
                        const result = await window.bgpApi.deleteAllRoutesByFamily(displayAddressFamily.value);

                        if (result.status === 'success') {
                            notify.success(result.msg || '成功删除所有路由');
                            // 刷新路由列表
                            pagination.value.current = 1;
                            await refreshRoutes();
                        } else {
                            notify.error(`删除失败: ${result.msg}`);
                        }
                    } catch (e) {
                        notify.error(`批量删除失败: ${e.message}`);
                    } finally {
                        deleteAllLoading.value = false;
                    }
                }
            });
        } catch (e) {
            notify.error(`批量删除失败: ${e.message}`);
        }
    };
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
</style>
