<template>
    <div class="nn-container network-info-page">
        <!-- 面板头部 -->
        <nn-card title="网络信息" class="network-info-card">
            <div class="network-info-content">
                <nn-tabs v-model:active-key="activePanelKey" size="small" class="network-tabs">
                    <nn-tab-pane key="interfaces" tab="接口信息">
                        <div class="network-pane">
                            <div class="network-toolbar network-interface-toolbar">
                                <nn-select
                                    v-model:value="selectedInterfaceName"
                                    placeholder="选择网络接口"
                                    class="network-interface-select"
                                    :options="interfaceOptions"
                                    :loading="isLoading"
                                />
                                <nn-button :loading="isLoading" @click="loadNetworkInfo">
                                    <template #icon>
                                        <ReloadOutlined />
                                    </template>
                                    刷新
                                </nn-button>
                            </div>

                            <div class="network-table-wrap">
                                <nn-table
                                    :columns="columns"
                                    :data-source="filteredInterfaces"
                                    :pagination="{
                                        pageSize: 30,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 30 条'
                                    }"
                                    size="small"
                                    row-key="name"
                                    :loading="isLoading"
                                    class="network-info-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'status'">
                                            <nn-tag v-if="record.isUp" color="success">UP</nn-tag>
                                            <nn-tag v-else color="default">DOWN</nn-tag>
                                        </template>
                                        <template v-else-if="column.key === 'family'">
                                            <nn-tag color="blue">{{ record.family }}</nn-tag>
                                        </template>
                                        <template v-else-if="column.key === 'mac'">
                                            <nn-tag v-if="record.mac" color="green">{{ record.mac }}</nn-tag>
                                            <span v-else class="network-empty-value">-</span>
                                        </template>
                                        <template v-else-if="column.key === 'addresses'">
                                            <div class="ip-address-list">
                                                <div
                                                    v-for="(addr, idx) in record.addresses"
                                                    :key="idx"
                                                    class="ip-address-item"
                                                >
                                                    <div class="ip-info">
                                                        <nn-tag
                                                            :color="addr.family === 'IPv4' ? 'blue' : 'purple'"
                                                            class="family-tag"
                                                        >
                                                            {{ addr.family }}
                                                        </nn-tag>
                                                        <div class="address-details">
                                                            <span class="ip-text">{{ addr.address }}</span>
                                                            <span
                                                                v-if="addr.family === 'IPv6' && addr.prefixLength"
                                                                class="subnet-text"
                                                            >
                                                                /{{ addr.prefixLength }}
                                                            </span>
                                                            <span
                                                                v-if="addr.family === 'IPv4' && addr.netmask"
                                                                class="subnet-text"
                                                            >
                                                                ({{ addr.netmask }})
                                                            </span>
                                                        </div>
                                                    </div>

                                                    <div class="ip-actions">
                                                        <nn-button
                                                            type="link"
                                                            size="small"
                                                            class="action-btn"
                                                            @click="prepareEdit(record.name, addr)"
                                                        >
                                                            <EditOutlined />
                                                        </nn-button>

                                                        <nn-popconfirm
                                                            v-if="addr.family === 'IPv6'"
                                                            title="确定要删除这个 IP 地址吗？"
                                                            ok-text="删除"
                                                            cancel-text="取消"
                                                            @confirm="
                                                                handleDelete(record.name, addr.address, addr.family)
                                                            "
                                                        >
                                                            <nn-button
                                                                type="link"
                                                                danger
                                                                size="small"
                                                                class="action-btn"
                                                            >
                                                                <DeleteOutlined />
                                                            </nn-button>
                                                        </nn-popconfirm>
                                                    </div>
                                                </div>

                                                <div class="add-ip-btn-wrapper">
                                                    <nn-button
                                                        type="link"
                                                        size="small"
                                                        class="action-btn"
                                                        @click="handleAddIPv6(record)"
                                                    >
                                                        <PlusOutlined />
                                                    </nn-button>
                                                </div>
                                            </div>
                                        </template>
                                    </template>
                                </nn-table>
                            </div>
                        </div>
                    </nn-tab-pane>

                    <nn-tab-pane key="routes" tab="路由信息">
                        <div class="network-pane">
                            <div class="network-toolbar">
                                <nn-segmented
                                    v-model:value="routeFamilyFilter"
                                    :options="[
                                        { label: '全部', value: 'all' },
                                        { label: 'IPv4', value: 'IPv4' },
                                        { label: 'IPv6', value: 'IPv6' }
                                    ]"
                                />
                                <nn-button type="primary" @click="openAddRouteModal">
                                    <template #icon>
                                        <PlusOutlined />
                                    </template>
                                    添加路由
                                </nn-button>
                                <nn-button :loading="isRouteLoading" @click="loadRouteInfo">
                                    <template #icon>
                                        <ReloadOutlined />
                                    </template>
                                    刷新
                                </nn-button>
                            </div>

                            <div class="network-table-wrap">
                                <nn-table
                                    :columns="routeColumns"
                                    :data-source="filteredRoutes"
                                    :pagination="{
                                        pageSize: 30,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 30 条'
                                    }"
                                    size="small"
                                    row-key="id"
                                    :loading="isRouteLoading"
                                    class="network-info-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'family'">
                                            <nn-tag :color="record.family === 'IPv4' ? 'blue' : 'purple'">
                                                {{ record.family }}
                                            </nn-tag>
                                        </template>
                                        <template v-else-if="column.key === 'gateway'">
                                            {{ routeValue(record.gateway) }}
                                        </template>
                                        <template v-else-if="column.key === 'metric'">
                                            {{ routeValue(record.metric) }}
                                        </template>
                                        <template v-else-if="column.key === 'protocol'">
                                            {{ routeValue(record.protocol) }}
                                        </template>
                                        <template v-else-if="column.key === 'flags'">
                                            {{ routeValue(record.flags || record.state) }}
                                        </template>
                                        <template v-else-if="column.key === 'action'">
                                            <nn-popconfirm
                                                title="确定要删除这条路由吗？"
                                                ok-text="删除"
                                                cancel-text="取消"
                                                @confirm="handleDeleteRoute(record)"
                                            >
                                                <nn-button type="link" danger size="small">删除</nn-button>
                                            </nn-popconfirm>
                                        </template>
                                    </template>
                                </nn-table>
                            </div>
                        </div>
                    </nn-tab-pane>
                </nn-tabs>
            </div>
        </nn-card>

        <!-- 添加 IPv6 弹窗 -->
        <nn-modal v-model:open="isAddModalVisible" title="添加 IPv6 地址" :confirm-loading="isAdding" @ok="handleAddOk">
            <nn-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <nn-form-item label="接口名称">
                    <span>{{ currentInterface?.displayName || currentInterface?.name }}</span>
                </nn-form-item>

                <nn-form-item label="IPv6 地址" required>
                    <nn-tooltip :title="addValidationErrors.ip" :open="!!addValidationErrors.ip">
                        <nn-input
                            v-model:value="addForm.ip"
                            placeholder="例如: 2001:db8::1"
                            :status="addValidationErrors.ip ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
                <nn-form-item label="前缀长度" required>
                    <nn-tooltip :title="addValidationErrors.mask" :open="!!addValidationErrors.mask">
                        <nn-input
                            v-model:value="addForm.mask"
                            placeholder="例如: 64"
                            :status="addValidationErrors.mask ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
                <nn-form-item label="默认网关">
                    <nn-tooltip :title="addValidationErrors.gateway" :open="!!addValidationErrors.gateway">
                        <nn-input
                            v-model:value="addForm.gateway"
                            placeholder="可选"
                            :status="addValidationErrors.gateway ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <!-- 修改 IP 弹窗 -->
        <nn-modal
            v-model:open="isEditModalVisible"
            title="修改 IP 地址"
            :confirm-loading="isUpdating"
            @ok="handleEditOk"
        >
            <nn-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <nn-form-item label="接口名称">
                    <span>{{ currentEditInterfaceName }}</span>
                </nn-form-item>

                <nn-form-item :label="editForm.family === 'ipv6' ? 'IPv6 地址' : 'IP 地址'" required>
                    <nn-tooltip :title="editValidationErrors.ip" :open="!!editValidationErrors.ip">
                        <nn-input v-model:value="editForm.ip" :status="editValidationErrors.ip ? 'error' : ''" />
                    </nn-tooltip>
                </nn-form-item>

                <nn-form-item :label="editForm.family === 'ipv6' ? '前缀长度' : '子网掩码'" required>
                    <nn-tooltip :title="editValidationErrors.mask" :open="!!editValidationErrors.mask">
                        <nn-input v-model:value="editForm.mask" :status="editValidationErrors.mask ? 'error' : ''" />
                    </nn-tooltip>
                </nn-form-item>

                <nn-form-item label="默认网关">
                    <nn-tooltip :title="editValidationErrors.gateway" :open="!!editValidationErrors.gateway">
                        <nn-input
                            v-model:value="editForm.gateway"
                            placeholder="可选"
                            :status="editValidationErrors.gateway ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <nn-modal
            v-model:open="isAddRouteModalVisible"
            title="添加本地路由"
            :confirm-loading="isRouteAdding"
            @ok="handleAddRouteOk"
        >
            <nn-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <nn-form-item label="地址族" required>
                    <nn-radio-group v-model:value="routeForm.family">
                        <nn-radio-button value="ipv4">IPv4</nn-radio-button>
                        <nn-radio-button value="ipv6">IPv6</nn-radio-button>
                    </nn-radio-group>
                </nn-form-item>
                <nn-form-item label="目标地址" required>
                    <nn-tooltip :title="routeValidationErrors.destination" :open="!!routeValidationErrors.destination">
                        <nn-input
                            v-model:value="routeForm.destination"
                            :placeholder="routeForm.family === 'ipv6' ? '例如: 2001:db8::' : '例如: 192.0.2.0'"
                            :status="routeValidationErrors.destination ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
                <nn-form-item label="前缀长度" required>
                    <nn-tooltip
                        :title="routeValidationErrors.prefixLength"
                        :open="!!routeValidationErrors.prefixLength"
                    >
                        <nn-input
                            v-model:value="routeForm.prefixLength"
                            :placeholder="routeForm.family === 'ipv6' ? '例如: 64' : '例如: 24'"
                            :status="routeValidationErrors.prefixLength ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
                <nn-form-item label="下一跳" required>
                    <nn-tooltip :title="routeValidationErrors.gateway" :open="!!routeValidationErrors.gateway">
                        <nn-input
                            v-model:value="routeForm.gateway"
                            :placeholder="routeForm.family === 'ipv6' ? '例如: fe80::1' : '例如: 192.0.2.1'"
                            :status="routeValidationErrors.gateway ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
                <nn-form-item label="接口">
                    <nn-select
                        v-model:value="routeForm.interfaceName"
                        allow-clear
                        placeholder="可选"
                        :options="interfaceOptions"
                    />
                </nn-form-item>
                <nn-form-item label="Metric">
                    <nn-tooltip :title="routeValidationErrors.metric" :open="!!routeValidationErrors.metric">
                        <nn-input
                            v-model:value="routeForm.metric"
                            placeholder="可选"
                            :status="routeValidationErrors.metric ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>
            </nn-form>
        </nn-modal>
    </div>
