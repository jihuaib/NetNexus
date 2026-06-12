<template>
    <div class="mt-container tcpao-page">
        <a-card title="TCP-AO MAC 计算器" class="tcpao-card">
            <a-form :model="formState" layout="vertical" class="tcpao-form" @finish="handleCalculate">
                <div class="tcpao-layout">
                    <div class="tcpao-main">
                        <div class="panel-block">
                            <div class="panel-title">输入上下文</div>
                            <a-row :gutter="12">
                                <a-col :xs="24" :lg="12">
                                    <a-form-item label="密钥 (Key)" name="key" class="compact-item">
                                        <a-tooltip :title="validationErrors.key" :open="!!validationErrors.key">
                                            <a-input
                                                v-model:value="formState.key"
                                                placeholder="如: mypassword"
                                                :status="validationErrors.key ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                                <a-col :xs="24" :lg="12">
                                    <a-form-item label="SNE（可选）" name="sne" class="compact-item">
                                        <a-tooltip :title="validationErrors.sne" :open="!!validationErrors.sne">
                                            <ScrollTextarea
                                                v-model:model-value="formState.sne"
                                                :height="44"
                                                placeholder="SNE（4字节hex）"
                                                :status="validationErrors.sne ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                            </a-row>

                            <a-row v-if="showKdfIsnInputs" :gutter="12">
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="ISN A（可选）" name="isnA" class="compact-item">
                                        <a-tooltip :title="validationErrors.isnA" :open="!!validationErrors.isnA">
                                            <a-input
                                                v-model:value="formState.isnA"
                                                placeholder="留空取报文 Seq"
                                                :status="validationErrors.isnA ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="ISN B（可选）" name="isnB" class="compact-item">
                                        <a-tooltip :title="validationErrors.isnB" :open="!!validationErrors.isnB">
                                            <a-input
                                                v-model:value="formState.isnB"
                                                placeholder="留空取报文 Ack"
                                                :status="validationErrors.isnB ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-col>
                            </a-row>
                            <div v-if="showKdfIsnInputs" class="field-hint">
                                仅覆盖 KDF 使用的 ISN，上层报文里的 Seq/Ack 不会被修改。
                            </div>
                        </div>

                        <div class="panel-block panel-block-grow packet-panel">
                            <div class="panel-title">报文输入</div>
                            <a-form-item
                                label="IP 报文"
                                name="ipPacket"
                                class="compact-item packet-item"
                                :validate-status="validationErrors.ipPacket ? 'error' : ''"
                                :help="validationErrors.ipPacket || ''"
                            >
                                <div class="packet-textarea-wrap">
                                    <ScrollTextarea
                                        v-model:model-value="formState.ipPacket"
                                        height="100%"
                                        placeholder="完整 IPv4 / IPv6 报文（hex），自动识别版本"
                                        :status="validationErrors.ipPacket ? 'error' : ''"
                                    />
                                </div>
                            </a-form-item>
                        </div>
                    </div>

                    <div class="tcpao-side">
                        <div class="panel-block">
                            <div class="panel-title">算法</div>
                            <a-form-item label="MAC 算法" class="compact-item">
                                <a-radio-group v-model:value="algorithm" class="choice-grid algo-grid">
                                    <a-radio value="hmac-md5">HMAC-MD5</a-radio>
                                    <a-radio value="hmac-sha1">HMAC-SHA1-12</a-radio>
                                    <a-radio value="hmac-sha1-20">HMAC-SHA1-20</a-radio>
                                    <a-radio value="hmac-sha256">HMAC-SHA-256</a-radio>
                                    <a-radio value="hmac-sha384">HMAC-SHA-384</a-radio>
                                    <a-radio value="hmac-sha512">HMAC-SHA-512</a-radio>
                                    <a-radio value="hmac-sm3">HMAC-SM3</a-radio>
                                    <a-radio value="aes-cmac">AES-128-CMAC</a-radio>
                                    <a-radio value="md5">MD5</a-radio>
                                    <a-radio value="sha1">SHA-1</a-radio>
                                    <a-radio value="sha256">SHA-256</a-radio>
                                    <a-radio value="sm3">SM3</a-radio>
                                </a-radio-group>
                            </a-form-item>
                        </div>

                        <div class="panel-block">
                            <div class="panel-title panel-title-row">
                                <span>KDF 与消息构造</span>
                                <a-tooltip v-if="isPlainAlgo && !skipKdf">
                                    <template #title>
                                        非 H 算法固定使用
                                        <code>hash(kdfInput ‖ key)</code>
                                        派生 Traffic Key，MAC 固定使用
                                        <code>hash(msg ‖ key)</code>
                                        。
                                    </template>
                                    <InfoCircleOutlined class="mode-info-icon" />
                                </a-tooltip>
                            </div>

                            <a-form-item v-if="isKdfAlgo" class="compact-item compact-flag">
                                <a-checkbox v-model:checked="skipKdf">跳过 KDF（直接用 master key）</a-checkbox>
                            </a-form-item>

                            <a-form-item label="TCP 选项" class="compact-item">
                                <div class="stacked-checks">
                                    <a-checkbox v-model:checked="includeOtherOptions">包含其他 TCP 选项</a-checkbox>
                                    <a-checkbox v-model:checked="includePseudoHeader">包含 IP 伪头部</a-checkbox>
                                </div>
                            </a-form-item>
                        </div>

                        <div class="action-bar">
                            <a-button type="primary" html-type="submit">计算 MAC</a-button>
                            <a-button @click="clearAll">清空</a-button>
                        </div>
                    </div>
                </div>
            </a-form>
        </a-card>

        <!-- 计算结果弹出框 -->
        <a-modal v-model:open="showResultModal" title="MAC 计算结果" :footer="null" width="680px">
            <template v-if="result">
                <a-descriptions :column="1" bordered size="small">
                    <a-descriptions-item :label="pseudoHeaderLabel">
                        <div class="result-row">
                            <span style="font-family: monospace; word-break: break-all">
                                {{ result.pseudoHeaderHex }}
                            </span>
                            <a-button size="small" @click="copyToClipboard(result.pseudoHeaderHex)">复制</a-button>
                        </div>
                        <div class="field-hint">{{ pseudoHeaderHint }}</div>
                    </a-descriptions-item>
                    <a-descriptions-item
                        v-if="result.trafficKeyHex !== undefined && result.trafficKeyHex !== null"
                        label="Traffic Key"
                    >
                        <div class="result-row">
                            <span style="font-family: monospace; word-break: break-all">
                                {{ result.trafficKeyHex }}
                            </span>
                            <a-button size="small" @click="copyToClipboard(result.trafficKeyHex)">复制</a-button>
                        </div>
                        <div class="field-hint">KDF 派生的 Traffic Key</div>
                    </a-descriptions-item>
                    <a-descriptions-item label="消息体">
                        <div class="result-row">
                            <span style="font-family: monospace; word-break: break-all">{{ result.messageHex }}</span>
                            <a-button size="small" @click="copyToClipboard(result.messageHex)">复制</a-button>
                        </div>
                        <div class="field-hint">SNE（可选） + 伪头部（可选） + TCP 段</div>
                    </a-descriptions-item>
                    <a-descriptions-item label="MAC（完整）">
                        <div class="result-row">
                            <span style="font-family: monospace">{{ result.mac }}</span>
                            <a-button size="small" @click="copyToClipboard(result.mac)">复制</a-button>
                        </div>
                    </a-descriptions-item>
                    <a-descriptions-item :label="`MAC（前${result.macLen}字节）`">
                        <div class="result-row">
                            <span style="font-family: monospace">{{ result.mac96 }}</span>
                            <a-button size="small" @click="copyToClipboard(result.mac96)">复制</a-button>
                        </div>
                        <div class="field-hint">TCP-AO 报文字段中实际填入的 MAC 值</div>
                    </a-descriptions-item>
                </a-descriptions>
            </template>
        </a-modal>
    </div>
