<template>
    <a-modal
        v-model:open="modalVisible"
        title="报文解析结果"
        :mask-closable="false"
        :footer="null"
        class="modal-xlarge packet-result-modal"
        @cancel="handleClose"
    >
        <div class="packet-result-viewer">
            <div class="result-summary">
                <nn-space size="small" wrap>
                    <nn-tag color="blue">总长度 {{ hexBuffer.length }} bytes</nn-tag>
                    <nn-tag v-if="selectedNode" color="red">
                        选中 {{ formatOffset(selectedNode.offset) }} +{{ selectedNode.length }}
                    </nn-tag>
                    <nn-tag v-else>未选择字段</nn-tag>
                </nn-space>
                <div v-if="selectedNode && selectedNode.value" class="selected-value">
                    {{ selectedNode.name }}: {{ selectedNode.value }}
                </div>
            </div>

            <div class="result-grid">
                <!-- 结构树视图 -->
                <section class="result-panel tree-view-panel">
                    <div class="panel-header">
                        <span class="panel-title">报文详情</span>
                        <div class="panel-actions">
                            <span class="panel-subtitle">Packet Details</span>
                            <nn-button
                                type="link"
                                size="small"
                                class="copy-tree-button"
                                :disabled="!treeCopyText"
                                @click="copyTreeText"
                            >
                                复制
                            </nn-button>
                        </div>
                    </div>
                    <div
                        v-if="parsedTreeData && parsedTreeData.length > 0"
                        ref="treeScrollRef"
                        class="packet-tree-scroll"
                    >
                        <a-tree
                            ref="treeRef"
                            v-model:selected-keys="treeSelectedKeys"
                            v-model:expanded-keys="treeExpandedKeys"
                            class="packet-tree"
                            :tree-data="parsedTreeData"
                            :virtual="false"
                            @expand="onTreeExpand"
                            @select="onTreeNodeSelect"
                        />
                    </div>
                    <div v-else class="no-data-message">暂无解析数据</div>
                </section>

                <!-- 十六进制视图 -->
                <section class="result-panel hex-view-panel">
                    <div class="panel-header">
                        <span class="panel-title">报文字节</span>
                        <span class="panel-subtitle">Packet Bytes</span>
                    </div>
                    <div ref="hexViewRef" class="hex-content">
                        <div class="hex-table-header">
                            <div class="offset-col">Offset</div>
                            <div class="hex-col">
                                <div v-for="label in byteColumnLabels" :key="label" class="hex-byte header-byte">
                                    {{ label }}
                                </div>
                            </div>
                            <div class="ascii-col">ASCII</div>
                        </div>
                        <div v-for="(row, rowIndex) in hexRows" :key="rowIndex" class="hex-data-row">
                            <div class="offset-col">{{ formatOffset(rowIndex * 16) }}</div>
                            <div class="hex-col">
                                <div
                                    v-for="(byte, byteIndex) in row"
                                    :key="byteIndex"
                                    :class="getByteCellClass(rowIndex * 16 + byteIndex)"
                                    @click="onByteClick(rowIndex * 16 + byteIndex)"
                                >
                                    {{ byte }}
                                </div>
                            </div>
                            <div class="ascii-col">
                                <div
                                    v-for="(byte, byteIndex) in row"
                                    :key="byteIndex"
                                    :class="getAsciiCellClass(rowIndex * 16 + byteIndex)"
                                    @click="onByteClick(rowIndex * 16 + byteIndex)"
                                >
                                    {{ formatAscii(byte) }}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    </a-modal>
</template>

