<template>
    <div class="mt-container network-info-page">
        <!-- 面板头部 -->
        <a-card title="网络信息" class="network-info-card">
            <div class="network-info-content">
                <div class="network-toolbar">
                    <a-select
                        v-model:value="selectedInterfaceName"
                        placeholder="选择网络接口"
                        class="network-interface-select"
                        :options="interfaces.map(i => ({ label: i.displayName || i.name, value: i.name }))"
                        :loading="isLoading"
                    />
                    <a-button :loading="isLoading" @click="loadNetworkInfo">
                        <template #icon>
                            <ReloadOutlined />
                        </template>
                        刷新
                    </a-button>
                </div>

                <div class="network-table-wrap">
                    <a-table
                        :columns="columns"
                        :data-source="filteredInterfaces"
                        :pagination="{
                            pageSize: 20,
                            showSizeChanger: false,
                            position: ['bottomCenter'],
                            showTotal: total => '共 ' + total + ' 条，每页 20 条'
                        }"
                        size="small"
                        row-key="name"
                        :loading="isLoading"
                        class="network-info-table"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'status'">
                                <a-tag v-if="record.isUp" color="success">UP</a-tag>
                                <a-tag v-else color="default">DOWN</a-tag>
                            </template>
                            <template v-else-if="column.key === 'family'">
                                <a-tag color="blue">{{ record.family }}</a-tag>
                            </template>
                            <template v-else-if="column.key === 'mac'">
                                <a-tag color="green">{{ record.mac }}</a-tag>
                            </template>
                            <template v-else-if="column.key === 'addresses'">
                                <div class="ip-address-list">
                                    <div v-for="(addr, idx) in record.addresses" :key="idx" class="ip-address-item">
                                        <div class="ip-info">
                                            <a-tag
                                                :color="addr.family === 'IPv4' ? 'blue' : 'purple'"
                                                class="family-tag"
                                            >
                                                {{ addr.family }}
                                            </a-tag>
                                            <div class="address-details">
                                                <span class="ip-text">{{ addr.address }}</span>
                                                <span
                                                    v-if="addr.family === 'IPv6' && addr.prefixLength"
                                                    class="subnet-text"
                                                >
                                                    /{{ addr.prefixLength }}
                                                </span>
                                                <span v-if="addr.family === 'IPv4' && addr.netmask" class="subnet-text">
                                                    ({{ addr.netmask }})
                                                </span>
                                            </div>
                                        </div>

                                        <!-- Inline Actions -->
                                        <div class="ip-actions">
                                            <a-button
                                                type="link"
                                                size="small"
                                                class="action-btn"
                                                @click="prepareEdit(record.name, addr)"
                                            >
                                                <EditOutlined />
                                            </a-button>

                                            <!-- Delete (IPv6 only) -->
                                            <a-popconfirm
                                                v-if="addr.family === 'IPv6'"
                                                title="确定要删除这个 IP 地址吗？"
                                                ok-text="删除"
                                                cancel-text="取消"
                                                @confirm="handleDelete(record.name, addr.address, addr.family)"
                                            >
                                                <a-button type="link" danger size="small" class="action-btn">
                                                    <DeleteOutlined />
                                                </a-button>
                                            </a-popconfirm>
                                        </div>
                                    </div>

                                    <!-- Add Button (IPv6 only) -->
                                    <div class="add-ip-btn-wrapper">
                                        <a-button
                                            type="link"
                                            size="small"
                                            class="action-btn"
                                            @click="handleAddIPv6(record)"
                                        >
                                            <PlusOutlined />
                                        </a-button>
                                    </div>
                                </div>
                            </template>
                        </template>
                    </a-table>
                </div>
            </div>
        </a-card>

        <!-- 添加 IPv6 弹窗 -->
        <a-modal v-model:open="isAddModalVisible" title="添加 IPv6 地址" :confirm-loading="isAdding" @ok="handleAddOk">
            <a-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <a-form-item label="接口名称">
                    <span>{{ currentInterface?.displayName || currentInterface?.name }}</span>
                </a-form-item>

                <a-form-item label="IPv6 地址" required>
                    <a-tooltip :title="addValidationErrors.ip" :open="!!addValidationErrors.ip">
                        <a-input
                            v-model:value="addForm.ip"
                            placeholder="例如: 2001:db8::1"
                            :status="addValidationErrors.ip ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>
                <a-form-item label="前缀长度" required>
                    <a-tooltip :title="addValidationErrors.mask" :open="!!addValidationErrors.mask">
                        <a-input
                            v-model:value="addForm.mask"
                            placeholder="例如: 64"
                            :status="addValidationErrors.mask ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>
                <a-form-item label="默认网关">
                    <a-tooltip :title="addValidationErrors.gateway" :open="!!addValidationErrors.gateway">
                        <a-input
                            v-model:value="addForm.gateway"
                            placeholder="可选"
                            :status="addValidationErrors.gateway ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>
            </a-form>
        </a-modal>

        <!-- 修改 IP 弹窗 -->
        <a-modal
            v-model:open="isEditModalVisible"
            title="修改 IP 地址"
            :confirm-loading="isUpdating"
            @ok="handleEditOk"
        >
            <a-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <a-form-item label="接口名称">
                    <span>{{ currentEditInterfaceName }}</span>
                </a-form-item>

                <a-form-item :label="editForm.family === 'ipv6' ? 'IPv6 地址' : 'IP 地址'" required>
                    <a-tooltip :title="editValidationErrors.ip" :open="!!editValidationErrors.ip">
                        <a-input v-model:value="editForm.ip" :status="editValidationErrors.ip ? 'error' : ''" />
                    </a-tooltip>
                </a-form-item>

                <a-form-item :label="editForm.family === 'ipv6' ? '前缀长度' : '子网掩码'" required>
                    <a-tooltip :title="editValidationErrors.mask" :open="!!editValidationErrors.mask">
                        <a-input v-model:value="editForm.mask" :status="editValidationErrors.mask ? 'error' : ''" />
                    </a-tooltip>
                </a-form-item>

                <a-form-item label="默认网关">
                    <a-tooltip :title="editValidationErrors.gateway" :open="!!editValidationErrors.gateway">
                        <a-input
                            v-model:value="editForm.gateway"
                            placeholder="可选"
                            :status="editValidationErrors.gateway ? 'error' : ''"
                        />
                    </a-tooltip>
                </a-form-item>
            </a-form>
        </a-modal>
    </div>
