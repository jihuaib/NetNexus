<template>
    <nn-drawer
        :open="open"
        title="NETCONF 执行记录"
        width="min(960px, calc(100vw - 24px))"
        placement="right"
        :body-style="{ padding: '0', overflow: 'hidden' }"
        @update:open="value => emit('update:open', value)"
    >
        <div class="execution-history-drawer">
            <div class="execution-history-toolbar">
                <div class="execution-history-summary">
                    <strong>本次运行 {{ records.length }} 条</strong>
                    <span>最新记录在前；关闭软件后自动清除</span>
                </div>
                <nn-popconfirm
                    title="确定清空全部 NETCONF 执行记录？"
                    ok-text="清空"
                    cancel-text="取消"
                    @confirm="clearAllHistory"
                >
                    <nn-button danger size="small" :disabled="records.length === 0" data-testid="netconf-history-clear">
                        <template #icon><DeleteOutlined /></template>
                        清空执行记录
                    </nn-button>
                </nn-popconfirm>
            </div>

            <div class="execution-history-content">
                <aside
                    ref="historyListRef"
                    class="execution-history-list"
                    role="listbox"
                    aria-label="NETCONF 执行记录列表"
                >
                    <nn-empty v-if="records.length === 0" description="暂无执行记录" />
                    <template v-else>
                        <button
                            v-for="(record, index) in records"
                            :key="record.id"
                            type="button"
                            class="execution-history-item"
                            :class="{ 'execution-history-item-active': record.id === selectedId }"
                            role="option"
                            :aria-selected="record.id === selectedId ? 'true' : 'false'"
                            :tabindex="record.id === selectedId ? 0 : -1"
                            :data-history-index="index"
                            data-testid="netconf-history-item"
                            @click="selectedId = record.id"
                            @keydown="handleRecordKeydown($event, index)"
                        >
                            <span class="execution-history-item-heading">
                                <span class="execution-history-operation">{{ record.operationLabel }}</span>
                                <nn-tag :color="statusMeta(record.status).color">
                                    {{ statusMeta(record.status).label }}
                                </nn-tag>
                            </span>
                            <span class="execution-history-item-meta">
                                <span>{{ formatTime(record.startedAt) }}</span>
                                <span>{{ durationText(record) }}</span>
                            </span>
                            <span class="execution-history-item-device" :title="deviceText(record)">
                                {{ deviceText(record) }}
                            </span>
                            <span v-if="record.origin === 'edit-config-readback'" class="execution-history-origin">
                                edit-config 自动回读
                            </span>
                        </button>
                    </template>
                </aside>

                <section class="execution-history-detail" aria-label="执行记录详情">
                    <nn-empty v-if="!selectedRecord" description="选择一条记录查看请求与响应" />
                    <template v-else>
                        <div class="execution-history-detail-summary">
                            <div class="execution-history-detail-title">
                                <strong>{{ selectedRecord.operationLabel }}</strong>
                                <nn-tag :color="statusMeta(selectedRecord.status).color">
                                    {{ statusMeta(selectedRecord.status).label }}
                                </nn-tag>
                                <nn-tag v-if="selectedRecord.origin === 'edit-config-readback'" color="blue">
                                    自动回读
                                </nn-tag>
                            </div>
                            <nn-descriptions :column="2" bordered size="small">
                                <nn-descriptions-item label="设备">
                                    {{ deviceText(selectedRecord) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Session">
                                    {{ selectedRecord.sessionId || '-' }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="执行时间">
                                    {{ formatDateTime(selectedRecord.startedAt) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="耗时">
                                    {{ durationText(selectedRecord) }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="message-id">
                                    {{ selectedRecord.messageId || '-' }}
                                </nn-descriptions-item>
                                <nn-descriptions-item label="Schema 节点">
                                    <span class="execution-history-context" :title="selectedRecord.contextPath">
                                        {{
                                            selectedRecord.contextPath ||
                                            selectedRecord.contextName ||
                                            '未关联 Schema 节点'
                                        }}
                                    </span>
                                </nn-descriptions-item>
                            </nn-descriptions>
                        </div>

                        <div class="execution-history-xml-stack">
                            <section class="execution-history-xml-section">
                                <header>
                                    <div class="execution-history-xml-title">
                                        <strong>RPC 请求</strong>
                                        <nn-tag v-if="selectedRecord.requestTruncated" color="warning">
                                            内容已截断
                                        </nn-tag>
                                    </div>
                                    <nn-button size="small" @click="copyXml(selectedRecord.requestXml, 'RPC 请求')">
                                        <template #icon><CopyOutlined /></template>
                                        复制
                                    </nn-button>
                                </header>
                                <nn-xml-code-editor
                                    :key="`${selectedRecord.id}-request`"
                                    :value="selectedRequestXml"
                                    :rows="8"
                                    readonly
                                    :line-numbers="!selectedRecord.requestTruncated"
                                    :lightweight="selectedRecord.requestTruncated"
                                    :bordered="false"
                                    class="execution-history-xml-editor"
                                    data-testid="netconf-history-request"
                                    tabindex="0"
                                    aria-label="RPC 请求 XML"
                                />
                            </section>

                            <section class="execution-history-xml-section">
                                <header>
                                    <div class="execution-history-reply-title">
                                        <strong>RPC 响应</strong>
                                        <nn-tag v-if="selectedRecord.replyTruncated" color="warning">
                                            仅显示预览
                                            <span v-if="selectedRecord.replyBytes">
                                                · 完整 {{ formatByteSize(selectedRecord.replyBytes) }}
                                            </span>
                                        </nn-tag>
                                        <span
                                            v-if="selectedRecord.errorMessage"
                                            class="execution-history-error-message"
                                        >
                                            {{ selectedRecord.errorMessage }}
                                        </span>
                                    </div>
                                    <nn-space>
                                        <nn-button
                                            v-if="selectedRecord.replyFileToken"
                                            size="small"
                                            @click="saveFullReply(selectedRecord)"
                                        >
                                            <template #icon><DownloadOutlined /></template>
                                            保存完整响应
                                        </nn-button>
                                        <nn-button
                                            size="small"
                                            :disabled="!selectedRecord.replyXml"
                                            @click="
                                                copyXml(
                                                    selectedRecord.replyXml,
                                                    selectedRecord.replyTruncated ? 'RPC 响应预览' : 'RPC 响应'
                                                )
                                            "
                                        >
                                            <template #icon><CopyOutlined /></template>
                                            {{ selectedRecord.replyTruncated ? '复制预览' : '复制' }}
                                        </nn-button>
                                    </nn-space>
                                </header>
                                <nn-xml-code-editor
                                    :key="`${selectedRecord.id}-reply`"
                                    :value="selectedReplyXml"
                                    :rows="8"
                                    readonly
                                    :line-numbers="!selectedRecord.replyTruncated"
                                    :lightweight="selectedRecord.replyTruncated"
                                    :bordered="false"
                                    class="execution-history-xml-editor"
                                    data-testid="netconf-history-reply"
                                    tabindex="0"
                                    aria-label="RPC 响应 XML"
                                    :class="{
                                        'execution-history-xml-error': ['rpc-error', 'failed'].includes(
                                            selectedRecord.status
                                        )
                                    }"
                                />
                            </section>
                        </div>
                    </template>
                </section>
            </div>
        </div>
    </nn-drawer>
</template>

<script setup>
    import { computed, nextTick, ref, watch } from 'vue';
    import { CopyOutlined, DeleteOutlined, DownloadOutlined } from 'netnexus-ui/icons';
    import { notify } from '../../utils/notify';
    import { formatXmlForDisplay, invokeBridge } from './yangUiUtils';
    import { useNetconfExecutionHistory } from './useNetconfExecutionHistory';

    defineOptions({ name: 'YangExecutionHistoryDrawer' });

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:open']);
    const { records, clearHistory } = useNetconfExecutionHistory();
    const selectedId = ref('');
    const historyListRef = ref(null);
    const selectedRecord = computed(() => records.value.find(record => record.id === selectedId.value) || null);
    const selectedRequestXml = computed(() => {
        const record = selectedRecord.value;
        const value = record?.requestXml || '';
        return record?.requestTruncated ? value : formatXmlForDisplay(value);
    });
    const selectedReplyXml = computed(() => {
        const record = selectedRecord.value;
        const value = record?.replyXml || record?.errorMessage || '';
        return record?.replyTruncated ? value : formatXmlForDisplay(value);
    });

    const statusMeta = status => {
        if (status === 'success') return { color: 'success', label: '成功' };
        if (status === 'rpc-error') return { color: 'error', label: 'RPC 错误' };
        if (status === 'cancelled') return { color: 'warning', label: '已终止' };
        if (status === 'failed') return { color: 'error', label: '执行失败' };
        return { color: 'blue', label: '执行中' };
    };

    const formatDateTime = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value || '-') : date.toLocaleString();
    };

    const formatTime = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString();
    };

    const durationText = record => (record?.duration === null ? '执行中' : `${record.duration} ms`);

    const formatByteSize = value => {
        const bytes = Math.max(0, Number(value) || 0);
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    };

    const deviceText = record => {
        const profile = record?.profileName || record?.host || 'NETCONF 设备';
        const endpoint = record?.host ? `${record.host}${record.port ? `:${record.port}` : ''}` : '';
        return endpoint && endpoint !== profile ? `${profile} · ${endpoint}` : profile;
    };

    const copyXml = async (value, label) => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(String(value || ''));
            notify.success(`${label}已复制`);
        } catch (_error) {
            notify.warning('系统剪贴板不可用');
        }
    };

    const saveFullReply = async record => {
        if (!record?.replyFileToken) return;
        try {
            const { data } = await invokeBridge('netconfApi', 'saveRpcReply', {
                token: record.replyFileToken,
                suggestedName: `${record.operation || 'rpc'}-${record.messageId || Date.now()}.xml`
            });
            if (!data?.canceled) notify.success('完整 RPC 响应已保存');
        } catch (error) {
            notify.error(`保存完整 RPC 响应失败：${error.message}`);
        }
    };

    const clearAllHistory = () => {
        clearHistory();
        selectedId.value = '';
        notify.success('NETCONF 执行记录已清空');
    };

    const focusRecordAt = async index => {
        if (records.value.length === 0) return;
        const boundedIndex = Math.min(Math.max(index, 0), records.value.length - 1);
        selectedId.value = records.value[boundedIndex].id;
        await nextTick();
        historyListRef.value?.querySelector(`[data-history-index="${boundedIndex}"]`)?.focus();
    };

    const handleRecordKeydown = (event, index) => {
        let nextIndex = null;
        if (event.key === 'ArrowUp') nextIndex = index - 1;
        if (event.key === 'ArrowDown') nextIndex = index + 1;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = records.value.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        focusRecordAt(nextIndex);
    };

    watch(
        [() => props.open, () => records.value],
        ([open, history]) => {
            if (!open) return;
            if (!history.some(record => record.id === selectedId.value)) selectedId.value = history[0]?.id || '';
        },
        { immediate: true }
    );
