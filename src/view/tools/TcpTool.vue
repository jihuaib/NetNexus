<template>
    <div class="mt-container tcp-tool-page">
        <!-- 连接配置 -->
        <a-card title="连接配置" class="tcp-config-card" size="small">
            <template #extra>
                <a-tag :color="stateColor">{{ stateName }}</a-tag>
            </template>
            <a-form layout="inline" :model="connectForm" class="tcp-config-form">
                <a-form-item label="目标地址">
                    <a-input
                        v-model:value="connectForm.host"
                        placeholder="127.0.0.1"
                        :disabled="isConnected"
                        style="width: 160px"
                        @press-enter="connect"
                    />
                </a-form-item>
                <a-form-item label="端口">
                    <a-input-number
                        v-model:value="connectForm.port"
                        :min="1"
                        :max="65535"
                        :disabled="isConnected"
                        placeholder="179"
                        style="width: 110px"
                    />
                </a-form-item>
                <a-form-item label="超时(ms)">
                    <a-input-number
                        v-model:value="connectForm.timeout"
                        :min="1000"
                        :max="600000"
                        :step="1000"
                        :disabled="isConnected"
                        style="width: 120px"
                    />
                </a-form-item>
                <a-form-item>
                    <a-button v-if="!isConnected" type="primary" :loading="connecting" @click="connect">
                        建立连接
                    </a-button>
                    <a-button v-else danger @click="disconnect">结束连接</a-button>
                </a-form-item>
            </a-form>
        </a-card>

        <!-- 发送报文 -->
        <a-card title="发送报文" class="tcp-send-card" size="small">
            <div class="tcp-encoding-row">
                <span class="tcp-encoding-label">编码方式</span>
                <a-radio-group v-model:value="sendForm.encoding" button-style="solid">
                    <a-radio-button :value="TCP_TOOL_ENCODING.UTF8">文本</a-radio-button>
                    <a-radio-button :value="TCP_TOOL_ENCODING.HEX">十六进制</a-radio-button>
                    <a-radio-button :value="TCP_TOOL_ENCODING.BASE64">Base64</a-radio-button>
                </a-radio-group>
            </div>
            <a-textarea
                v-model:value="sendForm.data"
                :rows="3"
                :placeholder="sendPlaceholder"
                class="tcp-send-input"
            />
            <div class="tcp-send-actions">
                <span v-if="conn" class="tcp-traffic-info">
                    发送 {{ conn.bytesSent }} B / 接收 {{ conn.bytesReceived }} B
                </span>
                <a-button type="primary" :loading="sending" :disabled="!isConnected" @click="send">发送</a-button>
            </div>
        </a-card>

        <!-- 收包窗口 -->
        <a-card title="收包窗口" class="tcp-recv-card" size="small">
            <div ref="logContainer" class="tcp-log-list">
                <div v-if="logs.length === 0" class="tcp-log-empty">暂无数据</div>
                <div v-for="(log, index) in logs" :key="index" class="tcp-log-item" :class="`tcp-log-${log.type}`">
                    <span class="tcp-log-time">{{ log.time }}</span>
                    <span class="tcp-log-tag">{{ log.tag }}</span>
                    <span class="tcp-log-text">{{ log.text }}</span>
                </div>
            </div>
            <div class="tcp-recv-toolbar">
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
    import {
        TCP_TOOL_STATE,
        TCP_TOOL_STATE_NAME,
        TCP_TOOL_EVT_TYPES,
        TCP_TOOL_ENCODING
    } from '../../const/toolsConst';

    defineOptions({
        name: 'TcpTool'
    });

    const PAGE_ID = 'tools-tcp-tool';

    const connectForm = reactive({
        host: '127.0.0.1',
        port: 179,
        timeout: 10000
    });

    const sendForm = reactive({
        encoding: TCP_TOOL_ENCODING.UTF8,
        data: ''
    });

    const conn = ref(null); // 当前唯一连接 { id, host, port, state, bytesSent, bytesReceived }
    const logs = ref([]);
    const connecting = ref(false);
    const sending = ref(false);
    const autoScroll = ref(true);
    const showText = ref(true);
    const logContainer = ref(null);

    const isConnected = computed(() => conn.value && conn.value.state === TCP_TOOL_STATE.CONNECTED);

    const stateName = computed(() => (conn.value ? TCP_TOOL_STATE_NAME[conn.value.state] : '未连接'));

    // 结合项目主色调 #1890ff，用实心标签清晰区分「有效（已连接）」与「禁用（未连接/已关闭）」
    const stateColor = computed(() => {
        if (!conn.value) {
            return '#8c8c8c'; // 未连接（禁用态）
        }
        switch (conn.value.state) {
            case TCP_TOOL_STATE.CONNECTED:
                return '#1890ff'; // 已连接（有效态）- 主色
            case TCP_TOOL_STATE.CONNECTING:
                return '#faad14'; // 连接中
            case TCP_TOOL_STATE.ERROR:
                return '#ff4d4f'; // 错误
            default:
                return '#8c8c8c'; // 已关闭（禁用态）
        }
    });

    const sendPlaceholder = computed(() =>
        sendForm.encoding === TCP_TOOL_ENCODING.HEX
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

    const connect = async () => {
        if (isConnected.value) {
            return;
        }
        connecting.value = true;
        try {
            const result = await window.toolsApi.tcpConnect({
                host: connectForm.host,
                port: connectForm.port,
                timeout: connectForm.timeout
            });
            if (result.status !== 'success') {
                message.error(result.msg || '连接失败');
                return;
            }
            const { id, host, port } = result.data;
            conn.value = {
                id,
                host,
                port,
                state: TCP_TOOL_STATE.CONNECTING,
                bytesSent: 0,
                bytesReceived: 0
            };
            addLog('info', '连接', `正在连接 ${host}:${port}`);
        } catch (error) {
            message.error('连接失败: ' + error.message);
        } finally {
            connecting.value = false;
        }
    };

    const send = async () => {
        if (!isConnected.value) {
            message.warning('请先建立连接');
            return;
        }
        sending.value = true;
        try {
            const result = await window.toolsApi.tcpSend({
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
        if (sendForm.encoding === TCP_TOOL_ENCODING.UTF8) {
            return `${length} 字节: ${sendForm.data}`;
        }
        return `${length} 字节 (${sendForm.encoding}): ${sendForm.data}`;
    };

    const disconnect = async () => {
        if (!conn.value) {
            return;
        }
        try {
            await window.toolsApi.tcpClose({ id: conn.value.id });
        } catch (error) {
            message.error('结束连接失败: ' + error.message);
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
        conn.value.bytesSent = data.bytesSent;
        conn.value.bytesReceived = data.bytesReceived;
        if (data.state === TCP_TOOL_STATE.ERROR) {
            addLog('error', '错误', data.message || '连接错误');
        } else if (data.state === TCP_TOOL_STATE.CLOSED) {
            addLog('info', '关闭', '连接已关闭');
        } else if (data.state === TCP_TOOL_STATE.CONNECTED) {
            addLog('info', '已连接', `${data.remoteAddress || ''}:${data.remotePort || ''}`);
        }
    };

    const handleData = data => {
        if (!conn.value || data.id !== conn.value.id) {
            return;
        }
        conn.value.bytesReceived = data.totalReceived;
        const body = showText.value ? `${data.dataHex}  |  ${data.dataText}` : data.dataHex;
        addLog('recv', '接收', `${data.length} 字节: ${body}`);
    };

    onActivated(() => {
        EventBus.on(TCP_TOOL_EVT_TYPES.STATE_CHANGE, PAGE_ID, handleStateChange);
        EventBus.on(TCP_TOOL_EVT_TYPES.DATA, PAGE_ID, handleData);
    });

    onDeactivated(() => {
        EventBus.off(TCP_TOOL_EVT_TYPES.STATE_CHANGE, PAGE_ID);
        EventBus.off(TCP_TOOL_EVT_TYPES.DATA, PAGE_ID);
    });

    defineExpose({
        clearValidationErrors: () => {}
    });
</script>

<style scoped>
    .tcp-tool-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .tcp-config-card,
    .tcp-send-card {
        flex: 0 0 auto;
    }

    /* 主按钮（建立连接/发送）对齐项目主色调 #1890ff，有效态醒目、禁用态保留默认灰 */
    .tcp-tool-page :deep(.ant-btn-primary:not(:disabled)) {
        background-color: #1890ff;
        border-color: #1890ff;
    }

    .tcp-tool-page :deep(.ant-btn-primary:not(:disabled):hover) {
        background-color: #40a9ff;
        border-color: #40a9ff;
    }

    /* 编码切换：选中态使用主色实心填充 */
    .tcp-tool-page :deep(.ant-radio-button-wrapper-checked) {
        background-color: #1890ff;
        border-color: #1890ff;
    }

    .tcp-tool-page :deep(.ant-radio-button-wrapper-checked:hover) {
        background-color: #40a9ff;
        border-color: #40a9ff;
    }

    .tcp-config-form :deep(.ant-form-item) {
        margin-bottom: 0;
    }

    .tcp-encoding-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
    }

    .tcp-encoding-label {
        color: rgba(0, 0, 0, 0.85);
        font-size: 14px;
    }

    .tcp-send-input {
        font-family: 'Courier New', Courier, monospace;
    }

    .tcp-send-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 8px;
    }

    .tcp-traffic-info {
        color: #888;
        font-size: 12px;
    }

    .tcp-recv-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .tcp-recv-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 8px 12px;
    }

    .tcp-recv-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 8px;
    }

    .tcp-log-list {
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

    .tcp-log-empty {
        color: #777;
        text-align: center;
        padding-top: 12px;
    }

    .tcp-log-item {
        white-space: pre-wrap;
        word-break: break-all;
    }

    .tcp-log-time {
        color: #6a9955;
        margin-right: 8px;
    }

    .tcp-log-tag {
        display: inline-block;
        width: 42px;
        margin-right: 8px;
        text-align: center;
        border-radius: 2px;
        background: #333;
        color: #ccc;
    }

    .tcp-log-recv .tcp-log-tag {
        background: #2d5a2d;
        color: #b5f5b5;
    }

    .tcp-log-send .tcp-log-tag {
        background: #1f4e7a;
        color: #a6d8ff;
    }

    .tcp-log-error .tcp-log-tag {
        background: #6b2222;
        color: #ffb3b3;
    }

    .tcp-log-recv .tcp-log-text {
        color: #9cdc9c;
    }

    .tcp-log-send .tcp-log-text {
        color: #9cd2ff;
    }

    .tcp-log-error .tcp-log-text {
        color: #ff9c9c;
    }
</style>
