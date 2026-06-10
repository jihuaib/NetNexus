<template>
    <div class="mt-container snmp-mib-page" @click="hideContextMenu">
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
                                @right-click="handleTreeRightClick"
                                @select="handleTreeSelect"
                            >
                                <template #title="{ title, oid, moduleName, macro, canGet, canSet, notifyOnly, nodeRole }">
                                    <span class="mib-node-title">
                                        <span class="mib-node-name">{{ title }}</span>
                                        <span class="mib-node-oid">{{ oid }}</span>
                                        <span v-if="macro" class="mib-node-macro">{{ macro }}</span>
                                        <span
                                            v-if="getNodeRoleText({ canGet, canSet, notifyOnly, nodeRole })"
                                            :class="[
                                                'mib-node-role',
                                                getNodeRoleClass({ canGet, canSet, notifyOnly, nodeRole })
                                            ]"
                                        >
                                            {{ getNodeRoleText({ canGet, canSet, notifyOnly, nodeRole }) }}
                                        </span>
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
                                    <a-descriptions-item v-if="selectedOidNode.canGet || selectedOidNode.canSet" label="查询OID">
                                        <a-typography-text copyable>
                                            {{ selectedOidNode.queryOid || selectedOidNode.oid }}
                                        </a-typography-text>
                                    </a-descriptions-item>
                                    <a-descriptions-item label="能力">
                                        {{ getNodeAbilityText(selectedOidNode) }}
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

        <a-modal
            v-model:open="getModalOpen"
            title="SNMP GET"
            ok-text="发送 GET"
            cancel-text="取消"
            :confirm-loading="getSending"
            width="680px"
            @ok="sendGetRequest"
        >
            <a-alert
                v-if="getTargetNode?.isTableColumn"
                type="warning"
                show-icon
                message="表字段需要指定行索引"
                description="请在OID最后补具体行索引，例如接口表第1行追加 .1。"
                class="mib-request-alert"
            />
            <a-form :model="getForm" :label-col="{ style: { width: '86px' } }" class="mib-request-form">
                <a-form-item label="目标">
                    <div class="mib-request-readonly">{{ getRequestTargetText(getForm) }}</div>
                </a-form-item>
                <a-form-item label="版本">
                    <div class="mib-request-readonly">{{ getRequestAuthText(getForm) }}</div>
                </a-form-item>
                <a-form-item label="OID">
                    <a-input v-model:value="getForm.oid" />
                </a-form-item>
            </a-form>

            <a-descriptions v-if="getResult" :column="1" bordered size="small" class="mib-request-result">
                <a-descriptions-item label="OID">
                    <a-typography-text copyable>
                        {{ getResult.oid }}
                    </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="类型">
                    {{ getResult.type || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="值">
                    <a-typography-text copyable>
                        {{ getResult.value }}
                    </a-typography-text>
                </a-descriptions-item>
            </a-descriptions>
        </a-modal>

        <a-modal
            v-model:open="setModalOpen"
            title="SNMP SET"
            ok-text="发送 SET"
            cancel-text="取消"
            :confirm-loading="setSending"
            width="680px"
            @ok="sendSetRequest"
        >
            <a-alert
                v-if="setTargetNode?.isTableColumn"
                type="warning"
                show-icon
                message="表字段需要指定行索引"
                description="请在OID最后补具体行索引，例如接口表第1行追加 .1。"
                class="mib-request-alert"
            />
            <a-form :model="setForm" :label-col="{ style: { width: '86px' } }" class="mib-request-form">
                <a-form-item label="目标">
                    <div class="mib-request-readonly">{{ getRequestTargetText(setForm) }}</div>
                </a-form-item>
                <a-form-item label="版本">
                    <div class="mib-request-readonly">{{ getRequestAuthText(setForm) }}</div>
                </a-form-item>
                <a-form-item label="OID">
                    <a-input v-model:value="setForm.oid" />
                </a-form-item>
                <a-row :gutter="12">
                    <a-col :span="12">
                        <a-form-item label="类型">
                            <a-select v-model:value="setForm.type">
                                <a-select-option v-for="option in setTypeOptions" :key="option.value" :value="option.value">
                                    {{ option.label }}
                                </a-select-option>
                            </a-select>
                        </a-form-item>
                    </a-col>
                    <a-col :span="12">
                        <a-form-item label="值">
                            <a-input v-model:value="setForm.value" placeholder="请输入SET值" />
                        </a-form-item>
                    </a-col>
                </a-row>
            </a-form>
        </a-modal>

        <div
            v-if="contextMenu.visible"
            class="mib-context-menu"
            :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
            @click.stop
        >
            <div class="mib-context-menu-title">
                {{ contextMenu.node?.moduleQualifiedName || contextMenu.node?.objectName || 'OID节点' }}
            </div>
            <a-menu class="mib-context-menu-list" :selectable="false" @click="handleContextMenuClick">
                <a-menu-item key="copy">
                    <template #icon><CopyOutlined /></template>
                    复制OID
                </a-menu-item>
                <a-menu-item key="parse">
                    <template #icon><SearchOutlined /></template>
                    解析OID
                </a-menu-item>
                <a-menu-divider />
                <a-menu-item key="get" :disabled="!canGetNode(contextMenu.node)">
                    <template #icon><ApiOutlined /></template>
                    GET 查询
                </a-menu-item>
                <a-menu-item key="set" :disabled="!canSetNode(contextMenu.node)">
                    <template #icon><EditOutlined /></template>
                    SET 设置
                </a-menu-item>
                <a-menu-item key="notify" :disabled="!isNotifyNode(contextMenu.node)">
                    <template #icon><BellOutlined /></template>
                    Trap变量
                </a-menu-item>
            </a-menu>
            <div class="mib-context-menu-hint">
                {{ getNodeAbilityText(contextMenu.node) }}
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, reactive, ref, onActivated, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_VALUES } from '../../const/snmpConst';
    import {
        ApiOutlined,
        BellOutlined,
        CopyOutlined,
        DeleteOutlined,
        EditOutlined,
        FileSearchOutlined,
        FolderOpenOutlined,
        InfoCircleOutlined,
        ReloadOutlined,
        SearchOutlined
    } from '@ant-design/icons-vue';

    defineOptions({ name: 'SnmpMib' });

    const mibCompileLoading = ref(false);
    const oidTranslateLoading = ref(false);
    const oidQuery = ref('');
    const oidResult = ref(null);
    const oidResultModalOpen = ref(false);
    const getModalOpen = ref(false);
    const getSending = ref(false);
    const getTargetNode = ref(null);
    const getResult = ref(null);
    const setModalOpen = ref(false);
    const setSending = ref(false);
    const setTargetNode = ref(null);
    const mibFiles = ref([]);
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const selectedOidNode = ref(null);
    const contextMenu = reactive({
        visible: false,
        x: 0,
        y: 0,
        node: null
    });
    const CONTEXT_MENU_WIDTH = 196;
    const CONTEXT_MENU_HEIGHT = 238;
    const CONTEXT_MENU_MARGIN = 8;
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
    const getForm = reactive({
        targetHost: DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
        targetPort: DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT,
        version: 'v2c',
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY,
        oid: ''
    });
    const setForm = reactive({
        targetHost: DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
        targetPort: DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT,
        version: 'v2c',
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY,
        oid: '',
        type: 'OctetString',
        value: ''
    });
    const setTypeOptions = [
        { label: 'Integer', value: 'Integer' },
        { label: 'OctetString', value: 'OctetString' },
        { label: 'OID', value: 'OID' },
        { label: 'IpAddress', value: 'IpAddress' },
        { label: 'Counter32', value: 'Counter32' },
        { label: 'Gauge32 / Unsigned32', value: 'Gauge32' },
        { label: 'TimeTicks', value: 'TimeTicks' },
        { label: 'Counter64', value: 'Counter64' }
    ];

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

    const canGetNode = node => Boolean(node?.canGet);
    const canSetNode = node => Boolean(node?.canSet);
    const isNotifyNode = node => Boolean(node?.notifyOnly);

    const getNodeRoleText = node => {
        if (!node) return '';
        if (node.canSet) return 'GET/SET';
        if (node.canGet) return 'GET';
        if (node.notifyOnly) return 'Trap';
        if (node.nodeRole === 'not-accessible') return '不可访问';
        return '';
    };

    const getNodeRoleClass = node => {
        if (!node) return '';
        if (node.canSet) return 'is-write';
        if (node.canGet) return 'is-read';
        if (node.notifyOnly) return 'is-notify';
        if (node.nodeRole === 'not-accessible') return 'is-disabled';
        return '';
    };

    const getNodeAbilityText = node => {
        if (!node) return '-';
        if (node.canSet && node.isTableColumn) return '表字段可GET/SET，需要指定表行索引';
        if (node.canSet && node.isScalar) return '标量可GET/SET，查询时自动追加 .0';
        if (node.canSet) return '允许GET查询和SET设置';
        if (node.canGet && node.isTableColumn) return '表字段可GET，需要指定表行索引';
        if (node.canGet && node.isScalar) return '标量可GET，查询时自动追加 .0';
        if (node.canGet) return '允许GET查询，不允许SET';
        if (node.notifyOnly) return '仅用于Trap/Inform通知变量';
        if (node.nodeRole === 'not-accessible') return '不可直接GET/SET，多为表、行或分组节点';
        return '分组或标识节点，不直接承载查询值';
    };

    const getEffectiveQueryOid = node => {
        if (!node?.oid) {
            return '';
        }
        return node.queryOid || (node.isScalar ? `${node.oid}.0` : node.oid);
    };

    const getRequestTargetText = form => `${form.targetHost || '-'}:${form.targetPort || '-'}`;

    const getRequestAuthText = form => {
        const version = form.version ? String(form.version).toUpperCase() : '-';
        return `${version} / ${form.community || '-'}`;
    };

    const getConfiguredSessionVersion = versions => {
        if (!Array.isArray(versions) || versions.length === 0 || !versions[0]) {
            return 'v2c';
        }
        return ['v1', 'v2c'].includes(versions[0]) ? versions[0] : '';
    };

    const inferSetType = syntax => {
        const normalized = String(syntax || '')
            .replace(/[\s_-]+/g, '')
            .toLowerCase();
        if (!normalized) return 'OctetString';
        if (
            normalized.includes('displaystring') ||
            normalized.includes('octetstring') ||
            normalized.includes('physaddress')
        ) {
            return 'OctetString';
        }
        if (normalized.includes('objectidentifier') || normalized === 'oid') {
            return 'OID';
        }
        if (normalized.includes('ipaddress')) {
            return 'IpAddress';
        }
        if (normalized.includes('counter64')) {
            return 'Counter64';
        }
        if (normalized.includes('counter32') || normalized === 'counter') {
            return 'Counter32';
        }
        if (normalized.includes('gauge') || normalized.includes('unsigned32')) {
            return 'Gauge32';
        }
        if (normalized.includes('timeticks')) {
            return 'TimeTicks';
        }
        if (
            normalized.includes('integer') ||
            normalized.includes('truthvalue') ||
            normalized.includes('rowstatus') ||
            normalized.includes('enumeration')
        ) {
            return 'Integer';
        }
        return 'OctetString';
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

    const getContextMenuPosition = event => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const maxX = Math.max(CONTEXT_MENU_MARGIN, viewportWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN);
        const maxY = Math.max(CONTEXT_MENU_MARGIN, viewportHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN);

        return {
            x: Math.min(Math.max(CONTEXT_MENU_MARGIN, event.clientX), maxX),
            y: Math.min(Math.max(CONTEXT_MENU_MARGIN, event.clientY), maxY)
        };
    };

    const handleTreeRightClick = ({ event, node }) => {
        event.preventDefault();
        event.stopPropagation();
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matchedNode = findTreeNode(mibStatus.value.oidTree, key) || node?.dataRef || node;
        if (!matchedNode?.key) {
            return;
        }

        treeSelectedKeys.value = [matchedNode.key];
        selectedOidNode.value = matchedNode;
        contextMenu.node = matchedNode;
        const position = getContextMenuPosition(event);
        contextMenu.x = position.x;
        contextMenu.y = position.y;
        contextMenu.visible = true;
    };

    const hideContextMenu = () => {
        contextMenu.visible = false;
    };

    const handleContextMenuClick = ({ key }) => {
        const actions = {
            copy: copyContextOid,
            parse: parseContextOid,
            get: showGetCapability,
            set: showSetCapability,
            notify: showNotifyCapability
        };
        actions[key]?.();
    };

    const copyContextOid = async () => {
        const oid = contextMenu.node?.oid;
        if (!oid) {
            return;
        }

        try {
            await navigator.clipboard.writeText(oid);
            message.success('OID已复制');
        } catch (error) {
            oidQuery.value = oid;
            message.warning('复制失败，已填入OID输入框');
        } finally {
            hideContextMenu();
        }
    };

    const parseContextOid = async () => {
        if (!contextMenu.node?.oid) {
            return;
        }

        oidQuery.value = contextMenu.node.oid;
        hideContextMenu();
        await translateOid();
    };

    const showGetCapability = async () => {
        const node = contextMenu.node;
        if (!node?.oid) {
            return;
        }

        hideContextMenu();
        await loadRequestDefaults(getForm);
        getTargetNode.value = node;
        getForm.oid = getEffectiveQueryOid(node);
        getResult.value = null;
        getModalOpen.value = true;
    };

    const showSetCapability = async () => {
        const node = contextMenu.node;
        hideContextMenu();
        if (!node?.canSet) {
            return;
        }

        await loadRequestDefaults(setForm);
        setTargetNode.value = node;
        setForm.oid = getEffectiveQueryOid(node);
        setForm.type = inferSetType(node.syntax);
        setForm.value = '';
        setModalOpen.value = true;
    };

    const showNotifyCapability = () => {
        hideContextMenu();
        message.info('该节点用于Trap/Inform变量绑定，不用于普通GET/SET');
    };

    const loadRequestDefaults = async form => {
        try {
            const result = await window.snmpApi.getSnmpConfig();
            const config = result.status === 'success' && result.data ? result.data : {};
            const versions = Array.isArray(config.supportedVersions) ? config.supportedVersions : [];
            form.targetHost = config.targetHost || DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST;
            form.targetPort = config.queryPort || DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT;
            form.community = config.community || DEFAULT_VALUES.DEFAULT_COMMUNITY;
            form.version = getConfiguredSessionVersion(versions);
        } catch (error) {
            form.targetHost = DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST;
            form.targetPort = DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT;
            form.community = DEFAULT_VALUES.DEFAULT_COMMUNITY;
            form.version = 'v2c';
        }
    };

    const sendGetRequest = async () => {
        await loadRequestDefaults(getForm);
        if (!getForm.targetHost || !getForm.targetPort || !getForm.version) {
            message.warning('请在SNMP配置中填写GET目标并启用SNMPv1/v2c');
            return;
        }

        if (!getForm.oid) {
            message.warning('请填写OID');
            return;
        }

        try {
            getSending.value = true;
            const result = await window.snmpApi.sendGetRequest({ oid: getForm.oid });
            if (result.status === 'success') {
                const varbind = result.data?.varbinds?.[0] || null;
                getResult.value = varbind;
                message.success('GET查询成功');
                return;
            }

            message.error(result.msg || 'GET查询失败');
        } catch (error) {
            message.error('GET查询失败: ' + error.message);
        } finally {
            getSending.value = false;
        }
    };

    const sendSetRequest = async () => {
        await loadRequestDefaults(setForm);
        if (!setForm.targetHost || !setForm.targetPort || !setForm.version) {
            message.warning('请在SNMP配置中填写SET目标并启用SNMPv1/v2c');
            return;
        }

        if (!setForm.oid || !setForm.value) {
            message.warning('请填写OID和值');
            return;
        }

        try {
            setSending.value = true;
            const result = await window.snmpApi.sendSetRequest({
                oid: setForm.oid,
                type: setForm.type,
                value: setForm.value
            });
            if (result.status === 'success') {
                setModalOpen.value = false;
                const varbind = result.data?.varbinds?.[0];
                message.success(`SET成功${varbind?.value !== undefined ? `: ${varbind.value}` : ''}`);
                return;
            }

            message.error(result.msg || 'SET发送失败');
        } catch (error) {
            message.error('SET发送失败: ' + error.message);
        } finally {
            setSending.value = false;
        }
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

    .mib-node-role {
        flex-shrink: 0;
        padding: 0 5px;
        border-radius: 4px;
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
    }

    .mib-node-role.is-read {
        color: #0958d9;
        background: #e6f4ff;
    }

    .mib-node-role.is-write {
        color: #389e0d;
        background: #f6ffed;
    }

    .mib-node-role.is-notify {
        color: #d46b08;
        background: #fff7e6;
    }

    .mib-node-role.is-disabled {
        color: #8c8c8c;
        background: #f5f5f5;
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

    .mib-request-alert {
        margin-bottom: 10px;
    }

    .mib-request-readonly {
        min-height: 32px;
        overflow: hidden;
        padding: 0 11px;
        color: #262626;
        line-height: 30px;
        text-overflow: ellipsis;
        white-space: nowrap;
        background: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
    }

    .mib-request-form :deep(.ant-form-item) {
        margin-bottom: 10px;
    }

    .mib-request-result {
        margin-top: 10px;
    }

    .mib-request-result :deep(.ant-descriptions-item-label) {
        width: 86px;
    }

    .mib-context-menu {
        position: fixed;
        z-index: 1200;
        width: 196px;
        max-height: calc(100vh - 16px);
        padding: 4px 0;
        overflow-y: auto;
        background: #fff;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
    }

    .mib-context-menu-title {
        overflow: hidden;
        padding: 5px 12px 6px;
        color: #262626;
        font-weight: 600;
        font-size: 13px;
        line-height: 20px;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-bottom: 1px solid #f0f0f0;
    }

    .mib-context-menu-list {
        border-inline-end: 0;
    }

    .mib-context-menu-list :deep(.ant-menu-item) {
        height: 30px;
        margin: 2px 4px;
        line-height: 30px;
        border-radius: 4px;
    }

    .mib-context-menu-list :deep(.ant-menu-item-divider) {
        margin: 4px 0;
    }

    .mib-context-menu-hint {
        padding: 6px 12px 4px;
        color: #8c8c8c;
        font-size: 12px;
        line-height: 18px;
        border-top: 1px solid #f0f0f0;
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