</template>

<script setup>
    import { ref, reactive, computed, onMounted, onActivated } from 'vue';
    import { message } from 'ant-design-vue';
    import ReloadOutlined from '@ant-design/icons-vue/es/icons/ReloadOutlined';
    import EditOutlined from '@ant-design/icons-vue/es/icons/EditOutlined';
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import PlusOutlined from '@ant-design/icons-vue/es/icons/PlusOutlined';
    import { FormValidator, createNetworkInfoValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'NetworkInfo'
    });

    const isLoading = ref(false);
    const interfaces = ref([]);
    const selectedInterfaceName = ref('');

    const filteredInterfaces = computed(() => {
        if (!selectedInterfaceName.value) return [];
        return interfaces.value.filter(i => i.name === selectedInterfaceName.value);
    });

    // Edit Modal State
    const isEditModalVisible = ref(false);
    const isUpdating = ref(false);
    const currentEditInterfaceName = ref('');
    const currentEditAddr = ref(null); // Store original addr object for update reference
    const editForm = reactive({
        family: 'ipv4', // Add family field for validation context
        ip: '',
        mask: '',
        gateway: ''
    });

    const editValidationErrors = ref({
        ip: '',
        mask: '',
        gateway: ''
    });
    const editValidator = new FormValidator(editValidationErrors);
    editValidator.addRules(createNetworkInfoValidationRules());

    // Add Modal State
    const isAddModalVisible = ref(false);
    const isAdding = ref(false);
    const currentInterface = ref(null);
    const addForm = reactive({
        family: 'ipv6', // Default to ipv6 for add
        ip: '',
        mask: '64',
        gateway: ''
    });

    const addValidationErrors = ref({
        ip: '',
        mask: '',
        gateway: ''
    });
    const addValidator = new FormValidator(addValidationErrors);
    addValidator.addRules(createNetworkInfoValidationRules());

    const columns = [
        {
            title: '接口名称',
            dataIndex: 'displayName',
            key: 'displayName',
            width: 300,
            ellipsis: true
        },
        {
            title: '状态',
            key: 'status',
            width: 100,
            align: 'center'
        },
        {
            title: 'MAC 地址',
            dataIndex: 'mac',
            key: 'mac',
            width: 140
        },
        {
            title: 'IP 地址',
            dataIndex: 'addresses',
            key: 'addresses'
        }
    ];

    onMounted(() => {
        loadNetworkInfo();
    });

    onActivated(() => {
        loadNetworkInfo();
    });

    // Simulate closing popovers (click outside usually handles it, but for buttons inside)
    function closeEditModal() {
        isEditModalVisible.value = false;
    }

    // Removed popover helper functions

    async function loadNetworkInfo() {
        if (!window.nativeApi) {
            message.error('网络信息API不可用');
            return;
        }

        isLoading.value = true;
        try {
            const response = await window.nativeApi.getNetworkInfo();
            if (response.status === 'success') {
                interfaces.value = response.data;
                // Auto-select first interface if none selected or selection no longer exists
                if (response.data.length > 0) {
                    const stillExists = response.data.find(i => i.name === selectedInterfaceName.value);
                    if (!selectedInterfaceName.value || !stillExists) {
                        selectedInterfaceName.value = response.data[0].name;
                    }
                } else {
                    selectedInterfaceName.value = '';
                }
            } else {
                message.error(`获取网络信息失败: ${response.msg}`);
            }
        } catch (err) {
            message.error(`获取网络信息出错: ${err.message}`);
        } finally {
            isLoading.value = false;
        }
    }

    function prepareEdit(interfaceName, addr) {
        currentEditInterfaceName.value = interfaceName;
        currentEditAddr.value = addr;

        editForm.family = addr.family === 'IPv4' ? 'ipv4' : 'ipv6';
        editForm.ip = addr.address;
        editForm.mask = addr.family === 'IPv4' ? addr.netmask : addr.prefixLength || '64';
        editForm.gateway = ''; // Gateway not usually visible in single address object, user enters if needed
        editValidator.clearErrors();
        isEditModalVisible.value = true;
    }

    async function handleEditOk() {
        if (editValidator.validate(editForm)) {
            return;
        }

        isUpdating.value = true;
        try {
            const config = {
                interfaceName: currentEditInterfaceName.value,
                family: editForm.family,
                type: 'update',
                oldIp: currentEditAddr.value.address,
                ip: editForm.ip,
                mask: editForm.mask,
                gateway: editForm.gateway
            };

            const response = await window.nativeApi.manageNetwork(config);
            if (response.status === 'success') {
                message.success('更新成功');
                closeEditModal();
                setTimeout(loadNetworkInfo, 1000); // Reduce timeout slightly
            } else {
                message.error('更新失败: ' + response.msg);
            }
        } catch (err) {
            message.error('更新出错: ' + err.message);
        } finally {
            isUpdating.value = false;
        }
    }

    async function handleDelete(interfaceName, ip, family) {
        try {
            // For IPv4, "deleting" usually means setting to another static or DHCP?
            // But valid use case is removing a secondary IP.
            // If it's the ONLY IP, Windows might not allow deleting cleanly without setting DHCP.
            // But let's try calling delete.

            const config = {
                interfaceName: interfaceName,
                family: family === 'IPv4' ? 'ipv4' : 'ipv6',
                type: 'delete',
                ip: ip
            };

            const response = await window.nativeApi.manageNetwork(config);
            if (response.status === 'success') {
                message.success('删除成功');
                setTimeout(loadNetworkInfo, 1000);
            } else {
                message.error('删除失败: ' + response.msg);
            }
        } catch (err) {
            message.error('删除出错: ' + err.message);
        }
    }

    function handleAddIPv6(record) {
        currentInterface.value = record;
        addForm.family = 'ipv6';
        addForm.ip = '';
        addForm.mask = '64';
        addForm.gateway = '';
        addValidator.clearErrors();
        isAddModalVisible.value = true;
    }

    async function handleAddOk() {
        if (addValidator.validate(addForm)) {
            return;
        }

        isAdding.value = true;
        try {
            const config = {
                interfaceName: currentInterface.value.name,
                family: 'ipv6',
                type: 'add',
                ip: addForm.ip,
                mask: addForm.mask,
                gateway: addForm.gateway
            };

            const response = await window.nativeApi.manageNetwork(config);

            if (response.status === 'success') {
                message.success('添加成功');
                isAddModalVisible.value = false;
                setTimeout(loadNetworkInfo, 1500);
            } else {
                message.error(`添加失败: ${response.msg}`);
            }
        } catch (err) {
            message.error(`添加出错: ${err.message}`);
        } finally {
            isAdding.value = false;
        }
    }

    // 暴露给父组件的方法
    defineExpose({
        clearValidationErrors: () => {
            // 端口监听页面没有表单验证，这里为了保持一致性
        }
    });
