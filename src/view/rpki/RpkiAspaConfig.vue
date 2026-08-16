<template>
    <div class="nn-container adaptive-list-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="RPKI ASPA 配置 (协议 v2)">
                    <nn-form :model="aspaConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="submitAspa">
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="Customer ASN" name="customerAsn">
                                    <nn-tooltip
                                        :title="validationErrors.customerAsn"
                                        :open="!!validationErrors.customerAsn"
                                    >
                                        <nn-input
                                            v-model:value="aspaConfig.customerAsn"
                                            :status="validationErrors.customerAsn ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="Provider ASNs" name="providerAsnsRaw">
                                    <nn-tooltip
                                        :title="validationErrors.providerAsnsRaw"
                                        :open="!!validationErrors.providerAsnsRaw"
                                    >
                                        <nn-input
                                            v-model:value="aspaConfig.providerAsnsRaw"
                                            placeholder="逗号分隔，如 65001,65002"
                                            :status="validationErrors.providerAsnsRaw ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="AFI Flags" name="afiFlags">
                                    <nn-radio-group v-model:value="aspaConfig.afiFlags">
                                        <nn-radio :value="RPKI_ASPA_AFI_FLAGS.IPV4">IPv4</nn-radio>
                                        <nn-radio :value="RPKI_ASPA_AFI_FLAGS.IPV6">IPv6</nn-radio>
                                        <nn-radio :value="RPKI_ASPA_AFI_FLAGS.BOTH">Both</nn-radio>
                                    </nn-radio-group>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-form-item class="rpki-form-actions" :wrapper-col="{ span: 24 }">
                            <nn-space>
                                <nn-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加 ASPA
                                </nn-button>
                                <nn-button @click="showAspaImportModal">
                                    <template #icon><UploadOutlined /></template>
                                    导入JSON
                                </nn-button>
                                <nn-button @click="resetForm">重置</nn-button>
                            </nn-space>
                        </nn-form-item>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card :title="aspaListTitle" class="adaptive-list-card">
                    <template #extra>
                        <nn-button
                            class="aspa-delete-all-button"
                            danger
                            :disabled="aspaStorageTotal === 0"
                            :loading="deleteAllLoading"
                            @click="confirmDeleteAllAspa"
                        >
                            批量删除
                        </nn-button>
                    </template>
                    <nn-table
                        data-testid="rpki-aspa-table"
                        :columns="aspaColumns"
                        :data-source="aspaList"
                        :row-key="record => `${record.customerAsn}`"
                        :pagination="aspaPagination"
                        :scroll="{ y: '100%' }"
                        :loading="tableLoading"
                        size="small"
                        class="adaptive-table"
                        @change="handleTableChange"
                    >
                        <template #bodyCell="{ column, record }">
                            <template v-if="column.key === 'providerAsns'">
                                <nn-tooltip :title="providerAsnsTooltip(record.providerAsns)">
                                    <span class="provider-asns-preview">
                                        {{ formatProviderAsns(record.providerAsns) }}
                                    </span>
                                </nn-tooltip>
                            </template>
                            <template v-if="column.key === 'afiFlags'">
                                {{ afiText(record.afiFlags) }}
                            </template>
                            <template v-if="column.key === 'action'">
                                <nn-button type="link" danger @click="deleteAspa(record)">删除</nn-button>
                            </template>
                        </template>
                    </nn-table>
                </nn-card>
            </nn-col>
        </nn-row>

        <RpkiAspaImportModal v-model:open="aspaImportModalVisible" @imported="handleAspaImported" />
    </div>
</template>

