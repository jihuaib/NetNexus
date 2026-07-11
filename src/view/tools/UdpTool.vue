<template>
    <div class="mt-container udp-tool-page">
        <!-- Socket 配置 -->
        <nn-card title="UDP 配置" class="udp-config-card" size="small">
            <template #extra>
                <nn-tag :color="stateColor">{{ stateName }}</nn-tag>
            </template>
            <nn-form layout="inline" :model="socketForm" class="udp-config-form">
                <nn-form-item label="目标地址">
                    <nn-input
                        v-model:value="socketForm.host"
                        placeholder="127.0.0.1"
                        :disabled="isActive"
                        style="width: 160px"
                        @press-enter="open"
                    />
                </nn-form-item>
                <nn-form-item label="目标端口">
                    <nn-input-number
                        v-model:value="socketForm.port"
                        :min="1"
                        :max="65535"
                        :disabled="isActive"
                        placeholder="9000"
                        style="width: 110px"
                    />
                </nn-form-item>
                <nn-form-item label="本地端口">
                    <nn-input-number
                        v-model:value="socketForm.localPort"
                        :min="0"
                        :max="65535"
                        :disabled="isActive"
                        placeholder="0=随机"
                        style="width: 120px"
                    />
                </nn-form-item>
                <nn-form-item>
                    <nn-button v-if="!isActive" type="primary" :loading="opening" @click="open">打开</nn-button>
                    <nn-button v-else danger @click="closeSocket">关闭</nn-button>
                </nn-form-item>
            </nn-form>
        </nn-card>

        <!-- 发送报文 -->
        <nn-card title="发送报文" class="udp-send-card" size="small">
            <div class="udp-encoding-row">
                <span class="udp-encoding-label">编码方式</span>
                <nn-radio-group v-model:value="sendForm.encoding" button-style="solid">
                    <nn-radio-button :value="UDP_TOOL_ENCODING.UTF8">文本</nn-radio-button>
                    <nn-radio-button :value="UDP_TOOL_ENCODING.HEX">十六进制</nn-radio-button>
                    <nn-radio-button :value="UDP_TOOL_ENCODING.BASE64">Base64</nn-radio-button>
                </nn-radio-group>
            </div>
            <nn-textarea
                v-model:value="sendForm.data"
                :rows="3"
                :placeholder="sendPlaceholder"
                class="udp-send-input"
            />
            <div class="udp-send-actions">
                <span v-if="conn" class="udp-traffic-info">
                    发送 {{ conn.bytesSent }} B / 接收 {{ conn.bytesReceived }} B
                </span>
                <nn-button type="primary" :loading="sending" :disabled="!isActive" @click="send">发送</nn-button>
            </div>
        </nn-card>

        <!-- 收包窗口 -->
        <nn-card title="收包窗口" class="udp-recv-card" size="small">
            <div ref="logContainer" class="udp-log-list">
                <nn-empty v-if="logs.length === 0" description="暂无收包数据" class="udp-log-empty" />
                <div v-for="(log, index) in logs" :key="index" class="udp-log-item" :class="`udp-log-${log.type}`">
                    <span class="udp-log-time">{{ log.time }}</span>
                    <span class="udp-log-tag">{{ log.tag }}</span>
                    <span class="udp-log-text">{{ log.text }}</span>
                </div>
            </div>
            <div class="udp-recv-toolbar">
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

    const stateColor = computed(() => {
        if (!conn.value) {
            return 'red';
        }
        switch (conn.value.state) {
            case UDP_TOOL_STATE.LISTENING:
                return 'green';
            case UDP_TOOL_STATE.OPENING:
                return 'blue';
            case UDP_TOOL_STATE.ERROR:
                return 'red';
            default:
                return 'red';
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
                notify.error(result.msg || '打开失败');
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
            notify.error('打开失败: ' + error.message);
        } finally {
            opening.value = false;
        }
    };

    const send = async () => {
        if (!isActive.value) {
            notify.warning('请先打开 socket');
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
            notify.error('关闭失败: ' + error.message);
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

    .udp-config-card :deep(.nn-tag) {
        min-width: 64px;
        margin-inline-end: 0;
        text-align: center;
        font-weight: 500;
    }

    /* 主按钮（打开/发送）对齐项目主色调，有效态醒目、禁用态保留默认灰 */
    .udp-tool-page :deep(.nn-button-primary:not(:disabled)) {
        background-color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
    }

    .udp-tool-page :deep(.nn-button-primary:not(:disabled):hover) {
        background-color: var(--nn-color-primary-hover);
        border-color: var(--nn-color-primary-hover);
    }

    /* 编码切换：选中态使用主色实心填充 */
    .udp-tool-page :deep(.nn-radio-button-checked) {
        background-color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
    }

    .udp-tool-page :deep(.nn-radio-button-checked:hover) {
        background-color: var(--nn-color-primary-hover);
        border-color: var(--nn-color-primary-hover);
    }

    .udp-config-form :deep(.nn-form-item) {
        margin-bottom: 0;
    }

    .udp-encoding-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
    }

    .udp-encoding-label {
        color: var(--nn-color-text);
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
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .udp-recv-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .udp-recv-card :deep(.nn-card-body) {
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
        background: var(--nn-color-bg-console);
        color: var(--nn-color-text-console);
        border-radius: 4px;
        padding: 8px 10px;
    }

    .udp-log-empty {
        height: 100%;
        min-height: 110px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family:
            -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
        color: var(--nn-color-text-console-muted);
    }

    .udp-log-empty :deep(.nn-empty-normal) {
        margin: 0;
    }

    .udp-log-empty :deep(.nn-empty-description) {
        color: var(--nn-color-text-console-muted);
        font-size: 12px;
    }

    .udp-log-item {
        white-space: pre-wrap;
        word-break: break-all;
    }

    .udp-log-time {
        color: var(--nn-color-text-console-success);
        margin-right: 8px;
    }

    .udp-log-tag {
        display: inline-block;
        width: 42px;
        margin-right: 8px;
        text-align: center;
        border-radius: 2px;
        background: var(--nn-color-bg-console-muted);
        color: var(--nn-color-text-console-label);
    }

    .udp-log-recv .udp-log-tag {
        background: var(--nn-color-bg-console-success);
        color: var(--nn-color-text-console-success-strong);
    }

    .udp-log-send .udp-log-tag {
        background: var(--nn-color-bg-console-info);
        color: var(--nn-color-text-console-info-strong);
    }

    .udp-log-error .udp-log-tag {
        background: var(--nn-color-bg-console-error);
        color: var(--nn-color-text-console-error-strong);
    }

    .udp-log-recv .udp-log-text {
        color: var(--nn-color-text-console-success);
    }

    .udp-log-send .udp-log-text {
        color: var(--nn-color-text-console-info);
    }

    .udp-log-error .udp-log-text {
        color: var(--nn-color-text-console-error);
    }
</style>
