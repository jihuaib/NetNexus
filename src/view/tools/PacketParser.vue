<template>
    <div class="mt-container">
        <a-card title="报文解析器">
            <a-form :model="formState" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="handleParsePacket">
                <a-form-item label="解析起始层" name="startLayer">
                    <a-select v-model:value="formState.startLayer">
                        <a-select-option :value="START_LAYER.L2">数据链路层</a-select-option>
                        <a-select-option :value="START_LAYER.L3">网络层</a-select-option>
                        <a-select-option :value="START_LAYER.L5">应用层</a-select-option>
                    </a-select>
                </a-form-item>

                <!-- 报文类型选择 -->
                <a-form-item label="应用协议类型" name="protocolType">
                    <a-select v-model:value="formState.protocolType">
                        <a-select-option :value="PROTOCOL_TYPE.AUTO">自动识别</a-select-option>
                        <a-select-option :value="PROTOCOL_TYPE.BGP">BGP</a-select-option>
                        <!-- 预留其他报文类型 -->
                    </a-select>
                </a-form-item>

                <!-- 协议端口输入 -->
                <a-form-item label="应用协议端口" name="protocolPort">
                    <a-tooltip :title="validationErrors.protocolPort" :open="!!validationErrors.protocolPort">
                        <a-input
                            v-model:value="formState.protocolPort"
                            :status="validationErrors.protocolPort ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>

                <!-- 报文输入框 -->
                <a-form-item label="报文数据" name="packetData">
                    <a-tooltip :title="validationErrors.packetData" :open="!!validationErrors.packetData">
                        <ScrollTextarea
                            v-model:model-value="formState.packetData"
                            :height="420"
                            placeholder="请输入16进制格式的报文内容, 如: FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 13 01"
                            :status="validationErrors.packetData ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>
                <!-- 操作按钮 -->
                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <a-space>
                        <a-button type="primary" html-type="submit">解析报文</a-button>
                        <a-button type="default" @click="showParseHistory">识别历史</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
        </a-card>
    </div>

    <!-- 报文结果查看器弹窗 -->
    <PacketResultViewer
        v-model:open="resultViewerVisible"
        :packet-data="formState.packetData"
        :raw-parse-result="rawParseResult"
    />

    <!-- 解析历史弹窗 -->
    <a-modal
        v-model:open="historyModalVisible"
        title="报文解析历史"
        :mask-closable="false"
        class="modal-xlarge"
        @cancel="closeHistoryModal"
    >
        <div>
            <a-table
                :columns="historyColumns"
                :data-source="parseHistory"
                :pagination="{ pageSize: 20, showSizeChanger: false, position: ['bottomCenter'], showTotal: total => '共 ' + total + ' 条，每页 20 条' }"
                :scroll="{ y: 200 }"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'action'">
                        <a-button type="link" @click="loadHistoryItem(record)">使用</a-button>
                    </template>
                    <template v-else-if="column.key === 'packetData'">
                        <div>{{ truncateString(record.packetData, 40) }}</div>
                    </template>
                </template>
            </a-table>
        </div>
        <template #footer>
            <a-button type="primary" @click="closeHistoryModal">关闭</a-button>
            <a-button v-if="parseHistory.length > 0" danger @click="clearHistory">清空历史</a-button>
        </template>
    </a-modal>
</template>

<script setup>
    import ScrollTextarea from '../../components/ScrollTextarea.vue';
    import PacketResultViewer from '../../components/PacketResultViewer.vue';
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { FormValidator, createPacketDataValidationRules } from '../../utils/validationCommon';
    import { PROTOCOL_TYPE, START_LAYER, START_LAYER_NAME, PROTOCOL_TYPE_NAME } from '../../const/toolsConst';
    defineOptions({
        name: 'PacketParser'
    });

    const _emit = defineEmits(['openSettings']);

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const validationErrors = ref({
        packetData: '',
        protocolPort: ''
    });

    const formState = ref({
        startLayer: START_LAYER.L2,
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
                message.error(resp.msg || '获取历史记录失败');
            }
        } catch (e) {
            message.error(e.message || String(e));
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
                message.success('历史记录已清空');
            } else {
                message.error(resp.msg || '清空历史记录失败');
            }
        } catch (e) {
            message.error(e.message || String(e));
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
                message.error('请检查配置信息是否正确');
                return;
            }

            const payload = {
                protocolType: formState.value.protocolType,
                protocolPort: formState.value.protocolPort,
                packetData: formState.value.packetData,
                startLayer: formState.value.startLayer
            };

            let resp;

            // 根据报文类型选择不同的解析方法
            resp = await window.toolsApi.parsePacket(payload);

            if (resp.status === 'success') {
                rawParseResult.value = resp.data;
                message.success('报文解析成功');
                showResultViewer();
            } else {
                message.error(resp.msg || '解析失败');
                rawParseResult.value = null;
            }
        } catch (e) {
            message.error(e.message || String(e));
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
    :deep(.ant-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