</template>

<script setup>
    import { ref, reactive, computed, onMounted, onActivated, watch } from 'vue';
    import { notify } from '../../utils/notify';
    import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '../../ui/icons';

    import {
        FormValidator,
        createNetworkInfoValidationRules,
        isValidIpv4,
        isValidIpv6
    } from '../../utils/validationCommon';

    defineOptions({
        name: 'NetworkInfo'
    });

    const isLoading = ref(false);
    const interfaces = ref([]);
    const selectedInterfaceName = ref('');
    const activePanelKey = ref('interfaces');
    const routes = ref([]);
    const routeFamilyFilter = ref('all');
    const isRouteLoading = ref(false);
    const isAddRouteModalVisible = ref(false);
    const isRouteAdding = ref(false);

    const filteredInterfaces = computed(() => {
        if (!selectedInterfaceName.value) return [];
        return interfaces.value.filter(i => i.name === selectedInterfaceName.value);
    });

    const interfaceOptions = computed(() =>
        interfaces.value.map(item => ({
            label:
                item.displayName && item.displayName !== item.name ? `${item.displayName} (${item.name})` : item.name,
            value: item.name
        }))
    );

    const filteredRoutes = computed(() => {
        if (routeFamilyFilter.value === 'all') return routes.value;
        return routes.value.filter(route => route.family === routeFamilyFilter.value);
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

    const routeForm = reactive({
        family: 'ipv4',
        destination: '',
        prefixLength: '24',
        gateway: '',
        interfaceName: '',
        metric: ''
    });

    const routeValidationErrors = ref({
        destination: '',
        prefixLength: '',
        gateway: '',
        metric: ''
    });

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

    const routeColumns = [
        {
            title: '地址族',
            dataIndex: 'family',
            key: 'family',
            width: 90,
            align: 'center'
        },
        {
            title: '目标网段',
            dataIndex: 'destinationPrefix',
            key: 'destinationPrefix',
            width: 220,
            ellipsis: true
        },
        {
            title: '网关/下一跳',
            dataIndex: 'gateway',
            key: 'gateway',
            width: 220,
            ellipsis: true
        },
        {
            title: '接口',
            dataIndex: 'interfaceName',
            key: 'interfaceName',
            width: 160,
            ellipsis: true
        },
        {
            title: 'Metric',
            dataIndex: 'metric',
            key: 'metric',
            width: 90,
            align: 'center'
        },
        {
            title: '协议',
            dataIndex: 'protocol',
            key: 'protocol',
            width: 110,
            ellipsis: true
        },
        {
            title: 'Flags/状态',
            dataIndex: 'flags',
            key: 'flags',
            width: 130,
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action',
            width: 90,
            fixed: 'right'
        }
    ];

    onMounted(() => {
        loadNetworkInfo();
        loadRouteInfo();
    });

    onActivated(() => {
        loadNetworkInfo();
        loadRouteInfo();
    });

    watch(
        () => routeForm.family,
        family => {
            routeForm.destination = '';
            routeForm.prefixLength = family === 'ipv6' ? '64' : '24';
            routeForm.gateway = '';
            routeForm.metric = '';
            clearRouteValidationErrors();
        }
    );

    // Simulate closing popovers (click outside usually handles it, but for buttons inside)
    function closeEditModal() {
        isEditModalVisible.value = false;
    }

    // Removed popover helper functions

    async function loadNetworkInfo() {
        if (!window.nativeApi) {
            notify.error('网络信息API不可用');
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
                notify.error(`获取网络信息失败: ${response.msg}`);
            }
        } catch (err) {
            notify.error(`获取网络信息出错: ${err.message}`);
        } finally {
            isLoading.value = false;
        }
    }

    function routeValue(value) {
        return value === null || value === undefined || value === '' ? '-' : value;
    }

    function clearRouteValidationErrors() {
        routeValidationErrors.value = {
            destination: '',
            prefixLength: '',
            gateway: '',
            metric: ''
        };
    }

    function setRouteFieldError(field, errorMessage) {
        routeValidationErrors.value[field] = errorMessage;
        return true;
    }

    function normalizeRouteFamily(family) {
        return String(family || '').toLowerCase() === 'ipv6' ? 'ipv6' : 'ipv4';
    }

    function isValidRouteIp(value, family) {
        if (family === 'ipv6') {
            const withoutScope = String(value || '').split('%')[0];
            return isValidIpv6(value) || isValidIpv6(withoutScope);
        }
        return isValidIpv4(value);
    }

    function validateRouteForm() {
        clearRouteValidationErrors();

        const family = normalizeRouteFamily(routeForm.family);
        const destination = String(routeForm.destination || '').trim();
        const prefixLength = String(routeForm.prefixLength || '').trim();
        const gateway = String(routeForm.gateway || '').trim();
        const metric = String(routeForm.metric || '').trim();
        const maxPrefixLength = family === 'ipv6' ? 128 : 32;
        const familyLabel = family === 'ipv6' ? 'IPv6' : 'IPv4';

        if (!destination) {
            return setRouteFieldError('destination', '请输入目标地址');
        }
        if (!isValidRouteIp(destination, family)) {
            return setRouteFieldError('destination', `请输入有效的 ${familyLabel} 目标地址`);
        }
        if (!/^\d+$/u.test(prefixLength)) {
            return setRouteFieldError('prefixLength', '前缀长度必须是整数');
        }
        const prefixNumber = Number(prefixLength);
        if (prefixNumber < 0 || prefixNumber > maxPrefixLength) {
            return setRouteFieldError('prefixLength', `前缀长度范围是 0-${maxPrefixLength}`);
        }
        if (!gateway) {
            return setRouteFieldError('gateway', '请输入下一跳网关');
        }
        if (!isValidRouteIp(gateway, family)) {
            return setRouteFieldError('gateway', `请输入有效的 ${familyLabel} 下一跳`);
        }
        if (metric && (!/^\d+$/u.test(metric) || Number(metric) > 999999)) {
            return setRouteFieldError('metric', 'Metric 必须是 0-999999 的整数');
        }

        routeForm.family = family;
        routeForm.destination = destination;
        routeForm.prefixLength = String(prefixNumber);
        routeForm.gateway = gateway;
        routeForm.metric = metric;
        return false;
    }

    function openAddRouteModal() {
        routeForm.family = 'ipv4';
        routeForm.destination = '';
        routeForm.prefixLength = '24';
        routeForm.gateway = '';
        routeForm.interfaceName = '';
        routeForm.metric = '';
        clearRouteValidationErrors();
        isAddRouteModalVisible.value = true;
    }

    async function loadRouteInfo() {
        if (!window.nativeApi?.getRoutes) {
            notify.error('本地路由API不可用');
            return;
        }

        isRouteLoading.value = true;
        try {
            const response = await window.nativeApi.getRoutes();
            if (response.status === 'success') {
                routes.value = (response.data || []).map((route, index) => ({
                    ...route,
                    id: route.id || `route-${index}`
                }));
            } else {
                notify.error(`获取本地路由失败: ${response.msg}`);
            }
        } catch (err) {
            notify.error(`获取本地路由出错: ${err.message}`);
        } finally {
            isRouteLoading.value = false;
        }
    }

    async function handleAddRouteOk() {
        if (validateRouteForm()) {
            return;
        }
        if (!window.nativeApi?.manageRoute) {
            notify.error('本地路由管理API不可用');
            return;
        }

        isRouteAdding.value = true;
        try {
            const response = await window.nativeApi.manageRoute({
                action: 'add',
                family: routeForm.family,
                destinationPrefix: `${routeForm.destination}/${routeForm.prefixLength}`,
                gateway: routeForm.gateway,
                interfaceName: routeForm.interfaceName,
                metric: routeForm.metric
            });

            if (response.status === 'success') {
                notify.success('添加路由成功');
                isAddRouteModalVisible.value = false;
                await loadRouteInfo();
            } else {
                notify.error(`添加路由失败: ${response.msg}`);
            }
        } catch (err) {
            notify.error(`添加路由出错: ${err.message}`);
        } finally {
            isRouteAdding.value = false;
        }
    }

    async function handleDeleteRoute(record) {
        if (!window.nativeApi?.manageRoute) {
            notify.error('本地路由管理API不可用');
            return;
        }
        if (!record?.destinationPrefix) {
            notify.error('路由目标网段为空，无法删除');
            return;
        }

        try {
            const response = await window.nativeApi.manageRoute({
                action: 'delete',
                family: normalizeRouteFamily(record.family),
                destinationPrefix: record.destinationPrefix,
                gateway: String(record.gateway || '').startsWith('link#') ? '' : record.gateway || '',
                interfaceName: record.interfaceName || ''
            });

            if (response.status === 'success') {
                notify.success('删除路由成功');
                await loadRouteInfo();
            } else {
                notify.error(`删除路由失败: ${response.msg}`);
            }
        } catch (err) {
            notify.error(`删除路由出错: ${err.message}`);
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
                notify.success('更新成功');
                closeEditModal();
                setTimeout(loadNetworkInfo, 1000); // Reduce timeout slightly
            } else {
                notify.error('更新失败: ' + response.msg);
            }
        } catch (err) {
            notify.error('更新出错: ' + err.message);
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
                notify.success('删除成功');
                setTimeout(loadNetworkInfo, 1000);
            } else {
                notify.error('删除失败: ' + response.msg);
            }
        } catch (err) {
            notify.error('删除出错: ' + err.message);
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
                notify.success('添加成功');
                isAddModalVisible.value = false;
                setTimeout(loadNetworkInfo, 1500);
            } else {
                notify.error(`添加失败: ${response.msg}`);
            }
        } catch (err) {
            notify.error(`添加出错: ${err.message}`);
        } finally {
            isAdding.value = false;
        }
    }

    // 暴露给父组件的方法
    defineExpose({
        clearValidationErrors: () => {
            editValidator.clearErrors();
            addValidator.clearErrors();
            clearRouteValidationErrors();
        }
    });