<script setup>
    import { ref, computed, nextTick, watch } from 'vue';
    import { notify } from '../utils/notify';

    defineOptions({
        name: 'PacketResultViewer'
    });

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        packetData: {
            type: String,
            default: ''
        },
        rawParseResult: {
            type: Object,
            default: () => null
        }
    });

    const emit = defineEmits(['update:open']);

    const hexViewRef = ref(null);
    const treeRef = ref(null);
    const treeScrollRef = ref(null);
    const selectedNode = ref(null);
    const treeSelectedKeys = ref([]);
    const treeExpandedKeys = ref([]);
    const hexBuffer = ref([]);
    const byteColumnLabels = Array.from({ length: 16 }, (_, index) =>
        index.toString(16).padStart(2, '0').toUpperCase()
    );

    // 计算属性处理弹窗显示状态
    const modalVisible = computed({
        get: () => props.open,
        set: value => emit('update:open', value)
    });

    // 将十六进制字符串转换为字节数组
    const parseHexString = hexString => {
        const sanitized = hexString.replace(/\s+/g, '');
        const result = [];

        for (let i = 0; i < sanitized.length; i += 2) {
            if (i + 1 >= sanitized.length) break;
            const byte = sanitized.substr(i, 2);
            result.push(byte.toUpperCase());
        }

        return result;
    };

    // 计算十六进制行数据
    const hexRows = computed(() => {
        const rows = [];
        for (let i = 0; i < hexBuffer.value.length; i += 16) {
            rows.push(hexBuffer.value.slice(i, i + 16));
        }
        return rows;
    });

    // 转换后端返回的解析树结构为前端Tree组件需要的格式
    const transformTreeData = (node, parentKey = '0') => {
        if (!node) return [];

        const result = [];
        let index = 0;

        for (const item of node) {
            const currentKey = `${parentKey}-${index}`;
            const dataRef = {
                name: item.name,
                offset: item.offset,
                length: item.length,
                value: formatTreeValue(item.value)
            };
            const treeNode = {
                title: formatNodeTitle(dataRef),
                key: currentKey,
                dataRef
            };

            if (item.children && item.children.length > 0) {
                treeNode.children = transformTreeData(item.children, currentKey);
            }

            result.push(treeNode);
            index++;
        }

        return result;
    };

    // 使用原始解析结果生成树数据
    const parsedTreeData = computed(() => {
        if (!props.rawParseResult || !props.rawParseResult.tree) {
            return [];
        }

        const tree = props.rawParseResult.tree;
        const dataRef = {
            name: tree.name,
            offset: tree.offset || 0,
            length: tree.length || 0,
            value: formatTreeValue(tree.value)
        };
        // 创建根节点
        return [
            {
                title: formatNodeTitle(dataRef),
                key: '0',
                dataRef,
                children: tree.children ? transformTreeData(tree.children, '0') : []
            }
        ];
    });

    const formatTreeLines = (nodes, depth = 0) => {
        const lines = [];
        const indent = '  '.repeat(depth);
        (nodes || []).forEach(node => {
            lines.push(`${indent}${node.title || ''}`);
            if (node.children && node.children.length > 0) {
                lines.push(...formatTreeLines(node.children, depth + 1));
            }
        });
        return lines;
    };

    const treeCopyText = computed(() => formatTreeLines(parsedTreeData.value).join('\n'));

    const writeClipboardText = async text => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
            throw new Error('copy failed');
        }
    };

    const copyTreeText = async () => {
        if (!treeCopyText.value) {
            notify.warning('暂无可复制的解析树');
            return;
        }

        try {
            await writeClipboardText(treeCopyText.value);
            notify.success('解析树已复制');
        } catch (error) {
            console.error('复制解析树失败:', error);
            notify.error('复制失败');
        }
    };

    const formatTreeValue = value => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    };

    const formatNodeTitle = dataRef => {
        if (!dataRef) return '';
        if (!dataRef.value) return dataRef.name || '';
        return `${dataRef.name}: ${dataRef.value}`;
    };

    const getAllTreeKeys = nodes => {
        const keys = [];
        const walk = list => {
            (list || []).forEach(node => {
                keys.push(node.key);
                if (node.children && node.children.length > 0) {
                    walk(node.children);
                }
            });
        };
        walk(nodes);
        return keys;
    };

    const getAncestorKeys = key => {
        const parts = String(key || '').split('-');
        const ancestors = [];
        for (let i = 1; i < parts.length; i++) {
            ancestors.push(parts.slice(0, i).join('-'));
        }
        return ancestors;
    };

    const normalizeNodeRange = dataRef => {
        if (!dataRef || hexBuffer.value.length === 0) return null;

        const offset = Number(dataRef.offset);
        const rawLength = Number(dataRef.length);
        if (!Number.isFinite(offset)) return null;

        const total = hexBuffer.value.length;
        const effectiveLength = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : 1;
        const rawStart = offset;
        const rawEnd = offset + effectiveLength - 1;

        if (rawEnd < 0) {
            return { start: 0, end: 0 };
        }
        if (rawStart >= total) {
            const lastByte = total - 1;
            return { start: lastByte, end: lastByte };
        }

        const start = Math.max(0, rawStart);
        const end = Math.min(total - 1, Math.max(start, rawEnd));
        return { start, end };
    };

    const nodeContainsByte = (node, byteOffset) => {
        const dataRef = node?.dataRef;
        if (!dataRef) return false;

        const offset = Number(dataRef.offset);
        const length = Number(dataRef.length);
        if (!Number.isFinite(offset)) return false;
        if (!Number.isFinite(length) || length <= 0) {
            return byteOffset === offset;
        }
        return byteOffset >= offset && byteOffset < offset + length;
    };

    // 处理十六进制显示相关函数
    const formatOffset = offset => {
        return offset.toString(16).padStart(8, '0').toUpperCase();
    };

    const formatAscii = hexByte => {
        const byte = parseInt(hexByte, 16);
        if (byte >= 32 && byte <= 126) {
            return String.fromCharCode(byte);
        }
        return '.';
    };

    const isHighlighted = byteIndex => {
        if (!selectedNode.value) return false;

        const range = normalizeNodeRange(selectedNode.value);
        return !!range && byteIndex >= range.start && byteIndex <= range.end;
    };

    const getByteCellClass = byteIndex => {
        return {
            'hex-byte': true,
            highlighted: isHighlighted(byteIndex),
            clickable: true
        };
    };

    const getAsciiCellClass = byteIndex => {
        return {
            'ascii-byte': true,
            highlighted: isHighlighted(byteIndex),
            clickable: true
        };
    };

    // 处理树节点选择
    const onTreeNodeSelect = (selectedKeys, info) => {
        if (selectedKeys.length > 0 && info.node.dataRef) {
            selectedNode.value = info.node.dataRef;
            scrollHexToNode(selectedNode.value);
        } else {
            selectedNode.value = null;
        }
    };

    const onTreeExpand = expandedKeys => {
        treeExpandedKeys.value = expandedKeys;
    };

    const scrollHexToNode = dataRef => {
        if (!hexViewRef.value) return;

        const range = normalizeNodeRange(dataRef);
        if (!range) return;

        const rows = hexViewRef.value.querySelectorAll('.hex-data-row');
        if (!rows || rows.length === 0) return;

        const rowIndex = Math.min(rows.length - 1, Math.max(0, Math.floor(range.start / 16)));
        rows[rowIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // 点击字节时查找并选择对应的树节点
    const onByteClick = byteIndex => {
        if (!parsedTreeData.value || parsedTreeData.value.length === 0) return;

        // 查找包含该字节偏移量的节点
        const nodeKey = findNodeKeyByByteOffset(parsedTreeData.value, byteIndex);

        if (nodeKey) {
            // 程序化选择树节点
            selectTreeNode(nodeKey);
        }
    };

    // 递归查找包含指定字节偏移量的节点的key
    const findNodeKeyByByteOffset = (nodes, byteOffset, parentKey = '') => {
        if (!nodes || nodes.length === 0) return null;

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const key = node.key || (parentKey ? `${parentKey}-${i}` : `${i}`);

            // 检查当前节点是否包含该字节偏移量
            if (nodeContainsByte(node, byteOffset)) {
                // 如果有子节点，先递归检查子节点是否包含该偏移量
                if (node.children && node.children.length > 0) {
                    const childKey = findNodeKeyByByteOffset(node.children, byteOffset, key);
                    if (childKey) return childKey;
                }

                // 如果没有更具体的子节点包含该偏移量，返回当前节点
                return key;
            }

            // 检查子节点
            if (node.children && node.children.length > 0) {
                const childKey = findNodeKeyByByteOffset(node.children, byteOffset, key);
                if (childKey) return childKey;
            }
        }

        return null;
    };

    // 程序化选择树节点
    const selectTreeNode = key => {
        if (!treeScrollRef.value) return;

        // 更新选中节点
        const findNodeByKey = (nodes, targetKey, currentPath = []) => {
            if (!nodes) return null;

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const path = [...currentPath, i];
                const key = path.join('-');

                if (key === targetKey) {
                    return { node, key };
                }

                if (node.children) {
                    const result = findNodeByKey(node.children, targetKey, path);
                    if (result) return result;
                }
            }

            return null;
        };

        const nodeInfo = findNodeByKey(parsedTreeData.value, key);
        if (nodeInfo && nodeInfo.node.dataRef) {
            // 更新选中节点的信息
            selectedNode.value = nodeInfo.node.dataRef;

            // 设置当前选中的树节点key
            treeSelectedKeys.value = [key];
            treeExpandedKeys.value = Array.from(new Set([...treeExpandedKeys.value, ...getAncestorKeys(key)]));

            // 滚动到节点位置
            nextTick(() => {
                setTimeout(scrollSelectedTreeNodeIntoView, 0);
                setTimeout(scrollSelectedTreeNodeIntoView, 80);
            });
        }
    };

    const scrollSelectedTreeNodeIntoView = () => {
        const scrollEl = treeScrollRef.value;
        const selectedEl = scrollEl?.querySelector?.('.ant-tree-node-selected');
        if (!scrollEl || !selectedEl) return;

        const selectedNodeEl = selectedEl.closest('.ant-tree-treenode') || selectedEl;
        const scrollRect = scrollEl.getBoundingClientRect();
        const selectedRect = selectedNodeEl.getBoundingClientRect();
        const selectedTop = selectedRect.top - scrollRect.top + scrollEl.scrollTop;
        const targetTop = selectedTop - (scrollEl.clientHeight - selectedRect.height) / 2;
        scrollEl.scrollTop = Math.max(0, targetTop);
    };

    // 关闭弹窗
    const handleClose = () => {
        emit('update:open', false);
        // 清空选中状态
        selectedNode.value = null;
        treeSelectedKeys.value = [];
    };

    // 监听报文数据变化，更新十六进制缓冲区
    watch(
        () => props.packetData,
        newData => {
            if (newData) {
                hexBuffer.value = parseHexString(newData);
            } else {
                hexBuffer.value = [];
            }
        },
        { immediate: true }
    );

    // 监听弹窗打开，重置状态
    watch(
        () => props.open,
        newVisible => {
            if (newVisible) {
                selectedNode.value = null;
                treeSelectedKeys.value = [];
                treeExpandedKeys.value = getAllTreeKeys(parsedTreeData.value);
            }
        }
    );

    watch(
        parsedTreeData,
        newTreeData => {
            treeExpandedKeys.value = getAllTreeKeys(newTreeData);
        },
        { immediate: true }
    );