</template>

<script setup>
    import ScrollTextarea from '../../components/ScrollTextarea.vue';
    import { InfoCircleOutlined } from '@ant-design/icons-vue';
    import { ref, computed, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { FormValidator, createTcpAoMacValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'TcpAoMac'
    });

    const validationErrors = ref({ key: '', sne: '', ipPacket: '', isnA: '', isnB: '' });
    const validator = new FormValidator(validationErrors);
    validator.addRules(createTcpAoMacValidationRules());

    defineExpose({
        clearValidationErrors: () => {
            validator.clearErrors();
        }
    });
    const result = ref(null);
    const showResultModal = ref(false);
    const formState = ref({ key: '', sne: '', ipPacket: '', isnA: '', isnB: '' });
    const includeOtherOptions = ref(true);
    const algorithm = ref('hmac-sha1');
    const skipKdf = ref(false);

    const PLAIN_ALGOS = ['md5', 'sha1', 'sha256', 'sm3'];
    const HMAC_ALGOS = [
        'hmac-sha1',
        'hmac-sha1-20',
        'hmac-md5',
        'hmac-sha256',
        'hmac-sha384',
        'hmac-sha512',
        'hmac-sm3',
        'aes-cmac'
    ];
    const isPlainAlgo = computed(() => PLAIN_ALGOS.includes(algorithm.value));
    const isHmacAlgo = computed(() => HMAC_ALGOS.includes(algorithm.value));
    const isKdfAlgo = computed(() => isHmacAlgo.value || isPlainAlgo.value);
    const showKdfIsnInputs = computed(() => isKdfAlgo.value && !skipKdf.value);
    const includePseudoHeader = ref(true);

    const pseudoHeaderLabel = computed(() => (result.value?.ipVersion === 6 ? 'IPv6 伪头部' : 'IPv4 伪头部'));
    const pseudoHeaderHint = computed(() =>
        result.value?.ipVersion === 6
            ? '源IP(16) + 目的IP(16) + 上层包长度(4) + 零(3) + Next Header(1)'
            : '源IP(4) + 目的IP(4) + 00(1) + 协议(1) + TCP段长度(2)'
    );

    const saveState = () => {
        window.toolsApi.saveTcpAoMacState({
            formState: { ...formState.value },
            algorithm: algorithm.value,
            skipKdf: skipKdf.value,
            includeOtherOptions: includeOtherOptions.value,
            includePseudoHeader: includePseudoHeader.value
        });
    };

    onMounted(async () => {
        const resp = await window.toolsApi.getTcpAoMacState();
        if (resp.status === 'success' && resp.data) {
            const s = resp.data;
            if (s.formState) formState.value = s.formState;
            if (s.algorithm) algorithm.value = s.algorithm;
            if (s.skipKdf !== undefined) skipKdf.value = s.skipKdf;
            if (s.includeOtherOptions !== undefined) includeOtherOptions.value = s.includeOtherOptions;
            if (s.includePseudoHeader !== undefined) includePseudoHeader.value = s.includePseudoHeader;
        }
    });

    const handleCalculate = async () => {
        if (validator.validate(formState.value)) {
            message.error('请检查输入是否正确');
            return;
        }

        try {
            const resp = await window.toolsApi.calculateTcpAoMac({
                key: formState.value.key,
                sne: formState.value.sne,
                ipPacket: formState.value.ipPacket,
                includeOtherOptions: includeOtherOptions.value,
                algorithm: algorithm.value,
                skipKdf: skipKdf.value,
                isnA: formState.value.isnA,
                isnB: formState.value.isnB,
                includePseudoHeader: includePseudoHeader.value
            });

            if (resp.status === 'success') {
                result.value = resp.data;
                showResultModal.value = true;
                saveState();
            } else {
                message.error(resp.msg || '计算失败');
                result.value = null;
            }
        } catch (e) {
            message.error(e.message || String(e));
            result.value = null;
        }
    };

    const clearAll = () => {
        formState.value = { key: '', sne: '', ipPacket: '', isnA: '', isnB: '' };
        validator.clearErrors();
        includeOtherOptions.value = true;
        algorithm.value = 'hmac-sha1';
        skipKdf.value = false;
        includePseudoHeader.value = true;
        result.value = null;
        showResultModal.value = false;
    };

    const copyToClipboard = text => {
        try {
            const el = document.createElement('textarea');
            el.value = text;
            el.style.position = 'fixed';
            el.style.opacity = '0';
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            message.success('已复制到剪贴板');
        } catch (_e) {
            message.error('复制失败');
        }
    };