</script>

<style scoped>
    .network-info-page {
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .network-info-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .network-info-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .network-info-content {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .network-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
        min-width: 0;
    }

    .network-interface-select {
        min-width: 280px;
    }

    .network-table-wrap {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .network-info-table,
    .network-info-table :deep(.ant-spin-nested-loading),
    .network-info-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .network-info-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .network-info-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        overflow: auto;
    }

    .network-info-table :deep(.ant-table-container),
    .network-info-table :deep(.ant-table-content) {
        min-height: 0;
    }

    .network-info-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .network-info-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .ip-address-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .ip-address-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        background-color: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 6px;
        transition: all 0.2s;
    }

    .ip-address-item:hover {
        background-color: #f0f7ff;
        border-color: #d6e4ff;
    }

    .ip-info {
        display: flex;
        align-items: center;
        flex: 1;
        overflow: hidden;
    }

    .family-tag {
        margin-right: 8px;
        min-width: 45px;
        text-align: center;
        font-weight: 500;
    }

    .address-details {
        display: flex;
        align-items: baseline;
        overflow: hidden;
    }

    .ip-text {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
        font-weight: 600;
        color: #1f1f1f;
        margin-right: 4px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .subnet-text {
        font-size: 12px;
        color: #8c8c8c;
    }

    .ip-actions {
        display: flex;
        gap: 4px;
        opacity: 0.6;
        transition: opacity 0.2s;
    }

    .ip-address-item:hover .ip-actions {
        opacity: 1;
    }

    .action-btn {
        padding: 0 4px;
        height: 24px;
        line-height: 24px;
    }

    .add-ip-btn-wrapper {
        margin-top: 4px;
        text-align: right;
        padding-right: 10px;
    }

    .add-ip-btn {
        color: #8c8c8c;
    }

    .add-ip-btn:hover {
        color: #1890ff;
    }
</style>
