<template>
    <div class="nn-container http-api-page">
        <nn-card title="HTTP API测试" class="http-api-card">
            <template #extra>
                <nn-space>
                    <nn-tag v-if="pageLoading" color="processing" role="status" aria-live="polite">加载中</nn-tag>
                    <nn-button type="primary" size="small" @click="createApiConnection">
                        <template #icon>
                            <PlusOutlined />
                        </template>
                        新建
                    </nn-button>
                    <nn-button size="small" :loading="saveLoading" @click="saveApiConnections">
                        <template #icon>
                            <SaveOutlined />
                        </template>
                        保存
                    </nn-button>
                    <nn-button size="small" @click="resetBmpDefaults">
                        <template #icon>
                            <ReloadOutlined />
                        </template>
                        BMP默认
                    </nn-button>
                </nn-space>
            </template>

            <div class="api-workspace">
                <nn-empty v-if="apiItems.length === 0" description="暂无API连接" class="empty-api-list">
                    <template #description>
                        <span>暂无API连接</span>
                    </template>
                    <nn-button type="primary" @click="resetBmpDefaults">恢复BMP默认API</nn-button>
                </nn-empty>
                <div v-else class="api-layout">
                    <div class="api-sidebar">
                        <nn-dropdown v-for="api in apiItems" :key="api.id" :trigger="['contextmenu']">
                            <div
                                class="api-list-item"
                                :class="{ active: activeKey === api.id }"
                                :title="api.name || '未命名API'"
                                @click="activeKey = api.id"
                            >
                                {{ api.name || '未命名API' }}
                            </div>
                            <template #overlay>
                                <nn-menu>
                                    <nn-menu-item key="rename" @click="renameApiConnection(api)">
                                        <nn-space>
                                            <EditOutlined />
                                            <span>修改名称</span>
                                        </nn-space>
                                    </nn-menu-item>
                                    <nn-menu-item key="copy" @click="copyApiConnection(api)">
                                        <nn-space>
                                            <CopyOutlined />
                                            <span>复制</span>
                                        </nn-space>
                                    </nn-menu-item>
                                    <nn-menu-item key="delete" @click="deleteApiConnection(api)">
                                        <nn-space class="danger-menu-item">
                                            <DeleteOutlined />
                                            <span>删除</span>
                                        </nn-space>
                                    </nn-menu-item>
                                </nn-menu>
                            </template>
                        </nn-dropdown>
                    </div>
                    <div class="api-content">
                        <nn-form
                            v-if="activeApi"
                            :model="activeApi"
                            class="api-editor"
                            :colon="false"
                            :label-col="inlineLabelCol"
                            :wrapper-col="inlineWrapperCol"
                        >
                            <div class="request-panel">
                                <nn-row :gutter="8" class="request-basic-row">
                                    <nn-col :span="7">
                                        <nn-form-item label="方法">
                                            <nn-select v-model:value="activeApi.method">
                                                <nn-select-option
                                                    v-for="method in httpMethods"
                                                    :key="method"
                                                    :value="method"
                                                >
                                                    {{ method }}
                                                </nn-select-option>
                                            </nn-select>
                                        </nn-form-item>
                                    </nn-col>
                                    <nn-col :span="17">
                                        <nn-form-item label="URL">
                                            <nn-input
                                                v-model:value="activeApi.url"
                                                placeholder="http://127.0.0.1:18080/api/v1/status"
                                                @press-enter="sendRequest(activeApi)"
                                            />
                                        </nn-form-item>
                                    </nn-col>
                                </nn-row>

                                <nn-row :gutter="8" class="request-action-row">
                                    <nn-col :span="6">
                                        <nn-form-item label="超时(ms)">
                                            <nn-input-number
                                                v-model:value="activeApi.timeout"
                                                :min="1000"
                                                :max="600000"
                                                :step="1000"
                                                style="width: 100%"
                                            />
                                        </nn-form-item>
                                    </nn-col>
                                    <nn-col :span="18">
                                        <nn-form-item label="操作">
                                            <nn-space class="request-actions">
                                                <nn-button
                                                    type="primary"
                                                    :loading="sendingId === activeApi.id"
                                                    @click="sendRequest(activeApi)"
                                                >
                                                    <template #icon>
                                                        <SendOutlined />
                                                    </template>
                                                    发送
                                                </nn-button>
                                                <nn-button @click="formatRequestBody(activeApi)">格式化JSON</nn-button>
                                            </nn-space>
                                        </nn-form-item>
                                    </nn-col>
                                </nn-row>

                                <nn-tabs v-model:active-key="requestTabKey" size="small" class="request-tabs">
                                    <nn-tab-pane key="headers" tab="请求头">
                                        <div class="header-grid">
                                            <div v-if="activeApi.headers.length === 0" class="header-empty-row">
                                                <nn-button size="small" type="dashed" @click="addHeader(activeApi)">
                                                    <template #icon>
                                                        <PlusOutlined />
                                                    </template>
                                                    添加请求头
                                                </nn-button>
                                            </div>
                                            <div
                                                v-for="header in activeApi.headers"
                                                :key="header.rowId"
                                                class="header-row"
                                            >
                                                <nn-checkbox v-model:checked="header.enabled" />
                                                <nn-input v-model:value="header.key" placeholder="Header" />
                                                <nn-input v-model:value="header.value" placeholder="Value" />
                                                <div class="header-row-actions">
                                                    <nn-button type="text" @click="addHeader(activeApi)">
                                                        <template #icon>
                                                            <PlusOutlined />
                                                        </template>
                                                    </nn-button>
                                                    <nn-button
                                                        type="text"
                                                        danger
                                                        @click="removeHeader(activeApi, header.rowId)"
                                                    >
                                                        <template #icon>
                                                            <DeleteOutlined />
                                                        </template>
                                                    </nn-button>
                                                </div>
                                            </div>
                                        </div>
                                    </nn-tab-pane>
                                    <nn-tab-pane key="body" tab="请求体">
                                        <div class="request-body-pane">
                                            <ScrollTextarea v-model:model-value="activeApi.body" height="100%" />
                                        </div>
                                    </nn-tab-pane>
                                </nn-tabs>
                            </div>

                            <div class="response-panel">
                                <nn-divider>响应</nn-divider>
                                <div v-if="activeApi.response" class="response-summary">
                                    <nn-tag :color="getStatusColor(activeApi.response.statusCode)">
                                        {{ activeApi.response.statusCode }} {{ activeApi.response.statusMessage }}
                                    </nn-tag>
                                    <nn-tag color="blue">{{ activeApi.response.durationMs }} ms</nn-tag>
                                    <nn-tag>{{ formatBytes(activeApi.response.sizeBytes) }}</nn-tag>
                                </div>
                                <nn-alert
                                    v-if="activeApi.responseError"
                                    class="response-error"
                                    type="error"
                                    :message="activeApi.responseError"
                                    show-icon
                                />
                                <nn-tabs v-model:active-key="responseTabKey" size="small" class="response-tabs">
                                    <nn-tab-pane key="body" tab="响应体">
                                        <ScrollTextarea :model-value="activeApi.responseBody" height="100%" readonly />
                                    </nn-tab-pane>
                                    <nn-tab-pane key="headers" tab="响应头">
                                        <ScrollTextarea
                                            :model-value="activeApi.responseHeaders"
                                            height="100%"
                                            readonly
                                        />
                                    </nn-tab-pane>
                                </nn-tabs>
                            </div>
                        </nn-form>
                    </div>
                </div>
            </div>
        </nn-card>
    </div>