</script>

<style scoped>
    .network-info-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .network-info-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .network-info-card :deep(.nn-card-body) {
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

    .network-tabs,
    .network-tabs :deep(.nn-tabs-content-holder),
    .network-tabs :deep(.nn-tabs-content),
    .network-tabs :deep(.nn-tabs-tabpane) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .network-tabs :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin: 0 0 8px;
    }

    .network-pane {
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
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 10px;
        min-width: 0;
    }

    .network-interface-select {
        min-width: 280px;
    }

    .network-interface-toolbar {
        flex-wrap: nowrap;
    }

    .network-interface-toolbar .network-interface-select {
        width: 320px;
        min-width: 0;
        max-width: 100%;
        flex: 0 1 320px;
    }

    .network-interface-toolbar :deep(.nn-button) {
        flex: 0 0 auto;
    }

    .network-empty-value {
        color: var(--nn-color-text-muted);
    }

    .network-table-wrap {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .network-info-table,
    .network-info-table :deep(.nn-spin-nested-loading),
    .network-info-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .network-info-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .network-info-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        overflow: auto;
    }

    .network-info-table :deep(.nn-table-cell) {
        white-space: nowrap;
    }

    .network-info-table :deep(.nn-table-container),
    .network-info-table :deep(.nn-table-content) {
        min-height: 0;
    }

    .network-info-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .network-info-table :deep(.nn-table-thead > tr > th) {
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
        background-color: var(--nn-color-bg-subtle);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        transition: all 0.2s;
    }

    .ip-address-item:hover {
        background-color: var(--nn-color-bg-info-subtle);
        border-color: var(--nn-color-border-info);
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
        color: var(--nn-color-text-strong);
        margin-right: 4px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .subnet-text {
        font-size: 12px;
        color: var(--nn-color-text-muted);
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
        color: var(--nn-color-text-muted);
    }

    .add-ip-btn:hover {
        color: var(--nn-color-primary);
    }
</style>