</script>

<style scoped>
    .packet-result-viewer {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :global(.packet-result-modal.ant-modal) {
        --packet-result-modal-margin-y: clamp(32px, 10vh, 64px);
        --packet-result-modal-max-height: calc(
            100vh - var(--packet-result-modal-margin-y) - var(--packet-result-modal-margin-y)
        );
        top: var(--packet-result-modal-margin-y);
        max-height: var(--packet-result-modal-max-height) !important;
        padding-bottom: 0;
    }

    :global(.packet-result-modal .ant-modal-content) {
        height: min(720px, var(--packet-result-modal-max-height));
        max-height: var(--packet-result-modal-max-height) !important;
        overflow: hidden !important;
    }

    :global(.packet-result-modal .ant-modal-body) {
        flex: 1 1 0 !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: hidden !important;
    }

    .result-summary {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 32px;
        padding: 0 2px;
    }

    .selected-value {
        min-width: 0;
        max-width: 62%;
        overflow: hidden;
        color: var(--nn-color-text-secondary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .result-grid {
        flex: 1 1 0;
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(0, 1fr) minmax(0, 0.72fr);
        gap: 8px;
        overflow: hidden;
    }

    .result-panel {
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .panel-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 36px;
        padding: 0 12px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-subtle);
    }

    .panel-title {
        color: var(--nn-color-text);
        font-size: 13px;
        font-weight: 600;
    }

    .panel-subtitle {
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .panel-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    .copy-tree-button {
        height: 24px;
        padding: 0 4px;
        font-size: 12px;
        line-height: 24px;
    }

    .hex-content {
        flex: 1 1 0;
        min-height: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        white-space: nowrap;
        font-size: 12px;
        overflow: auto;
        background-color: var(--nn-color-bg-subtle);
    }

    .hex-table-header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        min-width: max-content;
        padding: 6px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        font-weight: 600;
    }

    .hex-data-row {
        display: flex;
        align-items: center;
        min-width: max-content;
        padding: 3px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .hex-data-row:hover {
        background-color: var(--nn-color-bg-hover);
    }

    .offset-col {
        width: 78px;
        flex-shrink: 0;
        color: var(--nn-color-text-secondary);
        font-weight: 500;
    }

    .hex-col {
        width: 494px;
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
    }

    .ascii-col {
        width: 154px;
        flex: 0 0 auto;
        display: flex;
        border-left: 1px solid var(--nn-color-border-light);
        padding-left: 10px;
    }

    .hex-byte {
        width: 24px;
        text-align: center;
        display: inline-block;
        border-radius: 3px;
    }

    .header-byte {
        color: var(--nn-color-text-secondary);
        font-weight: 600;
    }

    .ascii-byte {
        width: 9px;
        text-align: center;
        display: inline-block;
        border-radius: 2px;
    }

    .highlighted {
        background: var(--nn-color-bg-danger-subtle);
        color: var(--nn-color-error);
        font-weight: bold;
        outline: 1px solid var(--nn-color-border-danger);
    }

    .clickable {
        cursor: pointer;
    }

    .clickable:hover {
        background-color: var(--nn-color-bg-selected);
    }

    .tree-view-panel {
        font-size: 12px;
    }

    .no-data-message {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        width: 100%;
        color: var(--nn-color-text-placeholder);
    }

    /* 树结构区域字体样式 */
    .packet-tree-scroll {
        flex: 1 1 0;
        min-height: 0;
        padding: 4px 6px 8px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background: var(--nn-color-bg-surface);
    }

    .packet-tree {
        width: max-content;
        min-width: 100%;
        font-size: 12px;
        background: var(--nn-color-bg-surface);
    }

    .packet-tree :deep(.ant-tree-node-content-wrapper) {
        max-width: calc(100% - 24px);
        padding: 0 4px;
        line-height: 22px;
        border-radius: 2px;
    }

    .packet-tree :deep(.ant-tree-node-content-wrapper:hover) {
        background: var(--nn-color-bg-hover);
    }

    .packet-tree :deep(.ant-tree-title) {
        display: block;
        max-width: 100%;
    }

    .tree-node-title {
        display: block;
        color: var(--nn-color-text);
        line-height: 22px;
        overflow-wrap: normal;
        white-space: nowrap;
        text-overflow: clip;
    }

    /* 设置树节点选中的颜色 */
    :deep(.ant-tree-node-selected) {
        background-color: var(--nn-color-bg-danger-subtle) !important;
    }

    :deep(.ant-tree-node-content-wrapper.ant-tree-node-selected) {
        background-color: var(--nn-color-bg-danger-subtle) !important;
    }

    :deep(.ant-tree-node-content-wrapper.ant-tree-node-selected .ant-tree-title) {
        color: var(--nn-color-error);
    }

    @media (max-width: 1100px) {
        .result-grid {
            grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        }

        .selected-value {
            max-width: 100%;
        }
    }

    @media (max-height: 520px) and (min-width: 900px) {
        .result-grid {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            grid-template-rows: minmax(0, 1fr);
        }
    }
</style>
