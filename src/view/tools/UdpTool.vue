<template>
    <div class="mt-container udp-tool-page">
        <!-- Socket 配置 -->
        <a-card title="UDP 配置" class="udp-config-card" size="small">
            <template #extra>
                <a-tag :color="stateColor">{{ stateName }}</a-tag>
            </template>
            <a-form layout="inline" :model="socketForm" class="udp-config-form">
                <a-form-item label="目标地址">
                    <a-input
                        v-model:value="socketForm.host"
                        placeholder="127.0.0.1"
                        :disabled="isActive"
                        style="width: 160px"
                        @press-enter="open"
                    />
                </a-form-item>
                <a-form-item label="目标端口">
                    <a-input-number
                        v-model:value="socketForm.port"
                        :min="1"
                        :max="65535"
                        :disabled="isActive"
                        placeholder="9000"
                        style="width: 110px"
                    />
                </a-form-item>
                <a-form-item label="本地端口">
                    <a-input-number
                        v-model:value="socketForm.localPort"
                        :min="0"
                        :max="65535"
                        :disabled="isActive"
                        placeholder="0=随机"
                        style="width: 120px"
                    />
                </a-form-item>
                <a-form-item>
                    <a-button v-if="!isActive" type="primary" :loading="opening" @click="open">打开</a-button>
                    <a-button v-else danger @click="closeSocket">关闭</a-button>
                </a-form-item>
            </a-form>
        </a-card>

        <!-- 发送报文 -->
        <a-card title="发送报文" class="udp-send-card" size="small">
            <div class="udp-encoding-row">
                <span class="udp-encoding-label">编码方式</span>
                <a-radio-group v-model:value="sendForm.encoding" button-style="solid">
                    <a-radio-button :value="UDP_TOOL_ENCODING.UTF8">文本</a-radio-button>
                    <a-radio-button :value="UDP_TOOL_ENCODING.HEX">十六进制</a-radio-button>
                    <a-radio-button :value="UDP_TOOL_ENCODING.BASE64">Base64</a-radio-button>
                </a-radio-group>
            </div>
            <a-textarea v-model:value="sendForm.data" :rows="3" :placeholder="sendPlaceholder" class="udp-send-input" />
            <div class="udp-send-actions">
                <span v-if="conn" class="udp-traffic-info">
                    发送 {{ conn.bytesSent }} B / 接收 {{ conn.bytesReceived }} B
                </span>
                <a-button type="primary" :loading="sending" :disabled="!isActive" @click="send">发送</a-button>
            </div>
        </a-card>

        <!-- 收包窗口 -->
        <a-card title="收包窗口" class="udp-recv-card" size="small">
            <div ref="logContainer" class="udp-log-list">
                <div v-if="logs.length === 0" class="udp-log-empty">暂无数据</div>
                <div v-for="(log, index) in logs" :key="index" class="udp-log-item" :class="`udp-log-${log.type}`">
                    <span class="udp-log-time">{{ log.time }}</span>
                    <span class="udp-log-tag">{{ log.tag }}</span>
                    <span class="udp-log-text">{{ log.text }}</span>
                </div>
            </div>
            <div class="udp-recv-toolbar">
                <a-checkbox v-model:checked="autoScroll">自动滚动</a-checkbox>
                <a-checkbox v-model:checked="showText">显示文本</a-checkbox>
                <a-button size="small" @click="clearLogs">清空</a-button>
            </div>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, reactive, computed, nextTick, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import EventBus from '../../utils/eventBus';
    import { UDP_TOOL_STATE, UDP_TOOL_STATE_NAME, UDP_TOOL_EVT_TYPES, UDP_TOOL_ENCODING } from '../../const/toolsConst';

    defineOptions({
        name: 'UdpTool'
    });

    const PAGE_ID = 'tools-udp-tool';

    const socketForm = reactive({
        host: '127.0.0.1',
        port: 9000,
        localPort: 0
    });

    const sendForm = reactive({
        encoding: UDP_TOOL_ENCODING.UTF8,
        data: ''
    });

    const conn = ref(null); // 当前唯一 socket { id, host, port, state, localPort, bytesSent, bytesReceived }
    const logs = ref([]);
    const opening = ref(false);
    const sending = ref(false);
    const autoScroll = ref(true);
    const showText = ref(true);
    const logContainer = ref(null);

    const isActive = computed(() => conn.value && conn.value.state === UDP_TOOL_STATE.LISTENING);

    const stateName = computed(() => (conn.value ? UDP_TOOL_STATE_NAME[conn.value.state] : '未打开'));

    // 结合项目主色调 #1890ff，用实心标签清晰区分「有效（就绪）」与「禁用（未打开/已关闭）」
    const stateColor = computed(() => {
        if (!conn.value) {
            return '#8c8c8c'; // 未打开（禁用态）
        }
        switch (conn.value.state) {
            case UDP_TOOL_STATE.LISTENING:
                return '#1890ff'; // 就绪（有效态）- 主色
            case UDP_TOOL_STATE.OPENING:
                return '#faad14'; // 打开中
            case UDP_TOOL_STATE.ERROR:
                return '#ff4d4f'; // 错误
            default:
                return '#8c8c8c'; // 已关闭（禁用态）
        }
    });

    const sendPlaceholder = computed(() =>
        sendForm.encoding === UDP_TOOL_ENCODING.HEX
            ? '输入十六进制报文，如：ff 00 ab 或 ff00ab'
            : '输入要发送的报文内容'
    );

    const nowTime = () => {
        const d = new Date();
        return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    };

    const scrollToBottom = () => {
        if (!autoScroll.value) {
            return;
        }
        nextTick(() => {
            const el = logContainer.value;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    };

    const addLog = (type, tag, text) => {
        logs.value.push({ type, tag, text, time: nowTime() });
        if (logs.value.length > 1000) {
            logs.value.splice(0, logs.value.length - 1000);
        }
        scrollToBottom();
    };

    const open = async () => {
        if (isActive.value) {
            return;
        }
        opening.value = true;
        try {
            const result = await window.toolsApi.udpOpen({
                host: socketForm.host,
                port: socketForm.port,
                localPort: socketForm.localPort
            });
            if (result.status !== 'success') {
                message.error(result.msg || '打开失败');
                return;
            }
            const { id, host, port } = result.data;
            conn.value = {
                id,
                host,
                port,
                state: UDP_TOOL_STATE.OPENING,
                localPort: null,
                bytesSent: 0,
                bytesReceived: 0
            };
            addLog('info', '打开', `目标 ${host}:${port}`);
        } catch (error) {
            message.error('打开失败: ' + error.message);
        } finally {
            opening.value = false;
        }
    };

    const send = async () => {
        if (!isActive.value) {
            message.warning('请先打开 socket');
            return;
        }
        sending.value = true;
        try {
            const result = await window.toolsApi.udpSend({
                id: conn.value.id,
                data: sendForm.data,
                encoding: sendForm.encoding
            });
            if (result.status !== 'success') {
                message.error(result.msg || '发送失败');
                return;
            }
            conn.value.bytesSent += result.data.length;
            addLog('send', '发送', formatSent(result.data.length));
        } catch (error) {
            message.error('发送失败: ' + error.message);
        } finally {
            sending.value = false;
        }
    };

    const formatSent = length => {
        const target = `${conn.value.host}:${conn.value.port}`;
        if (sendForm.encoding === UDP_TOOL_ENCODING.UTF8) {
            return `${length} 字节 -> ${target}: ${sendForm.data}`;
        }
        return `${length} 字节 (${sendForm.encoding}) -> ${target}: ${sendForm.data}`;
    };

    const closeSocket = async () => {
        if (!conn.value) {
            return;
        }
        try {
            await window.toolsApi.udpClose({ id: conn.value.id });
        } catch (error) {
            message.error('关闭失败: ' + error.message);
        }
    };

    const clearLogs = () => {
        logs.value = [];
    };

    const handleStateChange = data => {
        if (!conn.value || data.id !== conn.value.id) {
            return;
        }
        conn.value.state = data.state;
        conn.value.localPort = data.localPort;
        conn.value.bytesSent = data.bytesSent;
        conn.value.bytesReceived = data.bytesReceived;
        if (data.state === UDP_TOOL_STATE.ERROR) {
            addLog('error', '错误', data.message || 'socket 错误');
        } else if (data.state === UDP_TOOL_STATE.CLOSED) {
            addLog('info', '关闭', 'socket 已关闭');
        } else if (data.state === UDP_TOOL_STATE.LISTENING) {
            addLog('info', '就绪', `本地 ${data.localAddress || ''}:${data.localPort || ''}`);
        }
    };

    const handleData = data => {
        if (!conn.value || data.id !== conn.value.id) {
            return;
        }
        conn.value.bytesReceived = data.totalReceived;
        const source = `${data.sourceAddress}:${data.sourcePort}`;
        const body = showText.value ? `${data.dataHex}  |  ${data.dataText}` : data.dataHex;
        addLog('recv', '接收', `${data.length} 字节 <- ${source}: ${body}`);
    };

    onActivated(() => {
        EventBus.on(UDP_TOOL_EVT_TYPES.STATE_CHANGE, PAGE_ID, handleStateChange);
        EventBus.on(UDP_TOOL_EVT_TYPES.DATA, PAGE_ID, handleData);
    });

    onDeactivated(() => {
        EventBus.off(UDP_TOOL_EVT_TYPES.STATE_CHANGE, PAGE_ID);
        EventBus.off(UDP_TOOL_EVT_TYPES.DATA, PAGE_ID);
    });

    defineExpose({
        clearValidationErrors: () => {}
    });
</script>

<style scoped>
    .udp-tool-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .udp-config-card,
    .udp-send-card {
        flex: 0 0 auto;
    }

    /* 主按钮（打开/发送）对齐项目主色调 #1890ff，有效态醒目、禁用态保留默认灰 */
    .udp-tool-page :deep(.ant-btn-primary:not(:disabled)) {
        background-color: #1890ff;
        border-color: #1890ff;
    }

    .udp-tool-page :deep(.ant-btn-primary:not(:disabled):hover) {
        background-color: #40a9ff;
        border-color: #40a9ff;
    }

    /* 编码切换：选中态使用主色实心填充 */
    .udp-tool-page :deep(.ant-radio-button-wrapper-checked) {
        background-color: #1890ff;
        border-color: #1890ff;
    }

    .udp-tool-page :deep(.ant-radio-button-wrapper-checked:hover) {
        background-color: #40a9ff;
        border-color: #40a9ff;
    }

    .udp-config-form :deep(.ant-form-item) {
        margin-bottom: 0;
    }

    .udp-encoding-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
    }

    .udp-encoding-label {
        color: rgba(0, 0, 0, 0.85);
        font-size: 14px;
    }

    .udp-send-input {
        font-family: 'Courier New', Courier, monospace;
    }

    .udp-send-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 8px;
    }

    .udp-traffic-info {
        color: #888;
        font-size: 12px;
    }

    .udp-recv-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .udp-recv-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 8px 12px;
    }

    .udp-recv-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 8px;
    }

    .udp-log-list {
        flex: 1 1 0;
        min-height: 0;
        overflow-y: auto;
        font-family: 'Courier New', Courier, monospace;
        font-size: 12px;
        line-height: 1.7;
        background: #1e1e1e;
        color: #d4d4d4;
        border-radius: 4px;
        padding: 8px 10px;
    }

    .udp-log-empty {
        color: #777;
        text-align: center;
        padding-top: 12px;
    }

    .udp-log-item {
        white-space: pre-wrap;
        word-break: break-all;
    }

    .udp-log-time {
        color: #6a9955;
        margin-right: 8px;
    }

    .udp-log-tag {
        display: inline-block;
        width: 42px;
        margin-right: 8px;
        text-align: center;
        border-radius: 2px;
        background: #333;
        color: #ccc;
    }

    .udp-log-recv .udp-log-tag {
        background: #2d5a2d;
        color: #b5f5b5;
    }

    .udp-log-send .udp-log-tag {
        background: #1f4e7a;
        color: #a6d8ff;
    }

    .udp-log-error .udp-log-tag {
        background: #6b2222;
        color: #ffb3b3;
    }

    .udp-log-recv .udp-log-text {
        color: #9cdc9c;
    }

    .udp-log-send .udp-log-text {
        color: #9cd2ff;
    }

    .udp-log-error .udp-log-text {
        color: #ff9c9c;
    }
</style>
