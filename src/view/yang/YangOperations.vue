<template>
    <div
        class="yang-operations-page"
        :class="{
            'nn-container': !embedded,
            'yang-operations-embedded': embedded,
            'yang-operations-resizing': requestPaneResizing,
            'yang-operations-parameter-resizing': parameterPaneResizing
        }"
        @click="hideParameterContextMenu()"
    >
        <div v-if="!embedded" class="operation-session-bar">
            <div class="session-summary">
                <span class="session-indicator" :class="{ 'session-indicator-online': connected }" />
                <div>
                    <div class="session-title">{{ connected ? 'NETCONF 会话已连接' : 'NETCONF 会话未连接' }}</div>
                    <div class="session-detail">
                        <template v-if="connected">
                            Session {{ session.sessionId || '-' }} ·
                            {{ session.profileName || session.host || '设备' }}
                        </template>
                        <template v-else>建立连接后才能执行设备操作</template>
                    </div>
                </div>
            </div>
            <nn-space>
                <nn-tag v-if="connected" color="success">
                    NETCONF {{ session.baseVersion || session.version || '1.x' }}
                </nn-tag>
                <nn-button v-if="!connected" type="primary" @click="goToConnections">前往连接设置</nn-button>
                <nn-button :loading="sessionLoading" @click="loadSession">
                    <template #icon><ReloadOutlined /></template>
                    刷新状态
                </nn-button>
            </nn-space>
        </div>

        <div
            ref="operationsLayoutRef"
            class="operations-layout"
            :class="{
                'operations-layout-embedded': embedded,
                'operations-layout-parameters-collapsed': embedded && requestOptionsCollapsed
            }"
            :style="operationsLayoutStyle"
        >
            <nn-card v-if="!embedded" title="操作" class="operation-nav-card">
                <div class="operation-nav">
                    <div class="operation-group-title">读取</div>
                    <template v-for="operationItem in readOperations" :key="operationItem.key">
                        <nn-tooltip :title="operationDisabledReason(operationItem.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operationItem.key }"
                                    :disabled="executing || !isOperationSupported(operationItem.key)"
                                    @click="activeOperation = operationItem.key"
                                >
                                    <span>{{ operationItem.label }}</span>
                                    <span class="operation-kind">READ</span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>

                    <div class="operation-group-title">配置与事务</div>
                    <template v-for="operationItem in writeOperations" :key="operationItem.key">
                        <nn-tooltip :title="operationDisabledReason(operationItem.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operationItem.key }"
                                    :disabled="executing || !isOperationSupported(operationItem.key)"
                                    @click="activeOperation = operationItem.key"
                                >
                                    <span>{{ operationItem.label }}</span>
                                    <span :class="['operation-kind', `operation-kind-${operationItem.category}`]">
                                        {{ operationItem.category === 'danger' ? 'RISK' : 'WRITE' }}
                                    </span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>

                    <div class="operation-group-title">高级</div>
                    <template v-for="operationItem in advancedOperations" :key="operationItem.key">
                        <nn-tooltip :title="operationDisabledReason(operationItem.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operationItem.key }"
                                    :disabled="executing || !isOperationSupported(operationItem.key)"
                                    @click="activeOperation = operationItem.key"
                                >
                                    <span>{{ operationItem.label }}</span>
                                    <span class="operation-kind operation-kind-danger">RAW</span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>
                </div>
            </nn-card>

            <div :class="embedded ? 'operations-message-stack' : 'operations-message-contents'">
                <nn-card class="operation-form-card operation-request-card">
                    <template #title>
                        <span class="operation-form-title">
                            {{ embedded ? `RPC 请求 · ${activeOperationMeta.label}` : activeOperationMeta.label }}
                            <nn-tag
                                :color="
                                    requestOverrideActive
                                        ? 'warning'
                                        : activeOperationMeta.category === 'read'
                                          ? 'blue'
                                          : 'warning'
                                "
                            >
                                {{
                                    requestOverrideActive
                                        ? '手工编辑'
                                        : activeOperationMeta.category === 'read'
                                          ? '只读'
                                          : '需要确认'
                                }}
                            </nn-tag>
                        </span>
                    </template>
                    <div v-if="embedded" class="request-browser-toolbar">
                        <span class="request-browser-label">RPC 报文</span>
                        <nn-space class="request-browser-actions" :size="4">
                            <nn-button
                                class="request-regenerate-action"
                                size="small"
                                :disabled="
                                    !requestOverrideActive || executing || editConfigLoading || requestValidating
                                "
                                @click="restoreGeneratedRequest"
                            >
                                参数生成
                            </nn-button>
                            <nn-button
                                class="request-toolbar-action"
                                size="small"
                                :disabled="executing || editConfigLoading || requestValidating"
                                @click="formatRequestXml"
                            >
                                格式化
                            </nn-button>
                            <nn-button
                                class="request-toolbar-action"
                                size="small"
                                :disabled="executing || editConfigLoading || requestValidating"
                                :loading="requestValidating"
                                @click="validateRequestEditor"
                            >
                                验证
                            </nn-button>
                            <nn-button
                                class="request-copy-action"
                                size="small"
                                :disabled="!currentRequestXml"
                                @click="copyRequestXml"
                            >
                                复制请求
                            </nn-button>
                        </nn-space>
                    </div>

                    <XmlCodeEditor
                        v-if="embedded"
                        :value="currentRequestXml"
                        :status="requestValidation.status"
                        :diagnostics="requestValidation.diagnostics"
                        :disabled="executing || editConfigLoading"
                        :rows="8"
                        line-numbers
                        class="rpc-request-preview rpc-request-editor"
                        aria-label="RPC 请求 XML"
                        :aria-invalid="requestValidation.status === 'error' ? 'true' : 'false'"
                        @update:value="handleRequestEditorInput"
                    />
                    <nn-form
                        v-else
                        :model="form"
                        layout="horizontal"
                        :label-col="labelCol"
                        :disabled="executing || editConfigLoading"
                        :inert="executing || editConfigLoading ? '' : undefined"
                        class="operation-form"
                    >
                        <template v-if="activeOperation === 'get' || activeOperation === 'get-config'">
                            <nn-form-item v-if="activeOperation === 'get-config'" label="源 datastore" required>
                                <nn-select v-model:value="form.source" :options="readDatastoreOptions" />
                            </nn-form-item>
                            <nn-form-item label="过滤类型">
                                <nn-select v-model:value="form.filterType" :options="filterTypeOptions" />
                            </nn-form-item>
                            <nn-form-item v-if="form.filterType === 'xpath'" label="XPath" required>
                                <nn-input
                                    v-model:value="form.xpath"
                                    placeholder="例如：/interfaces/interface[name='eth0']"
                                />
                            </nn-form-item>
                            <nn-form-item v-if="form.filterType === 'subtree'" label="Subtree" required>
                                <XmlCodeEditor
                                    v-model:value="form.subtree"
                                    :rows="10"
                                    placeholder='输入过滤内容，例如 <interfaces xmlns="..."><interface/></interfaces>'
                                    class="xml-editor"
                                />
                            </nn-form-item>
                        </template>

                        <template v-else-if="activeOperation === 'edit-config'">
                            <nn-row :gutter="12">
                                <nn-col :span="12">
                                    <nn-form-item label="目标 datastore" required>
                                        <nn-select v-model:value="form.target" :options="editDatastoreOptions" />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12">
                                    <nn-form-item label="default-operation">
                                        <nn-select
                                            v-model:value="form.defaultOperation"
                                            :options="defaultOperationOptions"
                                        />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>
                            <nn-row :gutter="12">
                                <nn-col :span="12">
                                    <nn-form-item label="test-option">
                                        <nn-select
                                            v-model:value="form.testOption"
                                            :options="testOptionOptions"
                                            :disabled="!supportsTestOption"
                                        />
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="12">
                                    <nn-form-item label="error-option">
                                        <nn-select v-model:value="form.errorOption" :options="errorOptionOptions" />
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>
                            <nn-form-item label="config XML" required>
                                <XmlCodeEditor
                                    v-model:value="form.config"
                                    :rows="15"
                                    placeholder="输入 <config> 内容；支持命名空间与 nc:operation 属性"
                                    class="xml-editor xml-editor-large"
                                />
                            </nn-form-item>
                            <nn-alert
                                v-if="form.config.includes('NETNEXUS_REQUIRED')"
                                type="warning"
                                show-icon
                                message="XML 草稿还不能执行"
                                description="请替换所有 NETNEXUS_REQUIRED 占位注释，并为每个祖先 list 填写完整 key。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'copy-config'">
                            <nn-form-item label="源 datastore" required>
                                <nn-select v-model:value="form.copySource" :options="readDatastoreOptions" />
                            </nn-form-item>
                            <nn-form-item label="目标 datastore" required>
                                <nn-select v-model:value="form.copyTarget" :options="copyTargetDatastoreOptions" />
                            </nn-form-item>
                        </template>

                        <template v-else-if="activeOperation === 'delete-config'">
                            <nn-form-item label="目标 datastore" required>
                                <nn-select v-model:value="form.deleteTarget" :options="deletableDatastoreOptions" />
                            </nn-form-item>
                            <nn-alert
                                type="warning"
                                show-icon
                                message="高风险操作"
                                description="标准 delete-config 只删除整个 startup datastore，不是删除当前 Schema 节点。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'lock' || activeOperation === 'unlock'">
                            <nn-form-item label="目标 datastore" required>
                                <nn-select v-model:value="form.lockTarget" :options="lockDatastoreOptions" />
                            </nn-form-item>
                            <nn-alert
                                type="info"
                                show-icon
                                :message="activeOperation === 'lock' ? '锁定配置存储' : '解除配置存储锁定'"
                                :description="
                                    activeOperation === 'lock'
                                        ? '锁定成功后，其他 NETCONF 会话将无法修改该 datastore。'
                                        : '只应解除由当前会话持有的锁。'
                                "
                            />
                        </template>

                        <template v-else-if="activeOperation === 'validate'">
                            <nn-form-item label="校验源" required>
                                <nn-select v-model:value="form.validateSource" :options="readDatastoreOptions" />
                            </nn-form-item>
                            <nn-alert
                                type="info"
                                show-icon
                                message="服务端校验"
                                description="设备将依据自身 Schema、约束和当前配置校验选定 datastore。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'commit'">
                            <nn-form-item label="Confirmed Commit">
                                <nn-checkbox
                                    v-model:checked="form.confirmed"
                                    :disabled="!hasCapability('confirmedCommit')"
                                >
                                    使用 confirmed-commit
                                </nn-checkbox>
                            </nn-form-item>
                            <nn-form-item v-if="form.confirmed" label="确认超时">
                                <nn-input-number
                                    v-model:value="form.confirmTimeout"
                                    :min="1"
                                    :max="3600"
                                    addon-after="秒"
                                    style="width: 220px"
                                />
                            </nn-form-item>
                            <nn-alert
                                type="warning"
                                show-icon
                                message="提交 candidate"
                                description="commit 将 candidate 中的修改应用到 running。执行前请确认配置和连接可恢复性。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'discard-changes'">
                            <nn-alert
                                type="warning"
                                show-icon
                                message="放弃 candidate 修改"
                                description="discard-changes 会将 candidate 恢复为 running 当前内容，未提交修改会丢失。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'cancel-commit'">
                            <nn-alert
                                type="warning"
                                show-icon
                                message="取消 confirmed commit"
                                description="cancel-commit 会取消当前会话尚未确认的 confirmed commit；设备没有待确认提交时会返回 rpc-error。"
                            />
                        </template>

                        <template v-else-if="activeOperation === 'raw-rpc'">
                            <nn-form-item label="RPC XML" required>
                                <XmlCodeEditor
                                    v-model:value="form.rawRpc"
                                    :rows="18"
                                    placeholder="输入完整 <rpc>，或输入 rpc 内部的操作元素"
                                    class="xml-editor xml-editor-raw"
                                />
                            </nn-form-item>
                            <nn-alert
                                type="warning"
                                show-icon
                                message="原始 RPC 不受 Schema 表单保护"
                                :description="
                                    form.rawRpc.includes('NETNEXUS_REQUIRED')
                                        ? '请先补全或移除 NETNEXUS_REQUIRED 参数占位，再检查命名空间和操作影响。'
                                        : '请检查命名空间、目标 datastore 与操作影响；发送前会再次确认。'
                                "
                            />
                        </template>
                    </nn-form>

                    <div class="operation-footer">
                        <nn-space>
                            <nn-button v-if="!embedded" @click="previewOpen = true">
                                <template #icon><EyeOutlined /></template>
                                请求预览
                            </nn-button>
                            <nn-tooltip :title="executeDisabledReason">
                                <span class="operation-execute-wrap">
                                    <nn-button
                                        type="primary"
                                        :danger="requestOverrideActive || activeOperationMeta.category === 'danger'"
                                        :loading="executing || requestValidating"
                                        :disabled="Boolean(executeDisabledReason)"
                                        @click="requestExecute"
                                    >
                                        <template #icon><SendOutlined /></template>
                                        {{
                                            requestOverrideActive ? '发送手工 RPC' : `执行 ${activeOperationMeta.label}`
                                        }}
                                    </nn-button>
                                </span>
                            </nn-tooltip>
                        </nn-space>
                        <span class="confirmation-hint">
                            {{
                                requestOverrideActive
                                    ? '手工报文发送前需要二次确认'
                                    : activeOperationMeta.category === 'read'
                                      ? '只读操作将直接发送'
                                      : '发送前需要二次确认'
                            }}
                        </span>
                    </div>
                </nn-card>

                <div
                    v-if="embedded"
                    class="operations-row-resizer"
                    role="separator"
                    aria-label="调整 RPC 请求和响应高度"
                    aria-orientation="horizontal"
                    :aria-valuemin="requestPaneMinHeight"
                    :aria-valuemax="requestPaneMaxHeight"
                    :aria-valuenow="requestPaneHeight"
                    tabindex="0"
                    title="拖动调整 RPC 请求和响应高度；双击恢复默认高度"
                    @pointerdown="startRequestPaneResize"
                    @keydown="handleRequestPaneResizeKeydown"
                    @dblclick="resetRequestPaneResize"
                >
                    <span class="pane-resizer-grip" aria-hidden="true" />
                </div>

                <nn-card :title="embedded ? 'RPC 响应' : 'RPC 结果'" class="operation-result-card">
                    <template #extra>
                        <nn-space>
                            <nn-tag v-if="result.status" :color="result.status === 'success' ? 'success' : 'error'">
                                {{ result.status === 'success' ? '成功' : '失败' }}
                            </nn-tag>
                            <span v-if="result.duration !== null" class="result-duration">
                                {{ result.duration }} ms
                            </span>
                        </nn-space>
                    </template>

                    <div v-if="result.status" class="result-browser-toolbar">
                        <div class="result-summary">
                            <span>{{ result.operation }}</span>
                            <span>{{ result.time }}</span>
                            <span v-if="result.messageId">message-id: {{ result.messageId }}</span>
                        </div>
                        <nn-space>
                            <nn-button class="xml-display-toggle" size="small" @click="toggleReplyDisplayMode">
                                {{ replyDisplayMode === 'formatted' ? '查看原文' : '格式化' }}
                            </nn-button>
                            <nn-button size="small" @click="copyReplyXml">复制响应</nn-button>
                            <nn-button size="small" @click="clearResult">清空</nn-button>
                        </nn-space>
                    </div>
                    <XmlCodeEditor
                        v-if="result.reply"
                        :value="displayedReplyXml"
                        :rows="8"
                        readonly
                        line-numbers
                        :bordered="false"
                        class="rpc-result"
                        :class="{ 'rpc-result-error': result.status === 'error' }"
                        aria-label="RPC 响应 XML"
                    />
                    <nn-empty v-else description="执行操作后在这里查看 rpc-reply" />
                </nn-card>
            </div>

            <div
                v-if="embedded && !requestOptionsCollapsed"
                class="operations-column-resizer"
                role="separator"
                aria-label="调整操作参数宽度"
                aria-orientation="vertical"
                :aria-valuemin="parameterPaneMinWidth"
                :aria-valuemax="parameterPaneMaxWidth"
                :aria-valuenow="parameterPaneWidth"
                tabindex="0"
                title="拖动调整操作参数宽度；双击恢复默认宽度"
                @pointerdown="startParameterPaneResize"
                @keydown="handleParameterPaneResizeKeydown"
                @dblclick="resetParameterPaneResize"
            >
                <span class="pane-resizer-grip" aria-hidden="true" />
            </div>

            <aside
                v-if="embedded"
                id="rpc-request-options"
                class="operation-parameters-panel"
                :class="{ 'operation-parameters-panel-collapsed': requestOptionsCollapsed }"
                aria-label="操作参数"
            >
                <button
                    v-if="requestOptionsCollapsed"
                    type="button"
                    class="operation-parameters-rail"
                    aria-label="展开操作参数"
                    aria-controls="rpc-request-options-tree"
                    aria-expanded="false"
                    @click="requestOptionsCollapsed = false"
                >
                    <span>操作参数</span>
                </button>
                <template v-else>
                    <div class="operation-parameters-header">
                        <div class="operation-parameters-heading">
                            <span class="operation-parameters-title">操作参数树</span>
                            <span class="operation-parameters-operation">{{ activeOperationMeta.label }}</span>
                        </div>
                        <div class="operation-parameters-actions">
                            <nn-button
                                size="small"
                                :disabled="executing || editConfigLoading"
                                @click="resetOperationParameters"
                            >
                                重置
                            </nn-button>
                            <nn-button
                                size="small"
                                aria-controls="rpc-request-options-tree"
                                aria-expanded="true"
                                @click="requestOptionsCollapsed = true"
                            >
                                隐藏
                            </nn-button>
                        </div>
                    </div>

                    <div v-if="activeOperation === 'edit-config'" class="edit-config-readback-bar">
                        <div class="edit-config-readback-status">
                            <nn-tag :color="editConfigReadbackMeta.color">
                                {{ editConfigReadbackMeta.label }}
                            </nn-tag>
                            <span>{{ editConfigReadbackMeta.description }}</span>
                        </div>
                        <nn-button
                            size="small"
                            :loading="editConfigLoading"
                            :disabled="executing || !props.contextSubtree"
                            @click="reloadEditConfig"
                        >
                            {{ editConfigReloadLabel }}
                        </nn-button>
                    </div>

                    <div
                        id="rpc-request-options-tree"
                        class="operation-parameters-tree-scroll"
                        :inert="executing || editConfigLoading ? '' : undefined"
                    >
                        <nn-tree
                            v-model:expanded-keys="parameterExpandedKeys"
                            v-model:selected-keys="parameterSelectedKeys"
                            :tree-data="operationParameterTree"
                            block-node
                            aria-label="操作参数树"
                            @keydown.capture="handleParameterTreeKeydown"
                            @right-click="handleParameterTreeRightClick"
                        >
                            <template #title="node">
                                <span
                                    class="schema-node-title operation-schema-node-title"
                                    :data-parameter-path="node.parameterPath"
                                    :data-parameter-invalid="
                                        node.required && !String(parameterNodeValue(node) ?? '').trim()
                                            ? 'true'
                                            : undefined
                                    "
                                >
                                    <span
                                        class="schema-node-icon"
                                        :class="`schema-node-icon-${parameterNodeIconKind(node)}`"
                                        :data-node-icon="parameterNodeIconKind(node)"
                                        aria-hidden="true"
                                    >
                                        <component :is="parameterNodeIconComponent(node)" :stroke-width="1.8" />
                                    </span>
                                    <span class="schema-node-name">{{ node.title }}</span>
                                    <span class="schema-node-keyword">{{ parameterKindLabel(node) }}</span>
                                    <span v-if="node.required" class="schema-node-access schema-node-state">必填</span>
                                    <span
                                        v-if="parameterNodeHasDisplayValue(node)"
                                        class="schema-node-module operation-parameter-value-summary"
                                        :title="String(parameterNodeValue(node))"
                                    >
                                        {{ parameterNodeDisplayValue(node) }}
                                    </span>
                                </span>
                            </template>
                        </nn-tree>
                    </div>
                </template>
            </aside>
        </div>

        <div
            v-if="parameterContextMenu.visible"
            ref="parameterContextMenuRef"
            class="operation-parameter-context-menu"
            :style="{ left: parameterContextMenu.x + 'px', top: parameterContextMenu.y + 'px' }"
            @click.stop
        >
            <div class="operation-parameter-context-menu-title">
                <span>{{ parameterContextMenu.node?.title || '参数节点' }}</span>
                <span>{{ parameterKindLabel(parameterContextMenu.node || {}) }}</span>
            </div>
            <div class="operation-parameter-context-menu-path" :title="parameterContextMenu.node?.parameterPath">
                {{ parameterContextMenu.node?.parameterPath || '/rpc' }}
            </div>
            <nn-menu
                class="operation-parameter-context-menu-list"
                :selectable="false"
                @click="handleParameterContextMenuClick"
            >
                <nn-menu-item key="add-child" :disabled="!parameterContextCapabilities.addChild">
                    <template #icon><PlusOutlined /></template>
                    添加子节点
                </nn-menu-item>
                <nn-menu-item key="add-sibling" :disabled="!parameterContextCapabilities.addSibling">
                    <template #icon><PlusOutlined /></template>
                    添加同级节点
                </nn-menu-item>
                <nn-menu-item key="add-attribute" :disabled="!parameterContextCapabilities.addAttribute">
                    <template #icon><CodeOutlined /></template>
                    添加属性
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item key="edit-value" :disabled="!parameterContextCapabilities.edit">
                    <template #icon><EditOutlined /></template>
                    修改值
                </nn-menu-item>
                <nn-menu-item key="remove-node" :disabled="!parameterContextCapabilities.remove">
                    <template #icon><DeleteOutlined /></template>
                    移除节点
                </nn-menu-item>
            </nn-menu>
            <div class="operation-parameter-context-menu-hint">
                {{ parameterContextMenuHint }}
            </div>
        </div>

        <nn-modal v-model:open="parameterActionOpen" :title="parameterActionTitle" :footer="null" width="520px">
            <nn-spin :spinning="parameterActionLoading">
                <nn-form layout="vertical" class="operation-parameter-action-form">
                    <template v-if="parameterAction.mode === 'edit-value'">
                        <nn-form-item label="节点值" required>
                            <nn-select
                                v-if="parameterAction.node?.editor === 'select'"
                                :value="parameterAction.value"
                                :options="parameterAction.node?.options || []"
                                aria-label="节点值"
                                :aria-invalid="
                                    parameterAction.node?.required && !String(parameterAction.value ?? '').trim()
                                        ? 'true'
                                        : undefined
                                "
                                @update:value="value => (parameterAction.value = value)"
                            />
                            <nn-input-number
                                v-else-if="parameterAction.node?.editor === 'number'"
                                :value="parameterAction.value"
                                :min="parameterAction.node?.min"
                                :max="parameterAction.node?.max"
                                aria-label="节点值"
                                @update:value="value => (parameterAction.value = value)"
                            />
                            <nn-checkbox
                                v-else-if="parameterAction.node?.editor === 'checkbox'"
                                :checked="Boolean(parameterAction.value)"
                                aria-label="节点值"
                                @update:checked="value => (parameterAction.value = value)"
                            >
                                {{ parameterAction.value ? '启用' : '未启用' }}
                            </nn-checkbox>
                            <XmlCodeEditor
                                v-else-if="parameterAction.node?.editor === 'textarea'"
                                :value="String(parameterAction.value ?? '')"
                                :rows="10"
                                aria-label="节点值"
                                @update:value="value => (parameterAction.value = value)"
                            />
                            <nn-input
                                v-else
                                :value="String(parameterAction.value ?? '')"
                                :placeholder="parameterAction.node?.placeholder || '输入节点值'"
                                aria-label="节点值"
                                :aria-invalid="
                                    parameterAction.node?.required && !String(parameterAction.value ?? '').trim()
                                        ? 'true'
                                        : undefined
                                "
                                @update:value="value => (parameterAction.value = value)"
                            />
                        </nn-form-item>
                    </template>
                    <template v-else>
                        <nn-form-item v-if="parameterAction.schemaOptions.length" label="Schema 节点" required>
                            <nn-select
                                :value="parameterAction.schemaKey"
                                :options="parameterAction.schemaOptions"
                                aria-label="Schema 节点"
                                @update:value="selectParameterSchemaCandidate"
                            />
                        </nn-form-item>
                        <nn-form-item v-else-if="!parameterAction.schemaRestricted" label="节点名称" required>
                            <nn-input
                                :value="parameterAction.name"
                                placeholder="例如 interface 或 nc:operation"
                                aria-label="节点名称"
                                @update:value="value => (parameterAction.name = value)"
                            />
                        </nn-form-item>
                        <nn-alert
                            v-else
                            type="info"
                            show-icon
                            message="没有可添加的 Schema 节点"
                            description="当前父节点的单实例子节点已存在，或 Schema 没有可用的配置子节点。"
                        />
                        <nn-form-item label="命名空间">
                            <nn-input
                                :value="parameterAction.namespace"
                                :placeholder="
                                    parameterAction.mode === 'add-attribute'
                                        ? 'nc: 前缀会自动使用 NETCONF 命名空间'
                                        : '留空表示无命名空间'
                                "
                                aria-label="节点命名空间"
                                @update:value="value => (parameterAction.namespace = value)"
                            />
                        </nn-form-item>
                        <nn-form-item v-if="parameterActionAcceptsValue" label="初始值">
                            <nn-input
                                :value="String(parameterAction.value ?? '')"
                                placeholder="可留空"
                                aria-label="节点初始值"
                                @update:value="value => (parameterAction.value = value)"
                            />
                        </nn-form-item>
                    </template>
                </nn-form>
            </nn-spin>
            <div class="operation-parameter-action-footer">
                <nn-button @click="closeParameterAction">取消</nn-button>
                <nn-button type="primary" :disabled="parameterActionLoading" @click="confirmParameterAction">
                    确认
                </nn-button>
            </div>
        </nn-modal>

        <nn-modal
            v-model:open="confirmationOpen"
            :title="requestOverrideActive ? '确认发送手工 RPC' : `确认执行 ${activeOperationMeta.label}`"
            :footer="null"
            width="520px"
            :z-index="1300"
        >
            <nn-alert
                :type="requestOverrideActive || activeOperationMeta.category === 'danger' ? 'warning' : 'info'"
                show-icon
                :message="confirmationDescription"
                description="请再次确认目标设备、datastore 和参数无误。"
            />
            <div class="operation-confirmation-footer">
                <nn-button @click="confirmationOpen = false">取消</nn-button>
                <nn-button
                    type="primary"
                    :danger="requestOverrideActive || activeOperationMeta.category === 'danger'"
                    :loading="executing || requestValidating"
                    :disabled="requestValidating"
                    @click="confirmAndExecute"
                >
                    确认执行
                </nn-button>
            </div>
        </nn-modal>

        <nn-modal
            v-if="!embedded"
            v-model:open="previewOpen"
            :title="`${activeOperationMeta.label} 请求预览`"
            :footer="null"
            width="820px"
        >
            <pre class="rpc-preview" data-xml-viewer><XmlHighlight :value="displayedRequestXml" /></pre>
        </nn-modal>
    </div>
