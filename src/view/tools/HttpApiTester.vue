<template>
    <div class="mt-container http-api-page">
        <a-card title="HTTP API测试" class="http-api-card">
            <template #extra>
                <a-space>
                    <a-tag v-if="pageLoading" color="processing">加载中</a-tag>
                    <a-button type="primary" size="small" @click="createApiConnection">
                        <template #icon>
                            <PlusOutlined />
                        </template>
                        新建
                    </a-button>
                    <a-button size="small" :loading="saveLoading" @click="saveApiConnections">
                        <template #icon>
                            <SaveOutlined />
                        </template>
                        保存
                    </a-button>
                    <a-button size="small" @click="resetBmpDefaults">
                        <template #icon>
                            <ReloadOutlined />
                        </template>
                        BMP默认
                    </a-button>
                </a-space>
            </template>

            <div class="api-workspace">
                <a-empty v-if="apiItems.length === 0" description="暂无API连接" class="empty-api-list">
                    <template #description>
                        <span>暂无API连接</span>
                    </template>
                    <a-button type="primary" @click="resetBmpDefaults">恢复BMP默认API</a-button>
                </a-empty>
                <div v-else class="api-layout">
                    <div class="api-sidebar">
                        <a-dropdown v-for="api in apiItems" :key="api.id" :trigger="['contextmenu']">
                            <div
                                class="api-list-item"
                                :class="{ active: activeKey === api.id }"
                                :title="api.name || '未命名API'"
                                @click="activeKey = api.id"
                            >
                                {{ api.name || '未命名API' }}
                            </div>
                            <template #overlay>
                                <a-menu>
                                    <a-menu-item key="rename" @click="renameApiConnection(api)">
                                        <a-space>
                                            <EditOutlined />
                                            <span>修改名称</span>
                                        </a-space>
                                    </a-menu-item>
                                    <a-menu-item key="copy" @click="copyApiConnection(api)">
                                        <a-space>
                                            <CopyOutlined />
                                            <span>复制</span>
                                        </a-space>
                                    </a-menu-item>
                                    <a-menu-item key="delete" @click="deleteApiConnection(api)">
                                        <a-space class="danger-menu-item">
                                            <DeleteOutlined />
                                            <span>删除</span>
                                        </a-space>
                                    </a-menu-item>
                                </a-menu>
                            </template>
                        </a-dropdown>
                    </div>
                    <div class="api-content">
                        <a-form
                            v-if="activeApi"
                            :model="activeApi"
                            class="api-editor"
                            :colon="false"
                            :label-col="inlineLabelCol"
                            :wrapper-col="inlineWrapperCol"
                        >
                            <div class="request-panel">
                                <a-row :gutter="8" class="request-basic-row">
                                    <a-col :span="7">
                                        <a-form-item label="方法">
                                            <a-select v-model:value="activeApi.method">
                                                <a-select-option
                                                    v-for="method in httpMethods"
                                                    :key="method"
                                                    :value="method"
                                                >
                                                    {{ method }}
                                                </a-select-option>
                                            </a-select>
                                        </a-form-item>
                                    </a-col>
                                    <a-col :span="17">
                                        <a-form-item label="URL">
                                            <a-input
                                                v-model:value="activeApi.url"
                                                placeholder="http://127.0.0.1:18080/api/v1/status"
                                                @press-enter="sendRequest(activeApi)"
                                            />
                                        </a-form-item>
                                    </a-col>
                                </a-row>

                                <a-row :gutter="8" class="request-action-row">
                                    <a-col :span="6">
                                        <a-form-item label="超时(ms)">
                                            <a-input-number
                                                v-model:value="activeApi.timeout"
                                                :min="1000"
                                                :max="600000"
                                                :step="1000"
                                                style="width: 100%"
                                            />
                                        </a-form-item>
                                    </a-col>
                                    <a-col :span="18">
                                        <a-form-item label="操作">
                                            <a-space class="request-actions">
                                                <a-button
                                                    type="primary"
                                                    :loading="sendingId === activeApi.id"
                                                    @click="sendRequest(activeApi)"
                                                >
                                                    <template #icon>
                                                        <SendOutlined />
                                                    </template>
                                                    发送
                                                </a-button>
                                                <a-button @click="formatRequestBody(activeApi)">格式化JSON</a-button>
                                            </a-space>
                                        </a-form-item>
                                    </a-col>
                                </a-row>

                                <a-tabs v-model:active-key="requestTabKey" size="small" class="request-tabs">
                                    <a-tab-pane key="headers" tab="请求头">
                                        <div class="header-grid">
                                            <div v-if="activeApi.headers.length === 0" class="header-empty-row">
                                                <a-button size="small" type="dashed" @click="addHeader(activeApi)">
                                                    <template #icon>
                                                        <PlusOutlined />
                                                    </template>
                                                    添加请求头
                                                </a-button>
                                            </div>
                                            <div
                                                v-for="header in activeApi.headers"
                                                :key="header.rowId"
                                                class="header-row"
                                            >
                                                <a-checkbox v-model:checked="header.enabled" />
                                                <a-input v-model:value="header.key" placeholder="Header" />
                                                <a-input v-model:value="header.value" placeholder="Value" />
                                                <div class="header-row-actions">
                                                    <a-button type="text" @click="addHeader(activeApi)">
                                                        <template #icon>
                                                            <PlusOutlined />
                                                        </template>
                                                    </a-button>
                                                    <a-button
                                                        type="text"
                                                        danger
                                                        @click="removeHeader(activeApi, header.rowId)"
                                                    >
                                                        <template #icon>
                                                            <DeleteOutlined />
                                                        </template>
                                                    </a-button>
                                                </div>
                                            </div>
                                        </div>
                                    </a-tab-pane>
                                    <a-tab-pane key="body" tab="请求体">
                                        <div class="request-body-pane">
                                            <ScrollTextarea v-model:model-value="activeApi.body" height="100%" />
                                        </div>
                                    </a-tab-pane>
                                </a-tabs>
                            </div>

                            <div class="response-panel">
                                <a-divider>响应</a-divider>
                                <div v-if="activeApi.response" class="response-summary">
                                    <a-tag :color="getStatusColor(activeApi.response.statusCode)">
                                        {{ activeApi.response.statusCode }} {{ activeApi.response.statusMessage }}
                                    </a-tag>
                                    <a-tag color="blue">{{ activeApi.response.durationMs }} ms</a-tag>
                                    <a-tag>{{ formatBytes(activeApi.response.sizeBytes) }}</a-tag>
                                </div>
                                <a-alert
                                    v-if="activeApi.responseError"
                                    class="response-error"
                                    type="error"
                                    :message="activeApi.responseError"
                                    show-icon
                                />
                                <a-tabs v-model:active-key="responseTabKey" size="small" class="response-tabs">
                                    <a-tab-pane key="body" tab="响应体">
                                        <ScrollTextarea :model-value="activeApi.responseBody" height="100%" readonly />
                                    </a-tab-pane>
                                    <a-tab-pane key="headers" tab="响应头">
                                        <ScrollTextarea
                                            :model-value="activeApi.responseHeaders"
                                            height="100%"
                                            readonly
                                        />
                                    </a-tab-pane>
                                </a-tabs>
                            </div>
                        </a-form>
                    </div>
                </div>
            </div>
        </a-card>
    </div>
