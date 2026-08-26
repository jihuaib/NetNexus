<template>
    <div class="nn-container grpc-proto-page" @click="hideContextMenu">
        <nn-card title="Proto 编译" class="proto-card">
            <template #extra>
                <nn-space wrap class="proto-status-group">
                    <nn-tag :color="runtimeStatusColor" data-testid="grpc-runtime-status">
                        {{ runtimeStatusText }}
                    </nn-tag>
                    <nn-button
                        type="primary"
                        size="small"
                        :loading="runtimeLoading && !grpcRuntime.running"
                        :disabled="!grpcRuntime.initialized || grpcRuntime.running || runtimeLoading"
                        data-testid="grpc-runtime-start-button"
                        @click="startRuntime"
                    >
                        启动进程
                    </nn-button>
                    <nn-button
                        type="primary"
                        danger
                        size="small"
                        :loading="runtimeLoading && grpcRuntime.running"
                        :disabled="!grpcRuntime.running || runtimeLoading"
                        data-testid="grpc-runtime-stop-button"
                        @click="stopRuntime"
                    >
                        停止进程
                    </nn-button>
                    <template v-if="grpcRuntime.running">
                        <nn-tag v-if="compiling" color="processing">正在编译</nn-tag>
                        <nn-tag v-else-if="status.compiled && status.cacheHit" color="success">缓存命中</nn-tag>
                        <nn-tag v-else-if="status.compiled" color="success">已编译</nn-tag>
                        <nn-tag v-else color="default">未编译</nn-tag>
                        <nn-tag color="blue">服务 {{ status.summary.serviceCount }}</nn-tag>
                        <nn-tag color="cyan">方法 {{ status.summary.methodCount }}</nn-tag>
                        <nn-tag color="green">消息 {{ status.summary.messageCount }}</nn-tag>
                        <nn-tag color="purple">枚举 {{ status.summary.enumCount }}</nn-tag>
                        <nn-tag color="default">文件 {{ status.summary.fileCount }}</nn-tag>
                    </template>
                </nn-space>
            </template>

            <div class="proto-compiler">
                <div class="proto-toolbar">
                    <nn-button
                        type="primary"
                        :disabled="!grpcRuntime.running"
                        :loading="compiling"
                        @click="selectProtoFiles"
                    >
                        <template #icon><FileSearchOutlined /></template>
                        导入文件
                    </nn-button>
                    <nn-button :disabled="!grpcRuntime.running" :loading="compiling" @click="selectIncludeDirectory">
                        <template #icon><FolderOpenOutlined /></template>
                        搜索目录
                    </nn-button>
                    <nn-button
                        :disabled="!grpcRuntime.running || !hasSources"
                        :loading="compiling"
                        @click="() => compileProtos({ force: true })"
                    >
                        <template #icon><ReloadOutlined /></template>
                        重新编译
                    </nn-button>
                    <nn-button
                        :disabled="!grpcRuntime.running || !status.compiled"
                        :loading="projectSaving"
                        @click="showSaveProject"
                    >
                        <template #icon><SaveOutlined /></template>
                        保存工程
                    </nn-button>
                    <nn-button
                        :disabled="!grpcRuntime.running"
                        :loading="projectLoading || projectImporting"
                        @click="showImportProject"
                    >
                        <template #icon><ImportOutlined /></template>
                        导入工程
                    </nn-button>
                    <nn-button danger :disabled="!grpcRuntime.running || !hasSources || compiling" @click="clearProtos">
                        <template #icon><DeleteOutlined /></template>
                        清空
                    </nn-button>
                </div>

                <nn-alert
                    v-if="compileError"
                    type="error"
                    show-icon
                    closable
                    class="proto-compile-alert"
                    :message="compileError.message"
                    :description="compileError.location"
                    @close="compileError = null"
                />

                <div class="proto-layout">
                    <section class="proto-panel proto-file-panel" aria-label="proto 文件">
                        <div class="panel-header">
                            <div class="panel-heading">
                                <span class="panel-title">文件</span>
                                <span class="panel-meta">
                                    待编译 {{ filePaths.length }} · 已加载 {{ status.files.length }} · 搜索目录
                                    {{ includeDirs.length }}
                                </span>
                            </div>
                            <nn-button
                                type="primary"
                                size="small"
                                :disabled="!grpcRuntime.running || !hasSources || !dirty"
                                :loading="compiling"
                                @click="() => compileProtos()"
                            >
                                编译
                            </nn-button>
                        </div>
                        <div class="proto-file-scroll">
                            <nn-table
                                :columns="fileColumns"
                                :data-source="fileRows"
                                :pagination="false"
                                row-key="key"
                                size="small"
                                class="proto-file-table"
                            >
                                <template #bodyCell="{ column, record }">
                                    <template v-if="column.key === 'status'">
                                        <nn-tag :color="fileStatusMeta(record).color" class="proto-file-tag">
                                            {{ fileStatusMeta(record).text }}
                                        </nn-tag>
                                    </template>
                                    <template v-else-if="column.key === 'name'">
                                        <nn-tooltip :title="record.path">
                                            <span class="proto-file-name">{{ record.name }}</span>
                                        </nn-tooltip>
                                        <nn-tag v-if="record.kind === 'dir'" color="default" class="proto-file-tag">
                                            目录
                                        </nn-tag>
                                    </template>
                                    <template v-else-if="column.key === 'action'">
                                        <nn-button
                                            v-if="record.removable"
                                            type="link"
                                            size="small"
                                            danger
                                            :disabled="compiling"
                                            @click="removeEntry(record)"
                                        >
                                            移除
                                        </nn-button>
                                        <span v-else class="proto-file-placeholder">-</span>
                                    </template>
                                </template>
                                <template #emptyText>
                                    <nn-empty description="导入 .proto 文件开始编译" />
                                </template>
                            </nn-table>
                        </div>
                    </section>

                    <section class="proto-panel proto-tree-panel" aria-label="proto 定义树">
                        <div class="panel-header">
                            <div class="panel-heading">
                                <span class="panel-title">定义树</span>
                            </div>
                            <div class="proto-locate">
                                <nn-input
                                    v-model:value="locateQuery"
                                    size="small"
                                    allow-clear
                                    placeholder="输入全名定位，如 gnmi.gNMI.Get"
                                    @press-enter="locateNode"
                                />
                                <nn-button size="small" :loading="locateLoading" @click="locateNode">定位</nn-button>
                            </div>
                        </div>
                        <div ref="treeScrollRef" class="proto-tree-scroll">
                            <nn-spin :spinning="treeLoading && treeData.length === 0">
                                <nn-tree
                                    v-if="treeData.length"
                                    ref="treeRef"
                                    v-model:expanded-keys="treeExpandedKeys"
                                    :selected-keys="treeSelectedKeys"
                                    :tree-data="treeData"
                                    block-node
                                    @expand="handleTreeExpand"
                                    @select="handleTreeSelect"
                                    @right-click="handleTreeRightClick"
                                >
                                    <template #title="node">
                                        <span class="proto-node-title" :data-tree-key="node.key">
                                            <span
                                                class="proto-node-icon"
                                                :class="`proto-node-icon-${nodeIconKind(node)}`"
                                                aria-hidden="true"
                                            >
                                                <component :is="nodeIconComponent(node)" :spin="node.loading" />
                                            </span>
                                            <span class="proto-node-name">{{ node.title }}</span>
                                            <span
                                                v-if="node.methodKind"
                                                :class="['proto-node-role', `is-${node.methodKind}`]"
                                            >
                                                {{ methodKindLabel(node.methodKind) }}
                                            </span>
                                            <span v-if="node.oneof" class="proto-node-role is-oneof">
                                                oneof {{ node.oneof }}
                                            </span>
                                            <span v-if="node.meta" class="proto-node-meta">{{ node.meta }}</span>
                                            <span v-if="node.file" class="proto-node-file">{{ node.file }}</span>
                                        </span>
                                    </template>
                                </nn-tree>
                                <nn-empty
                                    v-else
                                    :description="status.compiled ? '没有可展示的定义' : '编译后显示服务、消息与枚举'"
                                />
                            </nn-spin>
                        </div>
                    </section>
                </div>
            </div>
        </nn-card>

        <nn-context-menu
            ref="contextMenuRef"
            v-model:open="contextMenu.visible"
            :width="236"
            root-class="proto-context-menu"
            title-class="proto-context-menu-title"
            meta-class="proto-context-menu-kind"
            description-class="proto-context-menu-name"
            :title="contextMenu.node?.title || 'proto 节点'"
            :meta="contextNodeKindText"
            :description="contextMenu.node?.fullName || '-'"
        >
            <nn-menu class="proto-context-menu-list" :selectable="false" @click="handleContextMenuClick">
                <nn-menu-item key="properties">
                    <template #icon><EyeOutlined /></template>
                    查看节点属性
                </nn-menu-item>
                <nn-menu-item key="copy" :disabled="!contextMenu.node?.fullName">
                    <template #icon><CopyOutlined /></template>
                    复制全名
                </nn-menu-item>
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="copyPath">
                    <template #icon><CopyOutlined /></template>
                    复制调用路径
                </nn-menu-item>
                <nn-menu-divider v-if="contextTemplateType || contextMenu.node?.kind === 'method'" />
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="request">
                    <template #icon><SendOutlined /></template>
                    定位请求消息
                </nn-menu-item>
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="response">
                    <template #icon><ProfileOutlined /></template>
                    定位响应消息
                </nn-menu-item>
                <nn-menu-item v-if="contextTemplateType" key="template">
                    <template #icon><CodeOutlined /></template>
                    生成 JSON 模板
                </nn-menu-item>
            </nn-menu>
        </nn-context-menu>

        <nn-modal
            v-model:open="nodePropertyOpen"
            :title="nodePropertyTitle"
            :footer="null"
            width="820px"
            :body-style="{ padding: '12px', overflow: 'hidden' }"
        >
            <div class="node-property-scroll">
                <nn-spin :spinning="detailLoading">
                    <nn-empty v-if="!detail" description="暂无详情" />
                    <template v-else-if="detail.node.kind === 'method'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="方法" :span="2">
                                <nn-typography-text copyable>{{ detail.node.fullName }}</nn-typography-text>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="类型">
                                <nn-tag :color="methodKindColor(detail.detail.kind)">
                                    {{ methodKindLabel(detail.detail.kind) }}
                                </nn-tag>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="路径">
                                <nn-typography-text copyable>{{ detail.detail.path }}</nn-typography-text>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="请求消息">
                                <nn-button type="link" size="small" @click="revealByName(detail.detail.requestType)">
                                    {{ detail.detail.requestType }}
                                </nn-button>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="响应消息">
                                <nn-button type="link" size="small" @click="revealByName(detail.detail.responseType)">
                                    {{ detail.detail.responseType }}
                                </nn-button>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="注释" :span="2">
                                <span class="detail-description">{{ detail.detail.comment || '-' }}</span>
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </template>
                    <template v-else-if="detail.node.kind === 'service'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="服务" :span="2">
                                <nn-typography-text copyable>{{ detail.detail.fullName }}</nn-typography-text>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="文件">{{ baseName(detail.detail.file) }}</nn-descriptions-item>
                            <nn-descriptions-item label="方法数">
                                {{ detail.detail.methods.length }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="注释" :span="2">
                                <span class="detail-description">{{ detail.detail.comment || '-' }}</span>
                            </nn-descriptions-item>
                        </nn-descriptions>
                        <nn-table
                            :columns="methodColumns"
                            :data-source="detail.detail.methods"
                            :pagination="false"
                            row-key="fullName"
                            size="small"
                            class="proto-detail-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'kind'">
                                    <nn-tag :color="methodKindColor(record.kind)">
                                        {{ methodKindLabel(record.kind) }}
                                    </nn-tag>
                                </template>
                            </template>
                        </nn-table>
                    </template>
                    <template v-else-if="detail.node.kind === 'message'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="消息" :span="2">
                                <nn-typography-text copyable>{{ detail.detail.fullName }}</nn-typography-text>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="文件">{{ baseName(detail.detail.file) }}</nn-descriptions-item>
                            <nn-descriptions-item label="所属消息">
                                <nn-button
                                    v-if="detail.detail.parentType"
                                    type="link"
                                    size="small"
                                    @click="revealByName(detail.detail.parentType)"
                                >
                                    {{ detail.detail.parentType }}
                                </nn-button>
                                <span v-else>-</span>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="oneof" :span="2">
                                {{
                                    detail.detail.oneofs.length
                                        ? detail.detail.oneofs
                                              .map(item => `${item.name}(${item.fields.join(', ')})`)
                                              .join('; ')
                                        : '-'
                                }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="注释" :span="2">
                                <span class="detail-description">{{ detail.detail.comment || '-' }}</span>
                            </nn-descriptions-item>
                        </nn-descriptions>
                        <nn-table
                            :columns="fieldColumns"
                            :data-source="detail.detail.fields"
                            :pagination="false"
                            row-key="id"
                            size="small"
                            class="proto-detail-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'type'">
                                    <nn-button
                                        v-if="record.resolvedKind !== 'scalar'"
                                        type="link"
                                        size="small"
                                        @click="revealByName(record.resolvedType)"
                                    >
                                        {{ fieldTypeText(record) }}
                                    </nn-button>
                                    <span v-else>{{ fieldTypeText(record) }}</span>
                                </template>
                                <template v-else-if="column.key === 'rule'">
                                    {{ record.rule || '-' }}{{ record.oneof ? ` · oneof ${record.oneof}` : '' }}
                                </template>
                            </template>
                        </nn-table>
                    </template>
                    <template v-else-if="detail.node.kind === 'enum'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="枚举" :span="2">
                                <nn-typography-text copyable>{{ detail.detail.fullName }}</nn-typography-text>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="文件">{{ baseName(detail.detail.file) }}</nn-descriptions-item>
                            <nn-descriptions-item label="值数量">
                                {{ detail.detail.values.length }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                        <nn-table
                            :columns="enumColumns"
                            :data-source="detail.detail.values"
                            :pagination="false"
                            row-key="name"
                            size="small"
                            class="proto-detail-table"
                        />
                    </template>
                    <template v-else-if="detail.node.kind === 'field'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="字段">{{ detail.detail.name }}</nn-descriptions-item>
                            <nn-descriptions-item label="编号">{{ detail.detail.id }}</nn-descriptions-item>
                            <nn-descriptions-item label="所属消息" :span="2">
                                <nn-button type="link" size="small" @click="revealByName(detail.detail.message)">
                                    {{ detail.detail.message }}
                                </nn-button>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="类型">
                                <nn-button
                                    v-if="detail.detail.resolvedKind !== 'scalar'"
                                    type="link"
                                    size="small"
                                    @click="revealByName(detail.detail.resolvedType)"
                                >
                                    {{ detail.detail.typeText }}
                                </nn-button>
                                <span v-else>{{ detail.detail.typeText }}</span>
                            </nn-descriptions-item>
                            <nn-descriptions-item label="修饰">
                                {{ detail.detail.rule || '-'
                                }}{{ detail.detail.oneof ? ` · oneof ${detail.detail.oneof}` : '' }}
                            </nn-descriptions-item>
                            <nn-descriptions-item label="注释" :span="2">
                                <span class="detail-description">{{ detail.detail.comment || '-' }}</span>
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </template>
                    <template v-else-if="detail.node.kind === 'enum-value'">
                        <nn-descriptions :column="2" bordered size="small">
                            <nn-descriptions-item label="枚举值">{{ detail.detail.name }}</nn-descriptions-item>
                            <nn-descriptions-item label="数值">{{ detail.detail.value }}</nn-descriptions-item>
                            <nn-descriptions-item label="所属枚举" :span="2">
                                {{ detail.detail.enum }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </template>
                    <template v-else>
                        <nn-descriptions :column="1" bordered size="small">
                            <nn-descriptions-item label="包">
                                {{ detail.node.fullName || '(默认包)' }}
                            </nn-descriptions-item>
                        </nn-descriptions>
                    </template>
                </nn-spin>
            </div>
        </nn-modal>

        <nn-modal
            v-model:open="templateOpen"
            :title="templateTitle"
            :footer="null"
            width="720px"
            :body-style="{ padding: '12px' }"
        >
            <nn-textarea :value="templateText" height="360px" resize="vertical" readonly />
            <div class="proto-template-actions">
                <nn-button size="small" @click="copyText(templateText, 'JSON 模板已复制')">
                    <template #icon><CopyOutlined /></template>
                    复制
                </nn-button>
            </div>
        </nn-modal>

        <nn-modal
            v-model:open="projectSaveOpen"
            title="保存 proto 工程"
            ok-text="保存"
            cancel-text="取消"
            :confirm-loading="projectSaving"
            width="520px"
            @ok="saveProject"
        >
            <nn-form :model="projectForm" :label-col="{ style: { width: '72px' } }">
                <nn-form-item label="工程名">
                    <nn-input
                        v-model:value="projectForm.name"
                        :maxlength="80"
                        placeholder="请输入工程名"
                        @press-enter="saveProject"
                    />
                </nn-form-item>
                <nn-form-item label="内容">
                    <div class="proto-project-meta">
                        文件 {{ status.summary.fileCount }} / 服务 {{ status.summary.serviceCount }} / 消息
                        {{ status.summary.messageCount }}
                    </div>
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <nn-modal v-model:open="projectImportOpen" title="proto 工程" :footer="null" width="820px">
            <div class="proto-project-header">
                <nn-tooltip :title="projectRootDir">
                    <span class="proto-project-root">{{ projectRootDir || 'userData/grpc-proto-projects' }}</span>
                </nn-tooltip>
                <nn-space>
                    <nn-button size="small" :loading="projectImporting" @click="importProjectFromDirectory">
                        从目录导入
                    </nn-button>
                    <nn-button size="small" :loading="projectLoading" @click="loadProjects">刷新</nn-button>
                </nn-space>
            </div>
            <nn-table
                :columns="projectColumns"
                :data-source="projects"
                :loading="projectLoading"
                :pagination="{ pageSize: 6, size: 'small' }"
                row-key="name"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'name'">
                        <nn-tooltip :title="record.directory">
                            <span class="proto-project-name">{{ record.name }}</span>
                        </nn-tooltip>
                    </template>
                    <template v-else-if="column.key === 'content'">
                        文件 {{ record.fileCount }}

                        · 服务 {{ record.services.length }}
                    </template>
                    <template v-else-if="column.key === 'updatedAt'">
                        {{ formatProjectTime(record.updatedAt) }}
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <nn-space>
                            <nn-button
                                type="link"
                                size="small"
                                :loading="projectImporting && importingProjectName === record.name"
                                @click="importProject(record)"
                            >
                                导入
                            </nn-button>
                            <nn-button type="link" size="small" @click="exportProject(record)">导出</nn-button>
                            <nn-popconfirm title="删除该工程？" @confirm="removeProject(record)">
                                <nn-button type="link" size="small" danger>删除</nn-button>
                            </nn-popconfirm>
                        </nn-space>
                    </template>
                </template>
            </nn-table>
        </nn-modal>
    </div>
</template>

<script setup>
    import { computed, nextTick, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
    import {
        ApiOutlined,
        CodeOutlined,
        CopyOutlined,
        DeleteOutlined,
        EyeOutlined,
        FileSearchOutlined,
        FileTextOutlined,
        FolderOpenOutlined,
        FolderOutlined,
        ImportOutlined,
        LoadingOutlined,
        ProfileOutlined,
        ReloadOutlined,
        SaveOutlined,
        SendOutlined,
        UnorderedListOutlined
    } from 'netnexus-ui/icons';
    import { notify } from '../../utils/notify';
    import { GRPC_PROTO_TREE_KIND } from '../../const/grpcConst';
    import { formatJson, methodKindColor, methodKindLabel } from './grpcUtils';
    import { applyGrpcRuntimeState, useGrpcRuntime } from './useGrpcRuntime';

    defineOptions({ name: 'GrpcProto' });

    const CONTEXT_MENU_MARGIN = 12;
    const NODE_ICONS = Object.freeze({
        loading: LoadingOutlined,
        [GRPC_PROTO_TREE_KIND.PACKAGE]: FolderOutlined,
        [GRPC_PROTO_TREE_KIND.SERVICE]: ApiOutlined,
        [GRPC_PROTO_TREE_KIND.METHOD]: SendOutlined,
        [GRPC_PROTO_TREE_KIND.MESSAGE]: ProfileOutlined,
        [GRPC_PROTO_TREE_KIND.ENUM]: UnorderedListOutlined,
        [GRPC_PROTO_TREE_KIND.FIELD]: FileTextOutlined,
        [GRPC_PROTO_TREE_KIND.ENUM_VALUE]: FileTextOutlined
    });
    const NODE_KIND_TEXT = Object.freeze({
        [GRPC_PROTO_TREE_KIND.PACKAGE]: 'package',
        [GRPC_PROTO_TREE_KIND.SERVICE]: 'service',
        [GRPC_PROTO_TREE_KIND.METHOD]: 'rpc',
        [GRPC_PROTO_TREE_KIND.MESSAGE]: 'message',
        [GRPC_PROTO_TREE_KIND.ENUM]: 'enum',
        [GRPC_PROTO_TREE_KIND.FIELD]: 'field',
        [GRPC_PROTO_TREE_KIND.ENUM_VALUE]: 'enum value'
    });

    const emptyStatus = () => ({
        compiled: false,
        cacheHit: false,
        files: [],
        services: [],
        packages: [],
        summary: { fileCount: 0, serviceCount: 0, methodCount: 0, messageCount: 0, enumCount: 0 }
    });

    const grpcRuntime = useGrpcRuntime();
    const runtimeLoading = ref(false);
    const runtimeStatusText = computed(() => {
        if (grpcRuntime.running) return '进程运行中';
        if (grpcRuntime.starting) return '启动中';
        return '进程已停止';
    });
    const runtimeStatusColor = computed(() => {
        if (grpcRuntime.running) return 'green';
        if (grpcRuntime.starting) return 'processing';
        return 'default';
    });

    const filePaths = ref([]);
    const includeDirs = ref([]);
    const status = ref(emptyStatus());
    const compiling = ref(false);
    const compileError = ref(null);
    const dirty = ref(false);

    const treeRef = ref(null);
    const treeScrollRef = ref(null);
    const treeData = ref([]);
    const treeLoading = ref(false);
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const treeLoadingPromises = new Map();
    let treeRevision = 0;

    const contextMenuRef = ref(null);
    const contextMenu = reactive({ visible: false, node: null });
    const detail = ref(null);
    const detailLoading = ref(false);
    const nodePropertyOpen = ref(false);
    const templateOpen = ref(false);
    const templateText = ref('{}');
    const templateTypeName = ref('');
    const locateQuery = ref('');
    const locateLoading = ref(false);

    const projectSaveOpen = ref(false);
    const projectSaving = ref(false);
    const projectImportOpen = ref(false);
    const projectLoading = ref(false);
    const projectImporting = ref(false);
    const importingProjectName = ref('');
    const projectRootDir = ref('');
    const projects = ref([]);
    const projectForm = reactive({ name: '' });

    const fileColumns = [
        { title: '状态', key: 'status', width: 90 },
        { title: '文件', key: 'name', ellipsis: true },
        { title: '操作', key: 'action', width: 70, align: 'center' }
    ];
    const methodColumns = [
        { title: '方法', dataIndex: 'name', key: 'name', width: 160 },
        { title: '类型', key: 'kind', width: 120 },
        { title: '请求', dataIndex: 'requestType', key: 'requestType', ellipsis: true },
        { title: '响应', dataIndex: 'responseType', key: 'responseType', ellipsis: true }
    ];
    const fieldColumns = [
        { title: '#', dataIndex: 'id', key: 'id', width: 56 },
        { title: '字段', dataIndex: 'name', key: 'name', width: 180 },
        { title: '类型', key: 'type', width: 220 },
        { title: '修饰', key: 'rule', width: 150 },
        { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true }
    ];
    const enumColumns = [
        { title: '名称', dataIndex: 'name', key: 'name', width: 220 },
        { title: '值', dataIndex: 'value', key: 'value', width: 100 }
    ];
    const projectColumns = [
        { title: '工程', key: 'name', width: 200 },
        { title: '内容', key: 'content', width: 200 },
        { title: '更新时间', key: 'updatedAt', width: 170 },
        { title: '操作', key: 'action', width: 170 }
    ];

    const hasSources = computed(() => filePaths.value.length > 0);
    const baseName = file =>
        String(file || '')
            .split(/[\\/]/)
            .pop();

    const fieldTypeText = record => {
        const base = record.resolvedType || record.type;
        if (record.rule === 'map') return `map<${record.keyType}, ${base}>`;
        if (record.rule === 'repeated') return `repeated ${base}`;
        return base;
    };

    const nodePropertyTitle = computed(() =>
        detail.value ? `节点属性 · ${detail.value.node.fullName || detail.value.node.title}` : '节点属性'
    );
    const contextNodeKindText = computed(() => NODE_KIND_TEXT[contextMenu.node?.kind] || '-');
    // 可生成 JSON 模板的节点：消息本身，或字段类型为消息的字段
    const contextTemplateType = computed(() => {
        const node = contextMenu.node;
        if (!node) return '';
        if (node.kind === GRPC_PROTO_TREE_KIND.MESSAGE) return node.fullName;
        return '';
    });
    const templateTitle = computed(() =>
        templateTypeName.value ? `JSON 模板 · ${templateTypeName.value}` : 'JSON 模板'
    );

    const fileRows = computed(() => {
        const loaded = new Map(status.value.files.map(file => [file.path, file]));
        const rows = filePaths.value.map(file => ({
            key: `file:${file}`,
            kind: 'file',
            path: file,
            name: baseName(file),
            loaded: loaded.has(file),
            removable: true
        }));
        status.value.files
            .filter(file => !filePaths.value.includes(file.path))
            .forEach(file => {
                rows.push({
                    key: `import:${file.path}`,
                    kind: 'import',
                    path: file.path,
                    name: file.name,
                    loaded: true,
                    removable: false
                });
            });
        includeDirs.value.forEach(dir => {
            rows.push({
                key: `dir:${dir}`,
                kind: 'dir',
                path: dir,
                name: dir,
                loaded: true,
                removable: true
            });
        });
        return rows;
    });

    const fileStatusMeta = record => {
        if (record.kind === 'dir') return { color: 'default', text: '搜索目录' };
        if (record.kind === 'import') return { color: 'cyan', text: 'import' };
        if (compileError.value && compileError.value.file === record.path) return { color: 'error', text: '失败' };
        if (record.loaded && !dirty.value) return { color: 'success', text: '已编译' };
        return { color: 'warning', text: '待编译' };
    };

    // ---------------------------------------------------------------- 树

    const normalizeNodes = nodes =>
        (Array.isArray(nodes) ? nodes : []).map(node => ({
            ...node,
            loading: false,
            children: node.isLeaf ? undefined : [],
            isLeaf: Boolean(node.isLeaf)
        }));

    const refreshTree = () => {
        treeData.value = [...treeData.value];
    };

    const findNode = (nodes, key) => {
        for (const node of nodes || []) {
            if (node.key === key) return node;
            const matched = findNode(node.children, key);
            if (matched) return matched;
        }
        return null;
    };

    const collectDescendantKeys = node => {
        const keys = [];
        (node?.children || []).forEach(child => keys.push(child.key, ...collectDescendantKeys(child)));
        return keys;
    };

    const loadTreeChildren = async key => {
        const target = key ? findNode(treeData.value, key) : null;
        if (key && (!target || target.isLeaf)) return [];
        if (target && target.children?.length) return target.children;
        if (treeLoadingPromises.has(key)) return treeLoadingPromises.get(key);

        const revision = treeRevision;
        const promise = (async () => {
            if (target) {
                target.loading = true;
                refreshTree();
            } else {
                treeLoading.value = true;
            }
            try {
                const result = await window.grpcApi.getProtoTreeChildren(key || '');
                if (revision !== treeRevision) return [];
                if (result.status !== 'success') {
                    notify.error(result.msg || '获取 proto 树节点失败');
                    return [];
                }
                const children = normalizeNodes(result.data);
                if (target) {
                    target.children = children;
                    refreshTree();
                } else {
                    treeData.value = children;
                }
                return children;
            } catch (error) {
                if (revision === treeRevision) notify.error(`获取 proto 树节点失败：${error.message}`);
                return [];
            } finally {
                if (target) target.loading = false;
                treeLoading.value = false;
                if (revision === treeRevision) refreshTree();
                if (treeLoadingPromises.get(key) === promise) treeLoadingPromises.delete(key);
            }
        })();
        treeLoadingPromises.set(key, promise);
        return promise;
    };

    const resetTree = async () => {
        treeRevision += 1;
        treeLoadingPromises.clear();
        treeData.value = [];
        treeExpandedKeys.value = [];
        treeSelectedKeys.value = [];
        detail.value = null;
        hideContextMenu();
        nodePropertyOpen.value = false;
        if (status.value.compiled) {
            await loadTreeChildren('');
        }
    };

    const nodeIconKind = node => (node?.loading ? 'loading' : node?.kind || GRPC_PROTO_TREE_KIND.FIELD);
    const nodeIconComponent = node => {
        const kind = nodeIconKind(node);
        if (kind === GRPC_PROTO_TREE_KIND.PACKAGE && treeExpandedKeys.value.includes(node?.key))
            return FolderOpenOutlined;
        return NODE_ICONS[kind] || FileTextOutlined;
    };

    const handleTreeExpand = async (expandedKeys, { expanded, node }) => {
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matched = findNode(treeData.value, key);
        hideContextMenu();
        if (!matched) {
            treeExpandedKeys.value = expandedKeys;
            return;
        }
        if (expanded) {
            treeExpandedKeys.value = expandedKeys;
            await loadTreeChildren(key);
            return;
        }
        const descendants = new Set(collectDescendantKeys(matched));
        treeExpandedKeys.value = expandedKeys.filter(item => !descendants.has(item));
        if (descendants.has(treeSelectedKeys.value[0])) {
            treeSelectedKeys.value = [matched.key];
        }
        // 折叠后释放子节点，渲染层只保留展开路径上的节点
        matched.children = [];
        refreshTree();
    };

    const handleTreeSelect = selectedKeys => {
        treeSelectedKeys.value = selectedKeys;
        hideContextMenu();
    };

    const loadDetail = async key => {
        if (!key) {
            detail.value = null;
            return null;
        }
        detailLoading.value = true;
        try {
            const result = await window.grpcApi.getProtoNode(key);
            if (result.status === 'success') {
                detail.value = result.data;
                return result.data;
            }
            notify.error(result.msg || '获取节点详情失败');
            return null;
        } catch (error) {
            notify.error('获取节点详情失败: ' + error.message);
            return null;
        } finally {
            detailLoading.value = false;
        }
    };

    const revealNode = async (key, treePath) => {
        for (const ancestor of treePath) {
            if (!treeExpandedKeys.value.includes(ancestor)) {
                treeExpandedKeys.value = [...treeExpandedKeys.value, ancestor];
            }
            await loadTreeChildren(ancestor);
        }
        treeSelectedKeys.value = [key];
        await nextTick();
        treeRef.value?.scrollTo?.({ key, align: 'auto', offset: 24 });
        await nextTick();
        const element = Array.from(treeScrollRef.value?.querySelectorAll('.proto-node-title') || []).find(
            item => item.dataset.treeKey === key
        );
        element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    };

    const revealByName = async name => {
        if (!name) return;
        nodePropertyOpen.value = false;
        const data = await loadDetail(name);
        if (data) {
            await revealNode(data.node.key, data.treePath || []);
        }
    };

    const locateNode = async () => {
        const query = locateQuery.value.trim();
        if (!query) {
            notify.warning('请输入服务、方法、消息或枚举的全名');
            return;
        }
        locateLoading.value = true;
        try {
            await revealByName(query);
        } finally {
            locateLoading.value = false;
        }
    };

    // ---------------------------------------------------------------- 右键菜单

    const handleTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matched = findNode(treeData.value, key) || node?.dataRef || node;
        if (!matched?.key) return;
        treeSelectedKeys.value = [matched.key];
        nodePropertyOpen.value = false;
        contextMenu.node = matched;
        await nextTick();
        await contextMenuRef.value?.openAt(
            Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
                ? event
                : { x: CONTEXT_MENU_MARGIN, y: CONTEXT_MENU_MARGIN }
        );
    };

    const hideContextMenu = () => {
        contextMenuRef.value?.close({ reason: 'api' });
        contextMenu.visible = false;
    };

    const copyText = async (text, successMessage) => {
        if (!text) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(text);
            notify.success(successMessage);
        } catch (_error) {
            locateQuery.value = text;
            notify.warning('系统剪贴板不可用，已填入定位输入框');
        }
    };

    const showNodeProperties = async node => {
        if (!node?.key) return;
        nodePropertyOpen.value = true;
        await loadDetail(node.key);
    };

    const showTemplate = async typeName => {
        if (!typeName) return;
        try {
            const result = await window.grpcApi.getMessageTemplate(typeName);
            if (result.status !== 'success') {
                notify.error(result.msg || '生成模板失败');
                return;
            }
            templateTypeName.value = typeName;
            templateText.value = formatJson(result.data?.template || {});
            templateOpen.value = true;
        } catch (error) {
            notify.error('生成模板失败: ' + error.message);
        }
    };

    const handleContextMenuClick = async ({ key }) => {
        const node = contextMenu.node;
        hideContextMenu();
        if (!node) return;
        if (key === 'properties') {
            await showNodeProperties(node);
        } else if (key === 'copy') {
            await copyText(node.fullName, '全名已复制');
        } else if (key === 'copyPath') {
            const data = detail.value?.node.key === node.key ? detail.value : await loadDetail(node.key);
            await copyText(data?.detail?.path || '', '调用路径已复制');
        } else if (key === 'request' || key === 'response') {
            const data = detail.value?.node.key === node.key ? detail.value : await loadDetail(node.key);
            await revealByName(key === 'request' ? data?.detail?.requestType : data?.detail?.responseType);
        } else if (key === 'template') {
            await showTemplate(contextTemplateType.value || node.fullName);
        }
    };

    // ---------------------------------------------------------------- 状态

    const applyStatus = async data => {
        if (!data) return;
        if (Array.isArray(data.filePaths)) filePaths.value = data.filePaths;
        if (Array.isArray(data.includeDirs)) includeDirs.value = data.includeDirs;
        status.value = {
            ...emptyStatus(),
            ...data,
            files: Array.isArray(data.files) ? data.files : [],
            services: Array.isArray(data.services) ? data.services : [],
            summary: { ...emptyStatus().summary, ...(data.summary || {}) }
        };
        dirty.value = false;
        await resetTree();
    };

    const loadProtoConfig = async () => {
        try {
            const result = await window.grpcApi.getProtoConfig();
            if (result.status === 'success') {
                await applyStatus(result.data);
            } else {
                notify.error(result.msg || '获取 proto 配置失败');
            }
        } catch (error) {
            notify.error('获取 proto 配置失败: ' + error.message);
        }
    };

    const addFiles = files => {
        const next = new Set(filePaths.value);
        files.forEach(file => next.add(file));
        if (next.size !== filePaths.value.length) dirty.value = true;
        filePaths.value = Array.from(next);
    };

    const selectProtoFiles = async () => {
        try {
            const result = await window.grpcApi.selectProtoFiles();
            if (result.status === 'success' && Array.isArray(result.data) && result.data.length) {
                addFiles(result.data);
            }
        } catch (error) {
            notify.error('选择 proto 文件失败: ' + error.message);
        }
    };

    const selectIncludeDirectory = async () => {
        try {
            const result = await window.grpcApi.selectProtoDirectory();
            if (result.status === 'success' && result.data && !includeDirs.value.includes(result.data)) {
                includeDirs.value = [...includeDirs.value, result.data];
                dirty.value = true;
            }
        } catch (error) {
            notify.error('选择目录失败: ' + error.message);
        }
    };

    const removeEntry = record => {
        if (record.kind === 'dir') {
            includeDirs.value = includeDirs.value.filter(item => item !== record.path);
        } else {
            filePaths.value = filePaths.value.filter(item => item !== record.path);
        }
        dirty.value = true;
    };

    const compileProtos = async ({ force = false } = {}) => {
        if (!hasSources.value) return;
        compiling.value = true;
        compileError.value = null;
        try {
            const result = await window.grpcApi.compileProtos({
                filePaths: JSON.parse(JSON.stringify(filePaths.value)),
                includeDirs: JSON.parse(JSON.stringify(includeDirs.value)),
                force
            });
            if (result.status === 'success') {
                await applyStatus(result.data);
                notify.success(result.msg || 'proto 编译成功');
            } else {
                const file = result.data?.file || '';
                const location = file ? `${file}${result.data.line ? `:${result.data.line}` : ''}` : '';
                compileError.value = { message: result.msg || 'proto 编译失败', location, file };
                notify.error(result.msg || 'proto 编译失败');
            }
        } catch (error) {
            compileError.value = { message: 'proto 编译失败: ' + error.message, location: '', file: '' };
        } finally {
            compiling.value = false;
        }
    };

    const clearProtos = async () => {
        try {
            const result = await window.grpcApi.clearProtos();
            if (result.status === 'success') {
                compileError.value = null;
                await applyStatus({ ...result.data, filePaths: [], includeDirs: [] });
                notify.success(result.msg || 'proto 配置已清空');
            } else {
                notify.error(result.msg || '清空失败');
            }
        } catch (error) {
            notify.error('清空失败: ' + error.message);
        }
    };

    // ---------------------------------------------------------------- 工程

    const pad = value => String(value).padStart(2, '0');
    const formatProjectTime = value => {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    const showSaveProject = () => {
        const service = status.value.services[0]?.name || 'proto-project';
        const now = new Date();
        projectForm.name = `${service}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        projectSaveOpen.value = true;
    };

    const saveProject = async () => {
        const name = projectForm.name.trim();
        if (!name) {
            notify.warning('请输入工程名');
            return;
        }
        projectSaving.value = true;
        try {
            const result = await window.grpcApi.saveProtoProject({ name });
            if (result.status === 'success') {
                projectSaveOpen.value = false;
                notify.success(result.msg || 'proto 工程保存成功');
                if (projectImportOpen.value) await loadProjects();
            } else {
                notify.error(result.msg || '保存 proto 工程失败');
            }
        } catch (error) {
            notify.error('保存 proto 工程失败: ' + error.message);
        } finally {
            projectSaving.value = false;
        }
    };

    const loadProjects = async () => {
        projectLoading.value = true;
        try {
            const result = await window.grpcApi.listProtoProjects();
            if (result.status === 'success') {
                projectRootDir.value = result.data?.rootDir || '';
                projects.value = result.data?.projects || [];
            } else {
                notify.error(result.msg || '获取工程列表失败');
            }
        } catch (error) {
            notify.error('获取工程列表失败: ' + error.message);
        } finally {
            projectLoading.value = false;
        }
    };

    const showImportProject = async () => {
        projectImportOpen.value = true;
        await loadProjects();
    };

    const runImport = async payload => {
        projectImporting.value = true;
        compiling.value = true;
        try {
            const result = await window.grpcApi.importProtoProject(payload);
            if (result.status === 'success') {
                compileError.value = null;
                await applyStatus({
                    ...(result.data?.status || {}),
                    filePaths: result.data?.filePaths || [],
                    includeDirs: result.data?.includeDirs || []
                });
                projectImportOpen.value = false;
                notify.success(result.msg || 'proto 工程导入成功');
            } else {
                notify.error(result.msg || '导入 proto 工程失败');
            }
        } catch (error) {
            notify.error('导入 proto 工程失败: ' + error.message);
        } finally {
            projectImporting.value = false;
            importingProjectName.value = '';
            compiling.value = false;
        }
    };

    const importProject = async record => {
        if (!record?.name || projectImporting.value) return;
        importingProjectName.value = record.name;
        await runImport({ name: record.name });
    };

    const importProjectFromDirectory = async () => {
        try {
            const result = await window.grpcApi.selectDirectory({ title: '选择 proto 工程目录（含 manifest.json）' });
            if (result.status === 'success' && result.data) {
                await runImport({ directory: result.data });
                await loadProjects();
            }
        } catch (error) {
            notify.error('选择目录失败: ' + error.message);
        }
    };

    const exportProject = async record => {
        try {
            const dirResult = await window.grpcApi.selectDirectory({ title: '选择导出目录' });
            if (dirResult.status !== 'success' || !dirResult.data) return;
            const result = await window.grpcApi.exportProtoProject({ name: record.name, targetDir: dirResult.data });
            if (result.status === 'success') {
                notify.success(result.msg || '工程已导出');
            } else {
                notify.error(result.msg || '导出失败');
            }
        } catch (error) {
            notify.error('导出失败: ' + error.message);
        }
    };

    const removeProject = async record => {
        try {
            const result = await window.grpcApi.removeProtoProject({ name: record.name });
            if (result.status === 'success') {
                notify.success(result.msg || '工程已删除');
                await loadProjects();
            } else {
                notify.error(result.msg || '删除失败');
            }
        } catch (error) {
            notify.error('删除失败: ' + error.message);
        }
    };

    const startRuntime = async () => {
        if (runtimeLoading.value || grpcRuntime.running) return;
        runtimeLoading.value = true;
        try {
            const result = await window.grpcApi.startRuntime();
            if (result.status === 'success') {
                applyGrpcRuntimeState(result.data || { running: true });
                notify.success(result.msg || 'gRPC 进程启动成功');
                await loadProtoConfig();
            } else {
                notify.error(result.msg || 'gRPC 进程启动失败');
            }
        } catch (error) {
            notify.error('gRPC 进程启动失败: ' + error.message);
        } finally {
            runtimeLoading.value = false;
        }
    };

    const stopRuntime = async () => {
        if (runtimeLoading.value || !grpcRuntime.running) return;
        runtimeLoading.value = true;
        try {
            const result = await window.grpcApi.stopRuntime();
            if (result.status === 'success') {
                applyGrpcRuntimeState({ running: false, serverRunning: false });
                notify.success(result.msg || 'gRPC 进程已停止');
            } else {
                notify.error(result.msg || 'gRPC 进程停止失败');
            }
        } catch (error) {
            notify.error('gRPC 进程停止失败: ' + error.message);
        } finally {
            runtimeLoading.value = false;
        }
    };

    watch(
        () => grpcRuntime.runtimeRevision,
        () => {
            if (grpcRuntime.running) {
                void loadProtoConfig();
            } else {
                status.value = emptyStatus();
                compileError.value = null;
                hideContextMenu();
                nodePropertyOpen.value = false;
                templateOpen.value = false;
                void resetTree();
            }
        }
    );

    defineExpose({ clearValidationErrors: () => {} });

    onMounted(loadProtoConfig);
    onDeactivated(() => {
        hideContextMenu();
        nodePropertyOpen.value = false;
        templateOpen.value = false;
    });
</script>

<style scoped>
    .grpc-proto-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .proto-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .proto-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .proto-compiler {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        gap: 10px;
    }

    .proto-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    .proto-compile-alert {
        flex: 0 0 auto;
    }

    .proto-layout {
        display: grid;
        flex: 1;
        min-height: 0;
        grid-template-columns: minmax(280px, 30%) minmax(420px, 1fr);
        gap: 10px;
        overflow: hidden;
    }

    .proto-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .panel-header {
        display: flex;
        min-height: 42px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .panel-heading {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .panel-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .panel-meta {
        margin-left: 6px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .proto-locate {
        display: flex;
        flex: 0 0 auto;
        gap: 6px;
        width: min(360px, 55%);
    }

    .proto-file-scroll,
    .proto-tree-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
    }

    .proto-tree-scroll :deep(.nn-spin-nested-loading),
    .proto-tree-scroll :deep(.nn-spin-container) {
        min-height: 100%;
    }

    .proto-tree-scroll :deep(.nn-tree) {
        display: inline-block;
        min-width: 100%;
    }

    .proto-file-name {
        color: var(--nn-color-text-strong);
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
    }

    .proto-file-tag {
        margin-left: 6px;
    }

    .proto-file-placeholder {
        color: var(--nn-color-text-muted);
    }

    .proto-node-title {
        display: inline-flex;
        min-width: max-content;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        vertical-align: middle;
    }

    .proto-node-icon {
        display: inline-flex;
        width: 14px;
        height: 14px;
        flex: 0 0 14px;
        align-items: center;
        justify-content: center;
        color: var(--nn-color-text-muted);
        font-size: 14px;
        line-height: 1;
    }

    .proto-node-icon-loading,
    .proto-node-icon-package,
    .proto-node-icon-service {
        color: var(--nn-color-primary);
    }

    .proto-node-icon-method {
        color: var(--nn-color-text-success);
    }

    .proto-node-icon-message,
    .proto-node-icon-enum {
        color: var(--nn-color-text-info);
    }

    .proto-node-name {
        color: var(--nn-color-text-strong);
        font-weight: 500;
        white-space: nowrap;
    }

    .proto-node-meta,
    .proto-node-file {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .proto-node-file::before {
        content: '·';
        margin-right: 4px;
    }

    .proto-node-role {
        flex: 0 0 auto;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 17px;
        white-space: nowrap;
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-info-subtle);
    }

    .proto-node-role.is-unary {
        color: var(--nn-color-text-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .proto-node-role.is-bidi-stream,
    .proto-node-role.is-server-stream,
    .proto-node-role.is-client-stream {
        color: var(--nn-color-primary);
        background: var(--nn-color-bg-warning-subtle);
    }

    .proto-node-role.is-oneof {
        color: var(--nn-color-text-muted);
        background: var(--nn-color-bg-muted);
    }

    :global(.proto-context-menu) {
        position: fixed;
        z-index: 1200;
        width: 236px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        padding: 4px 0;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-elevated);
    }

    :global(.proto-context-menu-title) {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 12px 0;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    :global(.proto-context-menu-title > span:first-child),
    :global(.proto-context-menu-name) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    :global(.proto-context-menu-kind) {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 500;
    }

    :global(.proto-context-menu-name) {
        padding: 1px 12px 6px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    :global(.proto-context-menu-list) {
        border-inline-end: 0;
    }

    :global(.proto-context-menu-list .nn-menu-item) {
        height: 30px;
        min-height: 30px;
        margin: 2px 4px;
        padding-block: 3px;
        border-radius: 4px;
        line-height: 24px;
    }

    :global(.proto-context-menu-list .nn-menu-divider) {
        margin: 4px 0;
    }

    .node-property-scroll {
        max-height: calc(100vh - 180px);
        overflow-y: auto;
        text-align: left;
    }

    .node-property-scroll :deep(.nn-descriptions-item-bordered) {
        grid-template-columns: 92px minmax(0, 1fr);
    }

    .node-property-scroll :deep(.nn-descriptions-item-label),
    .node-property-scroll :deep(.nn-descriptions-item-content) {
        min-width: 0;
        overflow-wrap: anywhere;
        text-align: left;
    }

    .detail-description {
        display: inline-block;
        white-space: pre-wrap;
    }

    .proto-detail-table {
        margin-top: 10px;
    }

    .proto-template-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 8px;
    }

    .proto-project-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
    }

    .proto-project-root {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .proto-project-name {
        color: var(--nn-color-text-strong);
        font-weight: 500;
    }

    .proto-project-meta {
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }
</style>
