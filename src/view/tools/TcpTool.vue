<template>
    <div class="nn-container tcp-tool-page">
        <!-- 连接配置 -->
        <nn-card title="连接配置" class="tcp-config-card" size="small">
            <template #extra>
                <nn-tag :color="stateColor" role="status" aria-live="polite">{{ stateName }}</nn-tag>
            </template>
            <nn-form layout="inline" :model="connectForm" class="tcp-config-form">
                <nn-form-item label="目标地址">
                    <nn-input
                        v-model:value="connectForm.host"
                        placeholder="127.0.0.1"
                        :disabled="isConnected"
                        style="width: 160px"
                        @press-enter="connect"
                    />
                </nn-form-item>
                <nn-form-item label="端口">
                    <nn-input-number
                        v-model:value="connectForm.port"
                        :min="1"
                        :max="65535"
                        :disabled="isConnected"
                        placeholder="179"
                        style="width: 110px"
                    />
                </nn-form-item>
                <nn-form-item label="超时(ms)">
                    <nn-input-number
                        v-model:value="connectForm.timeout"
                        :min="1000"
                        :max="600000"
                        :step="1000"
                        :disabled="isConnected"
                        style="width: 120px"
                    />
                </nn-form-item>
                <nn-form-item>
                    <nn-button v-if="!isConnected" type="primary" :loading="connecting" @click="connect">
                        建立连接
                    </nn-button>
                    <nn-button v-else danger @click="disconnect">结束连接</nn-button>
                </nn-form-item>
            </nn-form>
        </nn-card>

        <!-- 发送报文 -->
        <nn-card title="发送报文" class="tcp-send-card" size="small">
            <div class="tcp-encoding-row">
                <span class="tcp-encoding-label">编码方式</span>
                <nn-radio-group v-model:value="sendForm.encoding" button-style="solid">
                    <nn-radio-button :value="TCP_TOOL_ENCODING.UTF8">文本</nn-radio-button>
                    <nn-radio-button :value="TCP_TOOL_ENCODING.HEX">十六进制</nn-radio-button>
                    <nn-radio-button :value="TCP_TOOL_ENCODING.BASE64">Base64</nn-radio-button>
                </nn-radio-group>
            </div>
            <nn-textarea
                v-model:value="sendForm.data"
                :rows="3"
                :placeholder="sendPlaceholder"
                class="tcp-send-input"
            />
            <div class="tcp-send-actions">
                <span v-if="conn" class="tcp-traffic-info">
                    发送 {{ conn.bytesSent }} B / 接收 {{ conn.bytesReceived }} B
                </span>
                <nn-button type="primary" :loading="sending" :disabled="!isConnected" @click="send">发送</nn-button>
            </div>
        </nn-card>

        <!-- 收包窗口 -->
        <nn-card title="收包窗口" class="tcp-recv-card" size="small">
            <div ref="logContainer" class="tcp-log-list nn-packet-log">
                <nn-empty
                    v-if="logs.length === 0"
                    description="暂无收包数据"
                    class="tcp-log-empty nn-packet-log-empty"
                />
                <div
                    v-for="(log, index) in logs"
                    :key="index"
                    class="tcp-log-item nn-packet-log-item"
                    :class="[`tcp-log-${log.type}`, `nn-packet-log-${log.type}`]"
                >
                    <span class="tcp-log-time nn-packet-log-time">{{ log.time }}</span>
                    <span class="tcp-log-tag nn-packet-log-tag">{{ log.tag }}</span>
                    <span class="tcp-log-text nn-packet-log-text">{{ log.text }}</span>
                </div>
            </div>
            <div class="tcp-recv-toolbar">
                <nn-checkbox v-model:checked="autoScroll">自动滚动</nn-checkbox>
                <nn-checkbox v-model:checked="showText">显示文本</nn-checkbox>
                <nn-button size="small" @click="clearLogs">清空</nn-button>
            </div>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, reactive, computed, nextTick, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import { TCP_TOOL_STATE, TCP_TOOL_STATE_NAME, TCP_TOOL_EVT_TYPES, TCP_TOOL_ENCODING } from '../../const/toolsConst';

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

    const stateColor = computed(() => {
        if (!conn.value) {
            return 'red';
        }
        switch (conn.value.state) {
            case TCP_TOOL_STATE.CONNECTED:
                return 'green';
            case TCP_TOOL_STATE.CONNECTING:
                return 'blue';
            case TCP_TOOL_STATE.ERROR:
                return 'red';
            default:
                return 'red';
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
                notify.error(result.msg || '连接失败');
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
            notify.error('连接失败: ' + error.message);
        } finally {
            connecting.value = false;
        }
    };

    const send = async () => {
        if (!isConnected.value) {
            notify.warning('请先建立连接');
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
                notify.error(result.msg || '发送失败');
                return;
            }
            conn.value.bytesSent += result.data.length;
            addLog('send', '发送', formatSent(result.data.length));
        } catch (error) {
            notify.error('发送失败: ' + error.message);
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
            notify.error('结束连接失败: ' + error.message);
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
        height: 100%;
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

    .tcp-config-card :deep(.nn-tag) {
        min-width: 64px;
        margin-inline-end: 0;
        text-align: center;
        font-weight: 500;
    }

    /* 主按钮（建立连接/发送）对齐项目主色调，有效态醒目、禁用态保留默认灰 */
    .tcp-tool-page :deep(.nn-button-primary:not(:disabled)) {
        background-color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
    }

    .tcp-tool-page :deep(.nn-button-primary:not(:disabled):hover) {
        background-color: var(--nn-color-primary-hover);
        border-color: var(--nn-color-primary-hover);
    }

    /* 编码切换：选中态使用主色实心填充 */
    .tcp-tool-page :deep(.nn-radio-button-checked) {
        background-color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
    }

    .tcp-tool-page :deep(.nn-radio-button-checked:hover) {
        background-color: var(--nn-color-primary-hover);
        border-color: var(--nn-color-primary-hover);
    }

    .tcp-config-form :deep(.nn-form-item) {
        margin-bottom: 0;
    }

    .tcp-encoding-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
    }

    .tcp-encoding-label {
        color: var(--nn-color-text);
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
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .tcp-recv-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .tcp-recv-card :deep(.nn-card-body) {
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
</style>