</template>

<script setup>
    import { computed, h, ref, onActivated, onMounted } from 'vue';
    import { Input, message, Modal } from 'ant-design-vue';
    import {
        CopyOutlined,
        DeleteOutlined,
        EditOutlined,
        PlusOutlined,
        ReloadOutlined,
        SaveOutlined,
        SendOutlined
    } from '@ant-design/icons-vue';
    import ScrollTextarea from '../../components/ScrollTextarea.vue';

    defineOptions({
        name: 'HttpApiTester'
    });

    const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const apiItems = ref([]);
    const activeKey = ref('');
    const requestTabKey = ref('headers');
    const responseTabKey = ref('body');
    const pageLoading = ref(false);
    const saveLoading = ref(false);
    const sendingId = ref('');
    const inlineLabelCol = { style: { width: '70px' } };
    const inlineWrapperCol = { style: { flex: 1, minWidth: 0 } };
    const activeApi = computed(() => apiItems.value.find(item => item.id === activeKey.value) || null);

    function setApiConnections(connections) {
        apiItems.value = connections.map(normalizeApiItem);
        if (!activeKey.value || !apiItems.value.some(item => item.id === activeKey.value)) {
            activeKey.value = apiItems.value[0]?.id || '';
        }
    }

    function makeId(prefix = 'api') {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return `${prefix}-${window.crypto.randomUUID()}`;
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function makeHeader(header = {}) {
        return {
            rowId: makeId('header'),
            enabled: header.enabled !== false,
            key: header.key || '',
            value: header.value || ''
        };
    }

    function normalizeApiItem(item = {}) {
        return {
            id: item.id || makeId('api'),
            name: item.name || '未命名API',
            method: httpMethods.includes(item.method) ? item.method : 'GET',
            url: item.url || '',
            headers: Array.isArray(item.headers) ? item.headers.map(makeHeader) : [],
            body: typeof item.body === 'string' ? item.body : '',
            timeout: Number.isInteger(Number(item.timeout)) ? Number(item.timeout) : 15000,
            response: null,
            responseBody: '',
            responseHeaders: '',
            responseError: ''
        };
    }

    function serializeApiItem(item) {
        return {
            id: item.id,
            name: item.name,
            method: item.method,
            url: item.url,
            headers: item.headers.map(header => ({
                enabled: header.enabled,
                key: header.key,
                value: header.value
            })),
            body: item.body,
            timeout: item.timeout
        };
    }

    async function loadApiConnections() {
        if (!window.toolsApi) {
            message.error('工具API不可用');
            return;
        }

        pageLoading.value = true;
        try {
            const resp = await window.toolsApi.getHttpApiConnections();
            if (resp.status !== 'success') {
                message.error(resp.msg || '获取API连接信息失败');
                return;
            }
            let connections = Array.isArray(resp.data) ? resp.data : [];
            if (connections.length === 0) {
                setApiConnections([]);
                return;
            }
            setApiConnections(connections);
        } catch (error) {
            message.error(error.message || String(error));
        } finally {
            pageLoading.value = false;
        }
    }

    function createApiConnection() {
        const item = normalizeApiItem({
            id: makeId('api'),
            name: '新建API',
            method: 'GET',
            url: 'http://127.0.0.1:18080/',
            headers: [{ enabled: true, key: 'Accept', value: 'application/json' }],
            timeout: 15000
        });
        apiItems.value.push(item);
        activeKey.value = item.id;
    }

    function copyApiConnection(api) {
        const item = normalizeApiItem({
            ...serializeApiItem(api),
            id: makeId('api'),
            name: `${api.name || '未命名API'} Copy`
        });
        apiItems.value.push(item);
        activeKey.value = item.id;
    }

    function renameApiConnection(api) {
        const inputValue = ref(api.name || '');
        Modal.confirm({
            title: '修改API名称',
            okText: '保存',
            cancelText: '取消',
            content: () =>
                h('div', { class: 'rename-api-modal' }, [
                    h(Input, {
                        value: inputValue.value,
                        maxlength: 80,
                        placeholder: '请输入API名称',
                        'onUpdate:value': value => {
                            inputValue.value = value;
                        },
                        onPressEnter: () => {
                            const name = String(inputValue.value || '').trim();
                            if (!name) {
                                message.error('API名称不能为空');
                                return;
                            }
                            api.name = name;
                            Modal.destroyAll();
                        }
                    })
                ]),
            onOk() {
                const name = String(inputValue.value || '').trim();
                if (!name) {
                    message.error('API名称不能为空');
                    return Promise.reject(new Error('API名称不能为空'));
                }
                api.name = name;
                return Promise.resolve();
            }
        });
    }

    function deleteApiConnection(api) {
        const index = apiItems.value.findIndex(item => item.id === api.id);
        if (index === -1) {
            return;
        }
        apiItems.value.splice(index, 1);
        if (activeKey.value === api.id) {
            activeKey.value = apiItems.value[Math.max(0, index - 1)]?.id || apiItems.value[0]?.id || '';
        }
    }

    async function saveApiConnections() {
        saveLoading.value = true;
        try {
            const payload = apiItems.value.map(serializeApiItem);
            const resp = await window.toolsApi.saveHttpApiConnections(payload);
            if (resp.status === 'success') {
                message.success('API连接信息已保存');
            } else {
                message.error(resp.msg || '保存API连接信息失败');
            }
        } catch (error) {
            message.error(error.message || String(error));
        } finally {
            saveLoading.value = false;
        }
    }

    function resetBmpDefaults() {
        Modal.confirm({
            title: '恢复BMP默认API',
            content: '当前API连接列表会被BMP默认接口模板覆盖。',
            okText: '恢复',
            cancelText: '取消',
            async onOk() {
                pageLoading.value = true;
                try {
                    const resp = await window.toolsApi.resetHttpApiConnections();
                    if (resp.status !== 'success') {
                        message.error(resp.msg || '恢复BMP默认API失败');
                        return;
                    }
                    apiItems.value = (resp.data || []).map(normalizeApiItem);
                    activeKey.value = apiItems.value[0]?.id || '';
                    message.success('已恢复BMP默认API');
                } catch (error) {
                    message.error(error.message || String(error));
                } finally {
                    pageLoading.value = false;
                }
            }
        });
    }

    function addHeader(api) {
        api.headers.push(makeHeader({ enabled: true }));
    }

    function removeHeader(api, rowId) {
        const index = api.headers.findIndex(header => header.rowId === rowId);
        if (index >= 0) {
            api.headers.splice(index, 1);
        }
    }

    function formatRequestBody(api) {
        if (!api.body || !api.body.trim()) {
            return;
        }
        try {
            api.body = JSON.stringify(JSON.parse(api.body), null, 4);
        } catch (error) {
            message.error('请求体不是合法JSON');
        }
    }

    function formatResponseBody(body) {
        if (!body) {
            return '';
        }
        try {
            return JSON.stringify(JSON.parse(body), null, 4);
        } catch (_error) {
            return body;
        }
    }

    async function sendRequest(api) {
        if (!api.url || !api.url.trim()) {
            message.error('URL不能为空');
            return;
        }

        sendingId.value = api.id;
        api.response = null;
        api.responseBody = '';
        api.responseHeaders = '';
        api.responseError = '';

        try {
            const resp = await window.toolsApi.sendHttpApiRequest(serializeApiItem(api));
            if (resp.status !== 'success') {
                api.responseError = resp.msg || '请求失败';
                return;
            }

            api.response = resp.data;
            api.responseBody = formatResponseBody(resp.data.body);
            api.responseHeaders = JSON.stringify(resp.data.headers || {}, null, 4);
            if (resp.data.statusCode >= 200 && resp.data.statusCode < 400) {
                message.success(`请求完成: ${resp.data.statusCode}`);
            } else {
                message.warning(`请求完成: ${resp.data.statusCode}`);
            }
        } catch (error) {
            api.responseError = error.message || String(error);
        } finally {
            sendingId.value = '';
        }
    }

    function getStatusColor(statusCode) {
        if (statusCode >= 200 && statusCode < 300) {
            return 'success';
        }
        if (statusCode >= 300 && statusCode < 400) {
            return 'processing';
        }
        if (statusCode >= 400) {
            return 'error';
        }
        return 'default';
    }

    function formatBytes(size) {
        const bytes = Number(size) || 0;
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    onActivated(() => {
        loadApiConnections();
    });

    onMounted(() => {
        loadApiConnections();
    });
</script>

<style scoped>
    .http-api-card {
        display: flex;
        flex-direction: column;
        height: calc(100vh - 70px);
        overflow: hidden;
    }

    :deep(.http-api-card > .ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
    }

    .api-workspace {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .api-layout {
        flex: 1 1 0;
        display: grid;
        grid-template-columns: 190px minmax(0, 1fr);
        min-height: 0;
        overflow: hidden;
    }

    .api-sidebar {
        height: 100% !important;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        border-right: 1px solid #f0f0f0;
        padding: 0 0 8px;
    }

    .api-list-item {
        position: relative;
        width: 100%;
        min-height: 42px;
        padding: 10px 20px;
        line-height: 1.35;
        text-align: left;
        color: rgba(0, 0, 0, 0.88);
        word-break: break-all;
        cursor: context-menu;
        user-select: none;
    }

    .api-list-item:hover {
        color: #1677ff;
    }

    .api-list-item.active {
        color: #1677ff;
        font-weight: 600;
        background: #fff;
    }

    .api-list-item.active::after {
        position: absolute;
        top: 0;
        right: -1px;
        bottom: 0;
        width: 2px;
        background: #1677ff;
        content: '';
    }

    .danger-menu-item {
        color: #ff4d4f;
    }

    .api-content {
        height: 100% !important;
        min-height: 0;
        padding-left: 12px;
        min-width: 0;
        overflow: hidden;
    }

    .api-editor {
        height: 100%;
        display: grid;
        grid-template-rows: minmax(220px, 38%) minmax(0, 1fr);
        row-gap: 8px;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .api-editor :deep(.ant-form-item) {
        margin-bottom: 8px !important;
    }

    .api-editor :deep(.ant-form-item-control) {
        min-width: 0;
    }

    .api-editor :deep(.ant-form-item-label) {
        overflow: visible;
        text-align: right;
    }

    .api-editor :deep(.ant-form-item-label > label) {
        height: 32px;
        font-size: 12px;
        white-space: nowrap;
    }

    .request-panel {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        min-height: 0;
        overflow: hidden;
    }

    .request-action-row {
        align-items: flex-end;
    }

    .request-actions {
        flex-wrap: wrap;
        row-gap: 8px;
    }

    .request-tabs {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    :deep(.request-tabs > .ant-tabs-nav) {
        flex: 0 0 auto;
    }

    :deep(.request-tabs .ant-tabs-content-holder) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.request-tabs .ant-tabs-content),
    :deep(.request-tabs .ant-tabs-tabpane) {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .header-grid {
        display: flex;
        flex-direction: column;
        flex: 1 1 0;
        gap: 8px;
        min-height: 0;
        overflow: auto;
        padding-right: 4px;
    }

    .header-row {
        display: grid;
        grid-template-columns: 28px minmax(0, 0.8fr) minmax(0, 1.2fr) 68px;
        gap: 8px;
        align-items: center;
    }

    .header-row-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
    }

    .header-empty-row {
        display: flex;
        justify-content: flex-end;
    }

    .request-body-pane {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .request-body-pane :deep(textarea.ant-input) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
    }

    .response-tabs :deep(textarea.ant-input) {
        height: 100% !important;
        min-height: 0;
    }

    .response-panel {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .response-panel :deep(.ant-divider) {
        flex: 0 0 auto;
    }

    .response-summary {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 8px;
    }

    .response-error {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .response-tabs {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    :deep(.response-tabs > .ant-tabs-nav) {
        flex: 0 0 auto;
    }

    :deep(.response-tabs .ant-tabs-content-holder) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.response-tabs .ant-tabs-content),
    :deep(.response-tabs .ant-tabs-tabpane) {
        flex: 1 1 0;
        height: 100% !important;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .empty-api-list,
    .empty-response {
        padding: 48px 0;
    }

    .empty-response {
        flex: 1 1 0;
        min-height: 0;
        overflow: auto;
    }
</style>