</script>

<style scoped>
    .execution-history-drawer {
        display: grid;
        height: 100%;
        min-width: 0;
        min-height: 0;
        grid-template-rows: auto minmax(0, 1fr);
    }

    .execution-history-toolbar {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .execution-history-summary {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
    }

    .execution-history-summary strong {
        color: var(--nn-color-text-strong);
        font-size: 13px;
    }

    .execution-history-summary span {
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .execution-history-content {
        display: grid;
        min-width: 0;
        min-height: 0;
        grid-template-columns: 300px minmax(0, 1fr);
    }

    .execution-history-list {
        min-width: 0;
        min-height: 0;
        overflow-y: auto;
        border-right: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .execution-history-list :deep(.nn-empty) {
        margin-top: 48px;
    }

    .execution-history-item {
        display: flex;
        width: 100%;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
        padding: 10px 12px;
        border: 0;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        text-align: left;
    }

    .execution-history-item:hover,
    .execution-history-item:focus-visible {
        background: var(--nn-color-bg-hover);
        outline: none;
    }

    .execution-history-item:focus-visible {
        box-shadow: inset 0 0 0 2px var(--nn-color-primary);
    }

    .execution-history-item-active {
        background: var(--nn-color-bg-info-subtle);
        box-shadow: inset 3px 0 0 var(--nn-color-primary);
    }

    .execution-history-item-heading,
    .execution-history-item-meta {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .execution-history-operation {
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .execution-history-item-meta,
    .execution-history-item-device,
    .execution-history-origin {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .execution-history-item-device {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .execution-history-origin {
        color: var(--nn-color-text-info);
    }

    .execution-history-detail {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 12px;
        background: var(--nn-color-bg-surface);
    }

    .execution-history-detail > :deep(.nn-empty) {
        margin: auto;
    }

    .execution-history-detail-summary {
        flex: 0 0 auto;
    }

    .execution-history-detail-title {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: 10px;
    }

    .execution-history-detail-title strong {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .execution-history-context {
        display: inline-block;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: bottom;
        white-space: nowrap;
    }

    .execution-history-xml-stack {
        display: grid;
        min-width: 0;
        min-height: 0;
        flex: 1 0 310px;
        grid-template-rows: minmax(150px, 1fr) minmax(150px, 1fr);
        gap: 10px;
        margin-top: 10px;
    }

    .execution-history-xml-section {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-code);
    }

    .execution-history-xml-section > header {
        display: flex;
        min-height: 36px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
        font-size: 12px;
    }

    .execution-history-xml-title,
    .execution-history-reply-title {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
    }

    .execution-history-error-message {
        overflow: hidden;
        color: var(--nn-color-error);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .execution-history-xml-editor {
        min-width: 0;
        min-height: 0;
        flex: 1;
        border-radius: 0;
        font-size: 11px;
    }

    .execution-history-xml-editor :deep(.xml-code-editor-highlight),
    .execution-history-xml-editor :deep(.xml-code-editor-input) {
        height: 100%;
    }

    .execution-history-xml-editor :deep(.xml-code-editor-input) {
        resize: none;
    }

    .execution-history-xml-editor :deep(.xml-code-editor-input:focus) {
        border-color: var(--nn-color-primary);
        box-shadow: none;
    }

    @media (max-width: 720px) {
        .execution-history-content {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(180px, 34%) minmax(0, 1fr);
        }

        .execution-history-list {
            border-right: 0;
            border-bottom: 1px solid var(--nn-color-border-light);
        }

        .execution-history-toolbar {
            align-items: flex-start;
        }

        .execution-history-summary span {
            white-space: normal;
        }

        .execution-history-detail {
            padding: 8px;
        }
    }
</style>
