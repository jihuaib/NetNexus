<template>
    <div class="nn-container packet-parser-page">
        <nn-card title="报文解析器" class="packet-parser-card">
            <nn-form :model="formState" layout="vertical" class="packet-parser-form" @finish="handleParsePacket">
                <div class="packet-config-grid">
                    <nn-form-item label="解析起始层" name="startLayer" class="packet-config-item">
                        <nn-select v-model:value="formState.startLayer">
                            <nn-select-option :value="START_LAYER.L2">数据链路层</nn-select-option>
                            <nn-select-option :value="START_LAYER.L3">网络层</nn-select-option>
                            <nn-select-option :value="START_LAYER.L4">传输层</nn-select-option>
                            <nn-select-option :value="START_LAYER.L5">应用层</nn-select-option>
                        </nn-select>
                    </nn-form-item>

                    <nn-form-item
                        v-if="formState.startLayer === START_LAYER.L4"
                        label="传输协议"
                        name="transportProtocol"
                        class="packet-config-item packet-config-item-narrow"
                    >
                        <nn-select v-model:value="formState.transportProtocol">
                            <nn-select-option :value="TRANSPORT_PROTOCOL.TCP">TCP</nn-select-option>
                            <nn-select-option :value="TRANSPORT_PROTOCOL.UDP">UDP</nn-select-option>
                        </nn-select>
                    </nn-form-item>

                    <nn-form-item label="应用协议类型" name="protocolType" class="packet-config-item">
                        <nn-select v-model:value="formState.protocolType">
                            <nn-select-option :value="PROTOCOL_TYPE.AUTO">自动识别</nn-select-option>
                            <nn-select-option :value="PROTOCOL_TYPE.BGP">BGP</nn-select-option>
                            <nn-select-option :value="PROTOCOL_TYPE.BMP">BMP</nn-select-option>
                        </nn-select>
                    </nn-form-item>

                    <nn-form-item
                        label="应用协议端口"
                        name="protocolPort"
                        class="packet-config-item packet-config-item-narrow"
                    >
                        <nn-tooltip :title="validationErrors.protocolPort" :open="!!validationErrors.protocolPort">
                            <nn-input
                                v-model:value="formState.protocolPort"
                                placeholder="可选"
                                :status="validationErrors.protocolPort ? 'error' : ''"
                            />
                        </nn-tooltip>
                    </nn-form-item>
                </div>

                <!-- 报文输入框 -->
                <nn-form-item
                    label="报文数据"
                    name="packetData"
                    class="packet-data-item"
                    :validate-status="validationErrors.packetData ? 'error' : ''"
                    :help="validationErrors.packetData || ''"
                >
                    <div class="packet-data-textarea-wrap">
                        <nn-textarea
                            v-model:value="formState.packetData"
                            height="100%"
                            auto-scroll="end"
                            resize="none"
                            placeholder="请输入16进制格式的报文内容, 如: FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 13 01"
                            :status="validationErrors.packetData ? 'error' : ''"
                        />
                    </div>
                </nn-form-item>
                <!-- 操作按钮 -->
                <div class="packet-action-bar">
                    <nn-space>
                        <nn-button type="primary" html-type="submit">解析报文</nn-button>
                        <nn-button type="default" @click="showParseHistory">识别历史</nn-button>
                    </nn-space>
                </div>
            </nn-form>
        </nn-card>
    </div>

    <!-- 报文结果查看器弹窗 -->
    <nn-packet-viewer
        v-model:open="resultViewerVisible"
        :packet-data="formState.packetData"
        :raw-parse-result="rawParseResult"
    />

    <!-- 解析历史弹窗 -->
    <nn-modal
        v-model:open="historyModalVisible"
        title="报文解析历史"
        :mask-closable="false"
        class="modal-xlarge"
        @cancel="closeHistoryModal"
    >
        <div>
            <nn-table
                :columns="historyColumns"
                :data-source="parseHistory"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    position: ['bottomCenter'],
                    showTotal: total => '共 ' + total + ' 条，每页 20 条'
                }"
                :scroll="{ y: 200 }"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'action'">
                        <nn-button type="link" @click="loadHistoryItem(record)">使用</nn-button>
                    </template>
                    <template v-else-if="column.key === 'packetData'">
                        <div>{{ truncateString(record.packetData, 40) }}</div>
                    </template>
                </template>
            </nn-table>
        </div>
        <template #footer>
            <nn-button type="primary" @click="closeHistoryModal">关闭</nn-button>
            <nn-button v-if="parseHistory.length > 0" danger @click="clearHistory">清空历史</nn-button>
        </template>
    </nn-modal>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { FormValidator, createPacketDataValidationRules } from '../../utils/validationCommon';
    import {
        PROTOCOL_TYPE,
        START_LAYER,
        START_LAYER_NAME,
        PROTOCOL_TYPE_NAME,
        TRANSPORT_PROTOCOL,
        TRANSPORT_PROTOCOL_NAME
    } from '../../const/toolsConst';
    defineOptions({
        name: 'PacketParser'
    });

    const _emit = defineEmits(['openSettings']);

    const validationErrors = ref({
        packetData: '',
        protocolPort: ''
    });

    const formState = ref({
        startLayer: START_LAYER.L2,
        transportProtocol: TRANSPORT_PROTOCOL.TCP,
        protocolType: PROTOCOL_TYPE.AUTO,
        protocolPort: '',
        packetData: ''
    });

    // 解析结果
    const rawParseResult = ref(null);

    // 历史记录相关状态
    const historyModalVisible = ref(false);
    const parseHistory = ref([]);

    // 结果查看器弹窗状态
    const resultViewerVisible = ref(false);
    const historyColumns = [
        {
            title: '开始层级',
            dataIndex: 'startLayer',
            key: 'startLayer',
            customRender: ({ text }) => {
                return START_LAYER_NAME[text];
            }
        },
        {
            title: '传输协议',
            dataIndex: 'transportProtocol',
            key: 'transportProtocol',
            customRender: ({ text, record }) => {
                if (record.startLayer !== START_LAYER.L4) return '-';
                return TRANSPORT_PROTOCOL_NAME[text || TRANSPORT_PROTOCOL.TCP];
            }
        },
        {
            title: '协议类型',
            dataIndex: 'protocolType',
            key: 'protocolType',
            customRender: ({ text }) => {
                return PROTOCOL_TYPE_NAME[text];
            }
        },
        {
            title: '协议端口',
            dataIndex: 'protocolPort',
            key: 'protocolPort'
        },
        {
            title: '报文数据',
            dataIndex: 'packetData',
            key: 'packetData',
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    // 截断显示内容
    const truncateString = (str, maxLength) => {
        if (!str) return '';
        return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
    };

    // 显示历史记录弹窗
    const showParseHistory = async () => {
        try {
            const resp = await window.toolsApi.getPacketParserHistory();
            if (resp.status === 'success') {
                parseHistory.value = resp.data || [];
                historyModalVisible.value = true;
            } else {
                notify.error(resp.msg || '获取历史记录失败');
            }
        } catch (e) {
            notify.error(e.message || String(e));
            console.error('获取历史记录错误:', e);
        }
    };

    // 关闭历史记录弹窗
    const closeHistoryModal = () => {
        historyModalVisible.value = false;
    };

    // 显示结果查看器
    const showResultViewer = () => {
        resultViewerVisible.value = true;
    };

    // 加载历史记录项
    const loadHistoryItem = record => {
        if (!record) return;

        // 更新表单数据
        formState.value = {
            startLayer: record.startLayer || START_LAYER.L2,
            transportProtocol: record.transportProtocol || TRANSPORT_PROTOCOL.TCP,
            protocolType: record.protocolType || PROTOCOL_TYPE.AUTO,
            protocolPort: record.protocolPort || '',
            packetData: record.packetData || ''
        };

        // 关闭弹窗
        closeHistoryModal();
    };

    // 清空历史记录
    const clearHistory = async () => {
        try {
            const resp = await window.toolsApi.clearPacketParserHistory();
            if (resp.status === 'success') {
                parseHistory.value = [];
                notify.success('历史记录已清空');
            } else {
                notify.error(resp.msg || '清空历史记录失败');
            }
        } catch (e) {
            notify.error(e.message || String(e));
            console.error('清空历史记录错误:', e);
        }
    };

    let validator = new FormValidator(validationErrors);
    validator.addRules(createPacketDataValidationRules());

    // 处理解析报文，添加历史记录保存
    const handleParsePacket = async () => {
        try {
            const hasError = validator.validate(formState.value);
            if (hasError) {
                notify.error('请检查配置信息是否正确');
                return;
            }

            const payload = {
                protocolType: formState.value.protocolType,
                protocolPort: formState.value.protocolPort,
                packetData: formState.value.packetData,
                startLayer: formState.value.startLayer,
                transportProtocol: formState.value.transportProtocol
            };

            let resp;

            // 根据报文类型选择不同的解析方法
            resp = await window.toolsApi.parsePacket(payload);

            if (resp.status === 'success') {
                rawParseResult.value = resp.data;
                notify.success('报文解析成功');
                showResultViewer();
            } else {
                notify.error(resp.msg || '解析失败');
                rawParseResult.value = null;
            }
        } catch (e) {
            notify.error(e.message || String(e));
            console.error('解析错误:', e);
            rawParseResult.value = null;
        }
    };

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    onMounted(async () => {});
</script>

<style scoped>
    .packet-parser-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .packet-parser-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .packet-parser-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .packet-parser-form {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .packet-parser-form :deep(.nn-form-item) {
        flex: 0 0 auto;
    }

    .packet-config-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px 16px;
        margin-bottom: 12px;
    }

    .packet-config-item {
        min-width: 0;
        margin-bottom: 0;
    }

    .packet-config-item-narrow {
        min-width: 140px;
    }

    .packet-config-item :deep(.nn-form-item-label) {
        padding-bottom: 4px;
    }

    .packet-config-item :deep(.nn-select),
    .packet-config-item :deep(.nn-input) {
        width: 100%;
    }

    .packet-data-item {
        flex: 1 1 0 !important;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .packet-data-item :deep(.nn-form-item-row),
    .packet-data-item :deep(.nn-form-item-control),
    .packet-data-item :deep(.nn-form-item-control-input),
    .packet-data-item :deep(.nn-form-item-control-input-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .packet-data-item :deep(.nn-form-item-label) {
        flex: 0 0 auto;
    }

    .packet-data-item :deep(.nn-form-item-control-input) {
        align-items: stretch;
    }

    .packet-data-item :deep(.nn-form-item-explain) {
        flex: 0 0 auto;
    }

    .packet-data-textarea-wrap {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
    }

    .packet-data-textarea-wrap :deep(textarea.nn-input) {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        height: auto !important;
    }

    .packet-action-bar {
        flex: 0 0 auto;
        display: flex;
        justify-content: center;
        padding-top: 12px;
    }

    @media (max-width: 640px) {
        .packet-config-grid {
            grid-template-columns: 1fr;
        }

        .packet-action-bar {
            justify-content: stretch;
        }

        .packet-action-bar :deep(.nn-space),
        .packet-action-bar :deep(.nn-button) {
            width: 100%;
        }
    }

    :deep(.nn-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
