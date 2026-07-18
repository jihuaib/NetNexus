<template>
    <div class="nn-container yang-operations-page">
        <div class="operation-session-bar">
            <div class="session-summary">
                <span class="session-indicator" :class="{ 'session-indicator-online': connected }" />
                <div>
                    <div class="session-title">{{ connected ? 'NETCONF 会话已连接' : 'NETCONF 会话未连接' }}</div>
                    <div class="session-detail">
                        <template v-if="connected">
                            Session {{ session.sessionId || '-' }} ·
                            {{ session.profileName || session.host || '设备' }} · {{ capabilities.length }} 项能力
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

        <div class="operations-layout">
            <nn-card title="操作" class="operation-nav-card">
                <div class="operation-nav">
                    <div class="operation-group-title">读取</div>
                    <template v-for="operation in readOperations" :key="operation.key">
                        <nn-tooltip :title="operationDisabledReason(operation.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operation.key }"
                                    :disabled="!isOperationSupported(operation.key)"
                                    @click="activeOperation = operation.key"
                                >
                                    <span>{{ operation.label }}</span>
                                    <span class="operation-kind">READ</span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>

                    <div class="operation-group-title">配置与事务</div>
                    <template v-for="operation in writeOperations" :key="operation.key">
                        <nn-tooltip :title="operationDisabledReason(operation.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operation.key }"
                                    :disabled="!isOperationSupported(operation.key)"
                                    @click="activeOperation = operation.key"
                                >
                                    <span>{{ operation.label }}</span>
                                    <span :class="['operation-kind', `operation-kind-${operation.category}`]">
                                        {{ operation.category === 'danger' ? 'RISK' : 'WRITE' }}
                                    </span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>

                    <div class="operation-group-title">高级</div>
                    <template v-for="operation in advancedOperations" :key="operation.key">
                        <nn-tooltip :title="operationDisabledReason(operation.key)">
                            <span class="operation-nav-wrap">
                                <button
                                    type="button"
                                    class="operation-nav-item"
                                    :class="{ 'operation-nav-item-active': activeOperation === operation.key }"
                                    :disabled="!isOperationSupported(operation.key)"
                                    @click="activeOperation = operation.key"
                                >
                                    <span>{{ operation.label }}</span>
                                    <span class="operation-kind operation-kind-danger">RAW</span>
                                </button>
                            </span>
                        </nn-tooltip>
                    </template>
                </div>
            </nn-card>

            <nn-card class="operation-form-card">
                <template #title>
                    <span class="operation-form-title">
                        {{ activeOperationMeta.label }}
                        <nn-tag :color="activeOperationMeta.category === 'read' ? 'blue' : 'warning'">
                            {{ activeOperationMeta.category === 'read' ? '只读' : '需要确认' }}
                        </nn-tag>
                    </span>
                </template>
                <template #extra>
                    <nn-button :disabled="!connected" @click="capabilityDrawerOpen = true">
                        Capability {{ capabilities.length }}
                    </nn-button>
                </template>

                <nn-form :model="form" :label-col="labelCol" class="operation-form">
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
                            <nn-textarea
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
                                    <nn-select v-model:value="form.target" :options="writeDatastoreOptions" />
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
                                        :disabled="!hasCapability('validate')"
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
                            <nn-textarea
                                v-model:value="form.config"
                                :rows="15"
                                placeholder="输入 <config> 内容；支持命名空间与 nc:operation 属性"
                                class="xml-editor xml-editor-large"
                            />
                        </nn-form-item>
                    </template>

                    <template v-else-if="activeOperation === 'copy-config'">
                        <nn-form-item label="源 datastore" required>
                            <nn-select v-model:value="form.copySource" :options="readDatastoreOptions" />
                        </nn-form-item>
                        <nn-form-item label="目标 datastore" required>
                            <nn-select v-model:value="form.copyTarget" :options="writeDatastoreOptions" />
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
                            description="delete-config 会删除整个目标 datastore。running 不允许被删除。"
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
                            <nn-checkbox v-model:checked="form.confirmed" :disabled="!hasCapability('confirmedCommit')">
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

                    <template v-else-if="activeOperation === 'raw-rpc'">
                        <nn-form-item label="RPC XML" required>
                            <nn-textarea
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
                            description="请检查命名空间、目标 datastore 与操作影响；发送前会再次确认。"
                        />
                    </template>
                </nn-form>

                <div class="operation-footer">
                    <nn-space>
                        <nn-button @click="previewOpen = true">
                            <template #icon><EyeOutlined /></template>
                            请求预览
                        </nn-button>
                        <nn-tooltip :title="executeDisabledReason">
                            <span class="operation-execute-wrap">
                                <nn-button
                                    type="primary"
                                    :danger="activeOperationMeta.category === 'danger'"
                                    :loading="executing"
                                    :disabled="Boolean(executeDisabledReason)"
                                    @click="requestExecute"
                                >
                                    <template #icon><SendOutlined /></template>
                                    执行 {{ activeOperationMeta.label }}
                                </nn-button>
                            </span>
                        </nn-tooltip>
                    </nn-space>
                    <span class="confirmation-hint">
                        {{ activeOperationMeta.category === 'read' ? '只读操作将直接发送' : '发送前需要二次确认' }}
                    </span>
                </div>
            </nn-card>

            <nn-card title="RPC 结果" class="operation-result-card">
                <template #extra>
                    <nn-space>
                        <nn-tag v-if="result.status" :color="result.status === 'success' ? 'success' : 'error'">
                            {{ result.status === 'success' ? '成功' : '失败' }}
                        </nn-tag>
                        <span v-if="result.duration !== null" class="result-duration">{{ result.duration }} ms</span>
                        <nn-button size="small" :disabled="!result.reply" @click="clearResult">清空</nn-button>
                    </nn-space>
                </template>

                <div v-if="result.status" class="result-summary">
                    <span>{{ result.operation }}</span>
                    <span>{{ result.time }}</span>
                    <span v-if="result.messageId">message-id: {{ result.messageId }}</span>
                </div>
                <pre
                    v-if="result.reply"
                    class="rpc-result"
                    :class="{ 'rpc-result-error': result.status === 'error' }"
                    >{{ result.reply }}</pre
                >
                <nn-empty v-else description="执行操作后在这里查看 rpc-reply" />
            </nn-card>
        </div>

        <nn-modal
            v-model:open="previewOpen"
            :title="`${activeOperationMeta.label} 请求预览`"
            :footer="null"
            width="820px"
        >
            <pre class="rpc-preview">{{ requestPreview }}</pre>
        </nn-modal>

        <nn-drawer v-model:open="capabilityDrawerOpen" title="设备 Capability" width="760px">
            <nn-input-search v-model:value="capabilityQuery" allow-clear placeholder="筛选 capability URI" />
            <div class="capability-list">
                <div v-for="capability in filteredCapabilities" :key="capability" class="capability-row">
                    <nn-typography-text copyable>{{ capability }}</nn-typography-text>
                </div>
                <nn-empty v-if="filteredCapabilities.length === 0" description="暂无 Capability" />
            </div>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { EyeOutlined, ReloadOutlined, SendOutlined } from '../../ui/icons';
    import { clonePlain, invokeBridge, normalizeCapability, normalizeSessionEvent, unwrapArray } from './yangUiUtils';

    defineOptions({ name: 'YangOperations' });

    const router = useRouter();
    const labelCol = { style: { width: '132px' } };
    const activeOperation = ref('get');
    const sessionLoading = ref(false);
    const executing = ref(false);
    const session = ref({ status: NETCONF_SESSION_STATUS.DISCONNECTED, capabilities: [] });
    const previewOpen = ref(false);
    const capabilityDrawerOpen = ref(false);
    const capabilityQuery = ref('');
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
        rawRpc: '<get>\n  <filter type="subtree">\n    <!-- subtree filter -->\n  </filter>\n</get>'
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
    const activeOperationMeta = computed(
        () => NETCONF_OPERATIONS.find(operation => operation.key === activeOperation.value) || NETCONF_OPERATIONS[0]
    );
    const filteredCapabilities = computed(() => {
        const query = capabilityQuery.value.trim().toLowerCase();
        return query
            ? capabilities.value.filter(capability => capability.toLowerCase().includes(query))
            : capabilities.value;
    });

    const capabilityIncludes = hint =>
        capabilities.value.some(capability => capability.toLowerCase().includes(hint.toLowerCase()));
    const hasCapability = name => capabilityIncludes(NETCONF_CAPABILITY_HINTS[name] || name);

    const readDatastoreOptions = computed(() => {
        const options = [{ label: 'running', value: 'running' }];
        if (hasCapability('candidate')) options.push({ label: 'candidate', value: 'candidate' });
        if (hasCapability('startup')) options.push({ label: 'startup', value: 'startup' });
        return options;
    });
    const writeDatastoreOptions = computed(() => {
        const options = [];
        if (hasCapability('candidate')) options.push({ label: 'candidate', value: 'candidate' });
        if (hasCapability('writableRunning')) options.push({ label: 'running', value: 'running' });
        if (hasCapability('startup')) options.push({ label: 'startup', value: 'startup' });
        return options;
    });
    const deletableDatastoreOptions = computed(() =>
        writeDatastoreOptions.value.filter(option => option.value !== 'running')
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

    const operationDisabledReason = operation => {
        if (!connected.value) return '请先建立 NETCONF 会话';
        if (operation === 'edit-config' && writeDatastoreOptions.value.length === 0) {
            return '设备未声明 :candidate、:writable-running 或 :startup 能力';
        }
        if (operation === 'copy-config' && writeDatastoreOptions.value.length === 0) return '没有可写的目标 datastore';
        if (operation === 'delete-config' && deletableDatastoreOptions.value.length === 0) {
            return '设备没有允许删除的 candidate/startup datastore';
        }
        if (operation === 'validate' && !hasCapability('validate')) return '设备未声明 :validate 能力';
        if (['commit', 'discard-changes'].includes(operation) && !hasCapability('candidate')) {
            return '设备未声明 :candidate 能力';
        }
        return '';
    };
    const isOperationSupported = operation => !operationDisabledReason(operation);

    const validateOperation = () => {
        if (!connected.value) return '请先建立 NETCONF 会话';
        if (!isOperationSupported(activeOperation.value)) return operationDisabledReason(activeOperation.value);
        if (['get', 'get-config'].includes(activeOperation.value)) {
            if (form.filterType === 'xpath' && !form.xpath.trim()) return '请输入 XPath 表达式';
            if (form.filterType === 'subtree' && !form.subtree.trim()) return '请输入 subtree 过滤内容';
        }
        if (activeOperation.value === 'edit-config') {
            if (!form.target) return '请选择目标 datastore';
            if (!form.config.trim()) return '请输入 config XML';
        }
        if (activeOperation.value === 'copy-config' && (!form.copySource || !form.copyTarget))
            return '请选择源和目标 datastore';
        if (activeOperation.value === 'delete-config' && !form.deleteTarget) return '请选择要删除的 datastore';
        if (['lock', 'unlock'].includes(activeOperation.value) && !form.lockTarget) return '请选择目标 datastore';
        if (activeOperation.value === 'validate' && !form.validateSource) return '请选择校验源';
        if (activeOperation.value === 'raw-rpc' && !form.rawRpc.trim()) return '请输入 RPC XML';
        return '';
    };
    const executeDisabledReason = computed(() => (executing.value ? '操作执行中' : validateOperation()));

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
                }</default-operation>${hasCapability('validate') ? `\n<test-option>${form.testOption}</test-option>` : ''}\n<error-option>${
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
            case 'discard-changes':
                return '<discard-changes/>';
            case 'raw-rpc':
                return form.rawRpc.trim();
            default:
                return '';
        }
    });
    const requestPreview = computed(() => {
        const body = operationBody.value;
        if (activeOperation.value === 'raw-rpc' && /^<rpc[\s>]/i.test(body)) return body;
        return `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="preview">\n${body}\n</rpc>`;
    });

    const buildPayload = () => {
        const payload = { operation: activeOperation.value };
        const filter =
            form.filterType === 'xpath'
                ? { type: 'xpath', select: form.xpath }
                : form.filterType === 'subtree'
                  ? { type: 'subtree', content: form.subtree }
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
                testOption: hasCapability('validate') ? form.testOption : undefined,
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
        const operation = activeOperation.value;
        if (operation === 'edit-config') return `将修改 ${form.target} datastore。`;
        if (operation === 'copy-config') return `将 ${form.copySource} 覆盖复制到 ${form.copyTarget}。`;
        if (operation === 'delete-config') return `将删除整个 ${form.deleteTarget} datastore。`;
        if (operation === 'commit') return '将 candidate 修改提交至 running。';
        if (operation === 'discard-changes') return '将永久放弃 candidate 中尚未提交的修改。';
        if (operation === 'lock') return `将锁定 ${form.lockTarget}。`;
        if (operation === 'unlock') return `将解锁 ${form.lockTarget}。`;
        if (operation === 'raw-rpc') return '原始 RPC 可能读取或修改任意设备状态。';
        return `即将执行 ${activeOperationMeta.value.label}。`;
    });

    const requestExecute = () => {
        const error = validateOperation();
        if (error) {
            notify.warning(error);
            return;
        }
        if (activeOperationMeta.value.category === 'read') {
            executeOperation();
            return;
        }
        dialog.confirm({
            title: `确认执行 ${activeOperationMeta.value.label}`,
            content: `${confirmationDescription.value} 请确认目标设备和参数无误。`,
            okText: '确认执行',
            cancelText: '取消',
            okType: activeOperationMeta.value.category === 'danger' ? 'danger' : 'primary',
            onOk: executeOperation
        });
    };

    const resultText = data => {
        if (typeof data === 'string') return data;
        const value = data?.reply || data?.xml || data?.rpcReply || data?.data;
        if (typeof value === 'string') return value;
        return JSON.stringify(value ?? data ?? {}, null, 2);
    };

    const executeOperation = async () => {
        executing.value = true;
        const startedAt = performance.now();
        const operation = activeOperation.value;
        result.status = '';
        result.reply = '';
        try {
            const request = operation === 'raw-rpc' ? { rpc: requestPreview.value } : buildPayload();
            const method = operation === 'raw-rpc' ? 'sendRpc' : 'executeOperation';
            const { data } = await invokeBridge('netconfApi', method, request);
            result.status = data?.errors?.length ? 'error' : 'success';
            result.operation = activeOperationMeta.value.label;
            result.reply = resultText(data);
            result.request = data?.rpc || requestPreview.value;
            result.messageId = data?.messageId || '';
            result.duration = Math.max(0, Math.round(performance.now() - startedAt));
            result.time = new Date().toLocaleString();
            if (result.status === 'success') notify.success(`${activeOperationMeta.value.label} 执行成功`);
            else notify.error(`${activeOperationMeta.value.label} 返回 rpc-error`);
        } catch (error) {
            result.status = 'error';
            result.operation = activeOperationMeta.value.label;
            result.reply = error.message;
            result.request = requestPreview.value;
            result.messageId = '';
            result.duration = Math.max(0, Math.round(performance.now() - startedAt));
            result.time = new Date().toLocaleString();
            notify.error(`${activeOperationMeta.value.label} 执行失败：${error.message}`);
        } finally {
            executing.value = false;
        }
    };

    const loadSession = async () => {
        sessionLoading.value = true;
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState');
            session.value = { ...session.value, ...(data || {}) };
        } catch (error) {
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            console.warn('Unable to load NETCONF session state:', error.message);
        } finally {
            sessionLoading.value = false;
        }
    };

    const handleSessionEvent = payload => {
        session.value = normalizeSessionEvent(payload, session.value);
    };

    const clearResult = () => {
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

    const goToConnections = () => router.push(YANG_ROUTE.CONNECTION);

    watch(writeDatastoreOptions, options => {
        if (!options.some(option => option.value === form.target)) form.target = options[0]?.value || '';
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
    watch(errorOptionOptions, options => {
        if (options.find(option => option.value === form.errorOption)?.disabled) {
            form.errorOption = 'stop-on-error';
        }
    });

    onMounted(() => {
        EventBus.on(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.OPERATIONS, handleSessionEvent);
        loadSession();
    });

    onActivated(loadSession);

    onBeforeUnmount(() => {
        EventBus.off(YANG_EVENT.SESSION_EVENT, YANG_EVENT_PAGE_ID.OPERATIONS);
    });
</script>

<style scoped>
    .yang-operations-page {
        display: flex;
        min-height: 0;
        flex-direction: column;
        gap: 8px;
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

    .operation-nav-card,
    .operation-form-card,
    .operation-result-card {
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

    .xml-editor {
        min-height: 190px;
        resize: vertical;
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

    .operation-execute-wrap {
        display: inline-flex;
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
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 7px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
    }

    .rpc-result,
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
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .rpc-result {
        flex: 1;
        padding: 10px;
    }

    .rpc-preview {
        max-height: 65vh;
        padding: 12px;
        white-space: pre;
    }

    .rpc-result-error {
        border-color: var(--nn-color-border-danger);
        color: var(--nn-color-error);
    }

    .capability-list {
        max-height: calc(100vh - 145px);
        margin-top: 10px;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .capability-row {
        padding: 7px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        overflow-wrap: anywhere;
    }

    .capability-row:last-child {
        border-bottom: 0;
    }

    @media (max-width: 1180px) {
        .operations-layout {
            grid-template-columns: 180px minmax(450px, 1fr);
        }

        .operation-result-card {
            min-height: 420px;
            grid-column: 1 / -1;
        }
    }
</style>
