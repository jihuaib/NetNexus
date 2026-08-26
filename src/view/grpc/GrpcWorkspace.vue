<template>
    <div class="nn-container grpc-workspace-page" @click="hideContextMenu">
        <nn-card class="workspace-card">
            <!-- 顶栏：模式 + 连接/监听参数 + 执行 -->
            <div class="workspace-toolbar">
                <nn-radio-group v-model:value="mode" button-style="solid" size="small" aria-label="工作模式">
                    <nn-radio-button :value="MODE.CLIENT">客户端（下发）</nn-radio-button>
                    <nn-radio-button :value="MODE.SERVER">服务器（上报）</nn-radio-button>
                </nn-radio-group>

                <template v-if="isClient">
                    <nn-input
                        v-model:value="clientForm.target"
                        class="toolbar-input toolbar-input-target"
                        size="small"
                        placeholder="目标 host:port"
                        :status="validation.target ? 'error' : ''"
                    />
                    <nn-button
                        size="small"
                        :type="clientForm.tlsEnabled ? 'primary' : 'default'"
                        @click="clientTlsOpen = true"
                    >
                        TLS{{ clientForm.tlsEnabled ? ' 开' : '' }}
                    </nn-button>
                    <nn-button size="small" @click="metadataOpen = true">
                        Metadata{{ metadataCount ? ` (${metadataCount})` : '' }}
                    </nn-button>
                    <nn-input-number
                        v-model:value="clientForm.timeoutMs"
                        class="toolbar-input-timeout"
                        size="small"
                        :min="0"
                        :max="3600000"
                        addon-after="ms"
                    />
                    <nn-button
                        type="primary"
                        size="small"
                        :loading="callLoading"
                        :disabled="!grpcRuntime.running || !selectedMethod"
                        @click="startCall"
                    >
                        <template #icon><SendOutlined /></template>
                        调用
                    </nn-button>
                </template>

                <template v-else>
                    <nn-input
                        v-model:value="serverForm.host"
                        class="toolbar-input toolbar-input-host"
                        size="small"
                        :disabled="isServerRunning"
                        placeholder="监听地址"
                    />
                    <nn-input-number
                        v-model:value="serverForm.port"
                        class="toolbar-input-port"
                        size="small"
                        :min="1"
                        :max="65535"
                        :disabled="isServerRunning"
                        :status="validation.port ? 'error' : ''"
                    />
                    <nn-button
                        size="small"
                        :type="serverForm.tlsEnabled ? 'primary' : 'default'"
                        :disabled="isServerRunning"
                        @click="serverTlsOpen = true"
                    >
                        TLS{{ serverForm.tlsEnabled ? ' 开' : '' }}
                    </nn-button>
                    <nn-button size="small" :disabled="isServerRunning" @click="decodeRulesOpen = true">
                        解码规则{{ serverForm.decodeRules.length ? ` (${serverForm.decodeRules.length})` : '' }}
                    </nn-button>
                    <nn-button size="small" :disabled="isServerRunning" @click="replyOpen = true">
                        Unary 回复{{ replyCount ? ` (${replyCount})` : '' }}
                    </nn-button>
                    <nn-button
                        v-if="!isServerRunning"
                        type="primary"
                        size="small"
                        :loading="serverLoading"
                        :disabled="!grpcRuntime.running || serverForm.services.length === 0"
                        @click="startServer"
                    >
                        启动服务器
                    </nn-button>
                    <nn-button v-else type="primary" danger size="small" @click="stopServer">停止服务器</nn-button>
                    <nn-tag :color="isServerRunning ? 'green' : 'default'" class="toolbar-status">
                        {{
                            isServerRunning
                                ? `监听 ${serverStatus.host}:${serverStatus.boundPort || serverForm.port}`
                                : '未监听'
                        }}
                    </nn-tag>
                </template>

                <span class="toolbar-spacer" />
                <nn-button
                    v-if="canOpenMonitorWindow"
                    size="small"
                    :loading="monitorOpening"
                    @click="openMonitorWindow"
                >
                    <template #icon><ExternalLinkOutlined /></template>
                    独立监控窗口
                </nn-button>
            </div>

            <div class="workspace-layout">
                <!-- 左：服务/方法树 -->
                <section class="workspace-panel" aria-label="服务与方法">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">{{ isClient ? '方法' : '托管服务' }}</span>
                            <span class="panel-meta">{{ methodCountText }}</span>
                        </div>
                        <nn-input-search
                            v-model:value="treeKeyword"
                            size="small"
                            allow-clear
                            placeholder="过滤"
                            class="tree-filter"
                        />
                    </div>
                    <div class="panel-scroll">
                        <nn-empty v-if="treeData.length === 0" :description="treeEmptyText" />
                        <nn-tree
                            v-else
                            v-model:expanded-keys="treeExpandedKeys"
                            :selected-keys="treeSelectedKeys"
                            :tree-data="treeData"
                            block-node
                            @select="handleTreeSelect"
                            @right-click="handleTreeRightClick"
                        >
                            <template #title="node">
                                <span class="tree-node-title" :data-tree-key="node.key">
                                    <nn-checkbox
                                        v-if="!isClient && node.kind === 'service'"
                                        :checked="serverForm.services.includes(node.fullName)"
                                        :disabled="isServerRunning"
                                        @click.stop
                                        @update:checked="checked => toggleService(node.fullName, checked)"
                                    />
                                    <span class="tree-node-icon" :class="`is-${node.kind}`" aria-hidden="true">
                                        <component :is="node.kind === 'service' ? ApiOutlined : SendOutlined" />
                                    </span>
                                    <span class="tree-node-name">{{ node.title }}</span>
                                    <span v-if="node.methodKind" :class="['tree-node-role', `is-${node.methodKind}`]">
                                        {{ methodKindLabel(node.methodKind) }}
                                    </span>
                                    <span v-if="node.meta" class="tree-node-meta">{{ node.meta }}</span>
                                </span>
                            </template>
                        </nn-tree>
                    </div>
                </section>

                <!-- 中：请求编辑 / 活动流 -->
                <section v-if="isClient" class="workspace-panel" aria-label="请求">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">请求</span>
                            <span v-if="selectedMethod" class="panel-meta">
                                {{ selectedMethod.requestType }}
                                <nn-tag :color="methodKindColor(selectedMethod.kind)" class="panel-tag">
                                    {{ methodKindLabel(selectedMethod.kind) }}
                                </nn-tag>
                            </span>
                        </div>
                        <nn-space size="small">
                            <nn-button size="small" :disabled="!selectedMethod" @click="generateRequestTemplate">
                                生成模板
                            </nn-button>
                            <nn-button size="small" @click="formatRequest">格式化</nn-button>
                        </nn-space>
                    </div>
                    <div class="panel-body-editor">
                        <nn-textarea
                            v-model:value="requestText"
                            height="100%"
                            resize="none"
                            :placeholder="selectedMethod ? '{}' : '在左侧选择方法'"
                        />
                    </div>
                    <div class="panel-footer">
                        <span v-if="requestError" class="error-text">{{ requestError }}</span>
                        <nn-space v-if="activeCall && isStreamingRequest(activeCall.kind)" size="small">
                            <nn-button size="small" :disabled="!activeCall.canSend" @click="sendMessage">
                                发送消息
                            </nn-button>
                            <nn-button size="small" :disabled="!activeCall.canSend" @click="endCall">
                                结束发送
                            </nn-button>
                            <nn-button size="small" danger :disabled="activeCall.state !== 'open'" @click="cancelCall">
                                取消调用
                            </nn-button>
                        </nn-space>
                    </div>
                </section>

                <section v-else class="workspace-panel" aria-label="设备与活动流">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">设备 / 活动流</span>
                            <span class="panel-meta">
                                活动 {{ stats.activeStreams }} · 收 {{ stats.totalReceived }} · 发 {{ stats.totalSent }}
                            </span>
                        </div>
                        <nn-button size="small" @click="loadStreams">刷新</nn-button>
                    </div>
                    <div class="panel-scroll">
                        <nn-empty v-if="streams.length === 0" description="暂无设备接入" />
                        <div
                            v-for="stream in streams"
                            :key="stream.id"
                            :class="['stream-item', { 'is-active': stream.id === activeStreamId }]"
                            @click="selectStream(stream)"
                        >
                            <div class="stream-item-head">
                                <span class="stream-item-peer">{{ stream.peer }}</span>
                                <nn-tag :color="streamStateColor(stream.state)" class="panel-tag">
                                    {{ streamStateText(stream.state) }}
                                </nn-tag>
                            </div>
                            <div class="stream-item-sub">
                                <span>#{{ stream.id }} {{ stream.fullName }}</span>
                                <span>↓{{ stream.inbound }} ↑{{ stream.outbound }} · {{ stream.startedAt }}</span>
                            </div>
                        </div>
                    </div>
                    <div class="panel-footer stream-send">
                        <div class="stream-send-head">
                            <span class="panel-title">下发</span>
                            <span class="panel-meta">
                                {{ activeStream ? activeStream.responseType : '选择一条流' }}
                            </span>
                            <span class="toolbar-spacer" />
                            <nn-button size="small" :disabled="!activeStream" @click="generateSendTemplate">
                                模板
                            </nn-button>
                            <nn-button
                                type="primary"
                                size="small"
                                :disabled="!activeStream || !activeStream.canSend"
                                @click="sendStreamMessage"
                            >
                                下发
                            </nn-button>
                            <nn-button size="small" danger :disabled="!activeStream" @click="closeStream">
                                关闭流
                            </nn-button>
                        </div>
                        <nn-textarea v-model:value="sendMessageText" height="120px" resize="none" placeholder="{}" />
                        <span v-if="sendMessageError" class="error-text">{{ sendMessageError }}</span>
                    </div>
                </section>

                <!-- 右：响应 / 消息时间线 -->
                <section class="workspace-panel" aria-label="消息时间线">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">{{ isClient ? '响应' : '消息' }}</span>
                            <template v-if="isClient">
                                <nn-select
                                    v-model:value="activeCallId"
                                    size="small"
                                    class="call-select"
                                    placeholder="调用记录"
                                    @change="loadTimeline"
                                >
                                    <nn-select-option v-for="call in calls" :key="call.id" :value="call.id">
                                        #{{ call.id }} {{ call.fullName.split('.').pop() }} ·
                                        {{ streamStateText(call.state) }}
                                    </nn-select-option>
                                </nn-select>
                            </template>
                        </div>
                        <nn-space size="small">
                            <nn-select
                                v-model:value="timelineDirection"
                                size="small"
                                allow-clear
                                placeholder="方向"
                                class="direction-select"
                                @change="loadTimeline"
                            >
                                <nn-select-option value="inbound">接收</nn-select-option>
                                <nn-select-option value="outbound">发送</nn-select-option>
                            </nn-select>
                            <nn-button size="small" @click="loadTimeline">刷新</nn-button>
                        </nn-space>
                    </div>
                    <div v-if="isClient && activeCall" class="call-status">
                        <nn-tag :color="streamStateColor(activeCall.state)">
                            {{ streamStateText(activeCall.state) }}
                        </nn-tag>
                        <span :class="activeCall.statusCode && activeCall.statusCode !== 0 ? 'error-text' : ''">
                            {{ activeCall.statusName || '-'
                            }}{{ activeCall.statusDetails ? `：${activeCall.statusDetails}` : '' }}
                        </span>
                        <span class="panel-meta">↑{{ activeCall.requests }} ↓{{ activeCall.responses }}</span>
                        <nn-button
                            v-if="
                                Object.keys(activeCall.responseMetadata || {}).length ||
                                Object.keys(activeCall.trailers || {}).length
                            "
                            type="link"
                            size="small"
                            @click="headersOpen = true"
                        >
                            Headers
                        </nn-button>
                    </div>
                    <div class="panel-scroll timeline">
                        <nn-empty v-if="timeline.length === 0" description="暂无消息" />
                        <div v-for="record in timeline" :key="record.id" class="timeline-item">
                            <div class="timeline-head" @click="toggleExpanded(record.id)">
                                <span class="timeline-caret">{{ expandedIds.has(record.id) ? '▾' : '▸' }}</span>
                                <span class="timeline-id">#{{ record.id }}</span>
                                <span class="timeline-time">{{ record.timestamp }}</span>
                                <nn-tag :color="record.direction === 'inbound' ? 'green' : 'blue'" class="panel-tag">
                                    {{ record.direction === 'inbound' ? '收' : '发' }}
                                </nn-tag>
                                <nn-tag :color="messageStatusColor(record.status)" class="panel-tag">
                                    {{ messageStatusText(record.status) }}
                                </nn-tag>
                                <span class="timeline-summary">{{ record.summary }}</span>
                                <span class="timeline-size">{{ record.byteLength }} B</span>
                            </div>
                            <div v-if="expandedIds.has(record.id)" class="timeline-detail">
                                <nn-spin :spinning="!details[record.id]">
                                    <template v-if="details[record.id]">
                                        <nn-alert
                                            v-for="(warning, index) in details[record.id].warnings || []"
                                            :key="index"
                                            type="warning"
                                            show-icon
                                            :message="warning"
                                            class="timeline-warning"
                                        />
                                        <nn-json-viewer
                                            :value="details[record.id].decoded || {}"
                                            :max-height="360"
                                            wrap
                                        />
                                        <div class="timeline-raw">{{ details[record.id].rawHex || '-' }}</div>
                                    </template>
                                </nn-spin>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </nn-card>

        <!-- 右键菜单 -->
        <nn-context-menu
            ref="contextMenuRef"
            v-model:open="contextMenu.visible"
            :width="220"
            root-class="proto-context-menu"
            title-class="proto-context-menu-title"
            meta-class="proto-context-menu-kind"
            description-class="proto-context-menu-name"
            :title="contextMenu.node?.title || '节点'"
            :meta="contextMenu.node?.kind === 'service' ? 'service' : 'rpc'"
            :description="contextMenu.node?.fullName || '-'"
        >
            <nn-menu class="proto-context-menu-list" :selectable="false" @click="handleContextMenuClick">
                <nn-menu-item key="properties">
                    <template #icon><EyeOutlined /></template>
                    查看节点属性
                </nn-menu-item>
                <nn-menu-item key="copy">
                    <template #icon><CopyOutlined /></template>
                    复制全名
                </nn-menu-item>
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="template">
                    <template #icon><CodeOutlined /></template>
                    生成请求模板
                </nn-menu-item>
            </nn-menu>
        </nn-context-menu>

        <!-- 节点属性 -->
        <nn-modal v-model:open="propertyOpen" :title="propertyTitle" :footer="null" width="760px">
            <nn-spin :spinning="propertyLoading">
                <nn-empty v-if="!property" description="暂无详情" />
                <template v-else-if="property.node.kind === 'method'">
                    <nn-descriptions :column="2" bordered size="small">
                        <nn-descriptions-item label="方法" :span="2">
                            <nn-typography-text copyable>{{ property.node.fullName }}</nn-typography-text>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="类型">
                            {{ methodKindLabel(property.detail.kind) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="路径">
                            <nn-typography-text copyable>{{ property.detail.path }}</nn-typography-text>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="请求消息">{{ property.detail.requestType }}</nn-descriptions-item>
                        <nn-descriptions-item label="响应消息">{{ property.detail.responseType }}</nn-descriptions-item>
                        <nn-descriptions-item label="注释" :span="2">
                            {{ property.detail.comment || '-' }}
                        </nn-descriptions-item>
                    </nn-descriptions>
                </template>
                <template v-else>
                    <nn-descriptions :column="2" bordered size="small">
                        <nn-descriptions-item label="服务" :span="2">
                            <nn-typography-text copyable>{{ property.node.fullName }}</nn-typography-text>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="文件">{{ baseName(property.detail.file) }}</nn-descriptions-item>
                        <nn-descriptions-item label="方法数">{{ property.detail.methods.length }}</nn-descriptions-item>
                    </nn-descriptions>
                </template>
            </nn-spin>
        </nn-modal>

        <!-- 客户端 TLS -->
        <nn-modal v-model:open="clientTlsOpen" title="客户端 TLS" width="560px" @ok="clientTlsOpen = false">
            <nn-form :label-col="{ style: { width: '110px' } }">
                <nn-form-item label="启用 TLS"><nn-switch v-model:checked="clientForm.tlsEnabled" /></nn-form-item>
                <nn-form-item label="CA 文件">
                    <nn-input v-model:value="clientForm.tlsCaPath" placeholder="可选，不填使用系统根证书" />
                </nn-form-item>
                <nn-form-item label="客户端证书">
                    <nn-input v-model:value="clientForm.tlsCertPath" placeholder="可选，PEM" />
                </nn-form-item>
                <nn-form-item label="客户端私钥">
                    <nn-input v-model:value="clientForm.tlsKeyPath" placeholder="可选，PEM" />
                </nn-form-item>
                <nn-form-item label="Server Name">
                    <nn-input v-model:value="clientForm.tlsServerName" placeholder="可选，覆盖证书校验主机名" />
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <!-- Metadata -->
        <nn-modal v-model:open="metadataOpen" title="请求 Metadata" width="560px" @ok="metadataOpen = false">
            <div class="kv-list">
                <div v-for="(entry, index) in clientForm.metadata" :key="index" class="kv-row">
                    <nn-input v-model:value="entry.key" placeholder="key，如 username" />
                    <nn-input v-model:value="entry.value" placeholder="value" />
                    <nn-button type="link" danger size="small" @click="clientForm.metadata.splice(index, 1)">
                        删除
                    </nn-button>
                </div>
                <nn-button size="small" @click="clientForm.metadata.push({ key: '', value: '' })">添加</nn-button>
            </div>
        </nn-modal>

        <!-- 响应头 -->
        <nn-modal v-model:open="headersOpen" title="响应 Metadata / Trailers" :footer="null" width="640px">
            <template v-if="activeCall">
                <div class="panel-title">Metadata</div>
                <nn-json-viewer :value="activeCall.responseMetadata || {}" :max-height="200" wrap />
                <div class="panel-title" style="margin-top: 12px">Trailers</div>
                <nn-json-viewer :value="activeCall.trailers || {}" :max-height="200" wrap />
            </template>
        </nn-modal>

        <!-- 服务器 TLS -->
        <nn-modal v-model:open="serverTlsOpen" title="服务器 TLS 与限制" width="600px" @ok="serverTlsOpen = false">
            <nn-form :label-col="{ style: { width: '120px' } }">
                <nn-form-item label="启用 TLS"><nn-switch v-model:checked="serverForm.tlsEnabled" /></nn-form-item>
                <nn-form-item label="证书文件">
                    <nn-input v-model:value="serverForm.tlsCertPath" placeholder="server.crt (PEM)" />
                </nn-form-item>
                <nn-form-item label="私钥文件">
                    <nn-input v-model:value="serverForm.tlsKeyPath" placeholder="server.key (PEM)" />
                </nn-form-item>
                <nn-form-item label="CA 文件">
                    <nn-input v-model:value="serverForm.tlsCaPath" placeholder="可选，校验客户端证书" />
                </nn-form-item>
                <nn-form-item label="客户端证书">
                    <nn-checkbox v-model:checked="serverForm.tlsRequireClientCert">要求客户端证书</nn-checkbox>
                </nn-form-item>
                <nn-form-item label="最大消息长度">
                    <nn-input-number
                        v-model:value="serverForm.maxMessageBytes"
                        :min="1024"
                        :max="1073741824"
                        addon-after="字节"
                        style="width: 100%"
                    />
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <!-- 解码规则 -->
        <nn-modal
            v-model:open="decodeRulesOpen"
            title="解码规则（可选，未配置时自动解码）"
            width="760px"
            @ok="decodeRulesOpen = false"
        >
            <div class="kv-list">
                <div v-for="(rule, index) in serverForm.decodeRules" :key="index" class="kv-row kv-row-3">
                    <nn-input v-model:value="rule.messageType" placeholder="消息类型，如 huawei_dialout.serviceArgs" />
                    <nn-input v-model:value="rule.field" placeholder="字段" />
                    <nn-input v-model:value="rule.targetType" placeholder="目标：消息全名 / @proto_path / @json" />
                    <nn-button type="link" danger size="small" @click="serverForm.decodeRules.splice(index, 1)">
                        删除
                    </nn-button>
                </div>
                <nn-button
                    size="small"
                    @click="serverForm.decodeRules.push({ messageType: '', field: '', targetType: '' })"
                >
                    添加规则
                </nn-button>
            </div>
        </nn-modal>

        <!-- Unary 回复模板 -->
        <nn-modal v-model:open="replyOpen" title="Unary / Client Stream 回复模板" width="720px" @ok="saveReplyTemplate">
            <nn-select
                v-model:value="replyMethod"
                placeholder="选择方法"
                show-search
                allow-clear
                style="width: 100%; margin-bottom: 8px"
            >
                <nn-select-option v-for="option in replyMethodOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                </nn-select-option>
            </nn-select>
            <nn-textarea
                v-model:value="replyTemplateText"
                height="220px"
                resize="vertical"
                placeholder="{}"
                :disabled="!replyMethod"
            />
            <nn-space style="margin-top: 8px">
                <nn-button size="small" :disabled="!replyMethod" @click="generateReplyTemplate">生成模板</nn-button>
                <span v-if="replyTemplateError" class="error-text">{{ replyTemplateError }}</span>
            </nn-space>
        </nn-modal>
    </div>
</template>

<script setup>
    import { computed, nextTick, onActivated, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
    import {
        ApiOutlined,
        CodeOutlined,
        CopyOutlined,
        ExternalLinkOutlined,
        EyeOutlined,
        SendOutlined
    } from 'netnexus-ui/icons';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import {
        DEFAULT_GRPC_CLIENT_CONFIG,
        DEFAULT_GRPC_SERVER_CONFIG,
        GRPC_EVENT_PAGE_ID,
        GRPC_MESSAGE_ROLE,
        GRPC_METHOD_KIND,
        GRPC_SUB_EVT_TYPES
    } from '../../const/grpcConst';
    import {
        formatJson,
        messageStatusColor,
        messageStatusText,
        methodKindColor,
        methodKindLabel,
        parseJsonObject,
        streamStateColor,
        streamStateText
    } from './grpcUtils';
    import { useGrpcRuntime } from './useGrpcRuntime';

    defineOptions({ name: 'GrpcWorkspace' });

    const MODE = Object.freeze({ CLIENT: 'client', SERVER: 'server' });
    const CONTEXT_MENU_MARGIN = 12;
    const TIMELINE_PAGE_SIZE = 200;

    const grpcRuntime = useGrpcRuntime();
    const mode = ref(MODE.CLIENT);
    const isClient = computed(() => mode.value === MODE.CLIENT);
    const canOpenMonitorWindow = computed(() => typeof window.windowApi?.openMonitor === 'function');
    const monitorOpening = ref(false);

    // ------------------------------------------------------------------ 目录 / 树
    const services = ref([]);
    const treeKeyword = ref('');
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const selectedMethodName = ref('');

    const allMethods = computed(() => services.value.flatMap(service => service.methods));
    const selectedMethod = computed(
        () => allMethods.value.find(item => item.fullName === selectedMethodName.value) || null
    );
    const methodCountText = computed(() => `${services.value.length} 服务 · ${allMethods.value.length} 方法`);
    const treeEmptyText = computed(() =>
        grpcRuntime.running ? '请先在 Proto编译 页编译含 service 的 proto' : '请先在 Proto编译 页启动进程并编译'
    );
    const matches = text => {
        const keyword = treeKeyword.value.trim().toLowerCase();
        return (
            !keyword ||
            String(text || '')
                .toLowerCase()
                .includes(keyword)
        );
    };
    const treeData = computed(() =>
        services.value
            .map(service => ({
                key: `svc:${service.fullName}`,
                title: service.fullName,
                kind: 'service',
                fullName: service.fullName,
                meta: `${service.methods.length} 个方法`,
                selectable: false,
                children: service.methods
                    .filter(method => matches(service.fullName) || matches(method.fullName))
                    .map(method => ({
                        key: `method:${method.fullName}`,
                        title: method.name,
                        kind: 'method',
                        fullName: method.fullName,
                        methodKind: method.kind,
                        meta: `${method.requestType} → ${method.responseType}`,
                        isLeaf: true
                    }))
            }))
            .filter(node => node.children.length > 0)
    );
    const isStreamingRequest = kind => kind === GRPC_METHOD_KIND.CLIENT_STREAM || kind === GRPC_METHOD_KIND.BIDI_STREAM;

    const loadCatalog = async () => {
        try {
            const result = await window.grpcApi.getProtoConfig();
            if (result.status === 'success' && result.data) {
                services.value =
                    result.data.compiled && Array.isArray(result.data.services) ? result.data.services : [];
                treeExpandedKeys.value = services.value.map(service => `svc:${service.fullName}`);
                const available = new Set(services.value.map(service => service.fullName));
                const kept = serverForm.value.services.filter(name => available.has(name));
                if (services.value.length && kept.length !== serverForm.value.services.length) {
                    notify.warning(
                        `当前编译结果中不存在服务：${serverForm.value.services.filter(name => !available.has(name)).join('、')}，已从托管列表移除`
                    );
                    serverForm.value.services = kept;
                }
                if (selectedMethodName.value && !selectedMethod.value) {
                    selectedMethodName.value = '';
                    treeSelectedKeys.value = [];
                }
            }
        } catch (error) {
            notify.error('获取 proto 目录失败: ' + error.message);
        }
    };

    const handleTreeSelect = (selectedKeys, { node }) => {
        hideContextMenu();
        const key = selectedKeys[0] || node?.key;
        if (!key || !String(key).startsWith('method:')) {
            return;
        }
        treeSelectedKeys.value = [key];
        selectedMethodName.value = key.slice('method:'.length);
        clientForm.value.method = selectedMethodName.value;
        requestError.value = '';
    };

    // ------------------------------------------------------------------ 右键菜单 / 属性
    const contextMenuRef = ref(null);
    const contextMenu = reactive({ visible: false, node: null });
    const propertyOpen = ref(false);
    const propertyLoading = ref(false);
    const property = ref(null);
    const propertyTitle = computed(() => (property.value ? `节点属性 · ${property.value.node.fullName}` : '节点属性'));
    const baseName = file =>
        String(file || '')
            .split(/[\\/]/)
            .pop();

    const handleTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const data = node?.dataRef || node;
        if (!data?.key) return;
        contextMenu.node = data;
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
    const copyText = async (text, message) => {
        try {
            await navigator.clipboard.writeText(text);
            notify.success(message);
        } catch (_error) {
            notify.warning('系统剪贴板不可用');
        }
    };
    const showProperties = async node => {
        propertyOpen.value = true;
        propertyLoading.value = true;
        property.value = null;
        try {
            const result = await window.grpcApi.getProtoNode(node.fullName);
            if (result.status === 'success') property.value = result.data;
            else notify.error(result.msg || '获取节点详情失败');
        } catch (error) {
            notify.error('获取节点详情失败: ' + error.message);
        } finally {
            propertyLoading.value = false;
        }
    };
    const handleContextMenuClick = async ({ key }) => {
        const node = contextMenu.node;
        hideContextMenu();
        if (!node) return;
        if (key === 'properties') await showProperties(node);
        else if (key === 'copy') await copyText(node.fullName, '全名已复制');
        else if (key === 'template') {
            handleTreeSelect([node.key], { node });
            mode.value = MODE.CLIENT;
            await generateRequestTemplate();
        }
    };

    // ------------------------------------------------------------------ 客户端
    const clientForm = ref({ ...DEFAULT_GRPC_CLIENT_CONFIG, metadata: [], method: '' });
    const clientTlsOpen = ref(false);
    const metadataOpen = ref(false);
    const headersOpen = ref(false);
    const metadataCount = computed(() => clientForm.value.metadata.filter(item => item.key).length);
    const requestText = ref('{}');
    const requestError = ref('');
    const callLoading = ref(false);
    const calls = ref([]);
    const activeCallId = ref(null);
    const activeCall = computed(() => calls.value.find(call => call.id === activeCallId.value) || null);
    const validation = ref({ target: '', port: '' });

    const loadClientConfig = async () => {
        try {
            const result = await window.grpcApi.getClientConfig();
            if (result.status === 'success' && result.data) {
                clientForm.value = {
                    ...clientForm.value,
                    ...result.data,
                    metadata: Array.isArray(result.data.metadata) ? result.data.metadata : []
                };
                if (typeof result.data.requestText === 'string') requestText.value = result.data.requestText;
                if (clientForm.value.method) {
                    selectedMethodName.value = clientForm.value.method;
                    treeSelectedKeys.value = [`method:${clientForm.value.method}`];
                }
            }
        } catch (error) {
            notify.error('加载客户端配置失败: ' + error.message);
        }
    };

    const generateRequestTemplate = async () => {
        if (!selectedMethod.value) return;
        try {
            const result = await window.grpcApi.getMessageTemplate(selectedMethod.value.requestType);
            if (result.status === 'success') {
                requestText.value = formatJson(result.data?.template || {});
                requestError.value = '';
            } else notify.error(result.msg || '生成模板失败');
        } catch (error) {
            notify.error('生成模板失败: ' + error.message);
        }
    };
    const formatRequest = () => {
        const { value, error } = parseJsonObject(requestText.value);
        if (error) {
            requestError.value = error;
            return;
        }
        requestError.value = '';
        requestText.value = formatJson(value);
    };

    const loadCalls = async () => {
        try {
            const result = await window.grpcApi.getClientCallList();
            if (result.status === 'success') calls.value = result.data?.list || [];
        } catch (error) {
            console.error('获取调用列表失败', error);
        }
    };

    const startCall = async () => {
        validation.value.target = String(clientForm.value.target || '').trim() ? '' : '请输入目标地址';
        if (validation.value.target) {
            notify.error(validation.value.target);
            return;
        }
        if (!selectedMethod.value) {
            notify.error('请先在左侧选择方法');
            return;
        }
        const { value, error } = parseJsonObject(requestText.value);
        if (error) {
            requestError.value = error;
            return;
        }
        requestError.value = '';
        callLoading.value = true;
        try {
            const config = JSON.parse(JSON.stringify({ ...clientForm.value, method: selectedMethod.value.fullName }));
            await window.grpcApi.saveClientConfig({ ...config, requestText: requestText.value });
            const result = await window.grpcApi.clientStartCall({
                ...config,
                message: value,
                decodeRules: JSON.parse(JSON.stringify(serverForm.value.decodeRules))
            });
            if (result.status === 'success') {
                notify.success(result.msg || '调用已发起');
                await loadCalls();
                activeCallId.value = result.data?.id || activeCallId.value;
                await loadTimeline();
            } else notify.error(result.msg || '调用失败');
        } catch (err) {
            notify.error('调用失败: ' + err.message);
        } finally {
            callLoading.value = false;
        }
    };
    const sendMessage = async () => {
        if (!activeCall.value) return;
        const { value, error } = parseJsonObject(requestText.value);
        if (error) {
            requestError.value = error;
            return;
        }
        const result = await window.grpcApi.clientSendMessage({ callId: activeCall.value.id, message: value });
        if (result.status === 'success') {
            notify.success(result.msg || '消息已发送');
            await loadTimeline();
        } else notify.error(result.msg || '发送失败');
    };
    const endCall = async () => {
        if (!activeCall.value) return;
        const result = await window.grpcApi.clientEndCall({ callId: activeCall.value.id });
        if (result.status !== 'success') notify.error(result.msg || '结束发送失败');
    };
    const cancelCall = async () => {
        if (!activeCall.value) return;
        const result = await window.grpcApi.clientCancelCall({ callId: activeCall.value.id });
        if (result.status !== 'success') notify.error(result.msg || '取消失败');
    };

    // ------------------------------------------------------------------ 服务器
    const serverForm = ref({ ...DEFAULT_GRPC_SERVER_CONFIG, services: [], decodeRules: [], unaryReplyTemplates: {} });
    const serverTlsOpen = ref(false);
    const decodeRulesOpen = ref(false);
    const replyOpen = ref(false);
    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const serverStatus = ref({});
    const emptyStats = () => ({ activeStreams: 0, totalReceived: 0, totalSent: 0, messageCount: 0 });
    const stats = ref(emptyStats());
    const streams = ref([]);
    const activeStreamId = ref(null);
    const activeStream = computed(() => streams.value.find(stream => stream.id === activeStreamId.value) || null);
    const sendMessageText = ref('{}');
    const sendMessageError = ref('');
    const replyMethod = ref('');
    const replyTemplateText = ref('{}');
    const replyTemplateError = ref('');
    const replyCount = computed(() => Object.keys(serverForm.value.unaryReplyTemplates).length);
    const replyMethodOptions = computed(() =>
        services.value
            .filter(service => serverForm.value.services.includes(service.fullName))
            .flatMap(service =>
                service.methods
                    .filter(
                        method =>
                            method.kind === GRPC_METHOD_KIND.UNARY || method.kind === GRPC_METHOD_KIND.CLIENT_STREAM
                    )
                    .map(method => ({
                        value: method.fullName,
                        label: `${method.fullName} → ${method.responseType}`,
                        method
                    }))
            )
    );

    const toggleService = (fullName, checked) => {
        const next = new Set(serverForm.value.services);
        if (checked) next.add(fullName);
        else next.delete(fullName);
        serverForm.value.services = Array.from(next);
    };

    const loadServerConfig = async () => {
        try {
            const result = await window.grpcApi.getServerConfig();
            if (result.status === 'success' && result.data) {
                serverForm.value = {
                    ...serverForm.value,
                    ...result.data,
                    services: Array.isArray(result.data.services) ? result.data.services : [],
                    decodeRules: Array.isArray(result.data.decodeRules) ? result.data.decodeRules : [],
                    unaryReplyTemplates: result.data.unaryReplyTemplates || {}
                };
            }
        } catch (error) {
            notify.error('加载服务器配置失败: ' + error.message);
        }
    };
    const applyServerStatus = data => {
        if (!data) return;
        isServerRunning.value = data.status === 'running';
        serverStatus.value = data;
        if (data.stats) stats.value = { ...stats.value, ...data.stats };
        if (!isServerRunning.value) {
            streams.value = [];
            activeStreamId.value = null;
            stats.value = emptyStats();
        }
    };
    const loadServerStatus = async () => {
        try {
            const result = await window.grpcApi.getServerStatus();
            if (result.status === 'success' && result.data) {
                isServerRunning.value = Boolean(result.data.running);
                if (result.data.status) applyServerStatus(result.data.status);
            }
        } catch (error) {
            console.error('获取 gRPC 服务器状态失败', error);
        }
    };
    const loadStreams = async () => {
        try {
            const result = await window.grpcApi.getStreamList();
            if (result.status === 'success') streams.value = result.data?.list || [];
        } catch (error) {
            console.error('获取流列表失败', error);
        }
    };
    const startServer = async () => {
        const port = Number(serverForm.value.port);
        validation.value.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? '' : '端口范围 1-65535';
        if (validation.value.port) {
            notify.error(validation.value.port);
            return;
        }
        if (serverForm.value.services.length === 0) {
            notify.error('请在左侧勾选要托管的服务');
            return;
        }
        serverLoading.value = true;
        try {
            const payload = JSON.parse(JSON.stringify(serverForm.value));
            await window.grpcApi.saveServerConfig(payload);
            const result = await window.grpcApi.startServer(payload);
            if (result.status === 'success') {
                applyServerStatus(result.data);
                isServerRunning.value = true;
                notify.success(result.msg || 'gRPC服务器启动成功');
            } else notify.error(result.msg || 'gRPC服务器启动失败');
        } catch (error) {
            notify.error('gRPC服务器启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };
    const stopServer = async () => {
        const result = await window.grpcApi.stopServer();
        if (result.status === 'success') {
            isServerRunning.value = false;
            applyServerStatus({ status: 'stopped' });
            notify.success(result.msg || 'gRPC服务器已停止');
        } else notify.error(result.msg || 'gRPC服务器停止失败');
    };
    const selectStream = stream => {
        activeStreamId.value = stream.id;
        sendMessageError.value = '';
        loadTimeline();
    };
    const generateSendTemplate = async () => {
        if (!activeStream.value) return;
        const result = await window.grpcApi.getMessageTemplate(activeStream.value.responseType);
        if (result.status === 'success') sendMessageText.value = formatJson(result.data?.template || {});
        else notify.error(result.msg || '生成模板失败');
    };
    const sendStreamMessage = async () => {
        if (!activeStream.value) return;
        const { value, error } = parseJsonObject(sendMessageText.value);
        if (error) {
            sendMessageError.value = error;
            return;
        }
        sendMessageError.value = '';
        const result = await window.grpcApi.sendStreamMessage({ streamId: activeStream.value.id, message: value });
        if (result.status === 'success') {
            notify.success(result.msg || '消息已下发');
            await loadStreams();
            await loadTimeline();
        } else sendMessageError.value = result.msg || '下发失败';
    };
    const closeStream = async () => {
        if (!activeStream.value) return;
        const result = await window.grpcApi.closeStream({ streamId: activeStream.value.id });
        if (result.status === 'success') notify.success(result.msg || '流已关闭');
        else notify.error(result.msg || '关闭流失败');
    };
    const upsertStream = summary => {
        const others = streams.value.filter(item => item.id !== summary.id);
        streams.value = summary.state === 'open' ? [...others, summary].sort((a, b) => a.id - b.id) : others;
        if (summary.state !== 'open' && activeStreamId.value === summary.id) activeStreamId.value = null;
    };

    watch(replyMethod, () => {
        replyTemplateText.value = formatJson(serverForm.value.unaryReplyTemplates[replyMethod.value] || {});
        replyTemplateError.value = '';
    });
    const generateReplyTemplate = async () => {
        const option = replyMethodOptions.value.find(item => item.value === replyMethod.value);
        if (!option) return;
        const result = await window.grpcApi.getMessageTemplate(option.method.responseType);
        if (result.status === 'success') replyTemplateText.value = formatJson(result.data?.template || {});
        else notify.error(result.msg || '生成模板失败');
    };
    const saveReplyTemplate = () => {
        if (!replyMethod.value) {
            replyOpen.value = false;
            return;
        }
        const { value, error } = parseJsonObject(replyTemplateText.value);
        if (error) {
            replyTemplateError.value = error;
            return;
        }
        serverForm.value.unaryReplyTemplates = { ...serverForm.value.unaryReplyTemplates, [replyMethod.value]: value };
        replyTemplateError.value = '';
        replyOpen.value = false;
    };

    // ------------------------------------------------------------------ 时间线
    const timeline = ref([]);
    const timelineDirection = ref(undefined);
    const expandedIds = ref(new Set());
    const details = ref({});

    const loadTimeline = async () => {
        try {
            const result = await window.grpcApi.getMessageList({
                page: 1,
                pageSize: TIMELINE_PAGE_SIZE,
                role: isClient.value ? GRPC_MESSAGE_ROLE.CLIENT : GRPC_MESSAGE_ROLE.SERVER,
                direction: timelineDirection.value || ''
            });
            if (result.status !== 'success') return;
            const list = result.data?.list || [];
            timeline.value = isClient.value
                ? activeCallId.value
                    ? list.filter(item => item.callId === activeCallId.value)
                    : list
                : activeStreamId.value
                  ? list.filter(item => item.streamId === activeStreamId.value)
                  : list;
        } catch (error) {
            console.error('获取消息列表失败', error);
        }
    };
    const toggleExpanded = async id => {
        const next = new Set(expandedIds.value);
        if (next.has(id)) next.delete(id);
        else {
            next.add(id);
            if (!details.value[id]) {
                const result = await window.grpcApi.getMessageDetail(id);
                if (result.status === 'success') details.value = { ...details.value, [id]: result.data };
            }
        }
        expandedIds.value = next;
    };

    const openMonitorWindow = async () => {
        if (!canOpenMonitorWindow.value || monitorOpening.value) return;
        monitorOpening.value = true;
        try {
            const result = await window.windowApi.openMonitor('grpc-message-log');
            if (result?.status !== 'success') notify.error(result?.msg || '打开独立监控窗口失败');
        } finally {
            monitorOpening.value = false;
        }
    };

    // ------------------------------------------------------------------ 事件 / 生命周期
    const handleGrpcEvent = respData => {
        if (respData.status !== 'success') return;
        const payload = respData.data;
        if (payload.stats) stats.value = { ...stats.value, ...payload.stats };
        if (payload.type === GRPC_SUB_EVT_TYPES.SERVER_STATUS) applyServerStatus(payload.data);
        else if (payload.type === GRPC_SUB_EVT_TYPES.STREAM_UPDATED && payload.data) {
            upsertStream(payload.data);
            if (!isClient.value) loadTimeline();
        } else if (payload.type === GRPC_SUB_EVT_TYPES.CLIENT_CALL_UPDATED && payload.data) {
            const index = calls.value.findIndex(call => call.id === payload.data.id);
            if (index >= 0) calls.value.splice(index, 1, payload.data);
            else calls.value = [payload.data, ...calls.value];
            if (payload.data.id === activeCallId.value) loadTimeline();
        } else if (payload.type === GRPC_SUB_EVT_TYPES.STATS_UPDATED && !isClient.value) loadTimeline();
        else if (payload.type === GRPC_SUB_EVT_TYPES.HISTORY_CLEARED) {
            timeline.value = [];
            details.value = {};
        }
    };

    const refreshAll = async () => {
        await loadCatalog();
        await loadServerStatus();
        await loadStreams();
        await loadCalls();
        await loadTimeline();
    };

    watch(mode, () => {
        expandedIds.value = new Set();
        loadTimeline();
    });
    watch(
        () => grpcRuntime.runtimeRevision,
        async () => {
            if (grpcRuntime.running) await refreshAll();
            else {
                services.value = [];
                isServerRunning.value = false;
                streams.value = [];
                calls.value = [];
                timeline.value = [];
                stats.value = emptyStats();
            }
        }
    );

    defineExpose({ clearValidationErrors: () => (validation.value = { target: '', port: '' }) });

    onMounted(async () => {
        await loadClientConfig();
        await loadServerConfig();
        await refreshAll();
    });
    onActivated(async () => {
        EventBus.on('grpc:event', GRPC_EVENT_PAGE_ID.PAGE_ID_GRPC_WORKSPACE, handleGrpcEvent);
        await refreshAll();
    });
    onDeactivated(() => {
        EventBus.off('grpc:event', GRPC_EVENT_PAGE_ID.PAGE_ID_GRPC_WORKSPACE);
        hideContextMenu();
    });
</script>

<style scoped>
    .grpc-workspace-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .workspace-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .workspace-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .workspace-toolbar {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
    }

    .toolbar-input-target,
    .toolbar-input-host {
        width: 220px;
    }

    .toolbar-input-port {
        width: 110px;
    }

    .toolbar-input-timeout {
        width: 130px;
    }

    .toolbar-spacer {
        flex: 1;
    }

    .toolbar-status {
        font-variant-numeric: tabular-nums;
    }

    .workspace-layout {
        display: grid;
        flex: 1;
        min-height: 0;
        grid-template-columns: minmax(240px, 24%) minmax(320px, 1fr) minmax(360px, 40%);
        gap: 10px;
        overflow: hidden;
    }

    .workspace-panel {
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
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        white-space: nowrap;
    }

    .panel-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .panel-meta {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .panel-tag {
        margin: 0;
    }

    .tree-filter {
        width: 140px;
    }

    .panel-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
    }

    .panel-body-editor {
        min-height: 0;
        flex: 1;
        padding: 6px;
    }

    .panel-body-editor :deep(.nn-textarea),
    .panel-body-editor :deep(textarea) {
        height: 100%;
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
    }

    .panel-footer {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 36px;
        padding: 6px 9px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .stream-send {
        flex-direction: column;
        align-items: stretch;
    }

    .stream-send-head {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .error-text {
        color: var(--nn-color-error, #d4380d);
        font-size: 12px;
    }

    .tree-node-title {
        display: inline-flex;
        min-width: max-content;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        vertical-align: middle;
    }

    .tree-node-icon {
        display: inline-flex;
        width: 14px;
        height: 14px;
        align-items: center;
        justify-content: center;
        color: var(--nn-color-primary);
        font-size: 14px;
    }

    .tree-node-icon.is-method {
        color: var(--nn-color-text-success);
    }

    .tree-node-name {
        color: var(--nn-color-text-strong);
        font-weight: 500;
        white-space: nowrap;
    }

    .tree-node-meta {
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .tree-node-role {
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 17px;
        white-space: nowrap;
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-info-subtle);
    }

    .tree-node-role.is-unary {
        color: var(--nn-color-text-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .tree-node-role.is-bidi-stream,
    .tree-node-role.is-server-stream,
    .tree-node-role.is-client-stream {
        color: var(--nn-color-primary);
        background: var(--nn-color-bg-warning-subtle);
    }

    .stream-item {
        padding: 6px 8px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        margin-bottom: 6px;
        cursor: pointer;
    }

    .stream-item.is-active {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-bg-info-subtle);
    }

    .stream-item-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-weight: 500;
    }

    .stream-item-peer {
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
    }

    .stream-item-sub {
        display: flex;
        justify-content: space-between;
        gap: 6px;
        margin-top: 2px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .stream-item-sub span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .call-select {
        width: 220px;
    }

    .direction-select {
        width: 90px;
    }

    .call-status {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
        padding: 4px 9px;
        border-bottom: 1px dashed var(--nn-color-border-light);
        font-size: 12px;
    }

    .timeline-item {
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .timeline-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 4px;
        font-size: 12px;
        cursor: pointer;
    }

    .timeline-head:hover {
        background: var(--nn-color-bg-muted);
    }

    .timeline-caret {
        width: 10px;
        color: var(--nn-color-text-muted);
    }

    .timeline-id,
    .timeline-time,
    .timeline-size {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .timeline-summary {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        font-family: var(--nn-font-mono, monospace);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .timeline-detail {
        padding: 4px 8px 8px 20px;
    }

    .timeline-warning {
        margin-bottom: 6px;
    }

    .timeline-raw {
        margin-top: 6px;
        max-height: 80px;
        overflow: auto;
        color: var(--nn-color-text-muted);
        font-family: var(--nn-font-mono, monospace);
        font-size: 11px;
        word-break: break-all;
    }

    .kv-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .kv-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 6px;
        align-items: center;
    }

    .kv-row-3 {
        grid-template-columns: 1.4fr 0.7fr 1.4fr auto;
    }

    :global(.proto-context-menu) {
        position: fixed;
        z-index: 1200;
        width: 220px;
        padding: 4px 0;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-elevated);
    }

    :global(.proto-context-menu-title) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 12px 0;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    :global(.proto-context-menu-kind) {
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
    }

    :global(.proto-context-menu-name) {
        padding: 1px 12px 6px;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
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
</style>
