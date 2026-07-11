<template>
    <div class="mt-container adaptive-table-page">
        <nn-row class="adaptive-table-row">
            <nn-col :span="24">
                <nn-card title="租约列表" class="adaptive-table-card">
                    <template #extra>
                        <nn-button size="small" @click="loadLeaseList">刷新</nn-button>
                    </template>
                    <nn-table
                        :columns="columns"
                        :data-source="leaseList"
                        :row-key="record => `${record.version}-${record.id}`"
                        :pagination="{
                            pageSize: 20,
                            showSizeChanger: false,
                            position: ['bottomCenter'],
                            showTotal: total => '共 ' + total + ' 条，每页 20 条'
                        }"
                        :scroll="{ y: '100%' }"
                        size="small"
                        class="adaptive-table"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'version'">
                                <nn-tag :color="record.version === 6 ? 'blue' : 'green'">
                                    {{ record.version === 6 ? 'IPv6' : 'IPv4' }}
                                </nn-tag>
                            </template>
                            <template v-if="column.key === 'status'">
                                <nn-tag :color="record.status === 'active' ? 'success' : 'default'">
                                    {{ record.status === 'active' ? '有效' : '已过期' }}
                                </nn-tag>
                            </template>
                            <template v-if="column.key === 'action'">
                                <nn-popconfirm
                                    title="确认释放此租约？"
                                    ok-text="确认"
                                    cancel-text="取消"
                                    @confirm="releaseLease(record)"
                                >
                                    <nn-button type="link" danger size="small">释放</nn-button>
                                </nn-popconfirm>
                            </template>
                        </template>
                    </nn-table>
                </nn-card>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { DHCP_SUB_EVT_TYPES, DHCP_EVENT_PAGE_ID } from '../../const/dhcpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'DhcpLeaseList' });

    const leaseList = ref([]);

    const columns = [
        { title: '版本', key: 'version', width: 70 },
        { title: '标识(MAC/DUID)', dataIndex: 'id', key: 'id', ellipsis: true },
        { title: 'IP地址', dataIndex: 'ip', key: 'ip', width: 160 },
        {
            title: '详情',
            key: 'detail',
            ellipsis: true,
            customRender: ({ record }) => record.hostname || record.iaid || '-'
        },
        {
            title: '生命周期(秒)',
            key: 'lifetime',
            width: 110,
            customRender: ({ record }) => record.leaseTime ?? record.validLifetime ?? '-'
        },
        { title: '分配时间', dataIndex: 'startTime', key: 'startTime', ellipsis: true },
        { title: '到期时间', dataIndex: 'expiresAt', key: 'expiresAt', ellipsis: true },
        { title: '状态', dataIndex: 'status', key: 'status', width: 80 },
        { title: '操作', key: 'action', width: 80 }
    ];

    const loadLeaseList = async () => {
        try {
            const result = await window.dhcpApi.getLeaseList();
            if (result.status === 'success') {
                leaseList.value = result.data || [];
            }
        } catch (error) {
            console.error('加载租约列表失败:', error);
        }
    };

    const releaseLease = async record => {
        try {
            let result;
            if (record.version === 6) {
                result = await window.dhcpApi.releaseDhcp6Lease(record.duid);
            } else {
                result = await window.dhcpApi.releaseLease(record.macAddr);
            }
            if (result.status === 'success') {
                notify.success(`租约 ${record.id} 已释放`);
            } else {
                notify.error(result.msg || '租约释放失败');
            }
        } catch (error) {
            notify.error(`租约释放出错: ${error.message}`);
        }
    };

    const onDhcpEvt = result => {
        if (result.status !== 'success') return;
        const data = result.data;

        if (data.type === DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE) {
            const version = data.version || 4;
            const lease = { ...data.data, version, id: version === 6 ? data.data.duid : data.data.macAddr };
            if (data.opType === 'add') {
                leaseList.value = [...leaseList.value, lease];
            } else if (data.opType === 'remove') {
                leaseList.value = leaseList.value.filter(l => !(l.id === lease.id && l.version === version));
            } else if (data.opType === 'update') {
                const idx = leaseList.value.findIndex(l => l.id === lease.id && l.version === version);
                if (idx !== -1) {
                    const newList = [...leaseList.value];
                    newList[idx] = lease;
                    leaseList.value = newList;
                }
            }
        }
    };

    onActivated(async () => {
        EventBus.on('dhcp:event', DHCP_EVENT_PAGE_ID.PAGE_ID_DHCP_LEASE, onDhcpEvt);
        await loadLeaseList();
    });

    onDeactivated(() => {
        EventBus.off('dhcp:event', DHCP_EVENT_PAGE_ID.PAGE_ID_DHCP_LEASE);
    });
</script>

<style scoped>
    .adaptive-table-page {
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .adaptive-table-row,
    .adaptive-table-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-table-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-table-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.nn-spin-nested-loading),
    .adaptive-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .adaptive-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.nn-table-container),
    .adaptive-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
