<template>
    <div class="mt-container">
        <!-- 配置面板 -->
        <a-card title="端口监听配置">
            <a-form :label-col="labelCol" :wrapper-col="wrapperCol">
                <a-form-item label="刷新间隔">
                    <a-space>
                        <a-switch v-model:checked="autoRefresh" @change="handleAutoRefreshChange" />
                        <a-select v-model:value="refreshInterval" :disabled="!autoRefresh" style="width: 120px">
                            <a-select-option :value="3000">3 秒</a-select-option>
                            <a-select-option :value="5000">5 秒</a-select-option>
                            <a-select-option :value="10000">10 秒</a-select-option>
                            <a-select-option :value="30000">30 秒</a-select-option>
                        </a-select>
                    </a-space>
                </a-form-item>
                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <a-space>
                        <a-button type="primary" :loading="isLoading" @click="loadPorts">
                            <template #icon>
                                <ReloadOutlined />
                            </template>
                            刷新
                        </a-button>
                        <a-button @click="clearFilter">清空筛选</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
        </a-card>

        <!-- 端口列表 -->
        <a-card title="端口连接列表" class="mt-margin-top-10">
            <template #extra>
                <a-space>
                    <a-input-search
                        v-model:value="searchText"
                        placeholder="搜索端口、地址、进程名或PID"
                        style="width: 250px"
                        @search="handleSearch"
                    />
                    <a-tag color="blue">共 {{ filteredPorts.length }} 个端口</a-tag>
                </a-space>
            </template>

            <a-table
                :columns="columns"
                :data-source="filteredPorts"
                :scroll="{ y: 400 }"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    showTotal: total => '共 ' + total + ' 条，每页 20 条',
                    position: ['bottomCenter']
                }"
                size="small"
                row-key="key"
                :loading="isLoading"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'protocol'">
                        <a-tag :color="record.protocol === 'TCP' ? 'blue' : 'green'">
                            {{ record.protocol }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'state'">
                        <a-tag
                            :color="
                                record.state === 'LISTENING'
                                    ? 'success'
                                    : record.state === 'ESTABLISHED'
                                      ? 'processing'
                                      : 'default'
                            "
                        >
                            {{ record.state }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'port'">
                        <a-tag color="orange">{{ record.port }}</a-tag>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-button
                            v-if="record.pid && record.pid !== '-'"
                            type="link"
                            danger
                            size="small"
                            @click="handleKillProcess(record)"
                        >
                            关闭
                        </a-button>
                    </template>
                </template>
            </a-table>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, computed, onActivated, onDeactivated } from 'vue';
    import { message, Modal } from 'ant-design-vue';
    import { ReloadOutlined } from '@ant-design/icons-vue';

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
            message.error('端口监听API不可用');
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
                message.success(`成功获取 ${ports.value.length} 个连接`);
            } else {
                message.error(`获取端口失败: ${response.msg}`);
                ports.value = [];
            }
        } catch (err) {
            message.error(`获取端口失败: ${err.message}`);
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
        Modal.confirm({
            title: isCritical ? '⚠️ 关闭关键进程' : '确认关闭进程',
            content: content,
            okText: '确定',
            okType: 'danger',
            cancelText: '取消',
            async onOk() {
                if (!window.nativeApi) {
                    message.error('进程管理API不可用');
                    return;
                }

                try {
                    const response = await window.nativeApi.killProcess(pid);

                    if (response.status === 'success') {
                        message.success(response.msg || `成功关闭进程 ${pid}`);
                        // 刷新端口列表
                        setTimeout(() => {
                            loadPorts();
                        }, 500);
                    } else {
                        message.error(response.msg || '关闭进程失败');
                    }
                } catch (err) {
                    message.error(`关闭进程失败: ${err.message}`);
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
    :deep(.ant-table-body) {
        height: 380px !important;
        overflow-y: auto !important;
    }
</style>
