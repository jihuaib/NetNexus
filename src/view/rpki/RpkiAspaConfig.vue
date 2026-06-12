<template>
    <div class="mt-container adaptive-list-page">
        <a-row class="adaptive-form-row">
            <a-col :span="24">
                <a-card title="RPKI ASPA 配置 (协议 v2)">
                    <a-form :model="aspaConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="submitAspa">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="Customer ASN" name="customerAsn">
                                    <a-tooltip
                                        :title="validationErrors.customerAsn"
                                        :open="!!validationErrors.customerAsn"
                                    >
                                        <a-input
                                            v-model:value="aspaConfig.customerAsn"
                                            :status="validationErrors.customerAsn ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="Provider ASNs" name="providerAsnsRaw">
                                    <a-tooltip
                                        :title="validationErrors.providerAsnsRaw"
                                        :open="!!validationErrors.providerAsnsRaw"
                                    >
                                        <a-input
                                            v-model:value="aspaConfig.providerAsnsRaw"
                                            placeholder="逗号分隔，如 65001,65002"
                                            :status="validationErrors.providerAsnsRaw ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="AFI Flags" name="afiFlags">
                                    <a-radio-group v-model:value="aspaConfig.afiFlags">
                                        <a-radio :value="RPKI_ASPA_AFI_FLAGS.IPV4">IPv4</a-radio>
                                        <a-radio :value="RPKI_ASPA_AFI_FLAGS.IPV6">IPv6</a-radio>
                                        <a-radio :value="RPKI_ASPA_AFI_FLAGS.BOTH">Both</a-radio>
                                    </a-radio-group>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item class="rpki-form-actions" :wrapper-col="{ span: 24 }">
                            <a-space>
                                <a-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加 ASPA
                                </a-button>
                                <a-button @click="showAspaImportModal">
                                    <template #icon><UploadOutlined /></template>
                                    导入JSON
                                </a-button>
                                <a-button @click="resetForm">重置</a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <a-row class="adaptive-list-row">
            <a-col :span="24">
                <a-card :title="aspaListTitle" class="adaptive-list-card">
                    <template #extra>
                        <a-button
                            class="aspa-delete-all-button"
                            danger
                            :disabled="aspaStorageTotal === 0"
                            :loading="deleteAllLoading"
                            @click="confirmDeleteAllAspa"
                        >
                            批量删除
                        </a-button>
                    </template>
                    <a-table
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
                                {{ (record.providerAsns || []).join(', ') }}
                            </template>
                            <template v-if="column.key === 'afiFlags'">
                                {{ afiText(record.afiFlags) }}
                            </template>
                            <template v-if="column.key === 'action'">
                                <a-button type="link" danger @click="deleteAspa(record)">删除</a-button>
                            </template>
                        </template>
                    </a-table>
                </a-card>
            </a-col>
        </a-row>

        <RpkiAspaImportModal v-model:open="aspaImportModalVisible" @imported="handleAspaImported" />
    </div>
</template>

<script setup>
    import { computed, ref, onMounted } from 'vue';
    import { message, Modal } from 'ant-design-vue';
    import { UploadOutlined } from '@ant-design/icons-vue';
    import RpkiAspaImportModal from '../../components/RpkiAspaImportModal.vue';
    import { FormValidator, createRpkiAspaValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, RPKI_ASPA_AFI_FLAGS } from '../../const/rpkiConst';

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
        { title: 'Customer ASN', dataIndex: 'customerAsn', key: 'customerAsn', ellipsis: true },
        { title: 'Provider ASNs', key: 'providerAsns', ellipsis: true },
        { title: 'AFI', key: 'afiFlags', ellipsis: true },
        { title: '操作', key: 'action' }
    ];

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

    const submitAspa = async () => {
        const hasErrors = validator.validate(aspaConfig.value);
        if (hasErrors) {
            message.error('请检查 ASPA 配置');
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
                message.success(result.msg || 'ASPA 保存成功');
                fetchList(aspaPagination.value.current);
            } else {
                message.error(result.msg || '添加失败');
            }
        } catch (e) {
            message.error(`添加出错: ${e.message}`);
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
                message.success('删除成功');
                const nextPage =
                    aspaList.value.length === 1 && aspaPagination.value.current > 1
                        ? aspaPagination.value.current - 1
                        : aspaPagination.value.current;
                fetchList(nextPage);
            } else {
                message.error(result.msg || '删除失败');
            }
        } catch (e) {
            message.error(`删除出错: ${e.message}`);
        }
    };

    const deleteAllAspa = async () => {
        deleteAllLoading.value = true;
        try {
            const result = await window.rpkiApi.deleteAllAspa();
            if (result.status === 'success') {
                message.success(`ASPA批量删除成功：删除 ${result.data?.deleted || 0} 条`);
                fetchList(1);
            } else {
                message.error(result.msg || 'ASPA批量删除失败');
            }
        } catch (e) {
            message.error(`ASPA批量删除出错: ${e.message}`);
        } finally {
            deleteAllLoading.value = false;
        }
    };

    const confirmDeleteAllAspa = () => {
        Modal.confirm({
            title: '确认批量删除ASPA？',
            content: `将删除全部 ${aspaStorageTotal.value} 条 ASPA。RPKI服务运行时会向客户端批量发送撤销报文。`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: deleteAllAspa
        });
    };

    const handleTableChange = pagination => {
        fetchList(pagination.current);
    };

    const fetchList = async (page = aspaPagination.value.current) => {
        tableLoading.value = true;
        try {
            const result = await window.rpkiApi.getAspaList({
                page,
                pageSize: ASPA_PAGE_SIZE
            });
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
            }
        } catch (e) {
            console.error(e);
        } finally {
            tableLoading.value = false;
        }
    };

    onMounted(() => {
        fetchList();
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: calc(100vh - 70px);
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

    .adaptive-list-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .rpki-form-actions :deep(.ant-form-item-control-input-content) {
        display: flex;
        justify-content: center;
    }

    .aspa-delete-all-button:disabled,
    .aspa-delete-all-button.ant-btn-disabled {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
        opacity: 1 !important;
    }

    .aspa-delete-all-button:disabled:hover,
    .aspa-delete-all-button.ant-btn-disabled:hover,
    .aspa-delete-all-button:disabled:focus,
    .aspa-delete-all-button.ant-btn-disabled:focus {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
    }

    .adaptive-table,
    .adaptive-table :deep(.ant-spin-nested-loading),
    .adaptive-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .adaptive-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.ant-table-container),
    .adaptive-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
