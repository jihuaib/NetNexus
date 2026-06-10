<template>
    <div class="mt-container snmp-mib-page">
        <a-card title="MIB 管理" class="mib-card">
            <div class="mib-workspace">
                <div class="mib-toolbar">
                    <div class="mib-action-group">
                        <a-button type="primary" :loading="mibCompileLoading" @click="selectMibFiles">
                            <template #icon><FileSearchOutlined /></template>
                            导入文件
                        </a-button>
                        <a-button :loading="mibCompileLoading" @click="selectMibDirectory">
                            <template #icon><FolderOpenOutlined /></template>
                            导入目录
                        </a-button>
                        <a-button :disabled="mibFiles.length === 0" :loading="mibCompileLoading" @click="compileStoredMibs">
                            <template #icon><ReloadOutlined /></template>
                            重新编译
                        </a-button>
                        <a-button danger :disabled="mibFiles.length === 0" @click="clearMibs">
                            <template #icon><DeleteOutlined /></template>
                            清空
                        </a-button>
                    </div>

                    <div class="mib-status-group">
                        <a-tag v-if="mibCompileLoading" color="processing">后台编译中</a-tag>
                        <a-tag v-else-if="mibStatus.cacheHit" color="success">缓存命中</a-tag>
                        <a-tag color="blue">用户 {{ mibStatus.modules.length }}</a-tag>
                        <a-tag color="cyan">基础 {{ mibStatus.baseModules.length }}</a-tag>
                        <a-tag color="green">OID {{ mibStatus.totalObjects }}</a-tag>
                        <a-tag color="default">文件 {{ mibStatus.expandedFileCount }}</a-tag>
                    </div>
                </div>

                <div class="mib-query-row">
                    <a-input
                        v-model:value="oidQuery"
                        placeholder="输入OID，例如 1.3.6.1.2.1.1.3.0"
                        allow-clear
                        @press-enter="translateOid"
                    />
                    <a-button :loading="oidTranslateLoading" @click="translateOid">解析OID</a-button>
                </div>

                <div class="mib-main">
                    <section class="mib-tree-panel">
                        <div class="mib-panel-header">
                            <span class="mib-panel-title">OID树</span>
                            <span class="mib-panel-meta">{{ mibStatus.totalObjects }} 个对象</span>
                        </div>
                        <div class="mib-tree-scroll">
                            <a-tree
                                v-if="mibStatus.oidTree.length > 0"
                                v-model:expanded-keys="treeExpandedKeys"
                                :selected-keys="treeSelectedKeys"
                                :tree-data="mibStatus.oidTree"
                                block-node
                                @select="handleTreeSelect"
                            >
                                <template #title="{ title, oid, moduleName, macro }">
                                    <span class="mib-node-title">
                                        <span class="mib-node-name">{{ title }}</span>
                                        <span class="mib-node-oid">{{ oid }}</span>
                                        <span v-if="macro" class="mib-node-macro">{{ macro }}</span>
                                        <span v-if="moduleName" class="mib-node-module">{{ moduleName }}</span>
                                    </span>
                                </template>
                            </a-tree>
                            <a-empty v-else description="暂无MIB树" />
                        </div>
                    </section>

                    <aside class="mib-side-panel">
                        <section class="mib-detail-block">
                            <div class="mib-panel-header">
                                <span class="mib-panel-title">节点详情</span>
                            </div>
                            <div class="mib-detail-scroll">
                                <a-descriptions
                                    v-if="selectedOidNode"
                                    :column="1"
                                    bordered
                                    size="small"
                                    class="mib-node-detail"
                                >
                                    <a-descriptions-item label="名称">
                                        {{ selectedOidNode.moduleQualifiedName || selectedOidNode.objectName }}
                                    </a-descriptions-item>
                                    <a-descriptions-item label="OID">
                                        <a-typography-text copyable>
                                            {{ selectedOidNode.oid }}
                                        </a-typography-text>
                                    </a-descriptions-item>
                                    <a-descriptions-item label="路径">
                                        {{ selectedOidNode.pathName || '-' }}
                                    </a-descriptions-item>
                                    <a-descriptions-item label="类型">
                                        {{ selectedOidNode.macro || '-' }}
                                    </a-descriptions-item>
                                    <a-descriptions-item label="语法">
                                        {{ selectedOidNode.syntax || '-' }}
                                    </a-descriptions-item>
                                    <a-descriptions-item label="访问">
                                        {{ selectedOidNode.maxAccess || '-' }}
                                    </a-descriptions-item>
                                    <a-descriptions-item label="状态">
                                        {{ selectedOidNode.status || '-' }}
                                    </a-descriptions-item>
                                </a-descriptions>
                                <a-empty v-else description="请选择OID节点" />
                            </div>
                        </section>

                        <section class="mib-file-block">
                            <div class="mib-panel-header">
                                <span class="mib-panel-title">文件状态</span>
                                <span class="mib-panel-meta">
                                    已编译 {{ compiledFileCount }} / 失败 {{ failedFileCount }}
                                </span>
                            </div>
                            <div class="mib-file-list">
                                <div v-for="record in mibFiles" :key="record.filePath" class="mib-file-row">
                                    <a-tag :color="record.status === 'compiled' ? 'green' : 'red'" class="mib-file-tag">
                                        {{ record.status === 'compiled' ? '已编译' : '失败' }}
                                    </a-tag>
                                    <a-tooltip :title="record.filePath">
                                        <span class="mib-file-name">{{ record.fileName }}</span>
                                    </a-tooltip>
                                    <a-tooltip v-if="record.msg" :title="record.msg">
                                        <InfoCircleOutlined class="mib-file-info" />
                                    </a-tooltip>
                                </div>
                                <a-empty v-if="mibFiles.length === 0" description="暂无文件" />
                            </div>
                        </section>
                    </aside>
                </div>
            </div>
        </a-card>

        <a-modal v-model:open="oidResultModalOpen" title="OID解析结果" :footer="null" width="640px">
            <a-alert
                v-if="oidResult"
                :type="oidResult.matched ? 'success' : 'warning'"
                show-icon
                :message="oidResult.matched ? oidResult.moduleQualifiedName : '未匹配到MIB对象'"
                :description="oidResult.matched ? oidResult.pathName || oidResult.oid : oidResult.oid"
            />

            <a-descriptions v-if="oidResult" :column="1" bordered size="small" class="oid-result-detail">
                <a-descriptions-item label="查询OID">
                    <a-typography-text copyable>
                        {{ oidResult.oid || '-' }}
                    </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="匹配OID">
                    <a-typography-text v-if="oidResult.matchedOid" copyable>
                        {{ oidResult.matchedOid }}
                    </a-typography-text>
                    <span v-else>-</span>
                </a-descriptions-item>
                <a-descriptions-item label="对象名称">
                    {{ oidResult.moduleQualifiedName || oidResult.objectName || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="模块">
                    {{ oidResult.moduleName || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="路径">
                    {{ oidResult.pathName || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="实例后缀">
                    {{ oidResult.instanceSuffix || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="类型">
                    {{ oidResult.macro || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="语法">
                    {{ oidResult.syntax || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="访问">
                    {{ oidResult.maxAccess || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="状态">
                    {{ oidResult.status || '-' }}
                </a-descriptions-item>
            </a-descriptions>
        </a-modal>
    </div>
</template>

<script setup>
    import { computed, ref, onActivated, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import {
        DeleteOutlined,
        FileSearchOutlined,
        FolderOpenOutlined,
        InfoCircleOutlined,
        ReloadOutlined
    } from '@ant-design/icons-vue';

    defineOptions({ name: 'SnmpMib' });

    const mibCompileLoading = ref(false);
    const oidTranslateLoading = ref(false);
    const oidQuery = ref('');
    const oidResult = ref(null);
    const oidResultModalOpen = ref(false);
    const mibFiles = ref([]);
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const selectedOidNode = ref(null);
    const mibStatus = ref({
        loadedFiles: [],
        failedFiles: [],
        requestedFiles: [],
        modules: [],
        baseModules: [],
        totalObjects: 0,
        expandedFileCount: 0,
        cacheHit: false,
        oidTree: []
    });

    const compiledFileCount = computed(() => mibStatus.value.loadedFiles.length);
    const failedFileCount = computed(() => mibStatus.value.failedFiles.length);

    const normalizeMibStatus = payload => ({
        loadedFiles: Array.isArray(payload?.loadedFiles) ? payload.loadedFiles : [],
        failedFiles: Array.isArray(payload?.failedFiles) ? payload.failedFiles : [],
        requestedFiles: Array.isArray(payload?.requestedFiles) ? payload.requestedFiles : [],
        modules: Array.isArray(payload?.modules) ? payload.modules : [],
        baseModules: Array.isArray(payload?.baseModules) ? payload.baseModules : [],
        totalObjects: Number(payload?.totalObjects) || 0,
        expandedFileCount: Number(payload?.expandedFileCount) || 0,
        cacheHit: Boolean(payload?.cacheHit),
        oidTree: Array.isArray(payload?.oidTree) ? payload.oidTree : []
    });

    const buildInitialExpandedKeys = (nodes, maxDepth = 2, depth = 0) => {
        const keys = [];
        nodes.forEach(node => {
            if (depth < maxDepth && node.children?.length > 0) {
                keys.push(node.key);
                keys.push(...buildInitialExpandedKeys(node.children, maxDepth, depth + 1));
            }
        });
        return keys;
    };

    const findTreeNode = (nodes, key) => {
        for (const node of nodes) {
            if (node.key === key) {
                return node;
            }

            const matched = findTreeNode(node.children || [], key);
            if (matched) {
                return matched;
            }
        }

        return null;
    };

    const findAncestorKeys = (nodes, key, parents = []) => {
        for (const node of nodes) {
            if (node.key === key) {
                return parents;
            }

            const matched = findAncestorKeys(node.children || [], key, [...parents, node.key]);
            if (matched) {
                return matched;
            }
        }

        return null;
    };

    const selectOidNode = oid => {
        const node = findTreeNode(mibStatus.value.oidTree, oid);
        if (!node) {
            return;
        }

        const ancestors = findAncestorKeys(mibStatus.value.oidTree, oid) || [];
        treeSelectedKeys.value = [oid];
        treeExpandedKeys.value = Array.from(new Set([...treeExpandedKeys.value, ...ancestors]));
        selectedOidNode.value = node;
    };

    const setMibStatus = payload => {
        const currentSelectedKey = treeSelectedKeys.value[0];
        mibStatus.value = normalizeMibStatus(payload);
        mibFiles.value = [
            ...mibStatus.value.loadedFiles.map(file => ({
                ...file,
                status: file.status || 'compiled',
                msg: file.msg || ''
            })),
            ...mibStatus.value.failedFiles.map(file => ({
                ...file,
                status: 'failed'
            }))
        ];

        treeExpandedKeys.value = buildInitialExpandedKeys(mibStatus.value.oidTree);
        if (currentSelectedKey) {
            selectOidNode(currentSelectedKey);
        } else {
            selectedOidNode.value = null;
            treeSelectedKeys.value = [];
        }
    };

    const loadMibStatus = async () => {
        try {
            mibCompileLoading.value = true;
            const result = await window.snmpApi.getMibStatus();
            if (result.status === 'success') {
                setMibStatus(result.data);
            }
        } catch (error) {
            console.error(error);
        } finally {
            mibCompileLoading.value = false;
        }
    };

    const compileMibFiles = async filePaths => {
        try {
            mibCompileLoading.value = true;
            const result = await window.snmpApi.compileMibs(filePaths);
            if (result.status === 'success') {
                setMibStatus(result.data);
                if (result.data?.failedFiles?.length > 0) {
                    message.warning(`MIB编译完成，${result.data.failedFiles.length} 个文件失败`);
                } else {
                    message.success('MIB编译完成');
                }
            } else {
                message.error(result.msg || 'MIB编译失败');
            }
        } catch (error) {
            message.error('MIB编译失败: ' + error.message);
        } finally {
            mibCompileLoading.value = false;
        }
    };

    const selectMibFiles = async () => {
        try {
            const result = await window.snmpApi.selectMibFiles();
            if (result.status !== 'success') {
                message.error(result.msg || '选择MIB文件失败');
                return;
            }

            const selectedFiles = Array.isArray(result.data) ? result.data : [];
            if (selectedFiles.length === 0) {
                return;
            }

            const currentFiles = mibStatus.value.requestedFiles.length
                ? mibStatus.value.requestedFiles
                : mibFiles.value.map(file => file.filePath);
            const allFiles = Array.from(new Set([...currentFiles, ...selectedFiles]));
            await compileMibFiles(allFiles);
        } catch (error) {
            message.error('选择MIB文件失败: ' + error.message);
        }
    };

    const selectMibDirectory = async () => {
        try {
            const result = await window.snmpApi.selectMibDirectory();
            if (result.status !== 'success') {
                message.error(result.msg || '选择MIB目录失败');
                return;
            }

            if (!result.data) {
                return;
            }

            const currentFiles = mibStatus.value.requestedFiles.length
                ? mibStatus.value.requestedFiles
                : mibFiles.value.map(file => file.filePath);
            const allPaths = Array.from(new Set([...currentFiles, result.data]));
            await compileMibFiles(allPaths);
        } catch (error) {
            message.error('选择MIB目录失败: ' + error.message);
        }
    };

    const compileStoredMibs = async () => {
        const currentFiles = mibStatus.value.requestedFiles.length
            ? mibStatus.value.requestedFiles
            : mibFiles.value.map(file => file.filePath);
        await compileMibFiles(currentFiles);
    };

    const clearMibs = async () => {
        try {
            const result = await window.snmpApi.clearMibs();
            if (result.status === 'success') {
                setMibStatus(result.data);
                oidResult.value = null;
                oidResultModalOpen.value = false;
                message.success(result.msg || 'MIB配置已清空');
            } else {
                message.error(result.msg || '清空MIB配置失败');
            }
        } catch (error) {
            message.error('清空MIB配置失败: ' + error.message);
        }
    };

    const handleTreeSelect = selectedKeys => {
        treeSelectedKeys.value = selectedKeys;
        selectedOidNode.value = selectedKeys.length > 0 ? findTreeNode(mibStatus.value.oidTree, selectedKeys[0]) : null;
    };

    const translateOid = async () => {
        const oid = oidQuery.value.trim();
        if (!oid) {
            message.warning('请输入OID');
            return;
        }

        try {
            oidTranslateLoading.value = true;
            const result = await window.snmpApi.translateOid(oid);
            if (result.status === 'success') {
                oidResult.value = result.data;
                oidResultModalOpen.value = true;
                if (result.data?.matchedOid) {
                    selectOidNode(result.data.matchedOid);
                }
            } else {
                message.error(result.msg || 'OID解析失败');
            }
        } catch (error) {
            message.error('OID解析失败: ' + error.message);
        } finally {
            oidTranslateLoading.value = false;
        }
    };

    defineExpose({
        clearValidationErrors: () => {}
    });

    onActivated(() => {
        loadMibStatus();
    });

    onMounted(() => {
        loadMibStatus();
    });
</script>

<style scoped>
    .snmp-mib-page {
        height: calc(100vh - 68px);
        overflow: hidden;
    }

    .mib-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .mib-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .mib-workspace {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .mib-toolbar {
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
    }

    .mib-action-group,
    .mib-status-group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        min-width: 0;
    }

    .mib-query-row {
        display: grid;
        flex-shrink: 0;
        grid-template-columns: minmax(0, 1fr) 96px;
        gap: 8px;
        min-width: 0;
    }

    .mib-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 34%);
        flex: 1;
        gap: 10px;
        min-height: 0;
        overflow: hidden;
    }

    .mib-tree-panel,
    .mib-side-panel,
    .mib-detail-block,
    .mib-file-block {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: #fff;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
    }

    .mib-side-panel {
        gap: 8px;
        border: 0;
        border-radius: 0;
        background: transparent;
    }

    .mib-detail-block {
        flex: 0 0 52%;
    }

    .mib-file-block {
        flex: 1;
    }

    .mib-panel-header {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        height: 34px;
        padding: 0 10px;
        border-bottom: 1px solid #f0f0f0;
    }

    .mib-panel-title {
        overflow: hidden;
        font-weight: 600;
        color: #262626;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-panel-meta {
        flex-shrink: 0;
        margin-left: 8px;
        color: #8c8c8c;
        font-size: 12px;
        white-space: nowrap;
    }

    .mib-tree-scroll,
    .mib-detail-scroll,
    .mib-file-list {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }

    .mib-tree-scroll {
        overflow-x: auto;
        padding: 6px 4px 6px 0;
    }

    .mib-tree-scroll :deep(.ant-tree) {
        display: inline-block;
        min-width: 100%;
    }

    .mib-tree-scroll :deep(.ant-tree-node-content-wrapper) {
        min-width: 0;
    }

    .mib-node-title {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        min-width: max-content;
        vertical-align: middle;
    }

    .mib-node-name {
        color: #262626;
        white-space: nowrap;
    }

    .mib-node-oid,
    .mib-node-module,
    .mib-node-macro {
        flex-shrink: 0;
        color: #8c8c8c;
        font-size: 12px;
        white-space: nowrap;
    }

    .mib-node-macro {
        color: #1677ff;
    }

    .mib-detail-scroll {
        padding: 8px;
    }

    .mib-node-detail :deep(.ant-descriptions-item-label) {
        width: 72px;
    }

    .mib-file-list {
        padding: 6px 8px;
    }

    .mib-file-row {
        display: flex;
        gap: 6px;
        align-items: center;
        min-width: 0;
        height: 28px;
        border-bottom: 1px solid #f5f5f5;
    }

    .mib-file-row:last-child {
        border-bottom: 0;
    }

    .mib-file-tag {
        flex-shrink: 0;
        margin-inline-end: 0;
    }

    .mib-file-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-file-info {
        flex-shrink: 0;
        color: #faad14;
    }

    .oid-result-detail {
        margin-top: 10px;
    }

    .oid-result-detail :deep(.ant-descriptions-item-label) {
        width: 92px;
    }

    @media (max-width: 900px) {
        .mib-main {
            grid-template-rows: minmax(0, 1fr) minmax(180px, 38%);
            grid-template-columns: minmax(0, 1fr);
        }

        .mib-side-panel {
            flex-direction: row;
        }

        .mib-detail-block,
        .mib-file-block {
            flex: 1;
        }
    }

    @media (max-width: 640px) {
        .mib-query-row {
            grid-template-columns: minmax(0, 1fr);
        }

        .mib-side-panel {
            flex-direction: column;
        }

        .mib-detail-block {
            flex: 0 0 50%;
        }
    }

    @media (max-height: 620px) {
        .mib-panel-header {
            height: 30px;
        }

        .mib-detail-block {
            flex-basis: 46%;
        }

        .mib-detail-scroll,
        .mib-file-list {
            padding: 6px;
        }
    }
</style>