</script>

<style scoped>
    .tcpao-page {
        min-height: 0;
        overflow: hidden;
    }

    .tcpao-card {
        display: flex;
        flex-direction: column;
        height: calc(100vh - 70px);
        overflow: hidden;
    }

    .tcpao-card :deep(.ant-card-head) {
        min-height: 38px !important;
    }

    .tcpao-card :deep(.ant-card-head-title) {
        padding: 8px 0 !important;
    }

    .tcpao-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        padding: 8px !important;
    }

    .tcpao-form {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .tcpao-form :deep(.ant-form-item) {
        margin-bottom: 10px;
    }

    .tcpao-layout {
        flex: 1 1 0;
        display: grid;
        grid-template-columns: minmax(0, 1.55fr) minmax(300px, 0.9fr);
        gap: 12px;
        min-height: 0;
        overflow: hidden;
    }

    .tcpao-main,
    .tcpao-side {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
        min-height: 0;
    }

    .tcpao-main {
        overflow: hidden;
    }

    .tcpao-side {
        overflow: auto;
        padding-right: 4px;
    }

    .panel-block {
        padding: 12px;
        border: 1px solid #e8edf3;
        border-radius: 12px;
        background: linear-gradient(180deg, #fcfdff 0%, #f7f9fc 100%);
    }

    .panel-block-grow {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .packet-panel {
        overflow: hidden;
    }

    .packet-item {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .packet-item :deep(.ant-form-item-row),
    .packet-item :deep(.ant-form-item-control),
    .packet-item :deep(.ant-form-item-control-input),
    .packet-item :deep(.ant-form-item-control-input-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .packet-item :deep(.ant-form-item-label) {
        flex: 0 0 auto;
    }

    .packet-item :deep(.ant-form-item-control-input) {
        align-items: stretch;
    }

    .packet-item :deep(.ant-form-item-explain) {
        flex: 0 0 auto;
    }

    .packet-textarea-wrap {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
    }

    .packet-textarea-wrap :deep(textarea.ant-input) {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        height: auto !important;
    }

    .panel-title {
        margin-bottom: 10px;
        font-size: 13px;
        font-weight: 600;
        color: #334155;
        letter-spacing: 0.01em;
    }

    .panel-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .mode-info-icon {
        flex: 0 0 auto;
        color: #64748b;
        cursor: help;
        font-size: 14px;
    }

    .mode-info-icon:hover {
        color: #1677ff;
    }

    .compact-item:last-child {
        margin-bottom: 0;
    }

    .compact-flag {
        margin-bottom: 8px;
    }

    .choice-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        width: 100%;
    }

    .algo-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .choice-grid :deep(.ant-radio-wrapper) {
        margin-inline-end: 0;
        min-height: 34px;
        padding: 6px 8px;
        border: 1px solid #d7dee8;
        border-radius: 10px;
        background: #fff;
        display: flex;
        align-items: center;
        line-height: 1.35;
        transition:
            border-color 0.2s ease,
            background 0.2s ease,
            box-shadow 0.2s ease;
    }

    .choice-grid :deep(.ant-radio-wrapper:hover) {
        border-color: #91caff;
    }

    .choice-grid :deep(.ant-radio-wrapper-checked) {
        border-color: #1677ff;
        background: #eff6ff;
        box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.08);
    }

    .stacked-checks {
        display: grid;
        gap: 8px;
    }

    .stacked-checks :deep(.ant-checkbox-wrapper) {
        margin-inline-start: 0;
    }

    .action-bar {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 2px 0 0;
    }

    .field-hint {
        font-size: 12px;
        color: #64748b;
        margin-top: 4px;
    }

    .result-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
    }

    @media (max-width: 960px) {
        .tcpao-layout {
            grid-template-columns: 1fr;
            overflow: auto;
        }

        .tcpao-main {
            min-height: 520px;
            overflow: visible;
        }

        .algo-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }
    }

    @media (max-width: 860px) {
        .algo-grid {
            grid-template-columns: 1fr;
        }

        .panel-block {
            padding: 12px;
        }

        .action-bar {
            justify-content: stretch;
        }

        .action-bar :deep(.ant-btn) {
            flex: 1;
        }
    }
</style>
