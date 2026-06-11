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
                        <a-button :disabled="mibFiles.length === 0" :loading="projectSaving" @click="showSaveProject">
                            <template #icon><SaveOutlined /></template>
                            保存工程
                        </a-button>
                        <a-button :loading="projectLoading || projectImporting" @click="showImportProject">
                            <template #icon><ImportOutlined /></template>
                            导入工程
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
                        <div ref="treeScrollRef" class="mib-tree-scroll">
                            <a-tree
                                v-if="mibStatus.oidTree.length > 0"
                                ref="treeRef"
                                v-model:expanded-keys="treeExpandedKeys"
                                :selected-keys="treeSelectedKeys"
                                :tree-data="mibStatus.oidTree"
                                block-node
                                @expand="handleTreeExpand"
                                @right-click="handleTreeRightClick"
                                @select="handleTreeSelect"
                            >
                                <template #title="{ title, oid, moduleName, macro, canGet, canSet, notifyOnly, nodeRole }">
                                    <span class="mib-node-title" :data-tree-oid="oid">
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
            v-model:open="projectSaveOpen"
            title="保存MIB工程"
            ok-text="保存"
            cancel-text="取消"
            :confirm-loading="projectSaving"
            width="520px"
            @ok="saveMibProject"
        >
            <a-form :model="projectForm" :label-col="{ style: { width: '72px' } }">
                <a-form-item label="工程名">
                    <a-input
                        v-model:value="projectForm.name"
                        :maxlength="80"
                        placeholder="请输入工程名"
                        @press-enter="saveMibProject"
                    />
                </a-form-item>
                <a-form-item label="内容">
                    <div class="mib-project-meta">
                        文件 {{ mibStatus.expandedFileCount }} / 模块 {{ mibStatus.modules.length }} / OID
                        {{ mibStatus.totalObjects }}
                    </div>
                </a-form-item>
            </a-form>
        </a-modal>

        <a-modal v-model:open="projectImportOpen" title="导入MIB工程" :footer="null" width="760px">
            <div class="mib-project-header">
                <a-tooltip :title="projectRootDir">
                    <span class="mib-project-root">{{ projectRootDir || 'userData/snmp-mib-projects' }}</span>
                </a-tooltip>
                <a-button size="small" :loading="projectLoading" @click="loadMibProjects">刷新</a-button>
            </div>
            <a-table
                :columns="projectColumns"
                :data-source="mibProjects"
                :loading="projectLoading"
                :pagination="{ pageSize: 6, size: 'small' }"
                row-key="name"
                size="small"
                class="mib-project-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'name'">
                        <a-tooltip :title="record.directory">
                            <span class="mib-project-name">{{ record.name }}</span>
                        </a-tooltip>
                    </template>
                    <template v-else-if="column.key === 'updatedAt'">
                        {{ formatProjectTime(record.updatedAt) }}
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-button
                            type="link"
                            size="small"
                            :loading="projectImporting && importingProjectName === record.name"
                            @click="importMibProject(record)"
                        >
                            导入
                        </a-button>
                    </template>
                </template>
            </a-table>
        </a-modal>

        <a-modal
            v-model:open="getModalOpen"
            :title="getModalTitle"
            :ok-text="getModalOkText"
            cancel-text="取消"
            :confirm-loading="getSending"
            :z-index="REQUEST_MODAL_Z_INDEX"
            width="680px"
            @ok="sendGetRequest"
        >
            <a-form :model="getForm" :label-col="{ style: { width: '86px' } }" class="mib-request-form">
                <a-form-item label="目标">
                    <div class="mib-request-readonly">{{ getRequestTargetText(getForm) }}</div>
                </a-form-item>
                <a-form-item label="版本">
                    <div class="mib-request-readonly">{{ getRequestAuthText(getForm) }}</div>
                </a-form-item>
                <a-form-item label="对象">
                    <div class="mib-request-object">
                        <div class="mib-request-object-title">
                            {{ getRequestObjectName(getTargetNode, getForm.oid) }}
                        </div>
                        <div class="mib-request-object-meta">
                            {{ getRequestObjectPath(getTargetNode, getForm.oid) }}
                        </div>
                    </div>
                </a-form-item>
                <a-form-item label="实际OID">
                    <div class="mib-oid-input-row">
                        <a-input v-model:value="getForm.oid" />
                        <a-button
                            v-if="getTargetNode?.isTableColumn && !isGetNextMode"
                            :loading="instanceLoading && instanceTargetForm === 'get'"
                            @click="showInstanceSelector('get')"
                        >
                            选择实例
                        </a-button>
                    </div>
                </a-form-item>
            </a-form>

            <a-descriptions v-if="getResult" :column="1" bordered size="small" class="mib-request-result">
                <a-descriptions-item label="对象">
                    <div class="mib-request-object">
                        <div class="mib-request-object-title">
                            {{ getVarbindObjectName(getResult) }}
                        </div>
                        <div class="mib-request-object-meta">
                            {{ getVarbindObjectPath(getResult) }}
                        </div>
                        <a-typography-text copyable class="mib-request-object-oid">
                            {{ getResult.oid }}
                        </a-typography-text>
                    </div>
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
            :z-index="REQUEST_MODAL_Z_INDEX"
            width="680px"
            @ok="sendSetRequest"
        >
            <a-form :model="setForm" :label-col="{ style: { width: '86px' } }" class="mib-request-form">
                <a-form-item label="目标">
                    <div class="mib-request-readonly">{{ getRequestTargetText(setForm) }}</div>
                </a-form-item>
                <a-form-item label="版本">
                    <div class="mib-request-readonly">{{ getRequestAuthText(setForm) }}</div>
                </a-form-item>
                <a-form-item label="对象">
                    <div class="mib-request-object">
                        <div class="mib-request-object-title">
                            {{ getRequestObjectName(setTargetNode, setForm.oid) }}
                        </div>
                        <div class="mib-request-object-meta">
                            {{ getRequestObjectPath(setTargetNode, setForm.oid) }}
                        </div>
                    </div>
                </a-form-item>
                <a-form-item label="实际OID">
                    <div class="mib-oid-input-row">
                        <a-input v-model:value="setForm.oid" />
                        <a-button
                            v-if="setTargetNode?.isTableColumn"
                            :loading="instanceLoading && instanceTargetForm === 'set'"
                            @click="showInstanceSelector('set')"
                        >
                            选择实例
                        </a-button>
                    </div>
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

        <a-modal
            v-model:open="instanceModalOpen"
            title="选择实例"
            :footer="null"
            :z-index="INSTANCE_MODAL_Z_INDEX"
            width="760px"
        >
            <a-alert
                v-if="instanceMeta?.limitReached"
                type="warning"
                show-icon
                message="实例数量达到上限"
                description="仅显示前100条实例，可手动填写实例后缀或提高后台限制后重试。"
                class="mib-request-alert"
            />
            <a-alert
                v-else-if="instanceMeta?.rows?.length === 0"
                type="info"
                show-icon
                message="未发现实例"
                description="设备未返回当前字段前缀下的实例，或当前字段没有可访问行。"
                class="mib-request-alert"
            />
            <a-table
                :columns="instanceColumns"
                :data-source="instanceRows"
                :loading="instanceLoading"
                :pagination="{ pageSize: 8, size: 'small' }"
                size="small"
                row-key="oid"
                class="instance-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'object'">
                        <div class="instance-object">
                            <div class="instance-object-title">
                                {{ getInstanceObjectName(record) }}
                            </div>
                            <a-typography-text copyable class="instance-object-oid">
                                {{ record.oid }}
                            </a-typography-text>
                        </div>
                    </template>
                    <template v-else-if="column.key === 'value'">
                        <a-tooltip :title="record.value">
                            <span class="instance-value">{{ record.value || '-' }}</span>
                        </a-tooltip>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-button type="link" size="small" @click="selectInstance(record)">选择</a-button>
                    </template>
                </template>
            </a-table>
        </a-modal>

        <a-modal
            v-model:open="walkModalOpen"
            title="SNMP WALK"
            ok-text="开始 WALK"
            cancel-text="关闭"
            :confirm-loading="walkLoading"
            :z-index="REQUEST_MODAL_Z_INDEX"
            :width="WALK_MODAL_WIDTH"
            :body-style="WALK_MODAL_BODY_STYLE"
            wrap-class-name="walk-modal-wrap"
            @ok="sendWalkRequest"
        >
            <div class="walk-modal-body">
                <a-form :model="walkForm" :label-col="{ style: { width: '92px' } }" class="mib-request-form walk-form">
                    <a-row :gutter="12">
                        <a-col :xs="24" :sm="12">
                            <a-form-item label="目标">
                                <div class="mib-request-readonly">{{ getRequestTargetText(walkForm) }}</div>
                            </a-form-item>
                        </a-col>
                        <a-col :xs="24" :sm="12">
                            <a-form-item label="版本">
                                <div class="mib-request-readonly">{{ getRequestAuthText(walkForm) }}</div>
                            </a-form-item>
                        </a-col>
                    </a-row>
                    <a-form-item label="起始对象">
                        <div class="mib-request-object">
                            <div class="mib-request-object-title">
                                {{ getRequestObjectName(walkTargetNode, walkForm.oid) }}
                            </div>
                            <div class="mib-request-object-meta">
                                {{ getRequestObjectPath(walkTargetNode, walkForm.oid) }}
                            </div>
                        </div>
                    </a-form-item>
                    <a-row :gutter="12">
                        <a-col :xs="24" :md="12">
                            <a-form-item label="起始OID">
                                <a-input v-model:value="walkForm.oid" />
                            </a-form-item>
                        </a-col>
                        <a-col :xs="12" :md="6">
                            <a-form-item label="上限">
                                <a-input-number v-model:value="walkForm.limit" :min="1" :max="1000" style="width: 100%" />
                            </a-form-item>
                        </a-col>
                        <a-col :xs="12" :md="6">
                            <a-form-item label="批量数">
                                <a-input-number
                                    v-model:value="walkForm.maxRepetitions"
                                    :min="1"
                                    :max="50"
                                    style="width: 100%"
                                    :disabled="walkForm.version !== 'v2c'"
                                />
                            </a-form-item>
                        </a-col>
                    </a-row>
                </a-form>

                <div v-if="walkMeta" class="walk-summary">
                    <a-space>
                        <a-tag color="blue">{{ walkRows.length }} 条</a-tag>
                        <a-tag v-if="walkMeta.limitReached" color="orange">达到上限</a-tag>
                        <a-tag v-else color="green">已停止: {{ walkMeta.stoppedBy || '-' }}</a-tag>
                    </a-space>
                </div>
                <div class="walk-output-shell">
                    <textarea
                        class="walk-output-textarea"
                        readonly
                        spellcheck="false"
                        :value="walkOutputText || '暂无 WALK 结果'"
                    />
                    <div v-if="walkLoading" class="walk-output-loading">WALK 查询中...</div>
                </div>
            </div>
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
                <a-menu-item key="getNext" :disabled="!contextMenu.node?.oid">
                    <template #icon><StepForwardOutlined /></template>
                    GET-NEXT 查询
                </a-menu-item>
                <a-menu-item key="walk" :disabled="!contextMenu.node?.oid">
                    <template #icon><FileSearchOutlined /></template>
                    WALK 查询
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
    import { computed, reactive, ref, nextTick, onActivated, onBeforeUnmount, onMounted } from 'vue';
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
        ImportOutlined,
        InfoCircleOutlined,
        ReloadOutlined,
        SaveOutlined,
        SearchOutlined,
        StepForwardOutlined
    } from '@ant-design/icons-vue';

    defineOptions({ name: 'SnmpMib' });

    const mibCompileLoading = ref(false);
    const oidTranslateLoading = ref(false);
    const oidQuery = ref('');
    const oidResult = ref(null);
    const oidResultModalOpen = ref(false);
    const getModalOpen = ref(false);
    const getSending = ref(false);
    const getRequestMode = ref('get');
    const getTargetNode = ref(null);
    const getResult = ref(null);
    const setModalOpen = ref(false);
    const setSending = ref(false);
    const setTargetNode = ref(null);
    const walkModalOpen = ref(false);
    const walkLoading = ref(false);
    const walkTargetNode = ref(null);
    const walkRows = ref([]);
    const walkMeta = ref(null);
    const instanceModalOpen = ref(false);
    const instanceLoading = ref(false);
    const instanceTargetForm = ref('get');
    const instanceRows = ref([]);
    const instanceMeta = ref(null);
    const projectSaveOpen = ref(false);
    const projectSaving = ref(false);
    const projectImportOpen = ref(false);
    const projectLoading = ref(false);
    const projectImporting = ref(false);
    const importingProjectName = ref('');
    const projectRootDir = ref('');
    const mibProjects = ref([]);
    const mibFiles = ref([]);
    const treeRef = ref(null);
    const treeScrollRef = ref(null);
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const selectedOidNode = ref(null);
    const treeLoadingPromises = new Map();
    const pendingTreeReleaseTimers = new Map();
    let mibStatusLoaded = false;
    let mibStatusLoadPromise = null;
    const contextMenu = reactive({
        visible: false,
        x: 0,
        y: 0,
        node: null
    });
    const projectForm = reactive({
        name: ''
    });
    const CONTEXT_MENU_WIDTH = 196;
    const CONTEXT_MENU_HEIGHT = 310;
    const CONTEXT_MENU_MARGIN = 8;
    const TREE_RELEASE_DELAY_MS = 300;
    const REQUEST_MODAL_Z_INDEX = 1000;
    const INSTANCE_MODAL_Z_INDEX = 1100;
    const WALK_MODAL_WIDTH = 'min(920px, calc(100vw - 32px))';
    const WALK_MODAL_BODY_STYLE = {
        display: 'flex',
        flexDirection: 'column',
        height: 'min(620px, calc(100vh - 170px))',
        maxWidth: '100%',
        maxHeight: 'calc(100vh - 170px)',
        overflow: 'hidden'
    };
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
    const walkForm = reactive({
        targetHost: DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
        targetPort: DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT,
        version: 'v2c',
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY,
        oid: '',
        limit: 100,
        maxRepetitions: 20
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
    const instanceColumns = [
        {
            title: '实例',
            dataIndex: 'instance',
            key: 'instance',
            width: 120
        },
        {
            title: '对象',
            dataIndex: 'oid',
            key: 'object',
            width: 300
        },
        {
            title: '类型',
            dataIndex: 'type',
            key: 'type',
            width: 110
        },
        {
            title: '值',
            dataIndex: 'value',
            key: 'value'
        },
        {
            title: '操作',
            key: 'action',
            width: 80
        }
    ];
    const projectColumns = [
        {
            title: '工程名',
            dataIndex: 'name',
            key: 'name'
        },
        {
            title: '文件',
            dataIndex: 'fileCount',
            key: 'fileCount',
            width: 72
        },
        {
            title: '模块',
            dataIndex: 'moduleCount',
            key: 'moduleCount',
            width: 72
        },
        {
            title: 'OID',
            dataIndex: 'totalObjects',
            key: 'totalObjects',
            width: 86
        },
        {
            title: '更新时间',
            dataIndex: 'updatedAt',
            key: 'updatedAt',
            width: 160
        },
        {
            title: '操作',
            key: 'action',
            width: 72
        }
    ];

    const compiledFileCount = computed(() => mibStatus.value.loadedFiles.length);
    const failedFileCount = computed(() => mibStatus.value.failedFiles.length);
    const isGetNextMode = computed(() => getRequestMode.value === 'getNext');
    const getModalTitle = computed(() => (isGetNextMode.value ? 'SNMP GET-NEXT' : 'SNMP GET'));
    const getModalOkText = computed(() => (isGetNextMode.value ? '发送 GET-NEXT' : '发送 GET'));

    const normalizeTreeNodes = nodes =>
        (Array.isArray(nodes) ? nodes : []).map(node => ({
            ...node,
            children: normalizeTreeNodes(node.children),
            isLeaf: Boolean(node.isLeaf)
        }));

    const normalizeMibStatus = payload => ({
        loadedFiles: Array.isArray(payload?.loadedFiles) ? payload.loadedFiles : [],
        failedFiles: Array.isArray(payload?.failedFiles) ? payload.failedFiles : [],
        requestedFiles: Array.isArray(payload?.requestedFiles) ? payload.requestedFiles : [],
        modules: Array.isArray(payload?.modules) ? payload.modules : [],
        baseModules: Array.isArray(payload?.baseModules) ? payload.baseModules : [],
        totalObjects: Number(payload?.totalObjects) || 0,
        expandedFileCount: Number(payload?.expandedFileCount) || 0,
        cacheHit: Boolean(payload?.cacheHit),
        oidTree: normalizeTreeNodes(payload?.oidTree)
    });

    const refreshTreeData = () => {
        mibStatus.value.oidTree = [...mibStatus.value.oidTree];
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

    const collectDescendantKeys = node => {
        const keys = [];
        (node?.children || []).forEach(child => {
            keys.push(child.key, ...collectDescendantKeys(child));
        });
        return keys;
    };

    const loadTreeNodeChildren = async node => {
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        if (!key) {
            return [];
        }

        const targetNode = findTreeNode(mibStatus.value.oidTree, key);
        if (!targetNode || targetNode.isLeaf) {
            return [];
        }

        if (targetNode.children?.length > 0) {
            return targetNode.children;
        }

        if (treeLoadingPromises.has(key)) {
            return treeLoadingPromises.get(key);
        }

        const loadPromise = (async () => {
            const result = await window.snmpApi.getMibTreeChildren(key);
            if (result.status !== 'success') {
                message.error(result.msg || '获取MIB树节点失败');
                return [];
            }

            const children = normalizeTreeNodes(result.data);
            if (!treeExpandedKeys.value.includes(key)) {
                return [];
            }

            targetNode.children = children;
            refreshTreeData();
            return children;
        })();

        treeLoadingPromises.set(key, loadPromise);
        try {
            return await loadPromise;
        } catch (error) {
            message.error('获取MIB树节点失败: ' + error.message);
            return [];
        } finally {
            treeLoadingPromises.delete(key);
        }
    };

    const releaseTreeNodeChildren = node => {
        if (!node) {
            return new Set();
        }

        const descendantKeys = new Set(collectDescendantKeys(node));
        node.children = [];
        refreshTreeData();

        return descendantKeys;
    };

    const cancelPendingTreeRelease = key => {
        const timer = pendingTreeReleaseTimers.get(key);
        if (!timer) {
            return;
        }

        clearTimeout(timer);
        pendingTreeReleaseTimers.delete(key);
    };

    const clearPendingTreeReleases = () => {
        pendingTreeReleaseTimers.forEach(timer => clearTimeout(timer));
        pendingTreeReleaseTimers.clear();
    };

    const scheduleTreeNodeChildrenRelease = key => {
        cancelPendingTreeRelease(key);

        const timer = setTimeout(() => {
            pendingTreeReleaseTimers.delete(key);
            nextTick(() => {
                if (treeExpandedKeys.value.includes(key)) {
                    return;
                }

                const node = findTreeNode(mibStatus.value.oidTree, key);
                if (node) {
                    releaseTreeNodeChildren(node);
                }
            });
        }, TREE_RELEASE_DELAY_MS);

        pendingTreeReleaseTimers.set(key, timer);
    };

    const loadTreePath = async treePath => {
        const pathParts = Array.isArray(treePath) ? treePath.filter(Boolean) : [];
        for (let index = 0; index < pathParts.length - 1; index++) {
            const node = findTreeNode(mibStatus.value.oidTree, pathParts[index]);
            if (!node) {
                return false;
            }

            treeExpandedKeys.value = Array.from(new Set([...treeExpandedKeys.value, pathParts[index]]));
            await loadTreeNodeChildren(node);
        }

        return true;
    };

    const findRenderedTreeOidElement = oid => {
        const scrollContainer = treeScrollRef.value;
        if (!scrollContainer || !oid) {
            return null;
        }

        return (
            Array.from(scrollContainer.querySelectorAll('.mib-node-title')).find(
                element => element.dataset.treeOid === oid
            ) || null
        );
    };

    const scrollToOidNode = async oid => {
        if (!oid) {
            return;
        }

        await nextTick();
        treeRef.value?.scrollTo?.({
            key: oid,
            align: 'auto',
            offset: 24
        });
        await nextTick();

        const targetElement = findRenderedTreeOidElement(oid);
        targetElement?.scrollIntoView({
            block: 'center',
            inline: 'nearest',
            behavior: 'smooth'
        });
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

    const normalizeOidText = oid =>
        String(oid || '')
            .trim()
            .replace(/\.$/, '');

    const getOidInstanceSuffix = (baseOid, oid) => {
        const normalizedBaseOid = normalizeOidText(baseOid);
        const normalizedOid = normalizeOidText(oid);
        if (!normalizedBaseOid || !normalizedOid || normalizedOid === normalizedBaseOid) {
            return '';
        }
        return normalizedOid.startsWith(`${normalizedBaseOid}.`) ? normalizedOid.slice(normalizedBaseOid.length + 1) : '';
    };

    const appendInstanceSuffix = (text, suffix) => {
        const displayText = String(text || '').trim();
        if (!displayText) {
            return '-';
        }
        return suffix ? `${displayText}.${suffix}` : displayText;
    };

    const getNodeDisplayName = node => node?.moduleQualifiedName || node?.objectName || node?.title || node?.oid || '-';

    const getNodeDisplayPath = node => node?.pathName || node?.oid || '-';

    const getRequestObjectName = (node, oid) =>
        appendInstanceSuffix(getNodeDisplayName(node), getOidInstanceSuffix(node?.oid, oid));

    const getRequestObjectPath = (node, oid) =>
        appendInstanceSuffix(getNodeDisplayPath(node), getOidInstanceSuffix(node?.oid, oid));

    const getVarbindObjectName = varbind =>
        appendInstanceSuffix(varbind?.oidName || varbind?.oidObject || varbind?.oid, varbind?.oidInstance);

    const getVarbindObjectPath = varbind => appendInstanceSuffix(varbind?.oidPath || varbind?.oid, varbind?.oidInstance);

    const getInstanceObjectName = record => {
        const node = instanceTargetForm.value === 'set' ? setTargetNode.value : getTargetNode.value;
        const suffix = record?.instance || getOidInstanceSuffix(node?.oid, record?.oid);
        return appendInstanceSuffix(getNodeDisplayName(node), suffix);
    };

    const getWalkRowObjectName = record => getVarbindObjectName(record);

    const formatWalkTextValue = value => {
        if (value === undefined || value === null || value === '') {
            return '-';
        }
        return String(value);
    };

    const walkOutputText = computed(() =>
        walkRows.value
            .map((row, index) =>
                [
                    `#${row.index || index + 1} ${getWalkRowObjectName(row)}`,
                    `OID   : ${row.oid || '-'}`,
                    `TYPE  : ${row.type || '-'}`,
                    `VALUE : ${formatWalkTextValue(row.value)}`
                ].join('\n')
            )
            .join('\n\n')
    );

    const enrichResultVarbind = async varbind => {
        if (!varbind?.oid) {
            return varbind;
        }

        try {
            const result = await window.snmpApi.translateOid(varbind.oid);
            if (result.status !== 'success' || !result.data) {
                return varbind;
            }

            const info = result.data;
            return {
                ...varbind,
                oidName: info.moduleQualifiedName || info.objectName || '',
                oidObject: info.objectName || '',
                oidPath: info.pathName || '',
                oidInstance: info.instanceSuffix || '',
                oidMatched: Boolean(info.matched)
            };
        } catch (error) {
            return varbind;
        }
    };

    const enrichResultRows = async rows => Promise.all((Array.isArray(rows) ? rows : []).map(enrichResultVarbind));

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

    const selectOidNode = async (oid, treePath = []) => {
        if (treePath.length > 0) {
            await loadTreePath(treePath);
        }

        const node = findTreeNode(mibStatus.value.oidTree, oid);
        if (!node) {
            return;
        }

        const ancestors = findAncestorKeys(mibStatus.value.oidTree, oid) || [];
        treeSelectedKeys.value = [oid];
        treeExpandedKeys.value = Array.from(new Set([...treeExpandedKeys.value, ...ancestors]));
        selectedOidNode.value = node;
        await scrollToOidNode(oid);
    };

    const setMibStatus = payload => {
        treeLoadingPromises.clear();
        clearPendingTreeReleases();
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

        treeExpandedKeys.value = [];
        treeSelectedKeys.value = [];
        selectedOidNode.value = null;
        contextMenu.visible = false;
        mibStatusLoaded = true;
    };

    const loadMibStatus = async ({ force = false } = {}) => {
        if (!force && mibStatusLoaded) {
            return;
        }

        if (mibStatusLoadPromise) {
            return mibStatusLoadPromise;
        }

        mibStatusLoadPromise = (async () => {
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
                mibStatusLoadPromise = null;
            }
        })();

        return mibStatusLoadPromise;
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

    const padTime = value => String(value).padStart(2, '0');

    const formatProjectTimestamp = date => {
        const year = date.getFullYear();
        const month = padTime(date.getMonth() + 1);
        const day = padTime(date.getDate());
        const hour = padTime(date.getHours());
        const minute = padTime(date.getMinutes());
        return `${year}${month}${day}-${hour}${minute}`;
    };

    const getDefaultProjectName = () => {
        const moduleName = mibStatus.value.modules[0] || 'mib-project';
        return `${moduleName}-${formatProjectTimestamp(new Date())}`;
    };

    const formatProjectTime = value => {
        if (!value) {
            return '-';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }

        return `${date.getFullYear()}-${padTime(date.getMonth() + 1)}-${padTime(date.getDate())} ${padTime(
            date.getHours()
        )}:${padTime(date.getMinutes())}`;
    };

    const showSaveProject = () => {
        projectForm.name = getDefaultProjectName();
        projectSaveOpen.value = true;
    };

    const saveMibProject = async () => {
        const name = projectForm.name.trim();
        if (!name) {
            message.warning('请输入工程名');
            return;
        }

        try {
            projectSaving.value = true;
            const result = await window.snmpApi.saveMibProject({ name });
            if (result.status !== 'success') {
                message.error(result.msg || '保存MIB工程失败');
                return;
            }

            projectSaveOpen.value = false;
            message.success(result.msg || 'MIB工程保存成功');
            if (projectImportOpen.value) {
                await loadMibProjects();
            }
        } catch (error) {
            message.error('保存MIB工程失败: ' + error.message);
        } finally {
            projectSaving.value = false;
        }
    };

    const loadMibProjects = async () => {
        try {
            projectLoading.value = true;
            const result = await window.snmpApi.listMibProjects();
            if (result.status !== 'success') {
                message.error(result.msg || '获取MIB工程列表失败');
                return;
            }

            projectRootDir.value = result.data?.rootDir || '';
            mibProjects.value = Array.isArray(result.data?.projects) ? result.data.projects : [];
        } catch (error) {
            message.error('获取MIB工程列表失败: ' + error.message);
        } finally {
            projectLoading.value = false;
        }
    };

    const showImportProject = async () => {
        projectImportOpen.value = true;
        await loadMibProjects();
    };

    const importMibProject = async record => {
        if (!record?.name || projectImporting.value) {
            return;
        }

        try {
            projectImporting.value = true;
            mibCompileLoading.value = true;
            importingProjectName.value = record.name;
            const result = await window.snmpApi.importMibProject({ name: record.name });
            if (result.status !== 'success') {
                message.error(result.msg || '导入MIB工程失败');
                return;
            }

            setMibStatus(result.data?.summary || result.data);
            projectImportOpen.value = false;
            message.success(result.msg || 'MIB工程导入成功');
        } catch (error) {
            message.error('导入MIB工程失败: ' + error.message);
        } finally {
            projectImporting.value = false;
            importingProjectName.value = '';
            mibCompileLoading.value = false;
        }
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

    const handleTreeExpand = async (expandedKeys, { expanded, node }) => {
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matchedNode = findTreeNode(mibStatus.value.oidTree, key);
        if (!matchedNode) {
            treeExpandedKeys.value = expandedKeys;
            return;
        }

        if (expanded) {
            cancelPendingTreeRelease(matchedNode.key);
            treeExpandedKeys.value = expandedKeys;
            await loadTreeNodeChildren(matchedNode);
            return;
        }

        const descendantKeys = new Set(collectDescendantKeys(matchedNode));
        treeExpandedKeys.value = expandedKeys.filter(expandedKey => !descendantKeys.has(expandedKey));
        if (descendantKeys.has(treeSelectedKeys.value[0])) {
            treeSelectedKeys.value = [matchedNode.key];
            selectedOidNode.value = matchedNode;
        }
        scheduleTreeNodeChildrenRelease(matchedNode.key);
        hideContextMenu();
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
            getNext: () => showGetCapability('getNext'),
            walk: showWalkCapability,
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

    const showGetCapability = async (mode = 'get') => {
        const node = contextMenu.node;
        if (!node?.oid) {
            return;
        }

        hideContextMenu();
        await loadRequestDefaults(getForm);
        getRequestMode.value = mode;
        getTargetNode.value = node;
        getForm.oid = mode === 'getNext' ? node.oid : getEffectiveQueryOid(node);
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

    const showWalkCapability = async () => {
        const node = contextMenu.node;
        hideContextMenu();
        if (!node?.oid) {
            return;
        }

        await loadRequestDefaults(walkForm);
        walkTargetNode.value = node;
        walkForm.oid = node.oid;
        walkForm.limit = 100;
        walkForm.maxRepetitions = 20;
        walkRows.value = [];
        walkMeta.value = null;
        walkModalOpen.value = true;
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

    const showInstanceSelector = async (targetForm = 'get') => {
        const node = targetForm === 'set' ? setTargetNode.value : getTargetNode.value;
        const form = targetForm === 'set' ? setForm : getForm;
        if (!node?.oid) {
            message.warning('请选择表字段节点');
            return;
        }

        try {
            instanceTargetForm.value = targetForm;
            instanceModalOpen.value = true;
            instanceLoading.value = true;
            instanceRows.value = [];
            instanceMeta.value = null;
            await loadRequestDefaults(form);

            const result = await window.snmpApi.listOidInstances({
                oid: node.oid,
                limit: 100,
                maxRepetitions: 20
            });

            if (result.status !== 'success') {
                message.error(result.msg || '实例枚举失败');
                return;
            }

            const rows = Array.isArray(result.data?.rows) ? result.data.rows : [];
            instanceRows.value = rows.map(row => ({
                ...row,
                value: row.value === undefined || row.value === null ? '' : String(row.value)
            }));
            instanceMeta.value = {
                ...result.data,
                rows: instanceRows.value
            };

            if (instanceRows.value.length === 0) {
                message.info('未发现当前字段下的实例');
            }
        } catch (error) {
            message.error('实例枚举失败: ' + error.message);
        } finally {
            instanceLoading.value = false;
        }
    };

    const selectInstance = record => {
        if (!record?.oid) {
            return;
        }

        if (instanceTargetForm.value === 'set') {
            setForm.oid = record.oid;
        } else {
            getForm.oid = record.oid;
        }

        instanceModalOpen.value = false;
    };

    const sendGetRequest = async () => {
        await loadRequestDefaults(getForm);
        const actionText = isGetNextMode.value ? 'GET-NEXT' : 'GET';
        if (!getForm.targetHost || !getForm.targetPort || !getForm.version) {
            message.warning(`请在SNMP配置中填写${actionText}目标并启用SNMPv1/v2c`);
            return;
        }

        if (!getForm.oid) {
            message.warning('请填写OID');
            return;
        }

        try {
            getSending.value = true;
            const request = { oid: getForm.oid };
            const result = isGetNextMode.value
                ? await window.snmpApi.sendGetNextRequest(request)
                : await window.snmpApi.sendGetRequest(request);
            if (result.status === 'success') {
                const varbind = result.data?.varbinds?.[0] || null;
                getResult.value = await enrichResultVarbind(varbind);
                message.success(`${actionText}查询成功`);
                return;
            }

            message.error(result.msg || `${actionText}查询失败`);
        } catch (error) {
            message.error(`${actionText}查询失败: ` + error.message);
        } finally {
            getSending.value = false;
        }
    };

    const sendWalkRequest = async () => {
        await loadRequestDefaults(walkForm);
        if (!walkForm.targetHost || !walkForm.targetPort || !walkForm.version) {
            message.warning('请在SNMP配置中填写WALK目标并启用SNMPv1/v2c');
            return;
        }

        if (!walkForm.oid) {
            message.warning('请填写起始OID');
            return;
        }

        try {
            walkLoading.value = true;
            walkRows.value = [];
            walkMeta.value = null;

            const result = await window.snmpApi.sendWalkRequest({
                oid: walkForm.oid,
                limit: walkForm.limit,
                maxRepetitions: walkForm.maxRepetitions
            });

            if (result.status !== 'success') {
                message.error(result.msg || 'WALK查询失败');
                return;
            }

            const rows = Array.isArray(result.data?.rows) ? result.data.rows : [];
            const enrichedRows = await enrichResultRows(
                rows.map((row, index) => ({
                    ...row,
                    index: index + 1,
                    value: row.value === undefined || row.value === null ? '' : String(row.value)
                }))
            );
            walkRows.value = enrichedRows;
            walkMeta.value = {
                ...result.data,
                rows: enrichedRows
            };

            if (enrichedRows.length === 0) {
                message.info('WALK未返回当前OID子树下的数据');
            } else {
                message.success(`WALK完成，共 ${enrichedRows.length} 条`);
            }
        } catch (error) {
            message.error('WALK查询失败: ' + error.message);
        } finally {
            walkLoading.value = false;
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
                const objectText = getRequestObjectName(setTargetNode.value, setForm.oid);
                message.success(`SET成功: ${objectText}${varbind?.value !== undefined ? ` = ${varbind.value}` : ''}`);
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
                    await selectOidNode(result.data.matchedOid, result.data.treePath || []);
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

    onBeforeUnmount(() => {
        clearPendingTreeReleases();
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

    .mib-project-meta {
        min-height: 32px;
        padding: 0 11px;
        color: #262626;
        line-height: 30px;
        background: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
    }

    .mib-project-header {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        min-width: 0;
    }

    .mib-project-root,
    .mib-project-name {
        display: inline-block;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-project-root {
        flex: 1;
        color: #8c8c8c;
        font-size: 12px;
    }

    .mib-project-table :deep(.ant-table-cell) {
        min-width: 0;
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

    .mib-request-object {
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        padding: 7px 11px;
        background: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
    }

    .mib-request-object-title {
        overflow: hidden;
        color: #262626;
        font-weight: 600;
        line-height: 20px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-request-object-meta,
    .mib-request-object-oid {
        display: block;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
        color: #8c8c8c;
        font-size: 12px;
        line-height: 18px;
        white-space: normal;
    }

    .mib-request-object-oid :deep(.ant-typography-copy) {
        margin-inline-start: 4px;
    }

    .mib-oid-input-row {
        display: flex;
        gap: 8px;
        align-items: center;
        min-width: 0;
    }

    .mib-oid-input-row :deep(.ant-input) {
        min-width: 0;
    }

    .mib-oid-input-row :deep(.ant-btn) {
        flex-shrink: 0;
    }

    .mib-request-form :deep(.ant-form-item) {
        margin-bottom: 10px;
    }

    .mib-request-form :deep(.ant-form-item-control),
    .mib-request-form :deep(.ant-form-item-control-input),
    .mib-request-form :deep(.ant-form-item-control-input-content) {
        min-width: 0;
    }

    .mib-request-result {
        margin-top: 10px;
    }

    .mib-request-result :deep(.ant-descriptions-item-label) {
        width: 86px;
    }

    .mib-request-result :deep(.ant-descriptions-item-content) {
        min-width: 0;
        overflow: hidden;
    }

    .instance-table {
        margin-top: 10px;
    }

    .walk-summary {
        flex-shrink: 0;
        margin: 2px 0 8px;
    }

    .walk-modal-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        height: 100%;
        max-height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .walk-form {
        flex-shrink: 0;
    }

    .walk-form :deep(.ant-form-item) {
        margin-bottom: 8px;
    }

    .walk-output-shell {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .walk-output-textarea {
        width: 100%;
        height: 100%;
        min-height: 180px;
        overflow: auto;
        resize: none;
        padding: 10px 12px;
        color: #262626;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
        font-size: 12px;
        line-height: 18px;
        white-space: pre-wrap;
        word-break: break-word;
        background: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
        outline: none;
    }

    .walk-output-loading {
        position: absolute;
        top: 8px;
        right: 10px;
        padding: 2px 8px;
        color: #1677ff;
        font-size: 12px;
        line-height: 20px;
        background: rgba(230, 244, 255, 0.95);
        border: 1px solid #91caff;
        border-radius: 4px;
    }

    :global(.walk-modal-wrap) {
        overflow: hidden;
    }

    :global(.walk-modal-wrap .ant-modal) {
        top: 24px;
        max-width: calc(100vw - 32px);
        padding-bottom: 0;
    }

    :global(.walk-modal-wrap .ant-modal-content) {
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 48px);
        overflow: hidden;
    }

    :global(.walk-modal-wrap .ant-modal-body) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }

    :global(.walk-modal-wrap .ant-modal-footer) {
        flex-shrink: 0;
    }

    .instance-value {
        display: inline-block;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
    }

    .instance-object {
        min-width: 0;
        overflow: hidden;
    }

    .instance-object-title {
        overflow: hidden;
        color: #262626;
        line-height: 20px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .instance-object-oid {
        display: block;
        overflow: hidden;
        color: #8c8c8c;
        font-size: 12px;
        line-height: 18px;
        text-overflow: ellipsis;
        white-space: nowrap;
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