<script setup>
    import { computed, ref } from 'vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { UploadOutlined } from 'netnexus-ui/icons';
    import RpkiAspaImportModal from '../../components/RpkiAspaImportModal.vue';
    import { FormValidator, createRpkiAspaValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, RPKI_ASPA_AFI_FLAGS, RPKI_EVENT_PAGE_ID } from '../../const/rpkiConst';
    import { useRpkiDatasetRuntime } from './useRpkiDatasetRuntime';

    defineOptions({ name: 'RpkiAspaConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const aspaConfig = ref({
        customerAsn: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_CUSTOMER_ASN,
        providerAsnsRaw: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_PROVIDER_ASNS,
        afiFlags: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_AFI_FLAGS
    });

    const submitLoading = ref(false);
    const deleteAllLoading = ref(false);
    const tableLoading = ref(false);
    const aspaImportModalVisible = ref(false);
    const ASPA_PAGE_SIZE = 20;
    let aspaListRequestId = 0;
    const aspaList = ref([]);
    const aspaStorageTotal = ref(0);
    const aspaPagination = ref({
        current: 1,
        pageSize: ASPA_PAGE_SIZE,
        total: 0,
        showSizeChanger: false,
        showTotal: total => `共 ${total} 条，每页 ${ASPA_PAGE_SIZE} 条`,
        position: ['bottomCenter']
    });
    const aspaListTitle = computed(() => `ASPA 列表（共 ${aspaStorageTotal.value || aspaPagination.value.total} 条）`);
    const aspaColumns = [
        { title: 'Customer ASN', dataIndex: 'customerAsn', key: 'customerAsn', width: 140, ellipsis: true },
        { title: 'Provider ASNs', key: 'providerAsns', ellipsis: true },
        { title: 'AFI', key: 'afiFlags', width: 110, ellipsis: true },
        { title: '操作', key: 'action', width: 90, align: 'center' }
    ];
    const PROVIDER_ASN_PREVIEW_LIMIT = 8;

    const validationErrors = ref({ customerAsn: '', providerAsnsRaw: '', afiFlags: '' });
    const validator = new FormValidator(validationErrors);
    validator.addRules(createRpkiAspaValidationRules());

    defineExpose({
        clearValidationErrors: () => validator.clearErrors()
    });

    const afiText = flags => {
        if (flags === RPKI_ASPA_AFI_FLAGS.BOTH) return 'IPv4+IPv6';
        if (flags === RPKI_ASPA_AFI_FLAGS.IPV4) return 'IPv4';
        if (flags === RPKI_ASPA_AFI_FLAGS.IPV6) return 'IPv6';
        return String(flags);
    };

    const getProviderAsnList = providerAsns => (Array.isArray(providerAsns) ? providerAsns : []);

    const formatProviderAsns = providerAsns => {
        const list = getProviderAsnList(providerAsns);
        if (list.length === 0) {
            return '无';
        }

        const preview = list.slice(0, PROVIDER_ASN_PREVIEW_LIMIT).join(', ');
        return list.length > PROVIDER_ASN_PREVIEW_LIMIT ? `${preview} ... 共 ${list.length} 个` : preview;
    };

    const providerAsnsTooltip = providerAsns => {
        const list = getProviderAsnList(providerAsns);
        if (list.length <= PROVIDER_ASN_PREVIEW_LIMIT) {
            return formatProviderAsns(list);
        }
        return `仅显示前 ${PROVIDER_ASN_PREVIEW_LIMIT} 个，共 ${list.length} 个 Provider ASN`;
    };

    const submitAspa = async () => {
        const hasErrors = validator.validate(aspaConfig.value);
        if (hasErrors) {
            notify.error('请检查 ASPA 配置');
            return;
        }
        submitLoading.value = true;
        try {
            const providerAsns = aspaConfig.value.providerAsnsRaw
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            const payload = {
                customerAsn: aspaConfig.value.customerAsn,
                providerAsns,
                afiFlags: aspaConfig.value.afiFlags
            };
            const result = await window.rpkiApi.addAspa(payload);
            if (result.status === 'success') {
                notify.success(result.msg || 'ASPA 保存成功');
                fetchList(aspaPagination.value.current);
            } else {
                notify.error(result.msg || '添加失败');
            }
        } catch (e) {
            notify.error(`添加出错: ${e.message}`);
        } finally {
            submitLoading.value = false;
        }
    };

    const resetForm = () => {
        aspaConfig.value = {
            customerAsn: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_CUSTOMER_ASN,
            providerAsnsRaw: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_PROVIDER_ASNS,
            afiFlags: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_AFI_FLAGS
        };
    };

    const showAspaImportModal = () => {
        aspaImportModalVisible.value = true;
    };

    const handleAspaImported = () => {
        fetchList(1);
    };

    const deleteAspa = async record => {
        try {
            const result = await window.rpkiApi.deleteAspa({ customerAsn: record.customerAsn });
            if (result.status === 'success') {
                notify.success('删除成功');
                const nextPage =
                    aspaList.value.length === 1 && aspaPagination.value.current > 1
                        ? aspaPagination.value.current - 1
                        : aspaPagination.value.current;
                fetchList(nextPage);
            } else {
                notify.error(result.msg || '删除失败');
            }
        } catch (e) {
            notify.error(`删除出错: ${e.message}`);
        }
    };

    const deleteAllAspa = async () => {
        deleteAllLoading.value = true;
        try {
            const result = await window.rpkiApi.deleteAllAspa();
            if (result.status === 'success') {
                notify.success(`ASPA批量删除成功：删除 ${result.data?.deleted || 0} 条`);
                fetchList(1);
            } else {
                notify.error(result.msg || 'ASPA批量删除失败');
            }
        } catch (e) {
            notify.error(`ASPA批量删除出错: ${e.message}`);
        } finally {
            deleteAllLoading.value = false;
        }
    };

    const confirmDeleteAllAspa = () => {
        dialog.confirm({
            title: '确认批量删除ASPA？',
            content: `将删除全部 ${aspaStorageTotal.value} 条 ASPA。RPKI服务运行时会通知客户端重新同步缓存。`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: deleteAllAspa
        });
    };

    const handleTableChange = pagination => {
        fetchList(pagination.current);
    };

    const clearAspaList = () => {
        aspaListRequestId += 1;
        aspaList.value = [];
        aspaStorageTotal.value = 0;
        aspaPagination.value = {
            ...aspaPagination.value,
            current: 1,
            total: 0
        };
        tableLoading.value = false;
    };

    const fetchList = async (page = aspaPagination.value.current) => {
        const requestId = ++aspaListRequestId;
        tableLoading.value = true;
        try {
            const result = await window.rpkiApi.getAspaList({
                page,
                pageSize: ASPA_PAGE_SIZE
            });
            if (requestId !== aspaListRequestId) return;
            if (result.status === 'success') {
                if (Array.isArray(result.data)) {
                    aspaList.value = result.data;
                    aspaStorageTotal.value = result.data.length;
                    aspaPagination.value = {
                        ...aspaPagination.value,
                        current: page,
                        pageSize: ASPA_PAGE_SIZE,
                        total: result.data.length
                    };
                    return;
                }

                aspaList.value = result.data.items || [];
                aspaStorageTotal.value = result.data.storageTotal ?? result.data.total ?? 0;
                aspaPagination.value = {
                    ...aspaPagination.value,
                    current: result.data.page || page,
                    pageSize: ASPA_PAGE_SIZE,
                    total: result.data.total || 0
                };
            } else {
                console.warn('获取ASPA列表失败:', result.msg);
                clearAspaList();
            }
        } catch (e) {
            if (requestId !== aspaListRequestId) return;
            console.error(e);
            clearAspaList();
        } finally {
            if (requestId === aspaListRequestId) {
                tableLoading.value = false;
            }
        }
    };

    useRpkiDatasetRuntime(RPKI_EVENT_PAGE_ID.PAGE_ID_RPKI_ASPA_CONFIG, {
        clearDataset: clearAspaList,
        refreshDataset: () => fetchList()
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .rpki-form-actions :deep(.nn-form-item-control-input-content) {
        display: flex;
        justify-content: center;
    }

    .provider-asns-preview {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .aspa-delete-all-button:disabled,
    .aspa-delete-all-button.nn-button-disabled {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
        opacity: 1 !important;
    }

    .aspa-delete-all-button:disabled:hover,
    .aspa-delete-all-button.nn-button-disabled:hover,
    .aspa-delete-all-button:disabled:focus,
    .aspa-delete-all-button.nn-button-disabled:focus {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
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
