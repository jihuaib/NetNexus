<template>
    <nn-modal
        :open="open"
        title="发送 BGP 原始报文"
        :width="720"
        :mask-closable="false"
        :closable="!sending"
        :keyboard="!sending"
        data-testid="bgp-raw-packet-modal"
        @cancel="close"
    >
        <div class="bgp-raw-packet-content">
            <div class="bgp-raw-packet-peer">
                <span data-testid="bgp-raw-packet-peer">邻居：{{ peer?.peerIp }}</span>
                <nn-tag :color="established ? 'green' : 'orange'" data-testid="bgp-raw-packet-status">
                    {{ peerState }}
                </nn-tag>
            </div>
            <nn-alert
                type="info"
                message="粘贴完整 BGP 报文的十六进制内容（含 BGP 头，不含 Ethernet、IP 或 TCP 头）。支持连续十六进制或空白分隔，可拼接多条完整报文；每条报文为 19～4096 字节。报文内容按原始字节发送。"
                show-icon
            />
            <p class="bgp-raw-packet-hint">仅在 BGP 邻居处于 Established 状态时手动发送；连接恢复后不会自动补发。</p>
            <nn-alert
                v-if="!established"
                type="warning"
                message="邻居尚未建立或连接已断开，当前不能发送。"
                show-icon
                data-testid="bgp-raw-packet-disconnected"
            />
            <label for="bgp-raw-packet-input">BGP 报文（十六进制）</label>
            <nn-textarea
                id="bgp-raw-packet-input"
                v-model:value="packetHex"
                height="220px"
                resize="vertical"
                :disabled="sending"
                placeholder="例如 KEEPALIVE：FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF001304"
                class="bgp-raw-packet-input"
                data-testid="bgp-raw-packet-input"
            />
            <nn-alert
                v-if="resultMessage"
                :type="resultType"
                :message="resultMessage"
                show-icon
                role="status"
                aria-live="polite"
                data-testid="bgp-raw-packet-result"
            />
        </div>
        <template #footer>
            <nn-button :disabled="sending" data-testid="bgp-raw-packet-close" @click="close">关闭</nn-button>
            <nn-button
                type="primary"
                :loading="sending"
                :disabled="!established || sending || !packetHex.trim()"
                data-testid="bgp-raw-packet-send"
                @click="send"
            >
                发送原始报文
            </nn-button>
        </template>
    </nn-modal>
</template>

<script setup>
    import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';

    const props = defineProps({
        open: { type: Boolean, default: false },
        peer: { type: Object, default: null },
        peerState: { type: String, default: 'Unavailable' }
    });
    const emit = defineEmits(['update:open']);
    const packetHex = ref('');
    const sending = ref(false);
    const resultMessage = ref('');
    const resultType = ref('error');
    const established = computed(() => props.peerState === 'Established');
    let requestGeneration = 0;

    const resetDraft = () => {
        // Ignore any previous IPC result; this does not cancel bytes already being sent.
        requestGeneration += 1;
        sending.value = false;
        packetHex.value = '';
        resultMessage.value = '';
        resultType.value = 'error';
    };

    watch(
        [() => props.open, () => props.peer?.peerIp, () => props.peer?.vrfIndex, () => props.peer?.addressFamily],
        resetDraft,
        { flush: 'sync' }
    );
    onDeactivated(resetDraft);
    onBeforeUnmount(resetDraft);
    watch(packetHex, () => {
        resultMessage.value = '';
    });

    const close = () => {
        if (!sending.value) emit('update:open', false);
    };

    const validatePacketHex = value => {
        const hex = value.replace(/\s/g, '');
        if (!hex || !/^[\da-f]+$/i.test(hex)) {
            return '请输入十六进制字符（0-9、A-F），仅允许空格或换行等空白分隔。';
        }
        if (hex.length % 2 !== 0) return '十六进制字符数必须为偶数，每两个字符表示一个字节。';

        let offset = 0;
        let packetCount = 0;
        while (offset < hex.length) {
            const packetLabel = `第 ${packetCount + 1} 条报文`;
            if (hex.length - offset < 38) return `${packetLabel}不完整：BGP 头至少需要 19 字节。`;
            if (!/^f{32}$/i.test(hex.slice(offset, offset + 32))) {
                return `${packetLabel}的 BGP Marker 必须为连续 16 个 FF 字节。`;
            }
            const length = parseInt(hex.slice(offset + 32, offset + 36), 16);
            if (length < 19 || length > 4096) return `${packetLabel}的 BGP 长度必须在 19～4096 字节之间。`;
            if (hex.length - offset < length * 2) return `${packetLabel}不完整：内容少于 BGP 头声明的长度。`;
            const type = parseInt(hex.slice(offset + 36, offset + 38), 16);
            if (type < 1 || type > 5) return `${packetLabel}的 BGP 类型必须为 1～5。`;
            const minimumLengths = { 1: 29, 2: 23, 3: 21, 4: 19, 5: 23 };
            if (length < minimumLengths[type]) {
                return `${packetLabel}的类型 ${type} 至少需要 ${minimumLengths[type]} 字节。`;
            }
            if (type === 4 && length !== 19) return `${packetLabel}为 KEEPALIVE，长度必须为 19 字节。`;
            offset += length * 2;
            packetCount += 1;
        }
        return '';
    };

    const send = async () => {
        if (!props.open || sending.value) return;
        resultType.value = 'error';
        if (!established.value || !props.peer?.peerIp) {
            resultMessage.value = '邻居尚未建立或连接已断开，当前不能发送。';
            return;
        }
        resultMessage.value = validatePacketHex(packetHex.value);
        if (resultMessage.value) return;

        const requestId = ++requestGeneration;
        const payload = {
            vrfIndex: props.peer.vrfIndex || 0,
            peerIp: props.peer.peerIp,
            packetHex: packetHex.value
        };
        const addressFamily = props.peer.addressFamily;
        const isCurrentRequest = () =>
            requestId === requestGeneration &&
            props.open &&
            props.peer?.peerIp === payload.peerIp &&
            (props.peer?.vrfIndex || 0) === payload.vrfIndex &&
            props.peer?.addressFamily === addressFamily;

        sending.value = true;
        try {
            const result = await window.bgpApi.sendRawPacket(payload);
            if (!isCurrentRequest()) return;
            if (result?.status !== 'success') {
                resultMessage.value = result?.msg || '原始报文发送失败';
                return;
            }
            resultType.value = 'success';
            resultMessage.value = `已发送 ${result.data.packetCount} 条 BGP 报文，共 ${result.data.byteLength} 字节。`;
        } catch (error) {
            if (isCurrentRequest()) resultMessage.value = error?.message || '原始报文发送失败';
        } finally {
            if (isCurrentRequest()) sending.value = false;
        }
    };
</script>

<style scoped>
    .bgp-raw-packet-content {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .bgp-raw-packet-peer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }

    .bgp-raw-packet-hint {
        margin: 0;
        color: var(--nn-color-text-secondary);
    }

    .bgp-raw-packet-input {
        font-family: monospace;
    }
</style>
