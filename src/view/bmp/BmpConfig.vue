<template>
    <div class="mt-container adaptive-list-page">
        <a-row class="adaptive-form-row">
            <a-col :span="24">
                <a-card title="BMP服务器配置">
                    <a-form :model="bmpConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBmp">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="服务端端口" name="port">
                                    <a-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <a-input
                                            v-model:value="bmpConfig.port"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row :gutter="12">
                            <a-col :span="12">
                                <a-form-item label="v4 TLV格式" name="bmpV4TlvDraft">
                                    <a-radio-group v-model:value="bmpConfig.bmpV4TlvDraft" button-style="solid">
                                        <a-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_20">draft-20</a-radio-button>
                                        <a-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_19">draft-19</a-radio-button>
                                    </a-radio-group>
                                </a-form-item>
                            </a-col>
                            <a-col :span="12">
                                <a-form-item label="Path TLV类型" name="pathMarkingTlvType">
                                    <a-tooltip
                                        :title="validationErrors.pathMarkingTlvType"
                                        :open="!!validationErrors.pathMarkingTlvType"
                                    >
                                        <a-input-number
                                            v-model:value="bmpConfig.pathMarkingTlvType"
                                            :min="1"
                                            :max="16383"
                                            :precision="0"
                                            style="width: 100%"
                                            :status="validationErrors.pathMarkingTlvType ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="启用认证" name="enableAuth">
                                    <a-checkbox v-model:checked="bmpConfig.enableAuth" />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <!-- 认证配置 -->
                        <a-row :gutter="12">
                            <a-col :span="8">
                                <a-form-item label="本地监听端口" name="localPort">
                                    <a-tooltip
                                        :title="validationErrors.localPort"
                                        :open="bmpConfig.enableAuth && !!validationErrors.localPort"
                                    >
                                        <a-input
                                            v-model:value="bmpConfig.localPort"
                                            :disabled="!bmpConfig.enableAuth"
                                            :status="bmpConfig.enableAuth && validationErrors.localPort ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="路由器IP" name="peerIP">
                                    <a-tooltip
                                        :title="validationErrors.peerIP"
                                        :open="bmpConfig.enableAuth && !!validationErrors.peerIP"
                                    >
                                        <a-input
                                            v-model:value="bmpConfig.peerIP"
                                            :disabled="!bmpConfig.enableAuth"
                                            :status="bmpConfig.enableAuth && validationErrors.peerIP ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="MD5密钥" name="md5Password">
                                    <a-tooltip
                                        :title="validationErrors.md5Password"
                                        :open="bmpConfig.enableAuth && !!validationErrors.md5Password"
                                    >
                                        <a-input-password
                                            v-model:value="bmpConfig.md5Password"
                                            :disabled="!bmpConfig.enableAuth"
                                            :status="
                                                bmpConfig.enableAuth && validationErrors.md5Password ? 'error' : ''
                                            "
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button
                                    type="primary"
                                    html-type="submit"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                >
                                    启动服务器
                                </a-button>
                                <a-button type="primary" danger :disabled="!serverRunning" @click="stopBmp">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- BMP客户端列表 -->
        <a-row class="adaptive-list-row">
            <a-col :span="24">
                <a-card title="BMP客户端列表" class="adaptive-list-card">
                    <div>
                        <a-table
                            class="adaptive-table"
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="
                                record =>
                                    `${record.localIp || ''}-${record.localPort || ''}-${record.remoteIp || ''}-${record.remotePort || ''}`
                            "
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ y: '100%' }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'bmpVersion'">
                                    <a-tag :color="record.bmpVersion === 4 ? 'blue' : 'default'">
                                        {{ getBmpVersionName(record.bmpVersion) }}
                                    </a-tag>
                                </template>
                                <template v-else-if="column.key === 'bmpV4TlvDraft'">
                                    <a-tag>{{ getBmpV4TlvDraftName(record.bmpV4TlvDraft) }}</a-tag>
                                </template>
                                <template v-else-if="column.key === 'tlvCount'">
                                    {{ getClientTlvCount(record) }}
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <a-button type="link" @click="viewClientDetails(record)">详情</a-button>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </a-card>
            </a-col>
        </a-row>

        <a-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </a-drawer>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated, watch } from 'vue';
    import { message } from 'ant-design-vue';
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
        localPort: '11019',
        enableAuth: false,
        peerIP: '',
        md5Password: ''
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);

    const getClientTlvCount = record => {
        return (record.rawTlvs || []).length + (record.terminationTlvs || []).length;
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
            title: '操作',
            key: 'action'
        }
    ];

    const validationErrors = ref({
        port: '',
        pathMarkingTlvType: '',
        localPort: '',
        peerIP: '',
        md5Password: ''
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

    const isServerDeployed = async () => {
        const deploymentStatus = await window.commonApi.getServerDeploymentStatus();
        return deploymentStatus.status === 'success' && deploymentStatus.data.success;
    };

    const startBmp = async () => {
        const hasErrors = validator.validate(bmpConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }

        if (bmpConfig.value.enableAuth && !(await isServerDeployed())) {
            message.error('请先部署服务器');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(bmpConfig.value));
            payload.bmpV4TlvDraft = normalizeBmpV4TlvDraft(payload.bmpV4TlvDraft);
            payload.pathMarkingTlvType = normalizePathMarkingTlvType(payload.pathMarkingTlvType, payload.bmpV4TlvDraft);
            const saveResult = await window.bmpApi.saveBmpConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.bmpApi.startBmp(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                // Clear the client list when starting the server
                clientList.value = [];
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'BMP服务器启动失败');
            }
        } catch (error) {
            message.error(`BMP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopBmp = async () => {
        try {
            const result = await window.bmpApi.stopBmp();
            if (result.status === 'success') {
                serverRunning.value = false;
                clientList.value = [];
                message.success(`${result.msg}`);
            } else {
                message.error(result.msg || 'BMP服务器停止失败');
            }
        } catch (error) {
            message.error(`BMP服务器停止出错: ${error.message}`);
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

    const onInitiationHandler = result => {
        const data = result.data;
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(
                client =>
                    `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                    `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
            );
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
                const existingIndex = clientList.value.findIndex(
                    client =>
                        `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                        `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
                );
                if (existingIndex !== -1) {
                    clientList.value.splice(existingIndex, 1);
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
            message.error('加载数据失败');
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
        if (savedConfig.status === 'success' && savedConfig.data) {
            bmpConfig.value.port = savedConfig.data.port || DEFAULT_VALUES.DEFAULT_BMP_PORT;
            const savedDraft = normalizeBmpV4TlvDraft(savedConfig.data.bmpV4TlvDraft);
            bmpConfig.value.bmpV4TlvDraft = savedDraft;
            bmpConfig.value.pathMarkingTlvType = normalizePathMarkingTlvType(
                savedConfig.data.pathMarkingTlvType,
                savedDraft
            );
            bmpConfig.value.enableAuth = savedConfig.data.enableAuth || false;
            bmpConfig.value.localPort = savedConfig.data.localPort;
            bmpConfig.value.peerIP = savedConfig.data.peerIP || '';
            bmpConfig.value.md5Password = savedConfig.data.md5Password || '';
        } else {
            console.error('配置文件加载失败', savedConfig.msg);
        }
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: calc(100vh - 70px);
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

    .adaptive-list-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.ant-card-body),
    .adaptive-list-card :deep(.ant-card-body > div) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.ant-spin-nested-loading),
    .adaptive-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .adaptive-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.ant-table-container),
    .adaptive-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