</template>

<script setup>
    import {
        computed,
        nextTick,
        onActivated,
        onBeforeUnmount,
        onDeactivated,
        onMounted,
        reactive,
        ref,
        watch
    } from 'vue';
    import { useRouter } from 'vue-router';
    import {
        NETCONF_CAPABILITY_HINTS,
        NETCONF_FILTER_TYPE_OPTIONS,
        NETCONF_OPERATIONS,
        NETCONF_SESSION_STATUS,
        YANG_EVENT,
        YANG_EVENT_PAGE_ID,
        YANG_ROUTE
    } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { notify } from '../../utils/notify';
    import {
        ApiOutlined,
        CodeOutlined,
        DeleteOutlined,
        EditOutlined,
        EyeOutlined,
        FileSearchOutlined,
        FileTextOutlined,
        FolderOpenOutlined,
        FolderOutlined,
        KeyOutlined,
        PlusOutlined,
        ReloadOutlined,
        SendOutlined,
        UnorderedListOutlined
    } from '../../ui/icons';
    import XmlCodeEditor from './XmlCodeEditor.vue';
    import XmlHighlight from './XmlHighlight.vue';
    import { validateNetconfRpc } from './netconfRpcValidation';
    import {
        clonePlain,
        formatXmlForDisplay,
        invokeBridge,
        normalizeCapability,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';
    import { beginNetconfExecution, completeNetconfExecution } from './useNetconfExecutionHistory';
    import { usePaneResize } from './usePaneResize';

    defineOptions({ name: 'YangOperations' });

    const emit = defineEmits(['executing-change']);

    const props = defineProps({
        profileId: {
            type: String,
            default: ''
        },
        embedded: {
            type: Boolean,
            default: false
        },
        operation: {
            type: String,
            default: 'get'
        },
        compileId: {
            type: String,
            default: ''
        },
        schemaTree: {
            type: Array,
            default: () => []
        },
        contextNode: {
            type: Object,
            default: null
        },
        contextSubtree: {
            type: String,
            default: ''
        },
        contextConfig: {
            type: String,
            default: ''
        },
        contextRawRpc: {
            type: String,
            default: ''
        },
        contextParams: {
            type: Object,
            default: () => ({})
        },
        contextRevision: {
            type: Number,
            default: 0
        }
    });

    const router = useRouter();
    const labelCol = { style: { width: '132px' } };
    const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
    const DEFAULT_RAW_RPC = '<get>\n  <filter type="subtree">\n    <!-- subtree filter -->\n  </filter>\n</get>';
    const PARAMETER_CONTEXT_MENU_MARGIN = 8;
    const PARAMETER_DATA_NODE_KEYWORDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
    const PARAMETER_SCHEMA_BRANCH_KEYWORDS = new Set(['choice', 'case', 'input']);
    const PARAMETER_NODE_ICONS = Object.freeze({
        operation: ApiOutlined,
        container: FolderOutlined,
        list: UnorderedListOutlined,
        key: KeyOutlined,
        leaf: FileTextOutlined,
        state: EyeOutlined,
        attribute: CodeOutlined,
        fallback: FileSearchOutlined
    });
    const operationsLayoutRef = ref(null);
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
        minFirst: 260,
        minSecond: 200,
        dividerSize: 8
    });
    const activeOperation = ref('get');
    const sessionLoading = ref(false);
    const executing = ref(false);
    const session = ref({ status: NETCONF_SESSION_STATUS.DISCONNECTED, capabilities: [] });
    const confirmationOpen = ref(false);
    const previewOpen = ref(false);
    const requestOptionsCollapsed = ref(false);
    const parameterExpandedKeys = ref([]);
    const parameterSelectedKeys = ref([]);
    const parameterContextMenuRef = ref(null);
    const parameterContextMenu = reactive({ visible: false, x: 0, y: 0, node: null, parent: null });
    const parameterActionOpen = ref(false);
    const parameterActionLoading = ref(false);
    const parameterAction = reactive({
        mode: '',
        node: null,
        value: '',
        name: '',
        namespace: '',
        schemaKey: '',
        schemaOptions: [],
        schemaCandidates: [],
        schemaNode: null,
        schemaRestricted: false,
        contextRevision: 0,
        operation: ''
    });
    let parameterContextMenuOpenRequest = 0;
    let parameterActionOpenRequest = 0;
    let parameterSchemaRequestRevision = 0;
    let parameterContextMenuTrigger = null;
    const parameterSchemaChildrenCache = new Map();
    const parameterDiscoveredSchemaNodes = ref([]);
    const {
        paneSize: parameterPaneWidth,
        minSize: parameterPaneMinWidth,
        maxSize: parameterPaneMaxWidth,
        resizing: parameterPaneResizing,
        startResize: startParameterPaneResize,
        handleResizeKeydown: handleParameterPaneResizeKeydown,
        resetResize: resetParameterPaneResize,
        stopResize: stopParameterPaneResize,
        updateBounds: updateParameterPaneBounds
    } = usePaneResize({
        containerRef: operationsLayoutRef,
        orientation: 'vertical',
        reverse: true,
        defaultRatio: 0.32,
        minFirst: 280,
        minSecond: 320,
        dividerSize: 8,
        activeWhen: () => props.embedded && !requestOptionsCollapsed.value
    });
    const replyDisplayMode = ref('formatted');
    const requestDraft = ref('');
    const requestOverrideActive = ref(false);
    const requestValidating = ref(false);
    const requestValidation = reactive({
        status: '',
        diagnostics: [],
        operation: '',
        engine: '',
        performed: false
    });
    let requestValidationRevision = 0;
    const editConfigLoading = ref(false);
    const editConfigReadbackStatus = ref('idle');
    const editConfigReadbackSource = ref('');
    const editConfigTargetStale = ref(false);
    let editConfigFallback = '';
    let editConfigBaseline = '';
    let editConfigLoadRevision = 0;
    let applyingOperationContext = false;
    const result = reactive({
        status: '',
        operation: '',
        reply: '',
        request: '',
        messageId: '',
        duration: null,
        time: ''
    });
    const form = reactive({
        source: 'running',
        filterType: 'none',
        xpath: '',
        subtree: '',
        target: 'candidate',
        defaultOperation: 'merge',
        testOption: 'test-then-set',
        errorOption: 'stop-on-error',
        config: '',
        copySource: 'running',
        copyTarget: 'startup',
        deleteTarget: 'startup',
        lockTarget: 'running',
        validateSource: 'candidate',
        confirmed: false,
        confirmTimeout: 600,
        rawRpc: DEFAULT_RAW_RPC
    });

    const defaultOperationOptions = [
        { label: 'merge', value: 'merge' },
        { label: 'replace', value: 'replace' },
        { label: 'none', value: 'none' }
    ];
    const testOptionOptions = [
        { label: 'test-then-set', value: 'test-then-set' },
        { label: 'set', value: 'set' },
        { label: 'test-only', value: 'test-only' }
    ];
    const readOperations = NETCONF_OPERATIONS.filter(
        operation => operation.key === 'get' || operation.key === 'get-config'
    );
    const writeOperations = NETCONF_OPERATIONS.filter(operation =>
        [
            'edit-config',
            'copy-config',
            'delete-config',
            'lock',
            'unlock',
            'validate',
            'commit',
            'cancel-commit',
            'discard-changes'
        ].includes(operation.key)
    );
    const advancedOperations = NETCONF_OPERATIONS.filter(operation => operation.key === 'raw-rpc');
    const capabilities = computed(() => {
        const values = session.value.capabilities || session.value.serverCapabilities || [];
        return [...new Set(unwrapArray(values).map(normalizeCapability).filter(Boolean))];
    });
    const connected = computed(() => {
        const status = session.value.status || session.value.state;
        return session.value.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
    });
    const operationsLayoutStyle = computed(() => {
        if (!props.embedded) return undefined;
        const style = {};
        if (requestPaneHeight.value > 0) style['--request-pane-height'] = `${requestPaneHeight.value}px`;
        if (parameterPaneWidth.value > 0) style['--parameter-pane-width'] = `${parameterPaneWidth.value}px`;
        return style;
    });
    const editConfigReadbackMeta = computed(() => {
        const source = editConfigReadbackSource.value || form.target || '目标 datastore';
        if (editConfigReadbackStatus.value === 'loading') {
            return { color: 'blue', label: '读取中', description: `正在从 ${source} 读取当前节点配置` };
        }
        if (editConfigReadbackStatus.value === 'loaded') {
            return { color: 'success', label: '已载入', description: `已从 ${source} 读取，可直接修改后提交` };
        }
        if (editConfigReadbackStatus.value === 'empty') {
            return {
                color: 'warning',
                label: '无现有配置',
                description: `${source} 未返回匹配数据，已使用 Schema 草稿`
            };
        }
        if (editConfigReadbackStatus.value === 'error') {
            return { color: 'error', label: '读取失败', description: `保留当前草稿，可重试或手工填写` };
        }
        if (editConfigReadbackStatus.value === 'stale') {
            return { color: 'warning', label: '目标已变化', description: `请从 ${source} 重新读取后再执行` };
        }
        return { color: 'default', label: '设备回读', description: `将先从 ${source} 读取当前节点配置` };
    });
    const editConfigReloadLabel = computed(() =>
        editConfigReadbackStatus.value === 'idle' ? '从设备读取' : '重新读取并覆盖'
    );
    const activeOperationMeta = computed(
        () => NETCONF_OPERATIONS.find(operation => operation.key === activeOperation.value) || NETCONF_OPERATIONS[0]
    );
    const capabilityIncludes = hint =>
        capabilities.value.some(capability => capability.toLowerCase().includes(hint.toLowerCase()));
    const hasCapability = name => capabilityIncludes(NETCONF_CAPABILITY_HINTS[name] || name);
    const supportsTestOption = computed(() =>
        capabilities.value.some(capability => /:validate:1\.1(?:[?&]|$)/iu.test(capability))
    );

    const readDatastoreOptions = computed(() => {
        const options = [{ label: 'running', value: 'running' }];
        if (hasCapability('candidate')) options.push({ label: 'candidate', value: 'candidate' });
        if (hasCapability('startup')) options.push({ label: 'startup', value: 'startup' });
        return options;
    });
    const editDatastoreOptions = computed(() => {
        const options = [];
        if (hasCapability('candidate')) options.push({ label: 'candidate', value: 'candidate' });
        if (hasCapability('writableRunning')) options.push({ label: 'running', value: 'running' });
        return options;
    });
    const copyTargetDatastoreOptions = computed(() => {
        const options = [...editDatastoreOptions.value];
        if (hasCapability('startup')) options.push({ label: 'startup', value: 'startup' });
        return options;
    });
    const deletableDatastoreOptions = computed(() =>
        hasCapability('startup') ? [{ label: 'startup', value: 'startup' }] : []
    );
    const lockDatastoreOptions = computed(() => {
        const values = new Set(['running', ...readDatastoreOptions.value.map(option => option.value)]);
        return [...values].map(value => ({ label: value, value }));
    });
    const filterTypeOptions = computed(() =>
        NETCONF_FILTER_TYPE_OPTIONS.map(option => ({
            ...option,
            disabled: option.value === 'xpath' && !hasCapability('xpath')
        }))
    );
    const errorOptionOptions = computed(() => [
        { label: 'stop-on-error', value: 'stop-on-error' },
        { label: 'continue-on-error', value: 'continue-on-error' },
        {
            label: 'rollback-on-error',
            value: 'rollback-on-error',
            disabled: !hasCapability('rollbackOnError')
        }
    ]);
    const booleanValueOptions = [
        { label: 'true', value: 'true' },
        { label: 'false', value: 'false' }
    ];

    const parseXmlFragment = value => {
        const source = String(value || '').trim();
        if (!source) return { source, documentNode: null, wrapper: null, roots: [], error: '' };
        if (typeof DOMParser === 'undefined') {
            return { source, documentNode: null, wrapper: null, roots: [], error: '当前环境不支持 XML 树解析' };
        }
        const body = source.replace(/^<\?xml[\s\S]*?\?>\s*/u, '');
        const documentNode = new DOMParser().parseFromString(
            `<netnexus-fragment xmlns:nc="${NETCONF_BASE_NAMESPACE}">${body}</netnexus-fragment>`,
            'application/xml'
        );
        const parserError = documentNode.getElementsByTagName('parsererror')[0];
        if (parserError || !documentNode.documentElement) {
            return {
                source,
                documentNode,
                wrapper: null,
                roots: [],
                error: parserError?.textContent?.trim() || 'XML 片段无法解析'
            };
        }
        const wrapper = documentNode.documentElement;
        return { source, documentNode, wrapper, roots: Array.from(wrapper.children), error: '' };
    };

    const serializeXmlFragment = parsed => {
        if (!parsed?.wrapper || typeof XMLSerializer === 'undefined') return parsed?.source || '';
        const serializer = new XMLSerializer();
        return Array.from(parsed.wrapper.children)
            .map(element => formatXmlForDisplay(serializer.serializeToString(element)))
            .join('\n');
    };

    const xmlElementAtPath = (wrapper, elementPath = []) => {
        let current = wrapper;
        for (const index of elementPath) {
            current = Array.from(current?.children || [])[index];
            if (!current) return null;
        }
        return current;
    };

    const xmlMetadataSegment = element => `{${element.namespaceURI || ''}}${element.localName || element.nodeName}`;

    const collectRequiredXmlMetadata = (value, expectedRootName) => {
        const parsed = parseXmlFragment(value);
        const metadata = new Map();
        const visit = (element, metadataPath) => {
            const requiredComment = Array.from(element.childNodes || []).find(
                node => node.nodeType === 8 && String(node.nodeValue || '').includes('NETNEXUS_REQUIRED')
            );
            if (requiredComment) {
                const placeholder = String(requiredComment.nodeValue || '').trim();
                metadata.set(metadataPath.join('/'), {
                    placeholder,
                    isKey: /list key/iu.test(placeholder),
                    boolean: /boolean/iu.test(placeholder)
                });
            }
            Array.from(element.children || []).forEach(child => {
                visit(child, [...metadataPath, xmlMetadataSegment(child)]);
            });
        };
        const rootMatches =
            parsed.roots.length === 1 &&
            parsed.roots[0].localName.toLowerCase() === String(expectedRootName || '').toLowerCase();
        if (rootMatches) {
            visit(parsed.roots[0], []);
            return metadata;
        }
        parsed.roots.forEach(element => {
            visit(element, [xmlMetadataSegment(element)]);
        });
        return metadata;
    };

    const makeXmlElementTree = (
        element,
        xmlField,
        elementPath,
        parameterPath,
        { deletable = true, requiredMetadata = new Map(), metadataPath = [] } = {}
    ) => {
        const directText = Array.from(element.childNodes || [])
            .filter(node => node.nodeType === 3 || node.nodeType === 4)
            .map(node => node.nodeValue || '')
            .join('')
            .trim();
        const requiredComment = Array.from(element.childNodes || []).find(
            node => node.nodeType === 8 && String(node.nodeValue || '').includes('NETNEXUS_REQUIRED')
        );
        const schemaMetadata = requiredMetadata.get(metadataPath.join('/')) || {};
        const requiredPlaceholder = String(requiredComment?.nodeValue || schemaMetadata.placeholder || '').trim();
        const elementChildren = Array.from(element.children || []);
        const attributes = Array.from(element.attributes || []).map(attribute => ({
            key: `parameter:xml:${xmlField}:${elementPath.join('.')}:@${attribute.name}`,
            title: `@${attribute.name}`,
            kind: 'attribute',
            editor: 'text',
            value: attribute.value,
            xmlField,
            xmlPath: elementPath,
            attributeName: attribute.name,
            attributeNamespace: attribute.namespaceURI || '',
            disabled: /^xmlns(?::|$)/iu.test(attribute.name),
            deletable: !/^xmlns(?::|$)/iu.test(attribute.name),
            parameterPath: `${parameterPath}/@${attribute.name}`,
            isLeaf: true
        }));
        const nameCounts = new Map();
        const childNodes = elementChildren.map((child, index) => {
            const metadataName = child.localName || child.nodeName;
            const count = (nameCounts.get(metadataName) || 0) + 1;
            nameCounts.set(metadataName, count);
            return makeXmlElementTree(
                child,
                xmlField,
                [...elementPath, index],
                `${parameterPath}/${child.nodeName}[${count}]`,
                { requiredMetadata, metadataPath: [...metadataPath, xmlMetadataSegment(child)] }
            );
        });
        const required = Boolean(requiredComment || schemaMetadata.placeholder);
        const hasRequiredDescendant = childNodes.some(child => child.required || child.hasRequiredDescendant);
        const isListNode = childNodes.some(child => child.kind === 'key');
        const hasEditableValue = elementChildren.length === 0 && Boolean(directText || required);
        const booleanValue =
            /^(?:true|false)$/iu.test(directText) || schemaMetadata.boolean || /boolean/iu.test(requiredPlaceholder);
        const children = [...attributes, ...childNodes];
        return {
            key: `parameter:xml:${xmlField}:${elementPath.join('.') || 'root'}`,
            title: element.nodeName,
            kind:
                schemaMetadata.isKey || /list key/iu.test(requiredPlaceholder)
                    ? 'key'
                    : isListNode
                      ? 'list'
                      : 'element',
            editor: hasEditableValue ? (booleanValue ? 'select' : 'text') : '',
            options: booleanValue ? booleanValueOptions : undefined,
            value: directText,
            placeholder: requiredPlaceholder,
            required,
            deletable: deletable && !required,
            hasRequiredDescendant,
            xmlField,
            xmlPath: elementPath,
            xmlNamespace: element.namespaceURI || '',
            parameterPath,
            children,
            isLeaf: children.length === 0
        };
    };

    const makeXmlSourceEditorNode = (xmlField, parameterPath, title, required = false) => ({
        key: `parameter:xml-source:${xmlField}`,
        title,
        kind: 'error',
        editor: 'textarea',
        field: xmlField,
        required,
        parameterPath,
        isLeaf: true
    });

    const makeXmlPayloadChildren = (xmlField, parameterPath, expectedRootName) => {
        const parsed = parseXmlFragment(form[xmlField]);
        const requiredMetadata =
            xmlField === 'config' && editConfigFallback
                ? collectRequiredXmlMetadata(editConfigFallback, expectedRootName)
                : new Map();
        if (!parsed.source || parsed.error) {
            return [
                makeXmlSourceEditorNode(
                    xmlField,
                    `${parameterPath}/xml-source`,
                    parsed.error ? 'XML 解析失败' : 'XML 片段',
                    true
                )
            ];
        }
        const rootMatches =
            parsed.roots.length === 1 && parsed.roots[0].localName.toLowerCase() === expectedRootName.toLowerCase();
        if (rootMatches) {
            const rootTree = makeXmlElementTree(parsed.roots[0], xmlField, [0], parameterPath, {
                deletable: false,
                requiredMetadata
            });
            return rootTree.children;
        }
        const nameCounts = new Map();
        return parsed.roots.map((element, index) => {
            const metadataName = element.localName || element.nodeName;
            const count = (nameCounts.get(metadataName) || 0) + 1;
            nameCounts.set(metadataName, count);
            return makeXmlElementTree(element, xmlField, [index], `${parameterPath}/${element.nodeName}[${count}]`, {
                requiredMetadata,
                metadataPath: [xmlMetadataSegment(element)]
            });
        });
    };

    const makeXmlContainerDescriptor = (xmlField, expectedRootName) => {
        const parsed = parseXmlFragment(form[xmlField]);
        const rootMatches =
            parsed.roots.length === 1 && parsed.roots[0].localName.toLowerCase() === expectedRootName.toLowerCase();
        return {
            xmlContainerField: xmlField,
            xmlContainerPath: rootMatches ? [0] : [],
            xmlDefaultNamespace: props.contextNode?.namespace || ''
        };
    };

    const makeParameterNode = ({
        key,
        title,
        parameterPath,
        kind = 'element',
        field = '',
        editor = '',
        options,
        disabled = false,
        min,
        max,
        children = [],
        xmlContainerField = '',
        xmlContainerPath,
        xmlDefaultNamespace = ''
    }) => ({
        key: `parameter:${activeOperation.value}:${key}`,
        title,
        parameterPath,
        kind,
        field,
        editor,
        options,
        disabled,
        min,
        max,
        xmlContainerField,
        xmlContainerPath,
        xmlDefaultNamespace,
        children,
        isLeaf: children.length === 0
    });

    const operationParameterTree = computed(() => {
        const operation = activeOperation.value;
        if (operation === 'raw-rpc') {
            const parsed = parseXmlFragment(form.rawRpc);
            if (!parsed.source || parsed.error) {
                return [
                    makeParameterNode({
                        key: 'rpc',
                        title: 'rpc',
                        parameterPath: '/rpc',
                        kind: 'rpc',
                        children: [
                            makeXmlSourceEditorNode(
                                'rawRpc',
                                '/rpc/xml-source',
                                parsed.error ? 'XML 解析失败' : 'RPC XML',
                                true
                            )
                        ]
                    })
                ];
            }
            if (parsed.roots.length === 1 && parsed.roots[0].localName.toLowerCase() === 'rpc') {
                return [makeXmlElementTree(parsed.roots[0], 'rawRpc', [0], '/rpc', { deletable: false })];
            }
            const rawChildren = parsed.roots.map((element, index) =>
                makeXmlElementTree(element, 'rawRpc', [index], `/rpc/${element.nodeName}[${index + 1}]`, {
                    deletable: false
                })
            );
            return [
                makeParameterNode({
                    key: 'rpc',
                    title: 'rpc',
                    parameterPath: '/rpc',
                    kind: 'rpc',
                    ...makeXmlContainerDescriptor('rawRpc', 'rpc'),
                    children: rawChildren
                })
            ];
        }

        const operationPath = `/rpc/${operation}`;
        const children = [];
        const selectNode = (key, title, field, options, extra = {}) =>
            makeParameterNode({
                key,
                title,
                field,
                editor: 'select',
                options,
                parameterPath: `${operationPath}/${key}`,
                ...extra
            });

        if (operation === 'get' || operation === 'get-config') {
            if (operation === 'get-config') {
                children.push(selectNode('source', 'source', 'source', readDatastoreOptions.value));
            }
            const filterChildren = [];
            if (form.filterType === 'xpath') {
                filterChildren.push(
                    makeParameterNode({
                        key: 'filter/@select',
                        title: '@select',
                        field: 'xpath',
                        editor: 'text',
                        parameterPath: `${operationPath}/filter/@select`
                    })
                );
            } else if (form.filterType === 'subtree') {
                filterChildren.push(...makeXmlPayloadChildren('subtree', `${operationPath}/filter`, 'filter'));
            }
            children.push(
                selectNode('filter', 'filter', 'filterType', filterTypeOptions.value, {
                    ...(form.filterType === 'subtree' ? makeXmlContainerDescriptor('subtree', 'filter') : {}),
                    children: filterChildren
                })
            );
        } else if (operation === 'edit-config') {
            children.push(selectNode('target', 'target', 'target', editDatastoreOptions.value));
            children.push(
                selectNode('default-operation', 'default-operation', 'defaultOperation', defaultOperationOptions)
            );
            children.push(
                selectNode('test-option', 'test-option', 'testOption', testOptionOptions, {
                    disabled: !supportsTestOption.value
                })
            );
            children.push(selectNode('error-option', 'error-option', 'errorOption', errorOptionOptions.value));
            children.push(
                makeParameterNode({
                    key: 'config',
                    title: 'config',
                    parameterPath: `${operationPath}/config`,
                    ...makeXmlContainerDescriptor('config', 'config'),
                    children: makeXmlPayloadChildren('config', `${operationPath}/config`, 'config')
                })
            );
        } else if (operation === 'copy-config') {
            children.push(selectNode('source', 'source', 'copySource', readDatastoreOptions.value));
            children.push(selectNode('target', 'target', 'copyTarget', copyTargetDatastoreOptions.value));
        } else if (operation === 'delete-config') {
            children.push(selectNode('target', 'target', 'deleteTarget', deletableDatastoreOptions.value));
        } else if (operation === 'lock' || operation === 'unlock') {
            children.push(selectNode('target', 'target', 'lockTarget', lockDatastoreOptions.value));
        } else if (operation === 'validate') {
            children.push(selectNode('source', 'source', 'validateSource', readDatastoreOptions.value));
        } else if (operation === 'commit') {
            children.push(
                makeParameterNode({
                    key: 'confirmed',
                    title: 'confirmed',
                    field: 'confirmed',
                    editor: 'checkbox',
                    disabled: !hasCapability('confirmedCommit'),
                    parameterPath: `${operationPath}/confirmed`
                })
            );
            if (form.confirmed) {
                children.push(
                    makeParameterNode({
                        key: 'confirm-timeout',
                        title: 'confirm-timeout',
                        field: 'confirmTimeout',
                        editor: 'number',
                        min: 1,
                        max: 3600,
                        parameterPath: `${operationPath}/confirm-timeout`
                    })
                );
            }
        }

        const operationNode = makeParameterNode({
            key: 'operation',
            title: operation,
            parameterPath: operationPath,
            kind: 'operation',
            children
        });
        return [
            makeParameterNode({
                key: 'rpc',
                title: 'rpc',
                parameterPath: '/rpc',
                kind: 'rpc',
                children: [operationNode]
            })
        ];
    });

    const parameterSchemaKeyword = node =>
        String(node?.keyword || node?.kind || '')
            .trim()
            .toLowerCase();
    const parameterLocalName = value => {
        const name = String(value || '').replace(/\[\d+\]$/u, '');
        return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    };
    const parameterSchemaPathSegments = node =>
        String(node?.path || '')
            .split('/')
            .filter(Boolean)
            .map(parameterLocalName)
            .filter(Boolean);
    const flattenParameterSchemaNodes = (nodes, result = []) => {
        (Array.isArray(nodes) ? nodes : []).forEach(node => {
            result.push(node);
            flattenParameterSchemaNodes(node?.children, result);
        });
        return result;
    };
    const flatParameterSchemaNodes = computed(() => [
        ...flattenParameterSchemaNodes(props.schemaTree),
        ...flattenParameterSchemaNodes(parameterDiscoveredSchemaNodes.value)
    ]);
    const parameterDataPathSegments = node => {
        const parts = String(node?.parameterPath || '')
            .split('/')
            .filter(Boolean);
        const markerIndex = Math.max(parts.lastIndexOf('filter'), parts.lastIndexOf('config'));
        if (markerIndex < 0) return [];
        return parts
            .slice(markerIndex + 1)
            .filter(part => part !== 'xml-source' && !part.startsWith('@'))
            .map(parameterLocalName);
    };
    const parameterSchemaNamespace = node => {
        if (node?.namespace) return node.namespace;
        const moduleNode = flatParameterSchemaNodes.value.find(
            candidate =>
                ['module', 'submodule'].includes(parameterSchemaKeyword(candidate)) &&
                (candidate.name === node?.module || candidate.title === node?.module)
        );
        return moduleNode?.namespace || props.contextNode?.namespace || '';
    };
    const findSchemaNodeBySegments = segments => {
        if (!segments.length) return null;
        const matches = flatParameterSchemaNodes.value.filter(node => {
            if (!PARAMETER_DATA_NODE_KEYWORDS.has(parameterSchemaKeyword(node))) return false;
            const candidateSegments = parameterSchemaPathSegments(node);
            if (candidateSegments.length < segments.length) return false;
            return segments.every(
                (segment, index) => candidateSegments[candidateSegments.length - segments.length + index] === segment
            );
        });
        return matches.find(node => parameterSchemaPathSegments(node).length === segments.length) || matches[0] || null;
    };
    const findParameterSchemaNode = node => findSchemaNodeBySegments(parameterDataPathSegments(node));
    const findContextRootSchemaNode = () => {
        const contextSegments = parameterSchemaPathSegments(props.contextNode);
        if (!contextSegments.length) return null;
        return findSchemaNodeBySegments([contextSegments[0]]);
    };
    const findParameterRecord = (nodes, key, parent = null) => {
        for (const node of nodes || []) {
            if (node.key === key) return { node, parent };
            const found = findParameterRecord(node.children, key, node);
            if (found) return found;
        }
        return null;
    };
    const findParameterRecordByPath = (nodes, parameterPath, parent = null) => {
        for (const node of nodes || []) {
            if (node.parameterPath === parameterPath) return { node, parent };
            const found = findParameterRecordByPath(node.children, parameterPath, node);
            if (found) return found;
        }
        return null;
    };

    const parameterNodeIconKind = node => {
        if (node?.kind === 'rpc' || node?.kind === 'operation') return 'operation';
        if (node?.kind === 'attribute') return 'attribute';
        if (node?.kind === 'key') return 'key';
        if (node?.kind === 'error') return 'fallback';
        if (node?.kind === 'list') return 'list';
        const schemaNode = findParameterSchemaNode(node);
        const schemaKeyword = parameterSchemaKeyword(schemaNode);
        if (schemaNode?.isListKey) return 'key';
        if (schemaKeyword === 'list') return 'list';
        if (schemaKeyword === 'container') return 'container';
        if (schemaNode?.config === false && ['leaf', 'leaf-list', 'anydata', 'anyxml'].includes(schemaKeyword)) {
            return 'state';
        }
        if (['leaf', 'leaf-list', 'anydata', 'anyxml'].includes(schemaKeyword)) return 'leaf';
        return node?.children?.length ? 'container' : 'leaf';
    };
    const parameterNodeIconComponent = node => {
        const kind = parameterNodeIconKind(node);
        if (kind === 'container' && parameterExpandedKeys.value.includes(node?.key)) return FolderOpenOutlined;
        return PARAMETER_NODE_ICONS[kind] || PARAMETER_NODE_ICONS.fallback;
    };
    const parameterKindLabel = node => {
        const kind = parameterNodeIconKind(node);
        if (node?.kind === 'rpc') return 'rpc';
        if (node?.kind === 'operation') return 'operation';
        if (kind === 'attribute') return 'attribute';
        if (kind === 'key') return 'key';
        if (kind === 'list') return 'list';
        if (kind === 'container') return 'container';
        if (kind === 'state') return 'state';
        if (kind === 'fallback') return 'XML';
        return 'leaf';
    };

    const parameterNodeValue = node => (node?.field ? form[node.field] : (node?.value ?? ''));
    const parameterNodeHasDisplayValue = node => {
        if (!node?.editor) return false;
        const value = parameterNodeValue(node);
        return value !== '' && value !== null && value !== undefined;
    };
    const parameterNodeDisplayValue = node => {
        const value = String(parameterNodeValue(node) ?? '');
        if (node?.editor === 'textarea') return value ? 'XML 源' : '';
        return value;
    };

    const updateXmlParameterNode = (node, value) => {
        const parsed = parseXmlFragment(form[node.xmlField]);
        if (!parsed.wrapper || parsed.error) return;
        const element = xmlElementAtPath(parsed.wrapper, node.xmlPath);
        if (!element) return;
        if (node.attributeName) {
            if (node.attributeNamespace) {
                element.setAttributeNS(node.attributeNamespace, node.attributeName, String(value ?? ''));
            } else {
                element.setAttribute(node.attributeName, String(value ?? ''));
            }
        } else {
            const nextValue = String(value ?? '');
            if (node.required && !nextValue.trim()) {
                element.replaceChildren(
                    parsed.documentNode.createComment(` ${node.placeholder || 'NETNEXUS_REQUIRED: 输入必填值'} `)
                );
            } else {
                element.replaceChildren(parsed.documentNode.createTextNode(nextValue));
            }
        }
        form[node.xmlField] = serializeXmlFragment(parsed);
    };

    const updateParameterNode = (node, value) => {
        if (executing.value || editConfigLoading.value || node.disabled) return;
        restoreGeneratedRequest({ silent: true });
        if (node.xmlField) {
            updateXmlParameterNode(node, value);
            return;
        }
        if (node.field) form[node.field] = value;
    };

    const removeParameterXmlNode = node => {
        if (!node.xmlField || !node.deletable || executing.value || editConfigLoading.value) return;
        const parsed = parseXmlFragment(form[node.xmlField]);
        if (!parsed.wrapper || parsed.error) return;
        const element = xmlElementAtPath(parsed.wrapper, node.xmlPath);
        if (!element) return;
        restoreGeneratedRequest({ silent: true });
        if (node.attributeName) {
            const attribute = element.getAttributeNode(node.attributeName);
            if (!attribute) return;
            element.removeAttributeNode(attribute);
        } else {
            if (!element.parentElement) return;
            const parent = element.parentElement;
            element.remove();
            if (
                parent.children.length === 0 &&
                Array.from(parent.childNodes || []).every(
                    child => child.nodeType === 3 && !String(child.nodeValue || '').trim()
                )
            ) {
                parent.replaceChildren();
            }
        }
        form[node.xmlField] = serializeXmlFragment(parsed);
        parameterSelectedKeys.value = [];
    };

    const collectExpandedParameterKeys = nodes =>
        nodes.flatMap(node =>
            node.children?.length ? [node.key, ...collectExpandedParameterKeys(node.children)] : []
        );

    const expandOperationParameterTree = () => {
        parameterExpandedKeys.value = collectExpandedParameterKeys(operationParameterTree.value);
        parameterSelectedKeys.value = [];
    };

    const getParameterContextMenuPosition = (anchor, menuRect) => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const maxX = Math.max(
            PARAMETER_CONTEXT_MENU_MARGIN,
            viewportWidth - menuRect.width - PARAMETER_CONTEXT_MENU_MARGIN
        );
        const maxY = Math.max(
            PARAMETER_CONTEXT_MENU_MARGIN,
            viewportHeight - menuRect.height - PARAMETER_CONTEXT_MENU_MARGIN
        );
        return {
            x: Math.min(Math.max(PARAMETER_CONTEXT_MENU_MARGIN, anchor.clientX), maxX),
            y: Math.min(Math.max(PARAMETER_CONTEXT_MENU_MARGIN, anchor.clientY), maxY)
        };
    };

    const handleParameterTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const record = findParameterRecord(operationParameterTree.value, node?.key || node?.eventKey);
        const matchedNode = record?.node || node?.dataRef || node;
        if (!matchedNode?.key) return;
        const openRequest = ++parameterContextMenuOpenRequest;
        parameterContextMenuTrigger =
            (event?.target instanceof Element && event.target.closest('[role="treeitem"]')) ||
            (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        parameterSelectedKeys.value = [matchedNode.key];
        Object.assign(parameterContextMenu, {
            visible: true,
            x: Number.isFinite(event?.clientX) ? event.clientX : PARAMETER_CONTEXT_MENU_MARGIN,
            y: Number.isFinite(event?.clientY) ? event.clientY : PARAMETER_CONTEXT_MENU_MARGIN,
            node: matchedNode,
            parent: record?.parent || null
        });
        await nextTick();
        if (!parameterContextMenuRef.value) await new Promise(resolve => window.requestAnimationFrame(resolve));
        if (
            !parameterContextMenu.visible ||
            openRequest !== parameterContextMenuOpenRequest ||
            !parameterContextMenuRef.value
        ) {
            return;
        }
        const position = getParameterContextMenuPosition(
            { clientX: parameterContextMenu.x, clientY: parameterContextMenu.y },
            parameterContextMenuRef.value.getBoundingClientRect()
        );
        parameterContextMenu.x = position.x;
        parameterContextMenu.y = position.y;
        parameterContextMenuRef.value
            .querySelector('[role="menuitem"]:not([aria-disabled="true"])')
            ?.focus?.({ preventScroll: true });
    };

    const handleParameterTreeKeydown = event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const treeItem = event.target instanceof Element ? event.target.closest('[role="treeitem"]') : null;
        const title = treeItem?.querySelector('[data-parameter-path]');
        const record = findParameterRecordByPath(operationParameterTree.value, title?.dataset?.parameterPath);
        if (!record) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = treeItem.getBoundingClientRect();
        void handleParameterTreeRightClick({
            event: {
                target: treeItem,
                clientX: bounds.left + Math.min(24, bounds.width / 2),
                clientY: bounds.bottom,
                preventDefault() {},
                stopPropagation() {}
            },
            node: record.node
        });
    };

    const hideParameterContextMenu = (restoreFocus = false) => {
        parameterContextMenuOpenRequest += 1;
        parameterContextMenu.visible = false;
        const trigger = parameterContextMenuTrigger;
        parameterContextMenuTrigger = null;
        if (restoreFocus === true && trigger?.isConnected) {
            void nextTick(() => trigger.focus?.({ preventScroll: true }));
        }
    };

    const handleParameterContextMenuPointerDown = event => {
        if (!parameterContextMenu.visible) return;
        if (event.target instanceof Node && parameterContextMenuRef.value?.contains(event.target)) return;
        hideParameterContextMenu();
    };

    const parameterContextCapabilities = computed(() => {
        const node = parameterContextMenu.node;
        const busy = executing.value || editConfigLoading.value;
        const schemaKeyword = parameterSchemaKeyword(findParameterSchemaNode(node));
        const concreteElement = Boolean(node?.xmlField && !node?.attributeName && node?.xmlPath);
        const schemaLeaf = ['leaf', 'leaf-list', 'anydata', 'anyxml'].includes(schemaKeyword);
        return {
            addChild: !busy && Boolean(node?.xmlContainerField || (concreteElement && !node?.editor && !schemaLeaf)),
            addSibling: !busy && concreteElement && node?.xmlPath?.length > 0,
            addAttribute: !busy && concreteElement,
            edit: !busy && Boolean(node?.editor || schemaLeaf) && !node?.disabled,
            remove: !busy && Boolean(node?.deletable)
        };
    });
    const parameterContextMenuHint = computed(() => {
        const node = parameterContextMenu.node;
        if (executing.value || editConfigLoading.value) return '操作执行或设备回读期间不能修改参数树';
        if (node?.disabled) return '该协议或命名空间节点为只读';
        if (requestOverrideActive.value) return '确认参数树修改后，将退出手工编辑并重新生成 RPC';
        if (node?.required) return '必填值或 list key 不能单独移除；可移除其上层可选分支';
        return '添加动作优先使用当前 libyang Schema；确认后 RPC 请求会立即同步';
    });

    const loadDirectParameterSchemaChildren = async node => {
        if (!node) return [];
        if (Array.isArray(node.children) && (node.children.length || node.childrenLoaded)) return node.children;
        if (!props.compileId || !node.id || node.isLeaf) return [];
        const profileId = props.profileId;
        const requestedCompileId = props.compileId;
        const requestedContextRevision = props.contextRevision;
        const requestRevision = parameterSchemaRequestRevision;
        const cacheKey = `${profileId}\u0000${requestedCompileId}\u0000${node.id}`;
        if (!parameterSchemaChildrenCache.has(cacheKey)) {
            const childRequest = invokeBridge('yangApi', 'getSchemaChildren', {
                profileId,
                compileId: requestedCompileId,
                parentId: node.id,
                nodeId: node.id
            })
                .then(({ data }) => unwrapArray(data, ['nodes', 'children']))
                .catch(error => {
                    if (parameterSchemaChildrenCache.get(cacheKey) === childRequest) {
                        parameterSchemaChildrenCache.delete(cacheKey);
                    }
                    throw error;
                });
            parameterSchemaChildrenCache.set(cacheKey, childRequest);
        }
        const children = await parameterSchemaChildrenCache.get(cacheKey);
        if (
            requestRevision !== parameterSchemaRequestRevision ||
            profileId !== props.profileId ||
            requestedCompileId !== props.compileId ||
            requestedContextRevision !== props.contextRevision
        ) {
            return [];
        }
        const knownKeys = new Set(
            parameterDiscoveredSchemaNodes.value.map(candidate => candidate.id || candidate.path).filter(Boolean)
        );
        const discovered = children.filter(child => {
            const key = child?.id || child?.path;
            return !key || !knownKeys.has(key);
        });
        if (discovered.length)
            parameterDiscoveredSchemaNodes.value = [...parameterDiscoveredSchemaNodes.value, ...discovered];
        return children;
    };
    const flattenAddableParameterSchemaChildren = async nodes => {
        const result = [];
        for (const node of nodes || []) {
            const keyword = parameterSchemaKeyword(node);
            if (keyword === 'output') continue;
            if (PARAMETER_SCHEMA_BRANCH_KEYWORDS.has(keyword)) {
                result.push(
                    ...(await flattenAddableParameterSchemaChildren(await loadDirectParameterSchemaChildren(node)))
                );
                continue;
            }
            if (!PARAMETER_DATA_NODE_KEYWORDS.has(keyword)) continue;
            if (activeOperation.value === 'edit-config' && node.config === false) continue;
            result.push(node);
        }
        return result;
    };
    const parameterSchemaCandidateKey = (node, index = 0) =>
        String(node?.id || node?.path || `${node?.module || 'schema'}:${node?.name || node?.title || index}`);
    const schemaCandidateName = node => String(node?.name || node?.title || '').trim();
    const schemaCandidateIsRepeatable = node => ['list', 'leaf-list'].includes(parameterSchemaKeyword(node));
    const selectParameterSchemaCandidate = key => {
        const index = parameterAction.schemaCandidates.findIndex(
            (candidate, candidateIndex) => parameterSchemaCandidateKey(candidate, candidateIndex) === key
        );
        const candidate = parameterAction.schemaCandidates[index];
        parameterAction.schemaKey = key || '';
        parameterAction.schemaNode = candidate || null;
        if (!candidate) return;
        parameterAction.name = schemaCandidateName(candidate);
        parameterAction.namespace = parameterSchemaNamespace(candidate);
        const defaultValue = Array.isArray(candidate.default) ? candidate.default[0] : candidate.default;
        parameterAction.value = defaultValue ?? '';
    };
    const availableParameterSchemaCandidates = async (mode, node, parent) => {
        let schemaParent = null;
        let candidates = [];
        if (mode === 'add-child' && node?.xmlContainerField && !node?.xmlField) {
            const contextRoot = findContextRootSchemaNode();
            candidates = contextRoot ? [contextRoot] : [];
        } else {
            schemaParent = mode === 'add-sibling' ? findParameterSchemaNode(parent) : findParameterSchemaNode(node);
            if (schemaParent) {
                candidates = await flattenAddableParameterSchemaChildren(
                    await loadDirectParameterSchemaChildren(schemaParent)
                );
            }
        }
        const presentNodes = mode === 'add-sibling' ? parent?.children || [] : node?.children || [];
        const presentNames = new Set(
            presentNodes
                .filter(child => child?.xmlField && !child?.attributeName)
                .map(child => parameterLocalName(child.title))
        );
        return candidates.filter(
            candidate => schemaCandidateIsRepeatable(candidate) || !presentNames.has(schemaCandidateName(candidate))
        );
    };

    const resetParameterAction = (mode, node) => {
        Object.assign(parameterAction, {
            mode,
            node,
            value: mode === 'edit-value' ? parameterNodeValue(node) : '',
            name: '',
            namespace:
                mode === 'add-attribute'
                    ? ''
                    : node?.xmlNamespace || node?.xmlDefaultNamespace || props.contextNode?.namespace || '',
            schemaKey: '',
            schemaOptions: [],
            schemaCandidates: [],
            schemaNode: null,
            schemaRestricted: false,
            contextRevision: props.contextRevision,
            operation: activeOperation.value
        });
    };
    const openParameterAddAction = async (mode, node, parent) => {
        const actionRequest = ++parameterActionOpenRequest;
        parameterActionLoading.value = false;
        resetParameterAction(mode, node);
        parameterActionOpen.value = true;
        if (mode === 'add-attribute') return;
        parameterActionLoading.value = true;
        try {
            const candidates = await availableParameterSchemaCandidates(mode, node, parent);
            if (actionRequest !== parameterActionOpenRequest || !parameterActionOpen.value) return;
            const hasSchemaContext = Boolean(
                props.compileId && (findParameterSchemaNode(node) || findContextRootSchemaNode())
            );
            parameterAction.schemaRestricted = activeOperation.value !== 'raw-rpc' && hasSchemaContext;
            parameterAction.schemaCandidates = candidates;
            parameterAction.schemaOptions = candidates.map((candidate, index) => ({
                label: `${schemaCandidateName(candidate)} (${parameterSchemaKeyword(candidate)})`,
                value: parameterSchemaCandidateKey(candidate, index)
            }));
            if (parameterAction.schemaOptions.length) {
                selectParameterSchemaCandidate(parameterAction.schemaOptions[0].value);
            }
        } catch (error) {
            if (actionRequest !== parameterActionOpenRequest || !parameterActionOpen.value) return;
            parameterAction.schemaRestricted = activeOperation.value !== 'raw-rpc';
            notify.warning(`加载可添加的 Schema 节点失败：${error.message}`);
        } finally {
            if (actionRequest === parameterActionOpenRequest) parameterActionLoading.value = false;
        }
    };
    const openParameterEditAction = node => {
        parameterActionOpenRequest += 1;
        parameterActionLoading.value = false;
        resetParameterAction('edit-value', node);
        parameterActionOpen.value = true;
    };
    const closeParameterAction = () => {
        parameterActionOpenRequest += 1;
        parameterActionLoading.value = false;
        parameterActionOpen.value = false;
    };
    const parameterActionTitle = computed(() => {
        const name = parameterAction.node?.title || '节点';
        if (parameterAction.mode === 'edit-value') return `修改值 · ${name}`;
        if (parameterAction.mode === 'add-attribute') return `添加属性 · ${name}`;
        if (parameterAction.mode === 'add-sibling') return `添加同级节点 · ${name}`;
        return `添加子节点 · ${name}`;
    });
    const parameterActionAcceptsValue = computed(() => {
        if (parameterAction.mode === 'add-attribute') return true;
        if (!parameterAction.schemaNode) return !parameterAction.schemaRestricted;
        return ['leaf', 'leaf-list', 'anydata', 'anyxml'].includes(parameterSchemaKeyword(parameterAction.schemaNode));
    });

    const parseXmlFragmentForMutation = value => {
        const parsed = parseXmlFragment(value);
        if (parsed.wrapper || parsed.error || parsed.source) return parsed;
        return parseXmlFragment('<!-- netnexus-empty-fragment -->');
    };
    const normalizeSchemaKeyNames = schemaNode => {
        const rawKeys = Array.isArray(schemaNode?.schemaKey)
            ? schemaNode.schemaKey
            : String(schemaNode?.schemaKey || '').split(/\s+/u);
        return rawKeys.map(parameterLocalName).filter(name => /^[A-Za-z_][\w.-]*$/u.test(name));
    };
    const createParameterXmlElement = (documentNode, name, namespace) => {
        if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/u.test(name)) {
            throw new Error('节点名称不是合法的 XML QName');
        }
        if (name.includes(':') && !namespace) throw new Error('带前缀的节点必须填写命名空间');
        return namespace ? documentNode.createElementNS(namespace, name) : documentNode.createElement(name);
    };
    const applyParameterAddAction = () => {
        const node = parameterAction.node;
        const mode = parameterAction.mode;
        const xmlField = node?.xmlContainerField || node?.xmlField;
        if (!xmlField) throw new Error('当前节点不支持添加 XML 内容');
        const parsed = parseXmlFragmentForMutation(form[xmlField]);
        if (!parsed.wrapper || parsed.error) throw new Error(parsed.error || 'XML 片段无法解析');
        const selectedElement = node.xmlField ? xmlElementAtPath(parsed.wrapper, node.xmlPath) : null;
        const containerElement = node.xmlContainerField
            ? xmlElementAtPath(parsed.wrapper, node.xmlContainerPath || [])
            : selectedElement;
        const targetParent = mode === 'add-sibling' ? selectedElement?.parentElement : containerElement;
        if (!targetParent) throw new Error('无法定位要添加节点的位置');

        const name = String(parameterAction.name || '').trim();
        const namespace = String(parameterAction.namespace || '').trim();
        if (mode === 'add-attribute') {
            if (!selectedElement) throw new Error('只有 XML 元素可以添加属性');
            if (/^xmlns(?::|$)/iu.test(name)) throw new Error('命名空间请通过节点命名空间字段设置');
            if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/u.test(name)) {
                throw new Error('属性名称不是合法的 XML QName');
            }
            if (selectedElement.hasAttribute(name)) throw new Error(`属性 ${name} 已存在`);
            const attributeNamespace = namespace || (name.startsWith('nc:') ? NETCONF_BASE_NAMESPACE : '');
            if (name.includes(':') && !attributeNamespace) throw new Error('带前缀的属性必须填写命名空间');
            if (attributeNamespace) {
                selectedElement.setAttributeNS(attributeNamespace, name, String(parameterAction.value ?? ''));
            } else selectedElement.setAttribute(name, String(parameterAction.value ?? ''));
        } else {
            const element = createParameterXmlElement(parsed.documentNode, name, namespace);
            const schemaNode = parameterAction.schemaNode;
            const schemaKeyword = parameterSchemaKeyword(schemaNode);
            if (activeOperation.value === 'edit-config' && schemaKeyword === 'list') {
                normalizeSchemaKeyNames(schemaNode).forEach(keyName => {
                    const keyElement = createParameterXmlElement(parsed.documentNode, keyName, namespace);
                    keyElement.appendChild(parsed.documentNode.createComment(' NETNEXUS_REQUIRED: 输入 list key 值 '));
                    element.appendChild(keyElement);
                });
            } else if (parameterActionAcceptsValue.value) {
                const value = String(parameterAction.value ?? '');
                if (!value.trim() && schemaNode?.mandatory) {
                    element.appendChild(parsed.documentNode.createComment(' NETNEXUS_REQUIRED: 输入必填值 '));
                } else if (value) {
                    element.appendChild(parsed.documentNode.createTextNode(value));
                }
            }
            targetParent.appendChild(element);
        }
        restoreGeneratedRequest({ silent: true });
        form[xmlField] = serializeXmlFragment(parsed);
    };
    const confirmParameterAction = () => {
        if (
            parameterAction.contextRevision !== props.contextRevision ||
            parameterAction.operation !== activeOperation.value
        ) {
            closeParameterAction();
            notify.warning('操作上下文已经变化，请重新选择参数节点');
            return;
        }
        try {
            if (parameterAction.mode === 'edit-value') {
                updateParameterNode(parameterAction.node, parameterAction.value);
            } else {
                if (parameterAction.schemaRestricted && !parameterAction.schemaNode) {
                    throw new Error('请选择一个可添加的 Schema 节点');
                }
                if (!String(parameterAction.name || '').trim()) throw new Error('请输入节点名称');
                applyParameterAddAction();
            }
            closeParameterAction();
            void nextTick(expandOperationParameterTree);
        } catch (error) {
            notify.warning(error.message);
        }
    };
    const handleParameterContextMenuClick = async ({ key }) => {
        const node = parameterContextMenu.node;
        const parent = parameterContextMenu.parent;
        hideParameterContextMenu();
        if (key === 'edit-value') openParameterEditAction(node);
        else if (key === 'remove-node') removeParameterXmlNode(node);
        else if (['add-child', 'add-sibling', 'add-attribute'].includes(key)) {
            await openParameterAddAction(key, node, parent);
        }
    };

    const operationDisabledReason = operation => {
        if (executing.value) return '操作执行中';
        if (!connected.value) return '请先建立 NETCONF 会话';
        if (operation === 'edit-config' && editDatastoreOptions.value.length === 0) {
            return '设备未声明 :candidate 或 :writable-running 能力';
        }
        if (operation === 'copy-config' && copyTargetDatastoreOptions.value.length === 0) {
            return '没有可复制的目标 datastore';
        }
        if (operation === 'delete-config' && deletableDatastoreOptions.value.length === 0) {
            return '设备未声明 :startup 能力';
        }
        if (operation === 'validate' && !hasCapability('validate')) return '设备未声明 :validate 能力';
        if (['commit', 'cancel-commit', 'discard-changes'].includes(operation) && !hasCapability('candidate')) {
            return '设备未声明 :candidate 能力';
        }
        if (operation === 'cancel-commit' && !hasCapability('confirmedCommit')) {
            return '设备未声明 :confirmed-commit 能力';
        }
        if (operation === 'commit' && form.confirmed && !hasCapability('confirmedCommit')) {
            return '设备未声明 :confirmed-commit 能力';
        }
        return '';
    };
    const isOperationSupported = operation => !operationDisabledReason(operation);

    const hasMissingRequiredParameter = nodes =>
        nodes.some(
            node =>
                (node.required && node.editor && !String(parameterNodeValue(node) ?? '').trim()) ||
                (node.children?.length && hasMissingRequiredParameter(node.children))
        );

    const validateOperation = () => {
        if (!connected.value) return '请先建立 NETCONF 会话';
        if (requestOverrideActive.value) return '';
        if (activeOperation.value === 'edit-config' && editConfigLoading.value) {
            return '正在读取设备当前配置';
        }
        if (activeOperation.value === 'edit-config' && editConfigTargetStale.value) {
            return '目标 datastore 已变化，请先重新读取当前配置';
        }
        if (!isOperationSupported(activeOperation.value)) return operationDisabledReason(activeOperation.value);
        if (hasMissingRequiredParameter(operationParameterTree.value)) return '请补全操作参数树中的必填值';
        if (['get', 'get-config'].includes(activeOperation.value)) {
            if (form.filterType === 'xpath' && !form.xpath.trim()) return '请输入 XPath 表达式';
            if (form.filterType === 'subtree' && !form.subtree.trim()) return '请输入 subtree 过滤内容';
        }
        if (activeOperation.value === 'edit-config') {
            if (!form.target) return '请选择目标 datastore';
            if (!form.config.trim()) return '请输入 config XML';
            if (form.config.includes('NETNEXUS_REQUIRED')) return '请补全 XML 草稿中的必填值和 list key';
        }
        if (activeOperation.value === 'copy-config' && (!form.copySource || !form.copyTarget))
            return '请选择源和目标 datastore';
        if (activeOperation.value === 'delete-config' && !form.deleteTarget) return '请选择要删除的 datastore';
        if (['lock', 'unlock'].includes(activeOperation.value) && !form.lockTarget) return '请选择目标 datastore';
        if (activeOperation.value === 'validate' && !form.validateSource) return '请选择校验源';
        if (activeOperation.value === 'raw-rpc') {
            if (!form.rawRpc.trim()) return '请输入 RPC XML';
            if (form.rawRpc.includes('NETNEXUS_REQUIRED')) return '请补全 RPC 草稿中的必填参数';
        }
        return '';
    };
    const executeDisabledReason = computed(() =>
        executing.value ? '操作执行中' : requestValidating.value ? '正在执行 YANG 数据校验' : validateOperation()
    );

    const escapeXmlAttribute = value =>
        String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;');
    const datastoreElement = value => `<${value}/>`;
    const makeFilterXml = () => {
        if (form.filterType === 'xpath') return `<filter type="xpath" select="${escapeXmlAttribute(form.xpath)}"/>`;
        if (form.filterType === 'subtree') {
            const subtree = form.subtree.trim();
            return /^<filter[\s>]/i.test(subtree) ? subtree : `<filter type="subtree">\n${subtree}\n</filter>`;
        }
        return '';
    };
    const makeConfigXml = () => {
        const config = form.config.trim();
        return /^<config[\s>]/i.test(config) ? config : `<config>\n${config}\n</config>`;
    };
    const operationBody = computed(() => {
        switch (activeOperation.value) {
            case 'get':
                return `<get>${makeFilterXml() ? `\n${makeFilterXml()}\n` : ''}</get>`;
            case 'get-config':
                return `<get-config>\n<source>${datastoreElement(form.source)}</source>${
                    makeFilterXml() ? `\n${makeFilterXml()}` : ''
                }\n</get-config>`;
            case 'edit-config':
                return `<edit-config>\n<target>${datastoreElement(form.target)}</target>\n<default-operation>${
                    form.defaultOperation
                }</default-operation>${supportsTestOption.value ? `\n<test-option>${form.testOption}</test-option>` : ''}\n<error-option>${
                    form.errorOption
                }</error-option>\n${makeConfigXml()}\n</edit-config>`;
            case 'copy-config':
                return `<copy-config>\n<target>${datastoreElement(form.copyTarget)}</target>\n<source>${datastoreElement(
                    form.copySource
                )}</source>\n</copy-config>`;
            case 'delete-config':
                return `<delete-config>\n<target>${datastoreElement(form.deleteTarget)}</target>\n</delete-config>`;
            case 'lock':
            case 'unlock':
                return `<${activeOperation.value}>\n<target>${datastoreElement(form.lockTarget)}</target>\n</${
                    activeOperation.value
                }>`;
            case 'validate':
                return `<validate xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">\n<source>${datastoreElement(
                    form.validateSource
                )}</source>\n</validate>`;
            case 'commit':
                return form.confirmed
                    ? `<commit>\n<confirmed/>\n<confirm-timeout>${form.confirmTimeout}</confirm-timeout>\n</commit>`
                    : '<commit/>';
            case 'cancel-commit':
                return '<cancel-commit/>';
            case 'discard-changes':
                return '<discard-changes/>';
            case 'raw-rpc':
                return form.rawRpc.trim();
            default:
                return '';
        }
    });
    const rpcEnvelopePattern = /^\s*<(?:[A-Za-z_][\w.-]*:)?rpc\b/i;
    const wrapRpc = (body, messageId = 'preview') =>
        `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${escapeXmlAttribute(
            messageId
        )}">\n${body}\n</rpc>`;
    const wrapRpcPreview = body => wrapRpc(body);
    const requestEnvelopeForResult = (data, fallbackXml) => {
        const messageId = String(data?.messageId || '').trim();
        const candidate = String(data?.requestXml || data?.rpc || fallbackXml || '').trim();
        if (!candidate) return '';
        if (!rpcEnvelopePattern.test(candidate)) return wrapRpc(candidate, messageId || 'preview');
        if (!messageId) return candidate;
        return candidate.replace(
            /(\bmessage-id\s*=\s*)(["'])preview\2/i,
            (_match, prefix) => `${prefix}"${escapeXmlAttribute(messageId)}"`
        );
    };
    const requestPreview = computed(() => {
        const body = operationBody.value;
        if (activeOperation.value === 'raw-rpc' && rpcEnvelopePattern.test(body)) return body;
        return wrapRpcPreview(body);
    });
    const currentRequestXml = computed(() => {
        if (requestOverrideActive.value) return requestDraft.value;
        return formatXmlForDisplay(result.request || requestPreview.value);
    });
    const makeEditConfigReadbackRequestXml = (source, subtree) => {
        const content = String(subtree || '').trim();
        const filter = /^<filter[\s>]/i.test(content) ? content : `<filter type="subtree">\n${content}\n</filter>`;
        return wrapRpcPreview(`<get-config>\n<source>${datastoreElement(source)}</source>\n${filter}\n</get-config>`);
    };
    const displayedRequestXml = computed(() => {
        const requestXml = result.request || requestPreview.value;
        return formatXmlForDisplay(requestXml);
    });
    const displayedReplyXml = computed(() =>
        replyDisplayMode.value === 'formatted' ? formatXmlForDisplay(result.reply) : result.reply
    );

    const clearRequestValidation = () => {
        requestValidationRevision += 1;
        requestValidating.value = false;
        Object.assign(requestValidation, {
            status: '',
            diagnostics: [],
            operation: '',
            engine: '',
            performed: false
        });
    };
    const handleRequestEditorInput = value => {
        requestDraft.value = String(value ?? '');
        requestOverrideActive.value = true;
        clearRequestValidation();
        if (result.request) clearResult();
    };
    const restoreGeneratedRequest = (options = {}) => {
        const silent = options?.silent === true;
        const wasOverridden = requestOverrideActive.value;
        requestOverrideActive.value = false;
        requestDraft.value = '';
        clearRequestValidation();
        if (result.request) clearResult();
        if (!silent && wasOverridden) notify.info('已恢复为参数树自动生成的 RPC');
    };
    const applyRequestValidation = (validation, { notifyResult = false } = {}) => {
        const diagnostics = Array.isArray(validation?.diagnostics) ? validation.diagnostics : [];
        Object.assign(requestValidation, {
            status: diagnostics.length
                ? 'error'
                : validation?.validationError || validation?.schemaUnavailable
                  ? 'warning'
                  : 'success',
            diagnostics,
            operation: validation?.operation || '',
            engine: validation?.engine || '',
            performed: validation?.performed === true
        });
        if (notifyResult) {
            if (diagnostics.length) notify.warning(`RPC 验证完成：发现 ${diagnostics.length} 处问题`);
            else if (validation?.validationError) notify.error(validation.validationError);
            else if (validation?.schemaUnavailable) notify.warning('RPC 结构合法，但当前没有已编译的 YANG Schema');
            else {
                const engine = validation?.engine === 'libyang' ? '（libyang）' : '';
                notify.success(`RPC 验证通过${engine}${validation?.operation ? `：${validation.operation}` : ''}`);
            }
        }
        return validation;
    };
    const mergeRequestDiagnostics = diagnostics => {
        const seen = new Set();
        return diagnostics.filter(diagnostic => {
            const key = `${diagnostic?.line || ''}\u0000${diagnostic?.column || ''}\u0000${diagnostic?.message || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };
    const validateRequestEditor = async options => {
        const validationOptions =
            options && typeof options === 'object' && !('currentTarget' in options) ? options : {};
        const notifyResult = validationOptions.notifyResult !== false;
        const source = currentRequestXml.value;
        const structuralValidation = validateNetconfRpc(source);
        if (!structuralValidation.valid) {
            requestValidationRevision += 1;
            requestValidating.value = false;
            return applyRequestValidation(structuralValidation, { notifyResult });
        }
        if (!props.compileId) {
            return applyRequestValidation(
                {
                    ...structuralValidation,
                    engine: 'xml',
                    authoritative: false,
                    performed: false,
                    schemaUnavailable: true
                },
                { notifyResult }
            );
        }

        const revision = ++requestValidationRevision;
        requestValidating.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'validateRpc', {
                profileId: props.profileId,
                compileId: props.compileId,
                rpc: source
            });
            if (revision !== requestValidationRevision || source !== currentRequestXml.value) {
                return { valid: false, stale: true, diagnostics: [], operation: structuralValidation.operation };
            }
            const diagnostics = mergeRequestDiagnostics([
                ...structuralValidation.diagnostics,
                ...(Array.isArray(data?.diagnostics) ? data.diagnostics : [])
            ]);
            return applyRequestValidation(
                {
                    ...data,
                    valid: structuralValidation.valid && data?.valid !== false && diagnostics.length === 0,
                    diagnostics,
                    operation: structuralValidation.operation || data?.operation || '',
                    engine: data?.engine || 'libyang',
                    authoritative: data?.authoritative !== false
                },
                { notifyResult }
            );
        } catch (error) {
            if (revision !== requestValidationRevision || source !== currentRequestXml.value) {
                return { valid: false, stale: true, diagnostics: [], operation: structuralValidation.operation };
            }
            return applyRequestValidation(
                {
                    ...structuralValidation,
                    valid: false,
                    engine: 'libyang',
                    performed: false,
                    validationError: `无法执行 YANG 数据校验：${error.message}`
                },
                { notifyResult }
            );
        } finally {
            if (revision === requestValidationRevision) requestValidating.value = false;
        }
    };
    const formatRequestXml = () => {
        const source = currentRequestXml.value;
        const validation = validateNetconfRpc(source);
        if (!validation.valid) {
            applyRequestValidation(validation, { notifyResult: true });
            return;
        }
        const formatted = formatXmlForDisplay(source);
        if (formatted === source) {
            applyRequestValidation(validation);
            notify.info('当前 RPC 已是格式化状态');
            return;
        }
        if (result.request) clearResult();
        requestDraft.value = formatted;
        requestOverrideActive.value = true;
        clearRequestValidation();
        notify.success('RPC 已格式化');
    };
    const toggleReplyDisplayMode = () => {
        replyDisplayMode.value = replyDisplayMode.value === 'formatted' ? 'raw' : 'formatted';
    };
    const copyXmlText = async (value, label) => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(value);
            notify.success(`${label}已复制`);
        } catch (_error) {
            notify.warning('系统剪贴板不可用');
        }
    };
    const copyRequestXml = () =>
        copyXmlText(props.embedded ? currentRequestXml.value : displayedRequestXml.value, 'RPC 请求');
    const copyReplyXml = () => copyXmlText(displayedReplyXml.value, 'RPC 响应');

    const buildPayload = () => {
        const payload = { operation: activeOperation.value };
        const subtree = form.subtree.trim();
        const filter =
            form.filterType === 'xpath'
                ? { type: 'xpath', select: form.xpath }
                : form.filterType === 'subtree'
                  ? /^<filter[\s>]/i.test(subtree)
                      ? subtree
                      : { type: 'subtree', content: subtree }
                  : undefined;
        if (activeOperation.value === 'get') {
            payload.filter = filter;
        } else if (activeOperation.value === 'get-config') {
            Object.assign(payload, {
                source: form.source,
                filter
            });
        } else if (activeOperation.value === 'edit-config') {
            Object.assign(payload, {
                target: form.target,
                defaultOperation: form.defaultOperation,
                testOption: supportsTestOption.value ? form.testOption : undefined,
                errorOption: form.errorOption,
                config: form.config
            });
        } else if (activeOperation.value === 'copy-config') {
            Object.assign(payload, { source: form.copySource, target: form.copyTarget });
        } else if (activeOperation.value === 'delete-config') payload.target = form.deleteTarget;
        else if (['lock', 'unlock'].includes(activeOperation.value)) payload.target = form.lockTarget;
        else if (activeOperation.value === 'validate') payload.source = form.validateSource;
        else if (activeOperation.value === 'commit') {
            Object.assign(payload, {
                confirmed: form.confirmed,
                confirmTimeout: form.confirmed ? form.confirmTimeout : undefined
            });
        }
        return clonePlain(payload);
    };

    const confirmationDescription = computed(() => {
        if (requestOverrideActive.value) {
            return '将按编辑器中的完整 RPC 原文发送；它可能读取或修改任意设备状态。';
        }
        const operation = activeOperation.value;
        if (operation === 'edit-config') return `将修改 ${form.target} datastore。`;
        if (operation === 'copy-config') return `将 ${form.copySource} 覆盖复制到 ${form.copyTarget}。`;
        if (operation === 'delete-config') return `将删除整个 ${form.deleteTarget} datastore。`;
        if (operation === 'commit') return '将 candidate 修改提交至 running。';
        if (operation === 'cancel-commit') return '将取消当前会话尚未确认的 confirmed commit。';
        if (operation === 'discard-changes') return '将永久放弃 candidate 中尚未提交的修改。';
        if (operation === 'lock') return `将锁定 ${form.lockTarget}。`;
        if (operation === 'unlock') return `将解锁 ${form.lockTarget}。`;
        if (operation === 'raw-rpc') return '原始 RPC 可能读取或修改任意设备状态。';
        return `即将执行 ${activeOperationMeta.value.label}。`;
    });

    const requestExecute = async () => {
        const error = validateOperation();
        if (error) {
            notify.warning(error);
            return;
        }
        const validation = await validateRequestEditor({ notifyResult: false });
        if (!validation.valid) {
            if (!validation.stale) {
                notify.warning(
                    validation.validationError ||
                        `RPC 验证失败：${validation.diagnostics[0]?.message || '请输入合法报文'}`
                );
            }
            return;
        }
        if (!requestOverrideActive.value && activeOperationMeta.value.category === 'read') {
            void executeOperation();
            return;
        }
        confirmationOpen.value = true;
    };

    const confirmAndExecute = async () => {
        const error = validateOperation();
        const validation = error ? null : await validateRequestEditor({ notifyResult: false });
        if (error || !validation?.valid) {
            confirmationOpen.value = false;
            if (!validation?.stale) {
                notify.warning(
                    error ||
                        validation?.validationError ||
                        `RPC 验证失败：${validation?.diagnostics?.[0]?.message || '请输入合法报文'}`
                );
            }
            return;
        }
        confirmationOpen.value = false;
        void executeOperation();
    };

    const resultText = data => {
        if (typeof data === 'string') return data;
        const value = data?.reply || data?.xml || data?.rpcReply || data?.data;
        if (typeof value === 'string') return value;
        return JSON.stringify(value ?? data ?? {}, null, 2);
    };

    const beginOperationHistory = ({ operation, operationLabel, category, origin, requestXml }) =>
        beginNetconfExecution({
            operation,
            operationLabel,
            category,
            origin,
            requestXml,
            profileId: session.value.profileId,
            profileName: session.value.profileName,
            host: session.value.host,
            port: session.value.port,
            sessionId: session.value.sessionId,
            contextPath: props.contextNode?.path,
            contextName: props.contextNode?.name || props.contextNode?.title
        });

    const executeOperation = async () => {
        if (executing.value) return;
        const manualRequest = requestOverrideActive.value;
        const manualValidation = manualRequest ? validateNetconfRpc(currentRequestXml.value) : null;
        if (manualRequest && !manualValidation.valid) {
            applyRequestValidation(manualValidation);
            notify.warning(`RPC 验证失败：${manualValidation.diagnostics[0]?.message || '请输入合法报文'}`);
            return;
        }
        executing.value = true;
        emit('executing-change', true);
        const startedAt = performance.now();
        const operation = manualRequest ? manualValidation.operation || 'raw-rpc' : activeOperation.value;
        const operationLabel = manualRequest ? `${operation}（手工 RPC）` : activeOperationMeta.value.label;
        const executionContextRevision = props.contextRevision;
        const requestXml = manualRequest ? currentRequestXml.value : requestPreview.value;
        const operationRequest = manualRequest || operation === 'raw-rpc' ? { rpc: requestXml } : buildPayload();
        const request = { ...operationRequest, profileId: props.profileId };
        const method = manualRequest || operation === 'raw-rpc' ? 'sendRpc' : 'executeOperation';
        const historyId = beginOperationHistory({
            operation,
            operationLabel,
            category: manualRequest ? 'danger' : activeOperationMeta.value.category,
            origin: 'manual',
            requestXml
        });
        clearResult();
        result.request = requestXml;
        try {
            const { data } = await invokeBridge('netconfApi', method, request);
            const status = data?.errors?.length ? 'error' : 'success';
            const duration = Math.max(0, Math.round(performance.now() - startedAt));
            const reply = resultText(data);
            const actualRequestXml = requestEnvelopeForResult(data, requestXml);
            completeNetconfExecution(historyId, {
                status: status === 'success' ? 'success' : 'rpc-error',
                requestXml: actualRequestXml,
                replyXml: reply,
                messageId: data?.messageId || '',
                duration,
                errors: Array.isArray(data?.errors) ? data.errors : [],
                errorMessage: status === 'error' ? data.errors[0]?.message || data.errors[0]?.tag || '' : ''
            });
            const contextUnchanged = executionContextRevision === props.contextRevision;
            if (contextUnchanged) {
                if (manualRequest) requestDraft.value = actualRequestXml;
                result.status = status;
                result.operation = operationLabel;
                result.reply = reply;
                result.request = actualRequestXml;
                result.messageId = data?.messageId || '';
                result.duration = duration;
                result.time = new Date().toLocaleString();
            }
            const contextSuffix = contextUnchanged ? '' : '（工作区上下文已切换）';
            if (status === 'success') notify.success(`${operationLabel} 执行成功${contextSuffix}`);
            else notify.error(`${operationLabel} 返回 rpc-error${contextSuffix}`);
        } catch (error) {
            const duration = Math.max(0, Math.round(performance.now() - startedAt));
            const details = error.details || {};
            const failedRequestXml = requestEnvelopeForResult(details, requestXml);
            const failedReplyXml = details.replyXml || error.message;
            completeNetconfExecution(historyId, {
                status: 'failed',
                requestXml: failedRequestXml,
                replyXml: failedReplyXml,
                messageId: details.messageId || '',
                duration,
                errors: Array.isArray(details.errors) ? details.errors : [],
                errorMessage: error.message
            });
            const contextUnchanged = executionContextRevision === props.contextRevision;
            if (contextUnchanged) {
                if (manualRequest) requestDraft.value = failedRequestXml;
                result.status = 'error';
                result.operation = operationLabel;
                result.reply = failedReplyXml;
                result.request = failedRequestXml;
                result.messageId = details.messageId || '';
                result.duration = duration;
                result.time = new Date().toLocaleString();
            }
            const contextSuffix = contextUnchanged ? '' : '（工作区上下文已切换）';
            notify.error(`${operationLabel} 执行失败${contextSuffix}：${error.message}`);
        } finally {
            executing.value = false;
            emit('executing-change', false);
        }
    };

    const loadSession = async () => {
        sessionLoading.value = true;
        const requestedProfileId = props.profileId;
        if (!requestedProfileId) {
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            sessionLoading.value = false;
            return;
        }
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState', requestedProfileId);
            if (requestedProfileId !== props.profileId) return;
            session.value = { ...session.value, ...(data || {}) };
        } catch (error) {
            if (requestedProfileId !== props.profileId) return;
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            console.warn('Unable to load NETCONF session state:', error.message);
        } finally {
            if (requestedProfileId === props.profileId) sessionLoading.value = false;
        }
    };

    const handleSessionEvent = payload => {
        const next = normalizeSessionEvent(payload, session.value);
        if (next?.profileId && next.profileId !== props.profileId) return;
        session.value = next;
    };

    const clearResult = () => {
        replyDisplayMode.value = 'formatted';
        Object.assign(result, {
            status: '',
            operation: '',
            reply: '',
            request: '',
            messageId: '',
            duration: null,
            time: ''
        });
    };

    const cancelEditConfigReadback = () => {
        editConfigLoadRevision += 1;
        editConfigLoading.value = false;
    };

    const prefillEditConfig = async ({ resetToFallback = false } = {}) => {
        if (!props.embedded || activeOperation.value !== 'edit-config' || !props.contextSubtree || !form.target) {
            return;
        }

        const requestRevision = ++editConfigLoadRevision;
        const contextRevision = props.contextRevision;
        const source = form.target;
        const startedAt = performance.now();
        const requestXml = makeEditConfigReadbackRequestXml(source, props.contextSubtree);
        const historyId = beginOperationHistory({
            operation: 'get-config',
            operationLabel: 'get-config',
            category: 'read',
            origin: 'edit-config-readback',
            requestXml
        });
        let historyCompleted = false;
        if (resetToFallback) {
            form.config = editConfigFallback;
            editConfigBaseline = form.config;
            editConfigTargetStale.value = false;
        }
        editConfigLoading.value = true;
        editConfigReadbackStatus.value = 'loading';
        editConfigReadbackSource.value = source;

        try {
            const { data } = await invokeBridge('netconfApi', 'executeOperation', {
                profileId: props.profileId,
                operation: 'get-config',
                source,
                filter: { type: 'subtree', content: props.contextSubtree }
            });
            const errors = Array.isArray(data?.errors) ? data.errors : [];
            const duration = Math.max(0, Math.round(performance.now() - startedAt));
            completeNetconfExecution(historyId, {
                status: errors.length ? 'rpc-error' : 'success',
                requestXml: requestEnvelopeForResult(data, requestXml),
                replyXml: resultText(data),
                messageId: data?.messageId || '',
                duration,
                errors,
                errorMessage: errors.length ? errors[0]?.message || errors[0]?.tag || '' : ''
            });
            historyCompleted = true;
            if (
                requestRevision !== editConfigLoadRevision ||
                contextRevision !== props.contextRevision ||
                activeOperation.value !== 'edit-config' ||
                source !== form.target
            ) {
                return;
            }

            if (errors.length) {
                const firstError = errors[0] || {};
                throw new Error(firstError.message || firstError.tag || '设备返回 rpc-error');
            }
            if (data?.empty) {
                form.config = editConfigFallback;
                editConfigBaseline = form.config;
                editConfigTargetStale.value = false;
                editConfigReadbackStatus.value = 'empty';
                void nextTick(expandOperationParameterTree);
                notify.info(`${source} 未返回当前节点配置，已使用 Schema 草稿`);
                return;
            }
            if (!data?.configXml) throw new Error('响应中没有可编辑的 NETCONF config 数据');

            form.config = formatXmlForDisplay(data.configXml);
            editConfigBaseline = form.config;
            editConfigTargetStale.value = false;
            editConfigReadbackStatus.value = 'loaded';
            void nextTick(expandOperationParameterTree);
        } catch (error) {
            if (!historyCompleted) {
                const details = error.details || {};
                completeNetconfExecution(historyId, {
                    status: 'failed',
                    requestXml: requestEnvelopeForResult(details, requestXml),
                    replyXml: details.replyXml || error.message,
                    messageId: details.messageId || '',
                    duration: Math.max(0, Math.round(performance.now() - startedAt)),
                    errors: Array.isArray(details.errors) ? details.errors : [],
                    errorMessage: error.message
                });
            }
            if (requestRevision !== editConfigLoadRevision || contextRevision !== props.contextRevision) return;
            editConfigReadbackStatus.value = 'error';
            notify.warning(`读取 ${source} 当前配置失败：${error.message}；已保留当前草稿`);
        } finally {
            if (requestRevision === editConfigLoadRevision) editConfigLoading.value = false;
        }
    };

    const reloadEditConfig = () => {
        restoreGeneratedRequest({ silent: true });
        void prefillEditConfig();
    };

    const applyOperationContext = () => {
        if (!props.embedded) return;
        parameterSchemaRequestRevision += 1;
        applyingOperationContext = true;
        restoreGeneratedRequest({ silent: true });
        cancelEditConfigReadback();
        hideParameterContextMenu();
        closeParameterAction();
        activeOperation.value = NETCONF_OPERATIONS.some(item => item.key === props.operation) ? props.operation : 'get';
        const contextParams = props.contextParams || {};
        if (typeof contextParams.source === 'string') form.source = contextParams.source;
        if (typeof contextParams.target === 'string') form.target = contextParams.target;
        if (typeof contextParams.copySource === 'string') form.copySource = contextParams.copySource;
        if (typeof contextParams.copyTarget === 'string') form.copyTarget = contextParams.copyTarget;
        if (typeof contextParams.deleteTarget === 'string') form.deleteTarget = contextParams.deleteTarget;
        if (typeof contextParams.lockTarget === 'string') form.lockTarget = contextParams.lockTarget;
        if (typeof contextParams.validateSource === 'string') form.validateSource = contextParams.validateSource;
        if (typeof contextParams.confirmed === 'boolean') form.confirmed = contextParams.confirmed;
        if (Number.isFinite(contextParams.confirmTimeout)) form.confirmTimeout = contextParams.confirmTimeout;
        form.filterType = props.contextSubtree ? 'subtree' : 'none';
        form.xpath = '';
        form.subtree = props.contextSubtree || '';
        editConfigFallback = props.contextConfig || '';
        form.config = editConfigFallback;
        editConfigBaseline = form.config;
        editConfigTargetStale.value = false;
        form.rawRpc = props.contextRawRpc || DEFAULT_RAW_RPC;
        editConfigReadbackStatus.value = 'idle';
        editConfigReadbackSource.value = form.target;
        confirmationOpen.value = false;
        previewOpen.value = false;
        clearResult();
        void nextTick(() => {
            applyingOperationContext = false;
            expandOperationParameterTree();
            if (activeOperation.value === 'edit-config' && props.contextSubtree) void prefillEditConfig();
        });
    };

    const resetOperationParameters = () => applyOperationContext();

    const goToConnections = () => router.push(YANG_ROUTE.CONNECTION);

    const handleParameterContextMenuKeydown = event => {
        if (event.key !== 'Escape' || !parameterContextMenu.visible) return;
        event.preventDefault();
        hideParameterContextMenu(true);
    };
    const handleParameterContextMenuScroll = event => {
        if (event.target instanceof Node && parameterContextMenuRef.value?.contains(event.target)) return;
        hideParameterContextMenu();
    };

    watch(
        form,
        () => {
            if (!executing.value && result.request) clearResult();
            if (!requestOverrideActive.value) clearRequestValidation();
        },
        { deep: true }
    );

    watch(editDatastoreOptions, options => {
        if (!options.some(option => option.value === form.target)) form.target = options[0]?.value || '';
    });
    watch(
        () => form.target,
        (target, previousTarget) => {
            if (
                applyingOperationContext ||
                target === previousTarget ||
                !props.embedded ||
                activeOperation.value !== 'edit-config' ||
                !props.contextSubtree
            ) {
                return;
            }
            if (form.config !== editConfigBaseline) {
                cancelEditConfigReadback();
                editConfigTargetStale.value = true;
                editConfigReadbackStatus.value = 'stale';
                editConfigReadbackSource.value = target;
                notify.warning(`目标已切换为 ${target}，请重新读取当前配置后再执行`);
                return;
            }
            void prefillEditConfig({ resetToFallback: true });
        }
    );
    watch(copyTargetDatastoreOptions, options => {
        if (!options.some(option => option.value === form.copyTarget)) form.copyTarget = options[0]?.value || '';
    });
    watch(deletableDatastoreOptions, options => {
        if (!options.some(option => option.value === form.deleteTarget)) form.deleteTarget = options[0]?.value || '';
    });
    watch(readDatastoreOptions, options => {
        if (!options.some(option => option.value === form.source)) form.source = options[0]?.value || 'running';
        if (!options.some(option => option.value === form.copySource)) form.copySource = options[0]?.value || 'running';
        if (!options.some(option => option.value === form.validateSource))
            form.validateSource = options[0]?.value || 'running';
    });
    watch(capabilities, () => {
        if (!hasCapability('confirmedCommit')) form.confirmed = false;
    });
    watch(errorOptionOptions, options => {
        if (options.find(option => option.value === form.errorOption)?.disabled) {
            form.errorOption = 'stop-on-error';
        }
    });
    watch(requestOptionsCollapsed, collapsed => {
        if (collapsed) {
            stopParameterPaneResize();
            return;
        }
        void nextTick(updateParameterPaneBounds);
    });
    watch(parameterActionOpen, open => {
        if (open) return;
        parameterActionOpenRequest += 1;
        parameterActionLoading.value = false;
    });
    watch(
        () => props.compileId,
        () => {
            parameterSchemaRequestRevision += 1;
            clearRequestValidation();
            parameterSchemaChildrenCache.clear();
            parameterDiscoveredSchemaNodes.value = [];
        }
    );
    watch(
        () => props.profileId,
        () => {
            parameterSchemaRequestRevision += 1;
            cancelEditConfigReadback();
            clearRequestValidation();
            clearResult();
            parameterSchemaChildrenCache.clear();
            parameterDiscoveredSchemaNodes.value = [];
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            void loadSession();
        }
    );
    watch([executing, editConfigLoading], ([isExecuting, isReading]) => {
        if (!isExecuting && !isReading) return;
        hideParameterContextMenu();
        closeParameterAction();
    });
    watch(
        () => [
            props.embedded,
            props.profileId,
            props.operation,
            props.contextNode?.id,
            props.contextNode?.path,
            props.contextSubtree,
            props.contextConfig,
            props.contextRawRpc,
            props.contextParams,
            props.contextRevision
        ],
        applyOperationContext,
        { immediate: true }
    );

    onMounted(() => {
        EventBus.on(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.OPERATIONS, handleSessionEvent);
        document.addEventListener('keydown', handleParameterContextMenuKeydown);
        document.addEventListener('pointerdown', handleParameterContextMenuPointerDown, true);
        window.addEventListener('resize', hideParameterContextMenu);
        window.addEventListener('scroll', handleParameterContextMenuScroll, true);
        loadSession();
    });

    onActivated(() => {
        loadSession();
        if (
            props.embedded &&
            activeOperation.value === 'edit-config' &&
            props.contextSubtree &&
            editConfigReadbackStatus.value === 'idle'
        ) {
            void prefillEditConfig();
        }
    });

    onDeactivated(() => {
        stopRequestPaneResize();
        stopParameterPaneResize();
        hideParameterContextMenu();
        closeParameterAction();
        const readbackWasLoading = editConfigLoading.value;
        cancelEditConfigReadback();
        if (readbackWasLoading) editConfigReadbackStatus.value = 'idle';
        confirmationOpen.value = false;
        previewOpen.value = false;
    });

    onBeforeUnmount(() => {
        cancelEditConfigReadback();
        stopParameterPaneResize();
        hideParameterContextMenu();
        EventBus.off(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.OPERATIONS);
        document.removeEventListener('keydown', handleParameterContextMenuKeydown);
        document.removeEventListener('pointerdown', handleParameterContextMenuPointerDown, true);
        window.removeEventListener('resize', hideParameterContextMenu);
        window.removeEventListener('scroll', handleParameterContextMenuScroll, true);
    });
</script>

<style scoped>
    .yang-operations-page {
        display: flex;
        min-height: 0;
        flex-direction: column;
        gap: 8px;
    }

    .yang-operations-embedded {
        width: 100%;
        min-width: 0;
        height: 100%;
        flex: 1 1 auto;
        overflow: hidden;
    }

    .operation-session-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .session-summary {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 10px;
    }

    .session-indicator {
        width: 10px;
        height: 10px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
        box-shadow: 0 0 0 3px var(--nn-color-bg-muted);
    }

    .session-indicator-online {
        background: var(--nn-color-success);
        box-shadow: 0 0 0 3px var(--nn-color-bg-success-subtle);
    }

    .session-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .session-detail {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .operations-layout {
        display: grid;
        min-height: 620px;
        grid-template-columns: 190px minmax(450px, 1fr) minmax(340px, 42%);
        gap: 8px;
        align-items: stretch;
    }

    .operations-layout-embedded {
        min-height: 0;
        flex: 1;
        grid-template-columns: minmax(320px, 1fr) 8px var(--parameter-pane-width, 320px);
        grid-template-rows: minmax(0, 1fr);
        gap: 0;
        overflow: hidden;
    }

    .operations-layout-embedded.operations-layout-parameters-collapsed {
        grid-template-columns: minmax(0, 1fr) 0 38px;
    }

    .operations-message-contents {
        display: contents;
    }

    .operations-message-stack {
        display: grid;
        min-width: 0;
        min-height: 0;
        grid-column: 1;
        grid-row: 1;
        grid-template-rows: var(--request-pane-height, 50%) 8px minmax(200px, 1fr);
        overflow: hidden;
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
    .yang-operations-resizing .operations-row-resizer .pane-resizer-grip {
        height: 3px;
        background: var(--nn-color-primary);
    }

    .operations-column-resizer {
        display: flex;
        min-width: 8px;
        min-height: 0;
        grid-column: 2;
        grid-row: 1;
        align-items: center;
        justify-content: center;
        cursor: col-resize;
        outline: none;
        touch-action: none;
        user-select: none;
    }

    .operations-column-resizer .pane-resizer-grip {
        width: 2px;
        height: 34px;
        border-radius: 999px;
        background: var(--nn-color-border-light);
        transition:
            width 0.15s ease,
            background-color 0.15s ease;
    }

    .operations-column-resizer:hover .pane-resizer-grip,
    .operations-column-resizer:focus-visible .pane-resizer-grip,
    .yang-operations-parameter-resizing .operations-column-resizer .pane-resizer-grip {
        width: 3px;
        background: var(--nn-color-primary);
    }

    .operation-nav-card,
    .operation-form-card,
    .operation-result-card {
        min-width: 0;
        min-height: 0;
    }

    .operation-nav-card :deep(.nn-card-body) {
        padding: 6px !important;
    }

    .operation-nav {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .operation-group-title {
        margin: 8px 7px 3px;
        color: var(--nn-color-text-muted);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }

    .operation-group-title:first-child {
        margin-top: 2px;
    }

    .operation-nav-wrap {
        display: block;
        width: 100%;
    }

    .operation-nav-item {
        display: flex;
        width: 100%;
        min-height: 31px;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 5px 8px;
        border: 1px solid transparent;
        border-radius: 5px;
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        text-align: left;
    }

    .operation-nav-item:hover:not(:disabled) {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .operation-nav-item-active {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-primary);
        font-weight: 600;
    }

    .operation-nav-item:disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .operation-kind {
        padding: 0 3px;
        border-radius: 3px;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
        font-family: var(--nn-font-family);
        font-size: 8px;
        font-weight: 600;
        line-height: 15px;
    }

    .operation-kind-write {
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-warning);
    }

    .operation-kind-danger {
        background: var(--nn-color-bg-danger-subtle);
        color: var(--nn-color-error);
    }

    .operation-form-card {
        display: flex;
        flex-direction: column;
    }

    .operation-form-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
    }

    .operation-form-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .operation-form {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        padding-right: 3px;
    }

    .request-browser-toolbar,
    .result-browser-toolbar {
        display: flex;
        min-width: 0;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding-bottom: 7px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .request-browser-toolbar {
        margin-bottom: 8px;
    }

    .request-browser-label {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .request-browser-actions {
        min-width: 0;
        flex: 0 0 auto;
    }

    .request-regenerate-action {
        width: 76px;
        min-width: 76px;
        flex: 0 0 76px;
    }

    .request-toolbar-action {
        width: 60px;
        min-width: 60px;
        flex: 0 0 60px;
    }

    .request-copy-action {
        width: 72px;
        min-width: 72px;
        flex: 0 0 72px;
    }

    .operation-parameters-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        grid-column: 3;
        grid-row: 1;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        background: var(--nn-color-bg-surface);
    }

    .operation-parameters-panel-collapsed {
        border-radius: 0 4px 4px 0;
    }

    .operation-parameters-header {
        display: flex;
        min-height: 42px;
        flex: 0 0 auto;
        align-items: center;
        align-content: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .operation-parameters-heading {
        display: flex;
        min-width: 0;
        flex: 1 1 120px;
        align-items: center;
        gap: 6px;
    }

    .operation-parameters-actions {
        display: flex;
        min-width: 0;
        flex: 1 1 92px;
        gap: 4px;
    }

    .operation-parameters-actions :deep(.nn-button) {
        min-width: 0;
        flex: 1 1 0;
        padding-inline: 4px;
    }

    .operation-parameters-title {
        color: var(--nn-color-text-strong);
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
    }

    .operation-parameters-operation {
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 400;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .operation-parameters-rail {
        display: flex;
        width: 100%;
        height: 100%;
        align-items: flex-start;
        justify-content: center;
        padding: 10px 0;
        border: 0;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-strong);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        outline: none;
    }

    .operation-parameters-rail:hover,
    .operation-parameters-rail:focus-visible {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .operation-parameters-rail:focus-visible {
        box-shadow: inset 0 0 0 2px var(--nn-color-primary);
    }

    .operation-parameters-rail > span {
        letter-spacing: 0.08em;
        writing-mode: vertical-rl;
    }

    .operation-parameters-tree-scroll {
        min-width: 0;
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
    }

    .operation-parameters-tree-scroll :deep(.nn-tree) {
        display: block;
        width: 100%;
    }

    .operation-parameters-tree-scroll :deep(.nn-tree-node) {
        box-sizing: border-box;
        width: 100%;
        min-width: 100%;
        align-items: center;
    }

    .operation-parameters-tree-scroll :deep(.nn-tree-node-content),
    .operation-parameters-tree-scroll :deep(.nn-tree-title) {
        min-width: 0;
        max-width: 100%;
    }

    .schema-node-title {
        display: inline-flex;
        max-width: 100%;
        align-items: center;
        gap: 5px;
        font-size: 12px;
    }

    .schema-node-icon {
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

    .schema-node-icon-container,
    .schema-node-icon-operation {
        color: var(--nn-color-primary);
    }

    .schema-node-icon-list {
        color: var(--nn-color-text-info);
    }

    .schema-node-icon-leaf {
        color: var(--nn-color-text-success);
    }

    .schema-node-icon-key {
        color: var(--nn-color-text-warning);
    }

    .schema-node-icon-attribute,
    .schema-node-icon-fallback {
        color: var(--nn-color-text-muted);
    }

    .schema-node-name {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .schema-node-keyword,
    .schema-node-module,
    .schema-node-access {
        flex: 0 0 auto;
        padding: 0 4px;
        border-radius: 3px;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
        font-size: 10px;
        line-height: 17px;
    }

    .schema-node-module {
        min-width: 0;
        overflow: hidden;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-muted);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .schema-node-access {
        background: var(--nn-color-bg-success-subtle);
        color: var(--nn-color-text-success);
    }

    .schema-node-state {
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-warning);
    }

    .operation-parameter-value-summary {
        max-width: 150px;
        flex: 0 1 auto;
    }

    .operation-parameter-context-menu {
        position: fixed;
        z-index: 1400;
        width: 260px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        padding: 4px 0;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-elevated);
    }

    .operation-parameter-context-menu-title {
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

    .operation-parameter-context-menu-title > span:first-child,
    .operation-parameter-context-menu-path {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .operation-parameter-context-menu-title > span:last-child {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 500;
    }

    .operation-parameter-context-menu-path {
        padding: 1px 12px 6px;
        border-bottom: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
    }

    .operation-parameter-context-menu-list {
        border-inline-end: 0;
    }

    .operation-parameter-context-menu-list :deep(.nn-menu-item) {
        height: 30px;
        min-height: 30px;
        margin: 2px 4px;
        padding-block: 3px;
        border-radius: 4px;
        line-height: 24px;
    }

    .operation-parameter-context-menu-list :deep(.nn-menu-divider) {
        margin: 4px 0;
    }

    .operation-parameter-context-menu-hint {
        padding: 6px 12px 4px;
        border-top: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text-muted);
        font-size: 11px;
        line-height: 17px;
    }

    .operation-parameter-action-form {
        min-height: 120px;
    }

    .operation-parameter-action-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
    }

    .edit-config-readback-bar {
        display: flex;
        min-width: 0;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 8px 8px 0;
        padding: 6px 8px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        background: var(--nn-color-bg-muted);
    }

    .edit-config-readback-status {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .edit-config-readback-status > span:last-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .operation-parameters-panel .edit-config-readback-bar {
        align-items: stretch;
        flex-direction: column;
    }

    .operation-parameters-panel .edit-config-readback-status {
        align-items: flex-start;
    }

    .operation-parameters-panel .edit-config-readback-status > span:last-child {
        white-space: normal;
    }

    .xml-display-toggle {
        width: 72px;
        min-width: 72px;
        flex: 0 0 72px;
    }

    .rpc-request-preview {
        --xml-code-line-height: 1.55em;
        --xml-code-padding-block: 10px;
        --xml-code-padding-inline: 10px;
        min-height: 0;
        flex: 1;
        margin: 0;
        overflow: hidden;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        tab-size: 2;
    }

    .rpc-request-editor :deep(.xml-code-editor-highlight),
    .rpc-request-editor :deep(.xml-code-editor-input) {
        height: 100%;
        min-height: 0;
    }

    .rpc-request-editor :deep(.xml-code-editor-input) {
        resize: none;
    }

    .xml-editor {
        min-height: 190px;
        resize: none;
        background: var(--nn-color-bg-code);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.5;
        tab-size: 2;
    }

    .xml-editor-large,
    .xml-editor-raw {
        min-height: 310px;
    }

    .operation-footer {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .operation-confirmation-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
    }

    .operation-execute-wrap {
        display: inline-flex;
    }

    .operation-execute-wrap :deep(.nn-button) {
        min-width: 138px;
    }

    .confirmation-hint {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .operation-result-card {
        display: flex;
        flex-direction: column;
    }

    .operation-result-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
    }

    .result-duration {
        color: var(--nn-color-text-card-head-ghost);
        font-size: 11px;
    }

    .result-summary {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        gap: 10px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
    }

    .result-browser-toolbar {
        margin-bottom: 8px;
    }

    .rpc-preview {
        min-height: 0;
        margin: 0;
        overflow: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre;
    }

    .rpc-result {
        --xml-code-line-height: 1.55em;
        --xml-code-padding-block: 10px;
        --xml-code-padding-inline: 10px;
        min-height: 0;
        flex: 1;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-code);
        font-size: 12px;
    }

    .rpc-result :deep(.xml-code-editor-highlight),
    .rpc-result :deep(.xml-code-editor-input) {
        height: 100%;
        min-height: 0;
    }

    .rpc-result :deep(.xml-code-editor-input) {
        resize: none;
    }

    .rpc-preview {
        max-height: 65vh;
        padding: 12px;
        white-space: pre;
    }

    .rpc-result-error {
        border-color: var(--nn-color-border-danger);
    }

    .yang-operations-embedded .operation-form-card,
    .yang-operations-embedded .operation-result-card {
        overflow: hidden;
        border-radius: 4px;
    }

    .yang-operations-embedded :deep(.operation-form-card > .nn-card-head),
    .yang-operations-embedded :deep(.operation-result-card > .nn-card-head) {
        min-height: 34px;
        padding: 0 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        border-radius: 4px 4px 0 0;
        background: var(--nn-color-bg-muted);
    }

    .yang-operations-embedded :deep(.operation-form-card > .nn-card-head .nn-card-head-title),
    .yang-operations-embedded :deep(.operation-result-card > .nn-card-head .nn-card-head-title) {
        padding: 7px 0;
        color: var(--nn-color-text-strong);
        font-size: 12px;
    }

    .yang-operations-embedded :deep(.operation-form-card > .nn-card-head .nn-card-extra),
    .yang-operations-embedded :deep(.operation-result-card > .nn-card-head .nn-card-extra),
    .yang-operations-embedded .result-duration {
        color: var(--nn-color-text-muted);
    }

    .yang-operations-embedded :deep(.operation-form-card > .nn-card-body),
    .yang-operations-embedded :deep(.operation-result-card > .nn-card-body) {
        padding: 8px;
    }

    @media (max-width: 1180px) {
        .operations-layout {
            grid-template-columns: 180px minmax(450px, 1fr);
        }

        .operation-result-card {
            min-height: 420px;
            grid-column: 1 / -1;
        }

        .operations-layout-embedded {
            grid-template-columns: minmax(320px, 1fr) 8px var(--parameter-pane-width, 320px);
        }

        .operations-layout-embedded.operations-layout-parameters-collapsed {
            grid-template-columns: minmax(0, 1fr) 0 38px;
        }

        .operations-layout-embedded .operation-result-card {
            min-height: 0;
            grid-column: auto;
        }
    }
</style>
