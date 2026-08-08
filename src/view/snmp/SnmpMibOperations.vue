<template>
    <div class="snmp-mib-operations" :class="{ 'snmp-mib-operations-resizing': requestPaneResizing }">
        <div
            ref="operationsLayoutRef"
            class="operations-layout"
            :class="{ 'operations-layout-empty': !activeOperation }"
            :style="operationsLayoutStyle"
        >
            <div v-if="!activeOperation" class="operation-empty">
                <nn-empty description="请通过左侧 OID 树节点的右键菜单选择操作" />
            </div>

            <section v-else class="operation-request-pane" aria-label="SNMP 请求">
                <div class="operation-pane-header">
                    <div class="operation-heading">
                        <span class="operation-title">请求 · {{ activeOperationMeta.label }}</span>
                        <nn-tag :color="activeOperationMeta.color">{{ activeOperationMeta.kind }}</nn-tag>
                    </div>
                    <div class="target-summary" :title="targetSummary">
                        {{ targetSummary }}
                    </div>
                </div>

                <div class="operation-request-scroll">
                    <nn-form :model="form" :label-col="{ style: { width: '88px' } }" class="operation-form">
                        <nn-form-item v-if="targetNode" label="对象">
                            <div class="operation-object-summary">
                                <div class="operation-object-name">{{ targetNodeName }}</div>
                                <div class="operation-object-path">{{ targetNodePath }}</div>
                            </div>
                        </nn-form-item>

                        <nn-form-item :label="activeOperation === 'walk' ? '起始 OID' : 'OID'" required>
                            <div class="oid-input-row">
                                <nn-input
                                    v-model:value="form.oid"
                                    allow-clear
                                    :disabled="executing"
                                    placeholder="请输入数字 OID"
                                    @press-enter="executeOperation"
                                />
                                <nn-button
                                    v-if="supportsInstanceSelection"
                                    :loading="instanceLoading"
                                    :disabled="executing"
                                    @click="loadInstances"
                                >
                                    实例
                                </nn-button>
                            </div>
                        </nn-form-item>

                        <nn-form-item v-if="instanceRows.length" label="实例列表">
                            <nn-select v-model:value="form.oid" :disabled="executing" placeholder="选择设备返回的实例">
                                <nn-select-option
                                    v-for="instance in instanceRows"
                                    :key="instance.oid"
                                    :value="instance.oid"
                                >
                                    {{ instanceLabel(instance) }}
                                </nn-select-option>
                            </nn-select>
                            <div v-if="instanceMeta?.limitReached" class="instance-hint">
                                仅显示前 {{ instanceRows.length }} 条实例
                            </div>
                        </nn-form-item>

                        <template v-if="activeOperation === 'walk'">
                            <nn-row :gutter="12">
                                <nn-col :span="12">
                                    <nn-form-item label="结果上限">
                                        <nn-input-number
                                            v-model:value="form.limit"
                                            :min="1"
                                            :max="1000"
                                            :disabled="executing"
                                            style="width: 100%"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12">
                                    <nn-form-item label="批量数">
                                        <nn-input-number
                                            v-model:value="form.maxRepetitions"
                                            :min="1"
                                            :max="50"
                                            :disabled="executing || config.version !== 'v2c'"
                                            style="width: 100%"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>
                        </template>

                        <template v-else-if="activeOperation === 'set'">
                            <nn-row :gutter="12">
                                <nn-col :span="10">
                                    <nn-form-item label="类型" required>
                                        <nn-select v-model:value="form.type" :disabled="executing">
                                            <nn-select-option
                                                v-for="option in SET_TYPE_OPTIONS"
                                                :key="option.value"
                                                :value="option.value"
                                            >
                                                {{ option.label }}
                                            </nn-select-option>
                                        </nn-select>
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="14">
                                    <nn-form-item label="值" required>
                                        <nn-input
                                            v-model:value="form.value"
                                            :disabled="executing"
                                            placeholder="请输入 SET 值"
                                            @press-enter="executeOperation"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>
                        </template>

                        <nn-form-item class="operation-submit-row">
                            <nn-button
                                type="primary"
                                :loading="executing"
                                :disabled="!form.oid"
                                @click="executeOperation"
                            >
                                <template #icon><SendOutlined /></template>
                                {{ executeButtonText }}
                            </nn-button>
                            <nn-button :disabled="executing" @click="resetCurrentOperation">
                                <template #icon><ReloadOutlined /></template>
                                重置
                            </nn-button>
                        </nn-form-item>
                    </nn-form>
                </div>
            </section>

            <div
                v-if="activeOperation"
                class="operations-row-resizer"
                role="separator"
                aria-label="调整 SNMP 请求和响应高度"
                aria-orientation="horizontal"
                :aria-valuemin="requestPaneMinHeight"
                :aria-valuemax="requestPaneMaxHeight"
                :aria-valuenow="requestPaneHeight"
                tabindex="0"
                title="拖动调整请求和响应高度；双击恢复默认高度"
                @pointerdown="startRequestPaneResize"
                @keydown="handleRequestPaneResizeKeydown"
                @dblclick="resetRequestPaneResize"
            >
                <span class="pane-resizer-grip" aria-hidden="true" />
            </div>

            <section v-if="activeOperation" class="operation-result-pane" aria-live="polite" aria-label="SNMP 响应">
                <div class="operation-pane-header">
                    <div class="operation-heading">
                        <span class="operation-title">响应</span>
                        <nn-tag v-if="resultStatus === 'success'" color="success">成功</nn-tag>
                        <nn-tag v-else-if="resultStatus === 'error'" color="error">失败</nn-tag>
                        <nn-tag v-else color="default">等待执行</nn-tag>
                    </div>
                    <span v-if="lastDuration !== null" class="result-duration">{{ lastDuration }} ms</span>
                </div>

                <div class="operation-result-scroll">
                    <nn-alert v-if="resultError" type="error" show-icon message="请求失败" :description="resultError" />

                    <nn-descriptions
                        v-else-if="varbindResult"
                        :column="1"
                        bordered
                        size="small"
                        class="operation-result-descriptions"
                    >
                        <nn-descriptions-item label="对象">
                            {{ varbindResult.oidName || varbindResult.moduleQualifiedName || targetNodeName }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="OID">
                            <nn-typography-text copyable>{{ varbindResult.oid || form.oid || '-' }}</nn-typography-text>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="类型">
                            {{ varbindResult.type || form.type || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="值">
                            <nn-typography-text copyable>
                                {{ displayVarbindValue(varbindResult) }}
                            </nn-typography-text>
                        </nn-descriptions-item>
                    </nn-descriptions>

                    <div v-else-if="walkRows.length" class="walk-result">
                        <div class="walk-result-summary">
                            <nn-tag color="blue">{{ walkRows.length }} 条</nn-tag>
                            <nn-tag v-if="walkMeta?.limitReached" color="warning">达到上限</nn-tag>
                            <span v-else-if="walkMeta?.stoppedBy">停止原因：{{ walkMeta.stoppedBy }}</span>
                        </div>
                        <textarea class="walk-result-output" readonly spellcheck="false" :value="walkOutputText" />
                    </div>

                    <nn-empty v-else :description="executing ? '正在等待设备响应' : '执行请求后在此查看响应'" />
                </div>
            </section>
        </div>
    </div>
</template>

<script setup>
    import { computed, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
    import { DEFAULT_VALUES } from '../../const/snmpConst';
    import { ReloadOutlined, SendOutlined } from 'netnexus-ui/icons';
    import { notify } from '../../utils/notify';
    import { usePaneResize } from '../yang/usePaneResize';

    defineOptions({ name: 'SnmpMibOperations' });

    const props = defineProps({
        contextNode: {
            type: Object,
            default: null
        },
        contextOperation: {
            type: String,
            default: ''
        },
        contextRevision: {
            type: Number,
            default: 0
        }
    });

    const OPERATION_OPTIONS = Object.freeze([
        { key: 'get', label: 'GET', kind: 'READ', color: 'blue' },
        { key: 'getNext', label: 'GET-NEXT', kind: 'READ', color: 'blue' },
        { key: 'walk', label: 'WALK', kind: 'READ', color: 'blue' },
        { key: 'set', label: 'SET', kind: 'WRITE', color: 'warning' }
    ]);
    const OPERATION_KEYS = new Set(OPERATION_OPTIONS.map(item => item.key));
    const SET_TYPE_OPTIONS = Object.freeze([
        { label: 'Integer', value: 'Integer' },
        { label: 'OctetString', value: 'OctetString' },
        { label: 'OID', value: 'OID' },
        { label: 'IpAddress', value: 'IpAddress' },
        { label: 'Counter32', value: 'Counter32' },
        { label: 'Gauge32 / Unsigned32', value: 'Gauge32' },
        { label: 'TimeTicks', value: 'TimeTicks' },
        { label: 'Counter64', value: 'Counter64' }
    ]);

    const activeOperation = ref('');
    const targetNode = ref(null);
    const executing = ref(false);
    const instanceLoading = ref(false);
    const instanceRows = ref([]);
    const instanceMeta = ref(null);
    const resultStatus = ref('idle');
    const resultError = ref('');
    const varbindResult = ref(null);
    const walkRows = ref([]);
    const walkMeta = ref(null);
    const lastDuration = ref(null);
    const operationsLayoutRef = ref(null);
    const config = reactive({
        targetHost: DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
        targetPort: DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT,
        version: 'v2c',
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY
    });
    const form = reactive({
        oid: '',
        type: 'OctetString',
        value: '',
        limit: 100,
        maxRepetitions: 20
    });
    let executionRevision = 0;
    let instanceRequestRevision = 0;

    const {
        paneSize: requestPaneHeight,
        minSize: requestPaneMinHeight,
        maxSize: requestPaneMaxHeight,
        resizing: requestPaneResizing,
        startResize: startRequestPaneResize,
        handleResizeKeydown: handleRequestPaneResizeKeydown,
        resetResize: resetRequestPaneResize,
        stopResize: stopRequestPaneResize
    } = usePaneResize({
        containerRef: operationsLayoutRef,
        orientation: 'horizontal',
        defaultRatio: 0.5,
        minFirst: 220,
        minSecond: 150,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--mib-request-pane-height'
    });

    const operationsLayoutStyle = computed(() =>
        requestPaneHeight.value > 0 ? { '--mib-request-pane-height': `${requestPaneHeight.value}px` } : undefined
    );
    const activeOperationMeta = computed(
        () => OPERATION_OPTIONS.find(item => item.key === activeOperation.value) || OPERATION_OPTIONS[0]
    );
    const targetNodeName = computed(
        () =>
            targetNode.value?.moduleQualifiedName ||
            targetNode.value?.objectName ||
            targetNode.value?.title ||
            targetNode.value?.oid ||
            '-'
    );
    const targetNodePath = computed(() => targetNode.value?.pathName || targetNode.value?.oid || '-');
    const targetSummary = computed(
        () =>
            `${config.targetHost || '-'}:${config.targetPort || '-'} · ${String(config.version || '-').toUpperCase()} / ${
                config.community || '-'
            }`
    );
    const supportsInstanceSelection = computed(
        () => Boolean(targetNode.value?.isTableColumn) && ['get', 'set'].includes(activeOperation.value)
    );
    const executeButtonText = computed(() => {
        if (activeOperation.value === 'getNext') return '发送 GET-NEXT';
        if (activeOperation.value === 'walk') return '开始 WALK';
        if (activeOperation.value === 'set') return '发送 SET';
        return '发送 GET';
    });
    const displayVarbindValue = varbind => {
        const value = varbind?.displayValue ?? varbind?.value;
        return value === undefined || value === null || value === '' ? '-' : String(value);
    };
    const walkOutputText = computed(() =>
        walkRows.value
            .map((row, index) =>
                [
                    `#${index + 1} ${row.oidName || row.moduleQualifiedName || row.oid || '-'}`,
                    `OID   : ${row.oid || '-'}`,
                    `TYPE  : ${row.type || '-'}`,
                    `VALUE : ${displayVarbindValue(row)}`
                ].join('\n')
            )
            .join('\n\n')
    );

    const normalizeOperation = operation => {
        if (operation === 'get-next') return 'getNext';
        return OPERATION_KEYS.has(operation) ? operation : '';
    };

    const normalizeOid = oid =>
        String(oid || '')
            .trim()
            .replace(/\.$/u, '');

    const effectiveQueryOid = node => {
        if (!node?.oid) return '';
        return node.queryOid || (node.isScalar ? `${normalizeOid(node.oid)}.0` : normalizeOid(node.oid));
    };

    const inferSetType = syntax => {
        const normalized = String(syntax || '')
            .replace(/[\s_-]+/gu, '')
            .toLowerCase();
        if (/objectidentifier|^oid$/u.test(normalized)) return 'OID';
        if (normalized.includes('ipaddress')) return 'IpAddress';
        if (normalized.includes('counter64')) return 'Counter64';
        if (normalized.includes('counter')) return 'Counter32';
        if (/gauge|unsigned32/u.test(normalized)) return 'Gauge32';
        if (normalized.includes('timeticks')) return 'TimeTicks';
        if (/integer|truthvalue|rowstatus|enumeration/u.test(normalized)) return 'Integer';
        return 'OctetString';
    };

    const clearResult = () => {
        resultStatus.value = 'idle';
        resultError.value = '';
        varbindResult.value = null;
        walkRows.value = [];
        walkMeta.value = null;
        lastDuration.value = null;
    };

    const applyOperationContext = (operation, node) => {
        executionRevision += 1;
        instanceRequestRevision += 1;
        executing.value = false;
        instanceLoading.value = false;
        activeOperation.value = normalizeOperation(operation);
        targetNode.value = node ? { ...node } : null;
        instanceRows.value = [];
        instanceMeta.value = null;
        form.value = '';
        form.limit = 100;
        form.maxRepetitions = 20;
        form.type = inferSetType(node?.syntax);
        form.oid =
            activeOperation.value === 'getNext' || activeOperation.value === 'walk'
                ? normalizeOid(node?.oid)
                : effectiveQueryOid(node);
        clearResult();
    };

    const resetCurrentOperation = () => {
        applyOperationContext(activeOperation.value, targetNode.value);
    };

    const loadConfig = async () => {
        try {
            const response = await window.snmpApi.getSnmpConfig();
            const next = response?.status === 'success' && response.data ? response.data : {};
            const versions = Array.isArray(next.supportedVersions) ? next.supportedVersions : [];
            config.targetHost = next.targetHost || DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST;
            config.targetPort = next.queryPort || DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT;
            config.community = next.community || DEFAULT_VALUES.DEFAULT_COMMUNITY;
            config.version = versions.length
                ? ['v1', 'v2c'].includes(versions[0])
                    ? versions[0]
                    : ''
                : ['v1', 'v2c'].includes(next.version)
                  ? next.version
                  : 'v2c';
        } catch (_error) {
            // Defaults keep the request editor useful when configuration cannot be loaded.
        }
    };

    const unwrapRows = data => {
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.rows)) return data.rows;
        if (Array.isArray(data?.varbinds)) return data.varbinds;
        if (Array.isArray(data?.instances)) return data.instances;
        return [];
    };

    const unwrapVarbind = data => {
        if (Array.isArray(data)) return data[0] || null;
        return data?.varbinds?.[0] || data?.varbind || data?.result || data || null;
    };

    const normalizeVarbind = varbind => {
        if (!varbind || typeof varbind !== 'object') return varbind;
        return { ...varbind, oid: varbind.oid || form.oid };
    };

    const ensureSuccessfulResponse = response => {
        if (!response || response.status !== 'success') {
            throw new Error(response?.msg || 'SNMP 请求失败');
        }
        return response.data;
    };

    const executeOperation = async () => {
        const oid = normalizeOid(form.oid);
        if (!oid) {
            notify.warning('请输入 OID');
            return;
        }
        if (activeOperation.value === 'set' && String(form.value) === '') {
            notify.warning('请输入 SET 值');
            return;
        }

        const requestRevision = ++executionRevision;
        const startedAt = performance.now();
        clearResult();
        executing.value = true;
        try {
            await loadConfig();
            if (requestRevision !== executionRevision) return;
            if (!config.targetHost || !config.targetPort || !config.version) {
                throw new Error('请先在 SNMP 配置中填写查询目标并启用 SNMPv1/v2c');
            }
            let data;
            if (activeOperation.value === 'get') {
                data = ensureSuccessfulResponse(await window.snmpApi.sendGetRequest({ oid }));
                const row = normalizeVarbind(unwrapVarbind(data));
                if (requestRevision !== executionRevision) return;
                varbindResult.value = row || { oid };
            } else if (activeOperation.value === 'getNext') {
                data = ensureSuccessfulResponse(await window.snmpApi.sendGetNextRequest({ oid }));
                const row = normalizeVarbind(unwrapVarbind(data));
                if (requestRevision !== executionRevision) return;
                varbindResult.value = row || { oid };
            } else if (activeOperation.value === 'walk') {
                data = ensureSuccessfulResponse(
                    await window.snmpApi.sendWalkRequest({
                        oid,
                        limit: Number(form.limit) || 100,
                        maxRepetitions: Number(form.maxRepetitions) || 20
                    })
                );
                const rows = unwrapRows(data).map(normalizeVarbind);
                if (requestRevision !== executionRevision) return;
                walkRows.value = rows;
                walkMeta.value = data && typeof data === 'object' && !Array.isArray(data) ? data : { rows };
            } else if (activeOperation.value === 'set') {
                data = ensureSuccessfulResponse(
                    await window.snmpApi.sendSetRequest({
                        oid,
                        type: form.type,
                        value: form.value
                    })
                );
                const row = normalizeVarbind(unwrapVarbind(data));
                if (requestRevision !== executionRevision) return;
                varbindResult.value = row || { oid, type: form.type, value: form.value };
            }

            if (requestRevision !== executionRevision) return;
            resultStatus.value = 'success';
            lastDuration.value = Math.max(0, Math.round(performance.now() - startedAt));
        } catch (error) {
            if (requestRevision !== executionRevision) return;
            resultStatus.value = 'error';
            resultError.value = error.message || String(error);
            lastDuration.value = Math.max(0, Math.round(performance.now() - startedAt));
        } finally {
            if (requestRevision === executionRevision) executing.value = false;
        }
    };

    const loadInstances = async () => {
        if (!targetNode.value?.oid || instanceLoading.value) return;
        const requestRevision = ++instanceRequestRevision;
        instanceLoading.value = true;
        try {
            await loadConfig();
            if (requestRevision !== instanceRequestRevision) return;
            const data = ensureSuccessfulResponse(
                await window.snmpApi.listOidInstances({
                    oid: targetNode.value.oid,
                    limit: 100
                })
            );
            if (requestRevision !== instanceRequestRevision) return;
            instanceRows.value = unwrapRows(data).filter(row => row?.oid);
            instanceMeta.value = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
            if (!instanceRows.value.length) notify.info('设备未返回当前字段的实例');
        } catch (error) {
            if (requestRevision === instanceRequestRevision) notify.error(`加载实例失败：${error.message}`);
        } finally {
            if (requestRevision === instanceRequestRevision) instanceLoading.value = false;
        }
    };

    const instanceLabel = instance => {
        const value = displayVarbindValue(instance);
        return value === '-' ? instance.oid : `${instance.oid} · ${value}`;
    };

    watch(
        () => props.contextRevision,
        () => applyOperationContext(props.contextOperation, props.contextNode),
        { immediate: true }
    );

    onMounted(loadConfig);
    onDeactivated(() => {
        executionRevision += 1;
        instanceRequestRevision += 1;
        executing.value = false;
        instanceLoading.value = false;
        stopRequestPaneResize();
    });

    defineExpose({
        openOperation: (operation, node) => applyOperationContext(operation, node),
        clearValidationErrors: () => {
            resultError.value = '';
            if (resultStatus.value === 'error') resultStatus.value = 'idle';
        }
    });
</script>

<style scoped>
    .snmp-mib-operations {
        display: flex;
        width: 100%;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .operations-layout {
        display: grid;
        min-width: 0;
        min-height: 0;
        flex: 1;
        grid-template-rows: var(--mib-request-pane-height, minmax(260px, 1fr)) 8px minmax(150px, 1fr);
        overflow: hidden;
    }

    .operations-layout-empty {
        grid-template-rows: minmax(0, 1fr);
    }

    .operation-empty {
        display: flex;
        min-width: 0;
        min-height: 0;
        align-items: center;
        justify-content: center;
        padding: 24px;
    }

    .operation-request-pane,
    .operation-result-pane {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .operation-pane-header {
        display: flex;
        min-width: 0;
        min-height: 38px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .operation-result-pane .operation-pane-header {
        border-top: 0;
    }

    .operation-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .operation-heading :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .operation-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
    }

    .target-summary,
    .result-duration {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .operation-request-scroll,
    .operation-result-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 10px;
    }

    .operation-form :deep(.nn-form-item) {
        margin-bottom: 9px;
    }

    .operation-form :deep(.nn-form-item-control),
    .operation-form :deep(.nn-form-item-control-input-content) {
        min-width: 0;
    }

    .operation-object-summary {
        min-width: 0;
        padding: 6px 10px;
        overflow: hidden;
        background: var(--nn-color-bg-subtle);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 5px;
    }

    .operation-object-name {
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .operation-object-path,
    .instance-hint {
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        line-height: 17px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .oid-input-row {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .oid-input-row :deep(.nn-input-affix-wrapper),
    .oid-input-row :deep(.nn-input) {
        min-width: 0;
        flex: 1;
    }

    .operation-submit-row :deep(.nn-form-item-control-input-content) {
        display: flex;
        gap: 6px;
    }

    .operations-row-resizer {
        display: flex;
        min-height: 8px;
        align-items: center;
        justify-content: center;
        cursor: row-resize;
        outline: none;
        touch-action: none;
        user-select: none;
        border-top: 1px solid var(--nn-color-border-light);
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .operations-row-resizer .pane-resizer-grip {
        width: 34px;
        height: 2px;
        border-radius: 999px;
        background: var(--nn-color-border-light);
        transition:
            height 0.15s ease,
            background-color 0.15s ease;
    }

    .operations-row-resizer:hover .pane-resizer-grip,
    .operations-row-resizer:focus-visible .pane-resizer-grip,
    .snmp-mib-operations-resizing .operations-row-resizer .pane-resizer-grip {
        height: 3px;
        background: var(--nn-color-primary);
    }

    .operation-result-descriptions :deep(.nn-descriptions-item-label) {
        width: 96px;
    }

    .operation-result-descriptions :deep(.nn-descriptions-item-content) {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .walk-result {
        display: flex;
        height: 100%;
        min-height: 160px;
        flex-direction: column;
    }

    .walk-result-summary {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 6px;
        margin-bottom: 7px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .walk-result-output {
        width: 100%;
        min-height: 140px;
        flex: 1;
        resize: none;
        padding: 9px 10px;
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 17px;
        background: var(--nn-color-bg-subtle);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 5px;
        outline: none;
    }

    @media (max-width: 700px) {
        .operation-pane-header {
            align-items: flex-start;
            flex-direction: column;
        }

        .target-summary {
            width: 100%;
        }

        .operation-form :deep(.nn-col) {
            max-width: 100%;
            flex: 0 0 100%;
        }
    }
</style>
