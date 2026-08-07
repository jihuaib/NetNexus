<template>
    <div class="nn-container adaptive-list-page" data-testid="bmp-config-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="BMP服务器配置">
                    <nn-form :model="bmpConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBmp">
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="服务端端口" name="port">
                                    <nn-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <nn-input
                                            v-model:value="bmpConfig.port"
                                            data-testid="bmp-port-input"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row :gutter="12">
                            <nn-col :span="12">
                                <nn-form-item label="v4 TLV格式" name="bmpV4TlvDraft">
                                    <nn-radio-group v-model:value="bmpConfig.bmpV4TlvDraft" button-style="solid">
                                        <nn-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_20">draft-20</nn-radio-button>
                                        <nn-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_19">draft-19</nn-radio-button>
                                    </nn-radio-group>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="12">
                                <nn-form-item label="Path TLV类型" name="pathMarkingTlvType">
                                    <nn-tooltip
                                        :title="validationErrors.pathMarkingTlvType"
                                        :open="!!validationErrors.pathMarkingTlvType"
                                    >
                                        <nn-input-number
                                            v-model:value="bmpConfig.pathMarkingTlvType"
                                            :min="1"
                                            :max="16383"
                                            :precision="0"
                                            style="width: 100%"
                                            :status="validationErrors.pathMarkingTlvType ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="持久化路由" name="persistenceEnabled">
                                    <nn-checkbox v-model:checked="bmpConfig.persistenceEnabled" disabled>
                                        SQLite RIB
                                    </nn-checkbox>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <nn-space>
                                <nn-button
                                    type="primary"
                                    html-type="submit"
                                    data-testid="bmp-start-button"
                                    :loading="serverLoading"
                                    :disabled="serverRunning || serverStopping"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button
                                    type="primary"
                                    danger
                                    data-testid="bmp-stop-button"
                                    :loading="serverStopping"
                                    :disabled="!serverRunning || serverStopping"
                                    @click="stopBmp"
                                >
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </nn-form-item>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <!-- BMP客户端列表 -->
        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card title="BMP客户端列表" class="adaptive-list-card">
                    <div>
                        <nn-table
                            class="adaptive-table"
                            data-testid="bmp-client-table"
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="getClientKey"
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ x: 'max-content', y: '100%' }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'bmpVersion'">
                                    <nn-tag :color="record.bmpVersion === 4 ? 'blue' : 'default'">
                                        {{ getBmpVersionName(record.bmpVersion) }}
                                    </nn-tag>
                                </template>
                                <template v-else-if="column.key === 'bmpV4TlvDraft'">
                                    <nn-tag>{{ getBmpV4TlvDraftName(record.bmpV4TlvDraft) }}</nn-tag>
                                </template>
                                <template v-else-if="column.key === 'tlvCount'">
                                    {{ getClientTlvCount(record) }}
                                </template>
                                <template v-else-if="column.key === 'connectionState'">
                                    <nn-tag :color="record.isOnline ? 'green' : 'default'">
                                        {{ record.isOnline ? '在线' : '已断开' }}
                                    </nn-tag>
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <nn-space size="small">
                                        <nn-button
                                            type="link"
                                            data-testid="bmp-client-monitor-button"
                                            :loading="isMonitorOpening(record)"
                                            :disabled="!canOpenClientMonitor(record)"
                                            @click="openClientMonitor(record)"
                                        >
                                            Client 监控
                                        </nn-button>
                                        <nn-button
                                            type="link"
                                            data-testid="bmp-client-detail-button"
                                            @click="viewClientDetails(record)"
                                        >
                                            详情
                                        </nn-button>
                                        <nn-tooltip :title="getClientDeleteDisabledReason(record)">
                                            <span>
                                                <nn-popconfirm
                                                    title="确认删除该客户端的全部数据？"
                                                    description="将删除数据库和内存中的所有关联数据，此操作不可恢复。"
                                                    ok-text="确认删除"
                                                    cancel-text="取消"
                                                    :disabled="!canDeleteClientData(record)"
                                                    @confirm="deleteClientData(record)"
                                                >
                                                    <nn-button
                                                        type="link"
                                                        danger
                                                        data-testid="bmp-client-delete-data-button"
                                                        :loading="deletingClientKey === getClientKey(record)"
                                                        :disabled="
                                                            !canDeleteClientData(record) ||
                                                            deletingClientKey === getClientKey(record)
                                                        "
                                                    >
                                                        删除数据
                                                    </nn-button>
                                                </nn-popconfirm>
                                            </span>
                                        </nn-tooltip>
                                    </nn-space>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, onActivated, onDeactivated, watch } from 'vue';
    import { notify } from '../../utils/notify';
    import { FormValidator, createBmpConfigValidationRules } from '../../utils/validationCommon';
    import {
        DEFAULT_VALUES,
        BMP_EVENT_PAGE_ID,
        BMP_V4_TLV_DRAFT,
        getBmpVersionName,
        getBmpV4TlvDraftName,
        getDefaultPathMarkingTlvType
    } from '../../const/bmpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'BmpConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const bmpConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_BMP_PORT,
        bmpV4TlvDraft: DEFAULT_VALUES.DEFAULT_BMP_V4_TLV_DRAFT,
        pathMarkingTlvType: getDefaultPathMarkingTlvType(DEFAULT_VALUES.DEFAULT_BMP_V4_TLV_DRAFT),
        persistenceEnabled: true
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);
    const serverStopping = ref(false);

    const getClientTlvCount = record => {
        return (record.rawTlvs || []).length + (record.terminationTlvs || []).length;
    };

    const getClientTransportKey = record =>
        `${record?.localIp || ''}|${record?.localPort || ''}|${record?.remoteIp || ''}|${record?.remotePort || ''}`;

    const getClientKey = record => {
        const sourceId = record?.persistentSourceId || record?.sourceId;
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(record)}`;
    };

    const normalizeBmpV4TlvDraft = draft => {
        return Number(draft) === BMP_V4_TLV_DRAFT.DRAFT_19 ? BMP_V4_TLV_DRAFT.DRAFT_19 : BMP_V4_TLV_DRAFT.DRAFT_20;
    };

    const normalizePathMarkingTlvType = (value, draft) => {
        const type = Number(value);
        return Number.isInteger(type) && type >= 1 && type <= 0x3fff ? type : getDefaultPathMarkingTlvType(draft);
    };

    // Initiation messages list
    const clientList = ref([]);
    const deletingClientKey = ref('');
    const openingMonitorKey = ref('');
    const canOpenMonitorWindow = computed(() => typeof window.windowApi?.openMonitor === 'function');
    const clientColumns = [
        {
            title: '客户端IP',
            dataIndex: 'remoteIp',
            key: 'remoteIp',
            ellipsis: true
        },
        {
            title: '客户端端口',
            dataIndex: 'remotePort',
            key: 'remotePort',
            ellipsis: true
        },
        {
            title: 'BMP版本',
            dataIndex: 'bmpVersion',
            key: 'bmpVersion',
            width: 90
        },
        {
            title: 'v4 TLV',
            dataIndex: 'bmpV4TlvDraft',
            key: 'bmpV4TlvDraft',
            width: 90
        },
        {
            title: '系统名称',
            dataIndex: 'sysName',
            key: 'sysName',
            ellipsis: true
        },
        {
            title: '系统描述',
            dataIndex: 'sysDesc',
            key: 'sysDesc',
            ellipsis: true
        },
        {
            title: '接收时间',
            dataIndex: 'receivedAt',
            key: 'receivedAt',
            ellipsis: true,
            customRender: ({ text }) => {
                if (!text) return '';
                const date = new Date(text);
                return date.toLocaleString();
            }
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 90,
            align: 'right'
        },
        {
            title: '状态',
            key: 'connectionState',
            width: 80,
            align: 'center'
        },
        {
            title: '操作',
            key: 'action',
            width: 280,
            align: 'center'
        }
    ];

    const validationErrors = ref({
        port: '',
        pathMarkingTlvType: ''
    });

    let validator = new FormValidator(validationErrors);
    validator.addRules(createBmpConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const startBmp = async () => {
        const hasErrors = validator.validate(bmpConfig.value);
        if (hasErrors) {
            notify.error('请检查配置信息是否正确');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(bmpConfig.value));
            payload.bmpV4TlvDraft = normalizeBmpV4TlvDraft(payload.bmpV4TlvDraft);
            payload.pathMarkingTlvType = normalizePathMarkingTlvType(payload.pathMarkingTlvType, payload.bmpV4TlvDraft);
            const saveResult = await window.bmpApi.saveBmpConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.bmpApi.startBmp(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                await loadClientList();
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'BMP服务器启动失败');
            }
        } catch (error) {
            notify.error(`BMP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopBmp = async () => {
        if (serverStopping.value) {
            return;
        }

        serverStopping.value = true;
        try {
            const result = await window.bmpApi.stopBmp();
            if (result.status === 'success') {
                serverRunning.value = false;
                clientList.value = [];
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'BMP服务器停止失败');
            }
        } catch (error) {
            notify.error(`BMP服务器停止出错: ${error.message}`);
        } finally {
            serverStopping.value = false;
        }
    };

    const viewClientDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `BMP客户端信息: ${record.remoteIp}:${record.remotePort}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
        });

    const isValidMonitorClientKey = clientKey => {
        if (typeof clientKey !== 'string' || clientKey.length === 0 || clientKey.length > 512) {
            return false;
        }
        if (hasControlCharacter(clientKey)) {
            return false;
        }
        if (clientKey.startsWith('source:')) {
            return /^[0-9a-f]{64}$/i.test(clientKey.slice('source:'.length));
        }
        if (!clientKey.startsWith('connection:')) {
            return false;
        }
        const [localIp, localPort, remoteIp, remotePort, ...extra] = clientKey.slice('connection:'.length).split('|');
        return (
            extra.length === 0 &&
            [localIp, localPort, remoteIp, remotePort].every(part => part.length > 0 && part.length <= 128) &&
            [localPort, remotePort].every(port => {
                const value = Number(port);
                return Number.isInteger(value) && value >= 1 && value <= 65535;
            })
        );
    };

    const BMP_CLIENT_MONITOR_ID = 'bmp-client';

    const getMonitorRequestKey = record => `${BMP_CLIENT_MONITOR_ID}:${getClientKey(record)}`;

    const canOpenClientMonitor = record => canOpenMonitorWindow.value && isValidMonitorClientKey(getClientKey(record));

    const isMonitorOpening = record => openingMonitorKey.value === getMonitorRequestKey(record);

    const openClientMonitor = async record => {
        const clientKey = getClientKey(record);
        if (!canOpenClientMonitor(record) || openingMonitorKey.value) {
            return;
        }

        const requestKey = getMonitorRequestKey(record);
        openingMonitorKey.value = requestKey;
        try {
            const result = await window.windowApi.openMonitor(BMP_CLIENT_MONITOR_ID, { clientKey });
            if (result?.status !== 'success') {
                notify.error(result?.msg || '打开独立监控窗口失败');
            }
        } catch (error) {
            notify.error('打开独立监控窗口失败: ' + error.message);
        } finally {
            if (openingMonitorKey.value === requestKey) {
                openingMonitorKey.value = '';
            }
        }
    };

    const getStableClientSourceId = record => record?.persistentSourceId || record?.sourceId || '';

    const hasDeleteClientDataApi = () => typeof window.bmpApi?.deleteClientData === 'function';

    const hasValidClientSourceId = record => /^[0-9a-f]{64}$/i.test(getStableClientSourceId(record));

    const canDeleteClientData = record =>
        hasDeleteClientDataApi() && !record?.isOnline && hasValidClientSourceId(record);

    const getClientDeleteDisabledReason = record => {
        if (!hasDeleteClientDataApi()) {
            return '删除接口尚未加载，请完全重启 NetNexus 后重试';
        }
        if (record?.isOnline) {
            return '在线客户端不可删除，请先断开连接';
        }
        if (!hasValidClientSourceId(record)) {
            return '客户端 sourceId 无效，无法安全删除';
        }
        return '';
    };

    const deleteClientData = async record => {
        const clientKey = getClientKey(record);
        if (!canDeleteClientData(record) || deletingClientKey.value === clientKey) {
            return;
        }

        const deleteRequest = {
            sourceId: getStableClientSourceId(record),
            remoteIp: typeof record?.remoteIp === 'string' ? record.remoteIp : ''
        };

        deletingClientKey.value = clientKey;
        try {
            const result = await window.bmpApi.deleteClientData(deleteRequest);
            if (result.status === 'success') {
                await loadClientList();
                if (currentDetails.value && getClientKey(currentDetails.value) === clientKey) {
                    closeDetailsDrawer();
                }
                notify.success(result.msg || '客户端数据删除成功');
            } else {
                notify.error(result.msg || '客户端数据删除失败');
            }
        } catch (error) {
            notify.error(`客户端数据删除失败: ${error.message}`);
        } finally {
            if (deletingClientKey.value === clientKey) {
                deletingClientKey.value = '';
            }
        }
    };

    const onInitiationHandler = result => {
        const data = result.data;
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(data));
            if (existingIndex !== -1) {
                clientList.value[existingIndex] = data;
            } else {
                clientList.value.push(data);
            }
        } else {
            console.error('initiation handler error', data.msg);
        }
    };

    const onTerminationHandler = result => {
        if (result && result.data) {
            const data = result.data;
            if (result.status === 'success') {
                const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(data));
                if (existingIndex !== -1) {
                    clientList.value[existingIndex] = {
                        ...clientList.value[existingIndex],
                        ...data,
                        connectionState: 'closed',
                        isOnline: false
                    };
                }
            } else {
                console.error('termination handler error', data.msg);
            }
        } else {
            clientList.value = [];
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.bmpApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    watch(
        () => bmpConfig.value.bmpV4TlvDraft,
        (newDraft, oldDraft) => {
            const nextDraft = normalizeBmpV4TlvDraft(newDraft);
            const previousDraft = normalizeBmpV4TlvDraft(oldDraft);
            const currentType = Number(bmpConfig.value.pathMarkingTlvType);
            const previousDefault = getDefaultPathMarkingTlvType(previousDraft);

            if (!Number.isInteger(currentType) || currentType === previousDefault) {
                bmpConfig.value.pathMarkingTlvType = getDefaultPathMarkingTlvType(nextDraft);
            }
        }
    );

    onActivated(async () => {
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onInitiationHandler);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onTerminationHandler);
        await loadClientList();
    });

    onDeactivated(() => {
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
    });

    onMounted(async () => {
        // 加载BMP配置
        const savedConfig = await window.bmpApi.loadBmpConfig();
        if (savedConfig.status === 'success') {
            if (savedConfig.data) {
                bmpConfig.value.port = savedConfig.data.port || DEFAULT_VALUES.DEFAULT_BMP_PORT;
                const savedDraft = normalizeBmpV4TlvDraft(savedConfig.data.bmpV4TlvDraft);
                bmpConfig.value.bmpV4TlvDraft = savedDraft;
                bmpConfig.value.pathMarkingTlvType = normalizePathMarkingTlvType(
                    savedConfig.data.pathMarkingTlvType,
                    savedDraft
                );
                bmpConfig.value.persistenceEnabled = true;
            }
        } else {
            console.error('配置文件加载失败', savedConfig.msg);
        }
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.nn-card-body),
    .adaptive-list-card :deep(.nn-card-body > div) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.nn-spin-nested-loading),
    .adaptive-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .adaptive-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.nn-table-container),
    .adaptive-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
