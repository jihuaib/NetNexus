<template>
    <div class="nn-container grpc-workspace-page" @click="hideContextMenu">
        <nn-card class="workspace-card">
            <!-- 顶栏（URL 栏）：模式 | 目标 + 方法路径 | 执行 -->
            <div class="workspace-toolbar">
                <nn-segmented v-model:value="mode" :options="modeOptions" aria-label="工作模式" />

                <div v-if="isClient" class="url-bar" :class="{ 'is-error': validation.target }">
                    <span class="url-scheme" :title="clientForm.tlsEnabled ? 'TLS 已启用' : '明文连接'">
                        {{ clientForm.tlsEnabled ? 'grpcs://' : 'grpc://' }}
                    </span>
                    <input
                        v-model="clientForm.target"
                        class="url-target"
                        placeholder="host:port"
                        spellcheck="false"
                        aria-label="目标地址"
                        @keydown.enter="startCall"
                    />
                    <span class="url-divider" aria-hidden="true" />
                    <div class="url-method" :title="selectedMethod ? selectedMethod.fullName : '在左侧选择方法'">
                        <template v-if="selectedMethod">
                            <span :class="['method-kind', `is-${selectedMethod.kind}`]">
                                {{ methodKindLabel(selectedMethod.kind) }}
                            </span>
                            <span class="method-path">{{ methodPath(selectedMethod) }}</span>
                        </template>
                        <span v-else class="method-placeholder">在左侧选择方法</span>
                    </div>
                </div>

                <div v-else class="url-bar" :class="{ 'is-error': validation.port }">
                    <span class="url-scheme">{{ serverForm.tlsEnabled ? 'grpcs://' : 'grpc://' }}</span>
                    <input
                        v-model="serverForm.host"
                        class="url-target url-host"
                        placeholder="0.0.0.0"
                        spellcheck="false"
                        aria-label="监听地址"
                        :disabled="isServerRunning"
                    />
                    <span class="url-colon">:</span>
                    <input
                        v-model.number="serverForm.port"
                        class="url-target url-port"
                        type="number"
                        min="1"
                        max="65535"
                        aria-label="监听端口"
                        :disabled="isServerRunning"
                    />
                    <span class="url-divider" aria-hidden="true" />
                    <div class="url-method">
                        <span :class="['server-dot', { 'is-on': isServerRunning }]" aria-hidden="true" />
                        <span class="method-path">
                            {{
                                isServerRunning
                                    ? `监听中 :${serverStatus.boundPort || serverForm.port} · ${serverForm.services.length} 个服务`
                                    : serverForm.services.length
                                      ? `${serverForm.services.length} 个服务待托管`
                                      : '在左侧勾选要托管的服务'
                            }}
                        </span>
                    </div>
                </div>

                <div class="workspace-actions">
                    <template v-if="isClient">
                        <template v-if="activeCall && activeCall.state === 'open'">
                            <nn-button
                                v-if="isStreamingRequest(activeCall.kind)"
                                type="primary"
                                :disabled="!activeCall.canSend"
                                @click="sendMessage"
                            >
                                <template #icon><SendOutlined /></template>
                                发送
                            </nn-button>
                            <nn-button
                                v-if="isStreamingRequest(activeCall.kind)"
                                :disabled="!activeCall.canSend"
                                @click="endCall"
                            >
                                结束发送
                            </nn-button>
                            <nn-button danger @click="cancelCall">取消</nn-button>
                        </template>
                        <nn-button
                            v-else
                            type="primary"
                            :loading="callLoading"
                            :disabled="!grpcRuntime.running || !selectedMethod"
                            @click="startCall"
                        >
                            <template #icon><SendOutlined /></template>
                            调用
                        </nn-button>
                    </template>
                    <template v-else>
                        <nn-button
                            v-if="!isServerRunning"
                            type="primary"
                            :loading="serverLoading"
                            :disabled="!grpcRuntime.running || serverForm.services.length === 0"
                            @click="startServer"
                        >
                            启动服务器
                        </nn-button>
                        <nn-button v-else type="primary" danger @click="stopServer">停止服务器</nn-button>
                    </template>

                    <nn-tooltip title="独立监控窗口">
                        <nn-button
                            v-if="canOpenMonitorWindow"
                            :loading="monitorOpening"
                            aria-label="独立监控窗口"
                            @click="openMonitorWindow"
                        >
                            <template #icon><ExternalLinkOutlined /></template>
                        </nn-button>
                    </nn-tooltip>
                </div>
            </div>

            <div class="workspace-layout">
                <!-- 左：服务/方法树 + 历史 -->
                <section class="workspace-panel" aria-label="服务与方法">
                    <div class="panel-header">
                        <nn-segmented
                            v-if="isClient"
                            v-model:value="sidebarTab"
                            size="small"
                            :options="sidebarOptions"
                            aria-label="侧栏"
                        />
                        <div v-else class="panel-heading">
                            <span class="panel-title">托管服务</span>
                            <span class="panel-meta">{{ serverForm.services.length }}/{{ services.length }}</span>
                        </div>
                        <nn-input-search
                            v-if="sidebarTab === 'methods' || !isClient"
                            v-model:value="treeKeyword"
                            size="small"
                            allow-clear
                            placeholder="过滤"
                            class="tree-filter"
                        />
                        <nn-button v-else size="small" :disabled="calls.length === 0" @click="clearCallHistory">
                            清空
                        </nn-button>
                    </div>

                    <div v-if="!isClient || sidebarTab === 'methods'" class="panel-scroll">
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
                                    <span v-if="node.methodKind" :class="['method-kind', `is-${node.methodKind}`]">
                                        {{ methodKindShort(node.methodKind) }}
                                    </span>
                                    <span v-if="node.meta" class="tree-node-meta">{{ node.meta }}</span>
                                </span>
                            </template>
                        </nn-tree>
                    </div>

                    <div v-else class="panel-scroll">
                        <nn-empty v-if="calls.length === 0" description="暂无调用记录" />
                        <div
                            v-for="call in calls"
                            :key="call.id"
                            :class="['history-item', { 'is-active': call.id === activeCallId }]"
                            @click="selectCall(call)"
                        >
                            <div class="history-head">
                                <span :class="['method-kind', `is-${call.kind}`]">
                                    {{ methodKindShort(call.kind) }}
                                </span>
                                <span class="history-name">{{ call.fullName }}</span>
                                <span :class="['history-status', statusClass(call)]">{{ callStatusText(call) }}</span>
                            </div>
                            <div class="history-sub">
                                <span>#{{ call.id }} · {{ call.target }}</span>
                                <span>{{ timeOnly(call.startedAt) }}</span>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- 中：请求（客户端） -->
                <section v-if="isClient" class="workspace-panel" aria-label="请求">
                    <nn-tabs v-model:active-key="requestTab" size="small" class="panel-tabs">
                        <nn-tab-pane key="message">
                            <template #tab>
                                消息
                                <span v-if="selectedMethod" class="tab-hint">
                                    {{ shortType(selectedMethod.requestType) }}
                                </span>
                            </template>
                            <div class="tab-toolbar">
                                <span v-if="requestError" class="error-text">{{ requestError }}</span>
                                <span
                                    v-else-if="selectedMethod && isStreamingRequest(selectedMethod.kind)"
                                    class="panel-meta"
                                >
                                    流式请求：发起后可多次「发送」，「结束发送」后等待响应
                                </span>
                                <span v-else class="panel-meta">
                                    {{ selectedMethod ? selectedMethod.requestType : '' }}
                                </span>
                                <span class="toolbar-spacer" />
                                <nn-button size="small" :disabled="!selectedMethod" @click="generateRequestTemplate">
                                    生成模板
                                </nn-button>
                                <nn-button size="small" @click="formatRequest">格式化</nn-button>
                            </div>
                            <div class="tab-editor">
                                <nn-textarea
                                    v-model:value="requestText"
                                    height="100%"
                                    resize="none"
                                    :placeholder="selectedMethod ? '{}' : '在左侧选择方法'"
                                />
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="metadata">
                            <template #tab>
                                Metadata
                                <nn-badge v-if="metadataCount" :count="metadataCount" class="tab-badge" />
                            </template>
                            <div class="tab-scroll">
                                <div class="kv-grid">
                                    <div class="kv-row kv-head">
                                        <span />
                                        <span>Key</span>
                                        <span>Value</span>
                                        <span />
                                    </div>
                                    <div v-for="(entry, index) in clientForm.metadata" :key="index" class="kv-row">
                                        <nn-checkbox v-model:checked="entry.enabled" />
                                        <nn-input v-model:value="entry.key" size="small" placeholder="如 username" />
                                        <nn-input
                                            v-model:value="entry.value"
                                            size="small"
                                            :placeholder="String(entry.key || '').endsWith('-bin') ? 'base64' : 'value'"
                                        />
                                        <nn-button
                                            type="text"
                                            danger
                                            size="small"
                                            @click="clientForm.metadata.splice(index, 1)"
                                        >
                                            <template #icon><DeleteOutlined /></template>
                                        </nn-button>
                                    </div>
                                </div>
                                <nn-button size="small" type="dashed" class="kv-add" @click="addMetadata">
                                    <template #icon><PlusOutlined /></template>
                                    添加
                                </nn-button>
                                <div class="panel-meta kv-note">
                                    key 以
                                    <code>-bin</code>
                                    结尾时 value 按 base64 解码。
                                </div>
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="tls">
                            <template #tab>
                                TLS
                                <span v-if="clientForm.tlsEnabled" class="tab-dot" aria-label="已启用" />
                            </template>
                            <div class="tab-scroll">
                                <nn-form :label-col="{ style: { width: '110px' } }" size="small">
                                    <nn-form-item label="启用 TLS">
                                        <nn-switch v-model:checked="clientForm.tlsEnabled" />
                                    </nn-form-item>
                                    <nn-form-item label="CA 文件">
                                        <nn-input
                                            v-model:value="clientForm.tlsCaPath"
                                            placeholder="可选，不填使用系统根证书"
                                        />
                                    </nn-form-item>
                                    <nn-form-item label="客户端证书">
                                        <nn-input v-model:value="clientForm.tlsCertPath" placeholder="可选，PEM" />
                                    </nn-form-item>
                                    <nn-form-item label="客户端私钥">
                                        <nn-input v-model:value="clientForm.tlsKeyPath" placeholder="可选，PEM" />
                                    </nn-form-item>
                                    <nn-form-item label="Server Name">
                                        <nn-input
                                            v-model:value="clientForm.tlsServerName"
                                            placeholder="可选，覆盖证书校验主机名"
                                        />
                                    </nn-form-item>
                                </nn-form>
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="settings" tab="设置">
                            <div class="tab-scroll">
                                <nn-form :label-col="{ style: { width: '110px' } }" size="small">
                                    <nn-form-item label="超时">
                                        <nn-input-number
                                            v-model:value="clientForm.timeoutMs"
                                            :min="0"
                                            :max="3600000"
                                            :step="1000"
                                            addon-after="ms"
                                            style="width: 200px"
                                        />
                                        <span class="panel-meta form-note">0 表示不设置 deadline</span>
                                    </nn-form-item>
                                </nn-form>
                                <div class="section-title">解码规则（可选，与服务器模式共用）</div>
                                <DecodeRulesEditor :rules="serverForm.decodeRules" />
                            </div>
                        </nn-tab-pane>
                    </nn-tabs>
                </section>

                <!-- 中：活动流 / 服务配置（服务器） -->
                <section v-else class="workspace-panel" aria-label="设备与活动流">
                    <nn-tabs v-model:active-key="serverTab" size="small" class="panel-tabs">
                        <nn-tab-pane key="streams">
                            <template #tab>
                                活动流
                                <nn-badge v-if="stats.activeStreams" :count="stats.activeStreams" class="tab-badge" />
                            </template>
                            <div class="tab-toolbar">
                                <span class="panel-meta">收 {{ stats.totalReceived }} · 发 {{ stats.totalSent }}</span>
                                <span class="toolbar-spacer" />
                                <nn-button size="small" @click="loadStreams">刷新</nn-button>
                            </div>
                            <div class="tab-scroll stream-list">
                                <nn-empty
                                    v-if="streams.length === 0"
                                    :description="isServerRunning ? '等待设备接入…' : '启动服务器后设备可接入'"
                                />
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
                                        <span>
                                            <span :class="['method-kind', `is-${stream.kind}`]">
                                                {{ methodKindShort(stream.kind) }}
                                            </span>
                                            #{{ stream.id }} {{ stream.fullName }}
                                        </span>
                                        <span>↓{{ stream.inbound }} ↑{{ stream.outbound }}</span>
                                    </div>
                                </div>
                            </div>
                            <div class="panel-footer stream-send">
                                <div class="stream-send-head">
                                    <span class="panel-title">下发</span>
                                    <span class="panel-meta">
                                        {{
                                            activeStream
                                                ? `→ ${activeStream.peer} · ${shortType(activeStream.responseType)}`
                                                : '先选择一条流'
                                        }}
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
                                        <template #icon><SendOutlined /></template>
                                        下发
                                    </nn-button>
                                    <nn-button size="small" danger :disabled="!activeStream" @click="closeStream">
                                        关闭流
                                    </nn-button>
                                </div>
                                <nn-textarea
                                    v-model:value="sendMessageText"
                                    height="120px"
                                    resize="none"
                                    placeholder="{}"
                                />
                                <span v-if="sendMessageError" class="error-text">{{ sendMessageError }}</span>
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="reply">
                            <template #tab>
                                回复模板
                                <nn-badge v-if="replyCount" :count="replyCount" class="tab-badge" />
                            </template>
                            <div class="tab-toolbar">
                                <nn-select
                                    v-model:value="replyMethod"
                                    size="small"
                                    placeholder="选择 Unary / Client Stream 方法"
                                    show-search
                                    allow-clear
                                    :disabled="isServerRunning"
                                    class="reply-select"
                                >
                                    <nn-select-option
                                        v-for="option in replyMethodOptions"
                                        :key="option.value"
                                        :value="option.value"
                                    >
                                        {{ option.label }}
                                    </nn-select-option>
                                </nn-select>
                                <nn-button
                                    size="small"
                                    :disabled="!replyMethod || isServerRunning"
                                    @click="generateReplyTemplate"
                                >
                                    生成模板
                                </nn-button>
                                <nn-button
                                    size="small"
                                    type="primary"
                                    :disabled="!replyMethod || isServerRunning"
                                    @click="saveReplyTemplate"
                                >
                                    保存
                                </nn-button>
                                <nn-button
                                    size="small"
                                    danger
                                    :disabled="
                                        !replyMethod || isServerRunning || !serverForm.unaryReplyTemplates[replyMethod]
                                    "
                                    @click="removeReplyTemplate"
                                >
                                    删除
                                </nn-button>
                            </div>
                            <div class="tab-editor">
                                <nn-textarea
                                    v-model:value="replyTemplateText"
                                    height="100%"
                                    resize="none"
                                    placeholder="{}"
                                    :disabled="!replyMethod || isServerRunning"
                                />
                            </div>
                            <div class="tab-toolbar tab-toolbar-bottom">
                                <span v-if="replyTemplateError" class="error-text">{{ replyTemplateError }}</span>
                                <span v-else class="panel-meta">
                                    {{
                                        replyMethodOptions.length
                                            ? '未配置模板的 Unary / Client Stream 方法回复空消息'
                                            : '勾选托管服务后可配置回复模板'
                                    }}
                                </span>
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="decode">
                            <template #tab>
                                解码规则
                                <nn-badge
                                    v-if="serverForm.decodeRules.length"
                                    :count="serverForm.decodeRules.length"
                                    class="tab-badge"
                                />
                            </template>
                            <div class="tab-scroll">
                                <div class="panel-meta kv-note">
                                    未配置时自动解码：JSON 文本、
                                    <code>proto_path</code>
                                    /
                                    <code>encoding_path</code>
                                    定位的业务消息、
                                    <code>Telemetry</code>
                                    头消息。
                                </div>
                                <DecodeRulesEditor :rules="serverForm.decodeRules" :disabled="isServerRunning" />
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="tls">
                            <template #tab>
                                TLS
                                <span v-if="serverForm.tlsEnabled" class="tab-dot" aria-label="已启用" />
                            </template>
                            <div class="tab-scroll">
                                <nn-form
                                    :label-col="{ style: { width: '120px' } }"
                                    size="small"
                                    :disabled="isServerRunning"
                                >
                                    <nn-form-item label="启用 TLS">
                                        <nn-switch
                                            v-model:checked="serverForm.tlsEnabled"
                                            :disabled="isServerRunning"
                                        />
                                    </nn-form-item>
                                    <nn-form-item label="证书文件">
                                        <nn-input
                                            v-model:value="serverForm.tlsCertPath"
                                            placeholder="server.crt (PEM)"
                                        />
                                    </nn-form-item>
                                    <nn-form-item label="私钥文件">
                                        <nn-input
                                            v-model:value="serverForm.tlsKeyPath"
                                            placeholder="server.key (PEM)"
                                        />
                                    </nn-form-item>
                                    <nn-form-item label="CA 文件">
                                        <nn-input
                                            v-model:value="serverForm.tlsCaPath"
                                            placeholder="可选，校验客户端证书"
                                        />
                                    </nn-form-item>
                                    <nn-form-item label="客户端证书">
                                        <nn-checkbox
                                            v-model:checked="serverForm.tlsRequireClientCert"
                                            :disabled="isServerRunning"
                                        >
                                            要求客户端证书
                                        </nn-checkbox>
                                    </nn-form-item>
                                    <nn-form-item label="最大消息长度">
                                        <nn-input-number
                                            v-model:value="serverForm.maxMessageBytes"
                                            :min="1024"
                                            :max="1073741824"
                                            addon-after="字节"
                                            style="width: 220px"
                                        />
                                    </nn-form-item>
                                </nn-form>
                            </div>
                        </nn-tab-pane>
                    </nn-tabs>
                </section>

                <!-- 右：响应 / 消息 -->
                <section class="workspace-panel" aria-label="响应">
                    <nn-tabs v-model:active-key="responseTab" size="small" class="panel-tabs">
                        <nn-tab-pane key="messages">
                            <template #tab>
                                {{ isClient ? '响应' : '消息' }}
                                <nn-badge
                                    v-if="timeline.length"
                                    :count="timeline.length"
                                    :overflow-count="999"
                                    class="tab-badge"
                                />
                            </template>

                            <!-- 客户端：调用状态栏 -->
                            <div v-if="isClient" class="status-bar">
                                <template v-if="activeCall">
                                    <span :class="['status-code', statusClass(activeCall)]">
                                        {{ callStatusText(activeCall) }}
                                    </span>
                                    <span class="status-item">{{ formatDuration(activeCall.durationMs) }}</span>
                                    <span class="status-item">
                                        ↑{{ activeCall.requests }} ↓{{ activeCall.responses }}
                                    </span>
                                    <span
                                        v-if="activeCall.statusDetails"
                                        class="status-detail"
                                        :title="activeCall.statusDetails"
                                    >
                                        {{ activeCall.statusDetails }}
                                    </span>
                                    <span class="toolbar-spacer" />
                                    <span class="panel-meta">#{{ activeCall.id }}</span>
                                </template>
                                <span v-else class="panel-meta">点击「调用」发起请求，或在「历史」中选择一条记录</span>
                            </div>
                            <!-- 服务器：流信息栏 -->
                            <div v-else class="status-bar">
                                <template v-if="activeStream">
                                    <nn-tag :color="streamStateColor(activeStream.state)" class="panel-tag">
                                        {{ streamStateText(activeStream.state) }}
                                    </nn-tag>
                                    <span class="status-item status-item-fixed">{{ activeStream.peer }}</span>
                                    <span class="status-item">{{ activeStream.fullName }}</span>
                                    <span class="toolbar-spacer" />
                                    <nn-button
                                        type="link"
                                        size="small"
                                        @click="
                                            activeStreamId = null;
                                            loadTimeline();
                                        "
                                    >
                                        显示全部
                                    </nn-button>
                                </template>
                                <span v-else class="panel-meta">
                                    全部服务端消息 · 在「活动流」中选择一条流可按流筛选
                                </span>
                            </div>

                            <div class="tab-toolbar">
                                <nn-segmented
                                    v-model:value="timelineDirection"
                                    size="small"
                                    :options="directionOptions"
                                    aria-label="方向"
                                    @change="loadTimeline"
                                />
                                <span class="toolbar-spacer" />
                                <nn-button size="small" :disabled="timeline.length === 0" @click="toggleExpandAll">
                                    {{ allExpanded ? '全部折叠' : '全部展开' }}
                                </nn-button>
                                <nn-button size="small" @click="loadTimeline">刷新</nn-button>
                            </div>

                            <div ref="timelineRef" class="tab-scroll timeline">
                                <nn-empty v-if="timeline.length === 0" description="暂无消息" />
                                <div v-for="record in timeline" :key="record.id" class="timeline-item">
                                    <div class="timeline-head" @click="toggleExpanded(record.id)">
                                        <span class="timeline-caret">{{ expandedIds.has(record.id) ? '▾' : '▸' }}</span>
                                        <span
                                            :class="[
                                                'timeline-dir',
                                                record.direction === 'inbound' ? 'is-in' : 'is-out'
                                            ]"
                                        >
                                            {{
                                                record.direction === 'inbound'
                                                    ? isClient
                                                        ? '响应'
                                                        : '收'
                                                    : isClient
                                                      ? '请求'
                                                      : '发'
                                            }}
                                        </span>
                                        <span class="timeline-time">{{ timeOnly(record.timestamp) }}</span>
                                        <span class="timeline-summary">{{ record.summary }}</span>
                                        <span
                                            v-if="record.status !== 'decoded' && record.status !== 'sent'"
                                            class="timeline-status"
                                        >
                                            <nn-tag :color="messageStatusColor(record.status)" class="panel-tag">
                                                {{ messageStatusText(record.status) }}
                                            </nn-tag>
                                        </span>
                                        <span class="timeline-size">{{ formatBytes(record.byteLength) }}</span>
                                    </div>
                                    <div v-if="expandedIds.has(record.id)" class="timeline-detail">
                                        <nn-spin :spinning="!details[record.id]">
                                            <template v-if="details[record.id]">
                                                <div class="timeline-detail-meta">
                                                    <span>#{{ record.id }}</span>
                                                    <span>{{ record.typeName }}</span>
                                                    <span v-if="record.peer">{{ record.peer }}</span>
                                                    <span class="toolbar-spacer" />
                                                    <nn-button
                                                        type="link"
                                                        size="small"
                                                        @click.stop="copyDecoded(record.id)"
                                                    >
                                                        复制 JSON
                                                    </nn-button>
                                                    <nn-button
                                                        v-if="
                                                            isClient && record.direction === 'inbound' && selectedMethod
                                                        "
                                                        type="link"
                                                        size="small"
                                                        @click.stop="useAsRequest(record.id)"
                                                    >
                                                        作为请求
                                                    </nn-button>
                                                </div>
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
                                                <details class="timeline-raw">
                                                    <summary>原始字节 ({{ record.byteLength }} B)</summary>
                                                    <div class="timeline-raw-hex">
                                                        {{ details[record.id].rawHex || '-' }}
                                                    </div>
                                                </details>
                                            </template>
                                        </nn-spin>
                                    </div>
                                </div>
                            </div>
                        </nn-tab-pane>

                        <template v-if="isClient">
                            <nn-tab-pane key="headers">
                                <template #tab>
                                    Metadata
                                    <nn-badge
                                        v-if="responseMetadataCount"
                                        :count="responseMetadataCount"
                                        class="tab-badge"
                                    />
                                </template>
                                <div class="tab-scroll">
                                    <KvTable :value="activeCall?.responseMetadata" empty-text="暂无响应 Metadata" />
                                </div>
                            </nn-tab-pane>
                            <nn-tab-pane key="trailers">
                                <template #tab>
                                    Trailers
                                    <nn-badge v-if="trailersCount" :count="trailersCount" class="tab-badge" />
                                </template>
                                <div class="tab-scroll">
                                    <KvTable :value="activeCall?.trailers" empty-text="暂无 Trailers" />
                                </div>
                            </nn-tab-pane>
                            <nn-tab-pane key="info" tab="信息">
                                <div class="tab-scroll">
                                    <nn-empty v-if="!activeCall" description="暂无调用" />
                                    <nn-descriptions v-else :column="1" bordered size="small">
                                        <nn-descriptions-item label="方法">
                                            <nn-typography-text copyable>{{ activeCall.fullName }}</nn-typography-text>
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="类型">
                                            {{ methodKindLabel(activeCall.kind) }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="目标">
                                            {{ activeCall.tlsEnabled ? 'grpcs://' : 'grpc://' }}{{ activeCall.target }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="状态">
                                            {{ streamStateText(activeCall.state) }}
                                            <template v-if="activeCall.statusName">
                                                · {{ activeCall.statusName }} ({{ activeCall.statusCode }})
                                            </template>
                                        </nn-descriptions-item>
                                        <nn-descriptions-item v-if="activeCall.statusDetails" label="详情">
                                            {{ activeCall.statusDetails }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item v-if="activeCall.reason" label="结束原因">
                                            {{ activeCall.reason }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="开始 / 结束">
                                            {{ activeCall.startedAt }} → {{ activeCall.endedAt }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="耗时">
                                            {{ formatDuration(activeCall.durationMs) }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="请求 / 响应">
                                            {{ activeCall.requests }} / {{ activeCall.responses }}
                                        </nn-descriptions-item>
                                        <nn-descriptions-item label="消息类型">
                                            {{ activeCall.requestType }} → {{ activeCall.responseType }}
                                        </nn-descriptions-item>
                                    </nn-descriptions>
                                </div>
                            </nn-tab-pane>
                        </template>
                        <nn-tab-pane v-else key="stream-info" tab="流信息">
                            <div class="tab-scroll">
                                <nn-empty v-if="!activeStream" description="在「活动流」中选择一条流" />
                                <nn-descriptions v-else :column="1" bordered size="small">
                                    <nn-descriptions-item label="对端">{{ activeStream.peer }}</nn-descriptions-item>
                                    <nn-descriptions-item label="方法">
                                        <nn-typography-text copyable>{{ activeStream.fullName }}</nn-typography-text>
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="类型">
                                        {{ methodKindLabel(activeStream.kind) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="状态">
                                        {{ streamStateText(activeStream.state) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="开始">
                                        {{ activeStream.startedAt }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="收 / 发">
                                        {{ activeStream.inbound }} / {{ activeStream.outbound }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="消息类型">
                                        {{ activeStream.requestType }} → {{ activeStream.responseType }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item v-if="activeStream.metadata" label="请求 Metadata">
                                        <KvTable :value="activeStream.metadata" empty-text="-" />
                                    </nn-descriptions-item>
                                </nn-descriptions>
                            </div>
                        </nn-tab-pane>
                    </nn-tabs>
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
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="invoke">
                    <template #icon><SendOutlined /></template>
                    {{ isClient ? '调用' : '切到客户端调用' }}
                </nn-menu-item>
                <nn-menu-item key="properties">
                    <template #icon><EyeOutlined /></template>
                    查看节点属性
                </nn-menu-item>
                <nn-menu-item key="copy">
                    <template #icon><CopyOutlined /></template>
                    复制全名
                </nn-menu-item>
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="copyPath">
                    <template #icon><CopyOutlined /></template>
                    复制调用路径
                </nn-menu-item>
                <nn-menu-item v-if="contextMenu.node?.kind === 'method'" key="template">
                    <template #icon><CodeOutlined /></template>
                    重新生成请求模板
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
    </div>
</template>

<script setup>
    import {
        computed,
        h,
        nextTick,
        onActivated,
        onDeactivated,
        onMounted,
        reactive,
        ref,
        resolveComponent,
        watch
    } from 'vue';
    import {
        ApiOutlined,
        CodeOutlined,
        CopyOutlined,
        DeleteOutlined,
        ExternalLinkOutlined,
        EyeOutlined,
        PlusOutlined,
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
        formatBytes,
        formatJson,
        messageStatusColor,
        messageStatusText,
        methodKindLabel,
        methodKindShort,
        parseJsonObject,
        streamStateColor,
        streamStateText
    } from './grpcUtils';
    import { useGrpcRuntime } from './useGrpcRuntime';

    defineOptions({ name: 'GrpcWorkspace' });

    const MODE = Object.freeze({ CLIENT: 'client', SERVER: 'server' });
    const CONTEXT_MENU_MARGIN = 12;
    const TIMELINE_PAGE_SIZE = 200;

    // ------------------------------------------------------------------ 内联小组件
    /** 在 render 函数内解析全局注册的 nn-* 组件 */
    const resolveNn = name => resolveComponent(name);
    /** 解码规则编辑器：客户端「设置」与服务器「解码规则」共用同一份数据 */
    const DecodeRulesEditor = {
        name: 'GrpcDecodeRulesEditor',
        props: { rules: { type: Array, required: true }, disabled: { type: Boolean, default: false } },
        setup(props) {
            const add = () => props.rules.push({ messageType: '', field: '', targetType: '' });
            return () =>
                h('div', { class: 'kv-grid' }, [
                    h('div', { class: 'kv-row kv-row-rule kv-head' }, [
                        h('span', '消息类型'),
                        h('span', '字段'),
                        h('span', '目标'),
                        h('span')
                    ]),
                    ...props.rules.map((rule, index) =>
                        h('div', { class: 'kv-row kv-row-rule', key: index }, [
                            h(resolveNn('nn-input'), {
                                value: rule.messageType,
                                'onUpdate:value': v => (rule.messageType = v),
                                size: 'small',
                                disabled: props.disabled,
                                placeholder: '如 huawei_dialout.serviceArgs'
                            }),
                            h(resolveNn('nn-input'), {
                                value: rule.field,
                                'onUpdate:value': v => (rule.field = v),
                                size: 'small',
                                disabled: props.disabled,
                                placeholder: '字段'
                            }),
                            h(resolveNn('nn-input'), {
                                value: rule.targetType,
                                'onUpdate:value': v => (rule.targetType = v),
                                size: 'small',
                                disabled: props.disabled,
                                placeholder: '消息全名 / @proto_path / @json'
                            }),
                            h(
                                resolveNn('nn-button'),
                                {
                                    type: 'text',
                                    danger: true,
                                    size: 'small',
                                    disabled: props.disabled,
                                    onClick: () => props.rules.splice(index, 1)
                                },
                                { icon: () => h(DeleteOutlined) }
                            )
                        ])
                    ),
                    h(
                        resolveNn('nn-button'),
                        { size: 'small', type: 'dashed', class: 'kv-add', disabled: props.disabled, onClick: add },
                        { icon: () => h(PlusOutlined), default: () => '添加规则' }
                    )
                ]);
        }
    };

    /** 只读键值表：响应 Metadata / Trailers */
    const KvTable = {
        name: 'GrpcKvTable',
        props: { value: { type: Object, default: null }, emptyText: { type: String, default: '-' } },
        setup(props) {
            return () => {
                const entries = Object.entries(props.value || {});
                if (entries.length === 0) {
                    return h(resolveNn('nn-empty'), { description: props.emptyText });
                }
                return h(
                    'div',
                    { class: 'kv-table' },
                    entries.map(([key, value]) =>
                        h('div', { class: 'kv-table-row', key }, [
                            h('span', { class: 'kv-table-key' }, key),
                            h(
                                'span',
                                { class: 'kv-table-value' },
                                Array.isArray(value) ? value.join(', ') : String(value)
                            )
                        ])
                    )
                );
            };
        }
    };

    // ------------------------------------------------------------------ 基础状态
    const grpcRuntime = useGrpcRuntime();
    const mode = ref(MODE.CLIENT);
    const isClient = computed(() => mode.value === MODE.CLIENT);
    const modeOptions = [
        { label: '客户端 · 下发', value: MODE.CLIENT },
        { label: '服务器 · 上报', value: MODE.SERVER }
    ];
    const sidebarTab = ref('methods');
    const sidebarOptions = [
        { label: '方法', value: 'methods' },
        { label: '历史', value: 'history' }
    ];
    const requestTab = ref('message');
    const serverTab = ref('streams');
    const responseTab = ref('messages');
    const directionOptions = [
        { label: '全部', value: '' },
        { label: '接收', value: 'inbound' },
        { label: '发送', value: 'outbound' }
    ];
    const canOpenMonitorWindow = computed(() => typeof window.windowApi?.openMonitor === 'function');
    const monitorOpening = ref(false);
    const validation = ref({ target: '', port: '' });

    const isStreamingRequest = kind => kind === GRPC_METHOD_KIND.CLIENT_STREAM || kind === GRPC_METHOD_KIND.BIDI_STREAM;
    const methodPath = method => {
        const idx = method.fullName.lastIndexOf('.');
        return idx > 0 ? `/${method.fullName.slice(0, idx)}/${method.fullName.slice(idx + 1)}` : `/${method.fullName}`;
    };
    const shortType = typeName =>
        String(typeName || '')
            .split('.')
            .pop();
    const timeOnly = timestamp => {
        const text = String(timestamp || '');
        const idx = text.indexOf(' ');
        return idx > 0 ? text.slice(idx + 1) : text;
    };
    const formatDuration = ms => {
        const number = Number(ms);
        if (!Number.isFinite(number)) return '-';
        if (number >= 1000) return `${(number / 1000).toFixed(2)} s`;
        return `${Math.round(number)} ms`;
    };
    const callStatusText = call => {
        if (!call) return '-';
        if (call.state === 'open') return '进行中';
        if (call.statusName) return `${call.statusName} (${call.statusCode})`;
        return streamStateText(call.state);
    };
    const statusClass = call => {
        if (!call) return '';
        if (call.state === 'open') return 'is-pending';
        return call.statusCode === 0 ? 'is-ok' : 'is-error';
    };
    const baseName = file =>
        String(file || '')
            .split(/[\\/]/)
            .pop();
    const copyText = async (text, message) => {
        try {
            await navigator.clipboard.writeText(text);
            notify.success(message);
        } catch (_error) {
            notify.warning('系统剪贴板不可用');
        }
    };
    const deepClone = value => JSON.parse(JSON.stringify(value));

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
                meta: `${service.methods.length}`,
                selectable: false,
                children: service.methods
                    .filter(method => matches(service.fullName) || matches(method.fullName))
                    .map(method => ({
                        key: `method:${method.fullName}`,
                        title: method.name,
                        kind: 'method',
                        fullName: method.fullName,
                        methodKind: method.kind,
                        isLeaf: true
                    }))
            }))
            .filter(node => node.children.length > 0)
    );

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

    /** 选中方法：像 BloomRPC 一样，首次打开自动生成请求模板；再次打开恢复上次编辑的内容 */
    const selectMethod = async fullName => {
        if (!fullName) return;
        if (selectedMethodName.value && selectedMethodName.value !== fullName) {
            rememberRequestText();
        }
        selectedMethodName.value = fullName;
        treeSelectedKeys.value = [`method:${fullName}`];
        clientForm.value.method = fullName;
        requestError.value = '';
        const saved = clientForm.value.requestTexts[fullName];
        if (typeof saved === 'string') {
            requestText.value = saved;
        } else {
            requestText.value = '{}';
            await generateRequestTemplate();
        }
        if (isClient.value) requestTab.value = 'message';
    };
    const handleTreeSelect = (selectedKeys, { node }) => {
        hideContextMenu();
        const key = selectedKeys[0] || node?.key;
        if (!key || !String(key).startsWith('method:')) return;
        void selectMethod(String(key).slice('method:'.length));
    };

    // ------------------------------------------------------------------ 右键菜单 / 属性
    const contextMenuRef = ref(null);
    const contextMenu = reactive({ visible: false, node: null });
    const propertyOpen = ref(false);
    const propertyLoading = ref(false);
    const property = ref(null);
    const propertyTitle = computed(() => (property.value ? `节点属性 · ${property.value.node.fullName}` : '节点属性'));

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
        else if (key === 'copyPath') await copyText(methodPath(node), '调用路径已复制');
        else if (key === 'invoke') {
            mode.value = MODE.CLIENT;
            await selectMethod(node.fullName);
            await startCall();
        } else if (key === 'template') {
            mode.value = MODE.CLIENT;
            await selectMethod(node.fullName);
            await generateRequestTemplate();
        }
    };

    // ------------------------------------------------------------------ 客户端
    const clientForm = ref({ ...DEFAULT_GRPC_CLIENT_CONFIG, metadata: [], method: '', requestTexts: {} });
    const metadataCount = computed(
        () => clientForm.value.metadata.filter(item => item.key && item.enabled !== false).length
    );
    const requestText = ref('{}');
    const requestError = ref('');
    const callLoading = ref(false);
    const calls = ref([]);
    const activeCallId = ref(null);
    const activeCall = computed(() => calls.value.find(call => call.id === activeCallId.value) || null);
    const responseMetadataCount = computed(() => Object.keys(activeCall.value?.responseMetadata || {}).length);
    const trailersCount = computed(() => Object.keys(activeCall.value?.trailers || {}).length);

    const addMetadata = () => clientForm.value.metadata.push({ key: '', value: '', enabled: true });
    const rememberRequestText = () => {
        if (selectedMethodName.value) {
            clientForm.value.requestTexts[selectedMethodName.value] = requestText.value;
        }
    };
    const persistClientConfig = async () => {
        rememberRequestText();
        try {
            await window.grpcApi.saveClientConfig(deepClone({ ...clientForm.value, method: selectedMethodName.value }));
        } catch (error) {
            console.error('保存客户端配置失败', error);
        }
    };

    const loadClientConfig = async () => {
        try {
            const result = await window.grpcApi.getClientConfig();
            if (result.status === 'success' && result.data) {
                const data = result.data;
                clientForm.value = {
                    ...clientForm.value,
                    ...data,
                    metadata: (Array.isArray(data.metadata) ? data.metadata : []).map(item => ({
                        enabled: true,
                        ...item
                    })),
                    requestTexts:
                        data.requestTexts && typeof data.requestTexts === 'object' ? { ...data.requestTexts } : {}
                };
                // 兼容旧版本：只保存了单个 requestText
                if (
                    typeof data.requestText === 'string' &&
                    data.method &&
                    !clientForm.value.requestTexts[data.method]
                ) {
                    clientForm.value.requestTexts[data.method] = data.requestText;
                }
                if (clientForm.value.method) {
                    selectedMethodName.value = clientForm.value.method;
                    treeSelectedKeys.value = [`method:${clientForm.value.method}`];
                    const saved = clientForm.value.requestTexts[clientForm.value.method];
                    if (typeof saved === 'string') requestText.value = saved;
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
    const selectCall = async call => {
        activeCallId.value = call.id;
        responseTab.value = 'messages';
        if (call.fullName !== selectedMethodName.value && allMethods.value.some(m => m.fullName === call.fullName)) {
            await selectMethod(call.fullName);
        }
        await loadTimeline();
    };
    const clearCallHistory = () => {
        // 调用记录保存在协议进程内存中；这里只清空视图中的已结束记录
        calls.value = calls.value.filter(call => call.state === 'open');
        if (activeCall.value === null) activeCallId.value = null;
        loadTimeline();
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
            requestTab.value = 'message';
            return;
        }
        requestError.value = '';
        callLoading.value = true;
        try {
            await persistClientConfig();
            const config = deepClone({ ...clientForm.value, method: selectedMethod.value.fullName });
            delete config.requestTexts;
            const result = await window.grpcApi.clientStartCall({
                ...config,
                message: value,
                decodeRules: deepClone(serverForm.value.decodeRules)
            });
            if (result.status === 'success') {
                await loadCalls();
                activeCallId.value = result.data?.id || activeCallId.value;
                responseTab.value = 'messages';
                autoExpandLatest = true;
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
            requestTab.value = 'message';
            return;
        }
        requestError.value = '';
        const result = await window.grpcApi.clientSendMessage({ callId: activeCall.value.id, message: value });
        if (result.status === 'success') await loadTimeline();
        else notify.error(result.msg || '发送失败');
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
                        label: `${method.fullName} → ${shortType(method.responseType)}${
                            serverForm.value.unaryReplyTemplates[method.fullName] ? ' ✓' : ''
                        }`,
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
    const persistServerConfig = async () => {
        try {
            await window.grpcApi.saveServerConfig(deepClone(serverForm.value));
        } catch (error) {
            console.error('保存服务器配置失败', error);
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
            const payload = deepClone(serverForm.value);
            await window.grpcApi.saveServerConfig(payload);
            const result = await window.grpcApi.startServer(payload);
            if (result.status === 'success') {
                applyServerStatus(result.data);
                isServerRunning.value = true;
                serverTab.value = 'streams';
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
        responseTab.value = 'messages';
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
    const saveReplyTemplate = async () => {
        if (!replyMethod.value) return;
        const { value, error } = parseJsonObject(replyTemplateText.value);
        if (error) {
            replyTemplateError.value = error;
            return;
        }
        serverForm.value.unaryReplyTemplates = { ...serverForm.value.unaryReplyTemplates, [replyMethod.value]: value };
        replyTemplateError.value = '';
        await persistServerConfig();
        notify.success('回复模板已保存');
    };
    const removeReplyTemplate = async () => {
        if (!replyMethod.value) return;
        const next = { ...serverForm.value.unaryReplyTemplates };
        delete next[replyMethod.value];
        serverForm.value.unaryReplyTemplates = next;
        replyTemplateText.value = '{}';
        await persistServerConfig();
    };

    // ------------------------------------------------------------------ 时间线
    const timeline = ref([]);
    const timelineDirection = ref('');
    const timelineRef = ref(null);
    const expandedIds = ref(new Set());
    const details = ref({});
    let autoExpandLatest = false;
    const allExpanded = computed(
        () => timeline.value.length > 0 && timeline.value.every(record => expandedIds.value.has(record.id))
    );

    const fetchDetail = async id => {
        if (details.value[id]) return details.value[id];
        const result = await window.grpcApi.getMessageDetail(id);
        if (result.status === 'success') details.value = { ...details.value, [id]: result.data };
        return details.value[id];
    };
    const loadTimeline = async () => {
        try {
            const result = await window.grpcApi.getMessageList({
                page: 1,
                pageSize: TIMELINE_PAGE_SIZE,
                role: isClient.value ? GRPC_MESSAGE_ROLE.CLIENT : GRPC_MESSAGE_ROLE.SERVER,
                direction: timelineDirection.value || '',
                callId: isClient.value ? activeCallId.value || 0 : 0,
                streamId: isClient.value ? 0 : activeStreamId.value || 0
            });
            if (result.status !== 'success') return;
            // 协议进程返回最新在前；时间线按时间顺序展示，最新在底部
            const list = (result.data?.list || []).slice().reverse();
            const previousLast = timeline.value[timeline.value.length - 1]?.id;
            timeline.value = list;
            const last = list[list.length - 1];
            if (last && last.id !== previousLast) {
                if (autoExpandLatest && last.direction === 'inbound') {
                    autoExpandLatest = false;
                    await toggleExpanded(last.id, true);
                }
                await nextTick();
                if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight;
            }
        } catch (error) {
            console.error('获取消息列表失败', error);
        }
    };
    const toggleExpanded = async (id, forceOpen = false) => {
        const next = new Set(expandedIds.value);
        if (next.has(id) && !forceOpen) next.delete(id);
        else {
            next.add(id);
            await fetchDetail(id);
        }
        expandedIds.value = next;
    };
    const toggleExpandAll = async () => {
        if (allExpanded.value) {
            expandedIds.value = new Set();
            return;
        }
        await Promise.all(timeline.value.map(record => fetchDetail(record.id)));
        expandedIds.value = new Set(timeline.value.map(record => record.id));
    };
    const copyDecoded = async id => {
        const detail = await fetchDetail(id);
        await copyText(formatJson(detail?.decoded || {}), 'JSON 已复制');
    };
    const useAsRequest = async id => {
        const detail = await fetchDetail(id);
        requestText.value = formatJson(detail?.decoded || {});
        requestTab.value = 'message';
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
            if (payload.data.id === activeCallId.value && isClient.value) loadTimeline();
        } else if (payload.type === GRPC_SUB_EVT_TYPES.STATS_UPDATED && !isClient.value) loadTimeline();
        else if (payload.type === GRPC_SUB_EVT_TYPES.HISTORY_CLEARED) {
            timeline.value = [];
            details.value = {};
            expandedIds.value = new Set();
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
        responseTab.value = 'messages';
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
        void persistClientConfig();
        void persistServerConfig();
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

    /* ------------------------------------------------------------ 顶栏 / URL 栏 */
    .workspace-toolbar {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 10px;
    }

    .url-bar {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        height: 32px;
        align-items: center;
        gap: 6px;
        padding: 0 10px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
        transition: border-color 0.15s;
    }

    .url-bar:focus-within {
        border-color: var(--nn-color-primary);
    }

    .url-bar.is-error {
        border-color: var(--nn-color-error, #d4380d);
    }

    .url-scheme {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        user-select: none;
    }

    .url-target {
        flex: 0 1 220px;
        min-width: 80px;
        height: 100%;
        padding: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--nn-color-text-strong);
        font: inherit;
    }

    .url-target:disabled {
        color: var(--nn-color-text-muted);
    }

    .url-host {
        flex: 0 1 140px;
    }

    .url-port {
        flex: 0 0 64px;
        -moz-appearance: textfield;
        appearance: textfield;
    }

    .url-port::-webkit-outer-spin-button,
    .url-port::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    .url-colon {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
    }

    .url-divider {
        flex: 0 0 1px;
        height: 18px;
        background: var(--nn-color-border-light);
    }

    .url-method {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        white-space: nowrap;
    }

    .method-path {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        text-overflow: ellipsis;
    }

    .method-placeholder {
        color: var(--nn-color-text-muted);
    }

    .server-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
    }

    .server-dot.is-on {
        background: var(--nn-color-text-success);
        box-shadow: 0 0 0 3px var(--nn-color-bg-success-subtle);
    }

    .workspace-actions {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
    }

    .toolbar-spacer {
        flex: 1;
    }

    @media (max-width: 1100px) {
        .workspace-toolbar {
            flex-wrap: wrap;
        }

        .url-bar {
            flex-basis: 100%;
            order: 3;
        }
    }

    /* ------------------------------------------------------------ 三栏 */
    .workspace-layout {
        display: grid;
        flex: 1;
        min-height: 0;
        grid-template-columns: minmax(230px, 22%) minmax(320px, 1fr) minmax(360px, 42%);
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
        min-height: 40px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 8px;
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
        flex: 0 0 auto;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
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
        width: 130px;
    }

    .panel-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
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

    /* ------------------------------------------------------------ 面板内 Tab */
    .panel-tabs {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    :deep(.panel-tabs > .nn-tabs-nav) {
        flex: 0 0 auto;
        margin: 0;
        padding: 0 8px;
        background: var(--nn-color-bg-muted);
    }

    :deep(.panel-tabs > .nn-tabs-nav .nn-tabs-tab) {
        padding: 9px 0;
        font-size: 12px;
    }

    :deep(.panel-tabs .nn-tabs-content-holder) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.panel-tabs .nn-tabs-content),
    :deep(.panel-tabs .nn-tabs-tabpane) {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .tab-hint {
        margin-left: 4px;
        color: var(--nn-color-text-muted);
        font-family: var(--nn-font-mono, monospace);
        font-size: 10px;
    }

    .panel-tabs .tab-badge {
        min-width: 16px;
        height: 16px;
        margin-left: 4px;
        padding: 0 5px;
        border-radius: 8px;
        background: var(--nn-color-text-muted);
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        vertical-align: middle;
    }

    :deep(.panel-tabs .nn-tabs-tab-active .tab-badge) {
        background: var(--nn-color-primary);
    }

    .tab-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-left: 4px;
        border-radius: 50%;
        background: var(--nn-color-text-success);
        vertical-align: middle;
    }

    .tab-toolbar {
        display: flex;
        min-height: 34px;
        flex: 0 0 auto;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .tab-toolbar-bottom {
        border-top: 1px solid var(--nn-color-border-light);
        border-bottom: 0;
    }

    .tab-editor {
        min-height: 0;
        flex: 1;
        padding: 6px;
    }

    .tab-editor :deep(.nn-textarea),
    .tab-editor :deep(textarea) {
        height: 100%;
        font-family: var(--nn-font-mono, monospace);
        font-size: 12px;
    }

    .tab-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 8px;
    }

    .section-title {
        margin: 12px 0 6px;
        color: var(--nn-color-text-strong);
        font-size: 12px;
        font-weight: 600;
    }

    .form-note {
        margin-left: 8px;
    }

    .reply-select {
        flex: 1;
        min-width: 0;
    }

    .error-text {
        color: var(--nn-color-error, #d4380d);
        font-size: 12px;
    }

    /* ------------------------------------------------------------ 方法类型标签 */
    .method-kind {
        flex: 0 0 auto;
        padding: 0 4px;
        border-radius: 3px;
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-info-subtle);
        font-family: var(--nn-font-mono, monospace);
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        letter-spacing: 0.02em;
        white-space: nowrap;
    }

    .method-kind.is-unary {
        color: var(--nn-color-text-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .method-kind.is-server-stream,
    .method-kind.is-client-stream,
    .method-kind.is-bidi-stream {
        color: var(--nn-color-primary);
        background: var(--nn-color-bg-warning-subtle);
    }

    /* ------------------------------------------------------------ 树 */
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

    /* ------------------------------------------------------------ 历史 */
    .history-item {
        padding: 6px 8px;
        border: 1px solid transparent;
        border-radius: 4px;
        margin-bottom: 4px;
        cursor: pointer;
    }

    .history-item:hover {
        background: var(--nn-color-bg-muted);
    }

    .history-item.is-active {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-bg-info-subtle);
    }

    .history-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
    }

    .history-name {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-family: var(--nn-font-mono, monospace);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .history-status {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 600;
    }

    .history-sub {
        display: flex;
        justify-content: space-between;
        gap: 6px;
        margin-top: 2px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .history-sub span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .is-ok {
        color: var(--nn-color-text-success);
    }

    .is-error {
        color: var(--nn-color-error, #d4380d);
    }

    .is-pending {
        color: var(--nn-color-primary);
    }

    /* ------------------------------------------------------------ 键值编辑 */
    .kv-grid {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    :deep(.kv-row) {
        display: grid;
        grid-template-columns: 22px 1fr 1.4fr auto;
        gap: 6px;
        align-items: center;
    }

    :deep(.kv-row-rule) {
        grid-template-columns: 1.4fr 0.7fr 1.4fr auto;
    }

    :deep(.kv-head) {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    :deep(.kv-add) {
        margin-top: 6px;
        align-self: flex-start;
    }

    .kv-note {
        margin-top: 8px;
        white-space: normal;
    }

    .kv-note code {
        font-family: var(--nn-font-mono, monospace);
    }

    .kv-table {
        display: flex;
        flex-direction: column;
        font-size: 12px;
    }

    :deep(.kv-table-row) {
        display: grid;
        grid-template-columns: minmax(120px, 0.6fr) 1fr;
        gap: 8px;
        padding: 5px 4px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    :deep(.kv-table-key) {
        color: var(--nn-color-text-strong);
        font-family: var(--nn-font-mono, monospace);
        word-break: break-all;
    }

    :deep(.kv-table-value) {
        font-family: var(--nn-font-mono, monospace);
        word-break: break-all;
    }

    /* ------------------------------------------------------------ 活动流 */
    .stream-list {
        padding: 6px;
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

    .stream-item {
        padding: 6px 8px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        margin-bottom: 6px;
        cursor: pointer;
    }

    .stream-item:hover {
        background: var(--nn-color-bg-muted);
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

    /* ------------------------------------------------------------ 响应 */
    .status-bar {
        display: flex;
        min-height: 32px;
        flex: 0 0 auto;
        align-items: center;
        gap: 10px;
        overflow: hidden;
        padding: 4px 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
        font-size: 12px;
    }

    .status-code {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .status-item {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text);
        font-variant-numeric: tabular-nums;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .status-item-fixed {
        flex: 0 0 auto;
    }

    .status-bar > .panel-tag,
    .status-bar > .status-code,
    .status-bar > .nn-btn {
        flex: 0 0 auto;
    }

    .status-detail {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-error, #d4380d);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .timeline {
        padding: 0;
    }

    .timeline-item {
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .timeline-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        font-size: 12px;
        cursor: pointer;
    }

    .timeline-head:hover {
        background: var(--nn-color-bg-muted);
    }

    .timeline-caret {
        width: 10px;
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
    }

    .timeline-dir {
        flex: 0 0 auto;
        min-width: 28px;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-align: center;
    }

    .timeline-dir.is-in {
        color: var(--nn-color-text-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .timeline-dir.is-out {
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-info-subtle);
    }

    .timeline-time,
    .timeline-size {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .timeline-status {
        flex: 0 0 auto;
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
        padding: 4px 10px 8px 24px;
        background: var(--nn-color-bg-surface);
    }

    .timeline-detail-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 4px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .timeline-warning {
        margin-bottom: 6px;
    }

    .timeline-raw {
        margin-top: 6px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .timeline-raw summary {
        cursor: pointer;
        user-select: none;
    }

    .timeline-raw-hex {
        max-height: 120px;
        margin-top: 4px;
        overflow: auto;
        font-family: var(--nn-font-mono, monospace);
        word-break: break-all;
    }

    /* ------------------------------------------------------------ 右键菜单 */
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