</template>

<script setup>
    import { computed, h, ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { dialog } from '../../utils/dialog';
    import {
        CopyOutlined,
        DeleteOutlined,
        EditOutlined,
        PlusOutlined,
        ReloadOutlined,
        SaveOutlined,
        SendOutlined
    } from '../../ui/icons';

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
            notify.error('工具API不可用');
            return;
        }

        pageLoading.value = true;
        try {
            const resp = await window.toolsApi.getHttpApiConnections();
            if (resp.status !== 'success') {
                notify.error(resp.msg || '获取API连接信息失败');
                return;
            }
            let connections = Array.isArray(resp.data) ? resp.data : [];
            if (connections.length === 0) {
                setApiConnections([]);
                return;
            }
            setApiConnections(connections);
        } catch (error) {
            notify.error(error.message || String(error));
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
        dialog.confirm({
            title: '修改API名称',
            okText: '保存',
            cancelText: '取消',
            content: () =>
                h('div', { class: 'rename-api-modal' }, [
                    dialog.textInput({
                        value: inputValue.value,
                        maxlength: 80,
                        placeholder: '请输入API名称',
                        'onUpdate:value': value => {
                            inputValue.value = value;
                        },
                        onPressEnter: () => {
                            const name = String(inputValue.value || '').trim();
                            if (!name) {
                                notify.error('API名称不能为空');
                                return;
                            }
                            api.name = name;
                            dialog.destroyAll();
                        }
                    })
                ]),
            onOk() {
                const name = String(inputValue.value || '').trim();
                if (!name) {
                    notify.error('API名称不能为空');
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
                notify.success('API连接信息已保存');
            } else {
                notify.error(resp.msg || '保存API连接信息失败');
            }
        } catch (error) {
            notify.error(error.message || String(error));
        } finally {
            saveLoading.value = false;
        }
    }

    function resetBmpDefaults() {
        dialog.confirm({
            title: '恢复BMP默认API',
            content: '当前API连接列表会被BMP默认接口模板覆盖。',
            okText: '恢复',
            cancelText: '取消',
            async onOk() {
                pageLoading.value = true;
                try {
                    const resp = await window.toolsApi.resetHttpApiConnections();
                    if (resp.status !== 'success') {
                        notify.error(resp.msg || '恢复BMP默认API失败');
                        return;
                    }
                    apiItems.value = (resp.data || []).map(normalizeApiItem);
                    activeKey.value = apiItems.value[0]?.id || '';
                    notify.success('已恢复BMP默认API');
                } catch (error) {
                    notify.error(error.message || String(error));
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
            notify.error('请求体不是合法JSON');
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
            notify.error('URL不能为空');
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
                notify.success(`请求完成: ${resp.data.statusCode}`);
            } else {
                notify.warning(`请求完成: ${resp.data.statusCode}`);
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

    onMounted(() => {
        loadApiConnections();
    });
</script>

<style scoped>
    .http-api-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .http-api-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    :deep(.http-api-card > .nn-card-body) {
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
        border-right: 1px solid var(--nn-color-border-light);
        padding: 0 0 8px;
    }

    .api-sidebar :deep(.nn-dropdown),
    .api-sidebar :deep(.nn-dropdown-trigger) {
        display: flex;
        width: 100%;
        min-width: 0;
    }

    .api-list-item {
        position: relative;
        width: 100%;
        min-height: 42px;
        padding: 10px 20px;
        font-size: 13px;
        line-height: 1.4;
        text-align: left;
        color: var(--nn-color-text);
        word-break: break-all;
        cursor: context-menu;
        user-select: none;
    }

    .api-list-item:hover {
        color: var(--nn-color-primary);
    }

    .api-list-item.active {
        color: var(--nn-color-primary);
        font-weight: 600;
        background: var(--nn-color-bg-surface);
    }

    .api-list-item.active::after {
        position: absolute;
        top: 0;
        right: -1px;
        bottom: 0;
        width: 2px;
        background: var(--nn-color-primary);
        content: '';
    }

    .danger-menu-item {
        color: var(--nn-color-error);
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

    .api-editor :deep(.nn-form-item) {
        margin-bottom: 8px !important;
    }

    .api-editor :deep(.nn-form-item-control) {
        min-width: 0;
    }

    .api-editor :deep(.nn-form-item-label) {
        overflow: visible;
        text-align: right;
    }

    .api-editor :deep(.nn-form-item-label > label) {
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

    :deep(.request-tabs > .nn-tabs-nav) {
        flex: 0 0 auto;
    }

    :deep(.request-tabs .nn-tabs-content-holder) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.request-tabs .nn-tabs-content),
    :deep(.request-tabs .nn-tabs-tabpane) {
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

    .request-body-pane :deep(textarea.nn-input) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
    }

    .response-tabs :deep(textarea.nn-input) {
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

    .response-panel :deep(.nn-divider) {
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

    :deep(.response-tabs > .nn-tabs-nav) {
        flex: 0 0 auto;
    }

    :deep(.response-tabs .nn-tabs-content-holder) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.response-tabs .nn-tabs-content),
    :deep(.response-tabs .nn-tabs-tabpane) {
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
