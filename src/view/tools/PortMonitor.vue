<template>
    <div class="mt-container port-monitor-page">
        <!-- 配置面板 -->
        <nn-card title="端口监听配置" class="port-config-card">
            <nn-form :label-col="labelCol" :wrapper-col="wrapperCol">
                <nn-form-item label="刷新间隔">
                    <nn-space>
                        <nn-switch v-model:checked="autoRefresh" @change="handleAutoRefreshChange" />
                        <nn-select v-model:value="refreshInterval" :disabled="!autoRefresh" style="width: 120px">
                            <nn-select-option :value="3000">3 秒</nn-select-option>
                            <nn-select-option :value="5000">5 秒</nn-select-option>
                            <nn-select-option :value="10000">10 秒</nn-select-option>
                            <nn-select-option :value="30000">30 秒</nn-select-option>
                        </nn-select>
                    </nn-space>
                </nn-form-item>
                <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <nn-space>
                        <nn-button type="primary" :loading="isLoading" @click="loadPorts">
                            <template #icon>
                                <ReloadOutlined />
                            </template>
                            刷新
                        </nn-button>
                        <nn-button @click="clearFilter">清空筛选</nn-button>
                    </nn-space>
                </nn-form-item>
            </nn-form>
        </nn-card>

        <!-- 端口列表 -->
        <nn-card title="端口连接列表" class="port-list-card">
            <template #extra>
                <nn-space>
                    <nn-input-search
                        v-model:value="searchText"
                        placeholder="搜索端口、地址、进程名或PID"
                        style="width: 250px"
                        @search="handleSearch"
                    />
                    <nn-tag color="blue">共 {{ filteredPorts.length }} 个端口</nn-tag>
                </nn-space>
            </template>

            <nn-table
                :columns="columns"
                :data-source="filteredPorts"
                :scroll="{ y: '100%' }"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    showTotal: total => '共 ' + total + ' 条，每页 20 条',
                    position: ['bottomCenter']
                }"
                size="small"
                row-key="key"
                :loading="isLoading"
                class="port-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'protocol'">
                        <nn-tag :color="record.protocol === 'TCP' ? 'blue' : 'green'">
                            {{ record.protocol }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'state'">
                        <nn-tag
                            :color="
                                record.state === 'LISTENING'
                                    ? 'success'
                                    : record.state === 'ESTABLISHED'
                                      ? 'processing'
                                      : 'default'
                            "
                        >
                            {{ record.state }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'port'">
                        <nn-tag color="orange">{{ record.port }}</nn-tag>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <nn-button
                            v-if="record.pid && record.pid !== '-'"
                            type="link"
                            danger
                            size="small"
                            @click="handleKillProcess(record)"
                        >
                            关闭
                        </nn-button>
                    </template>
                </template>
            </nn-table>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, computed, onActivated, onDeactivated } from 'vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { ReloadOutlined } from '../../ui/icons';
    defineOptions({
        name: 'PortMonitor'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    // 响应式数据
    const ports = ref([]);
    const isLoading = ref(false);
    const autoRefresh = ref(false);
    const refreshInterval = ref(5000);
    const searchText = ref('');
    let refreshTimer = null;

    // 表格列定义
    const columns = [
        {
            title: '协议',
            dataIndex: 'protocol',
            key: 'protocol',
            width: 80,
            filters: [
                { text: 'TCP', value: 'TCP' },
                { text: 'UDP', value: 'UDP' }
            ],
            onFilter: (value, record) => record.protocol === value
        },
        {
            title: '本地地址',
            dataIndex: 'address',
            key: 'address',
            width: 150,
            ellipsis: true
        },
        {
            title: '本地端口',
            dataIndex: 'port',
            key: 'port',
            width: 100,
            sorter: (a, b) => {
                const portA = typeof a.port === 'number' ? a.port : 0;
                const portB = typeof b.port === 'number' ? b.port : 0;
                return portA - portB;
            }
        },
        {
            title: '远程地址',
            dataIndex: 'remoteAddress',
            key: 'remoteAddress',
            width: 150,
            ellipsis: true
        },
        {
            title: '远程端口',
            dataIndex: 'remotePort',
            key: 'remotePort',
            width: 100
        },
        {
            title: '状态',
            dataIndex: 'state',
            key: 'state',
            width: 120,
            filters: [
                { text: 'LISTENING', value: 'LISTENING' },
                { text: 'ESTABLISHED', value: 'ESTABLISHED' }
            ],
            onFilter: (value, record) => record.state === value
        },
        {
            title: 'PID',
            dataIndex: 'pid',
            key: 'pid',
            width: 100
        },
        {
            title: '进程名',
            dataIndex: 'process',
            key: 'process',
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action',
            width: 80,
            fixed: 'right'
        }
    ];

    // 计算属性：过滤后的端口列表
    const filteredPorts = computed(() => {
        if (!searchText.value) {
            return ports.value;
        }

        const search = searchText.value.toLowerCase();
        return ports.value.filter(
            port =>
                port.port.toString().includes(search) ||
                port.process.toLowerCase().includes(search) ||
                port.pid.toString().includes(search) ||
                port.address.toLowerCase().includes(search) ||
                (port.remoteAddress && port.remoteAddress.toLowerCase().includes(search)) ||
                (port.remotePort && port.remotePort.toString().includes(search))
        );
    });

    onActivated(() => {
        loadPorts();
        if (autoRefresh.value) {
            startAutoRefresh();
        }
    });

    onDeactivated(() => {
        stopAutoRefresh();
    });

    // 加载端口信息
    async function loadPorts() {
        if (!window.nativeApi) {
            notify.error('端口监听API不可用');
            return;
        }

        isLoading.value = true;

        try {
            const response = await window.nativeApi.getListeningPorts();

            if (response.status === 'success') {
                // 为每个端口添加唯一key
                ports.value = response.data.map((port, index) => ({
                    ...port,
                    key: `${port.protocol}-${port.address}-${port.port}-${index}`
                }));
                notify.success(`成功获取 ${ports.value.length} 个连接`);
            } else {
                notify.error(`获取端口失败: ${response.msg}`);
                ports.value = [];
            }
        } catch (err) {
            notify.error(`获取端口失败: ${err.message}`);
            ports.value = [];
        } finally {
            isLoading.value = false;
        }
    }

    // 处理自动刷新开关
    function handleAutoRefreshChange(checked) {
        if (checked) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    }

    // 启动自动刷新
    function startAutoRefresh() {
        stopAutoRefresh(); // 先清除已有的定时器
        refreshTimer = setInterval(() => {
            loadPorts();
        }, refreshInterval.value);
    }

    // 停止自动刷新
    function stopAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // 处理搜索
    function handleSearch() {
        // 搜索功能由计算属性自动处理
    }

    // 清空筛选
    function clearFilter() {
        searchText.value = '';
    }

    // 关闭进程
    async function handleKillProcess(record) {
        const { pid, process: processName } = record;

        // 检查是否是关键进程
        const criticalProcesses = ['electron', 'node', 'npm', 'yarn', 'pnpm', 'vite', 'webpack'];
        const isCritical = criticalProcesses.some(name => processName.toLowerCase().includes(name));

        // 构建警告内容
        let content = `确定要关闭进程 "${processName}" (PID: ${pid}) 吗？此操作不可撤销。`;
        if (isCritical) {
            content = `⚠️ 警告：您正在尝试关闭系统关键进程 "${processName}" (PID: ${pid})！\n\n这可能导致应用或开发服务器崩溃。\n\n确定要继续吗？`;
        }

        // 确认对话框
        dialog.confirm({
            title: isCritical ? '⚠️ 关闭关键进程' : '确认关闭进程',
            content: content,
            okText: '确定',
            okType: 'danger',
            cancelText: '取消',
            async onOk() {
                if (!window.nativeApi) {
                    notify.error('进程管理API不可用');
                    return;
                }

                try {
                    const response = await window.nativeApi.killProcess(pid);

                    if (response.status === 'success') {
                        notify.success(response.msg || `成功关闭进程 ${pid}`);
                        // 刷新端口列表
                        setTimeout(() => {
                            loadPorts();
                        }, 500);
                    } else {
                        notify.error(response.msg || '关闭进程失败');
                    }
                } catch (err) {
                    notify.error(`关闭进程失败: ${err.message}`);
                }
            }
        });
    }

    // 暴露给父组件的方法
    defineExpose({
        clearValidationErrors: () => {
            // 端口监听页面没有表单验证，这里为了保持一致性
        }
    });
</script>

<style scoped>
    .port-monitor-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .port-config-card {
        flex: 0 0 auto;
    }

    .port-list-card {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .port-list-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .port-table,
    .port-table :deep(.nn-spin-nested-loading),
    .port-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .port-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .port-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .port-table :deep(.nn-table-container),
    .port-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .port-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .port-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .port-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .port-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
