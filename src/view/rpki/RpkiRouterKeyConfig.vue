<template>
    <div class="mt-container adaptive-list-page">
        <a-row class="adaptive-form-row">
            <a-col :span="24">
                <a-card title="RPKI Router Key 配置 (协议 v1+)">
                    <a-form :model="rkConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="submitRk">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="SKI" name="ski">
                                    <a-tooltip :title="validationErrors.ski" :open="!!validationErrors.ski">
                                        <a-input
                                            v-model:value="rkConfig.ski"
                                            placeholder="20 字节 hex (40 字符)"
                                            :status="validationErrors.ski ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="ASN" name="asn">
                                    <a-tooltip :title="validationErrors.asn" :open="!!validationErrors.asn">
                                        <a-input
                                            v-model:value="rkConfig.asn"
                                            :status="validationErrors.asn ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="SPKI" name="spki">
                                    <a-tooltip :title="validationErrors.spki" :open="!!validationErrors.spki">
                                        <a-textarea
                                            v-model:value="rkConfig.spki"
                                            placeholder="Subject Public Key Info, DER 编码 hex"
                                            :rows="3"
                                            :status="validationErrors.spki ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加 Router Key
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
                <a-card title="Router Key 列表" class="adaptive-list-card">
                    <a-table
                        :columns="rkColumns"
                        :data-source="rkList"
                        :row-key="record => `${record.ski}-${record.asn}`"
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
                            <template v-if="column.key === 'action'">
                                <a-button type="link" danger @click="deleteRk(record)">删除</a-button>
                            </template>
                        </template>
                    </a-table>
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { FormValidator, createRpkiRouterKeyValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES } from '../../const/rpkiConst';

    defineOptions({ name: 'RpkiRouterKeyConfig' });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const rkConfig = ref({
        ski: DEFAULT_VALUES.DEFAULT_RPKI_RK_SKI,
        asn: DEFAULT_VALUES.DEFAULT_RPKI_ASN,
        spki: DEFAULT_VALUES.DEFAULT_RPKI_RK_SPKI
    });

    const submitLoading = ref(false);
    const rkList = ref([]);
    const rkColumns = [
        { title: 'SKI', dataIndex: 'ski', key: 'ski', ellipsis: true },
        { title: 'ASN', dataIndex: 'asn', key: 'asn', ellipsis: true },
        { title: 'SPKI', dataIndex: 'spki', key: 'spki', ellipsis: true },
        { title: '操作', key: 'action' }
    ];

    const validationErrors = ref({ ski: '', asn: '', spki: '' });
    const validator = new FormValidator(validationErrors);
    validator.addRules(createRpkiRouterKeyValidationRules());

    defineExpose({
        clearValidationErrors: () => validator.clearErrors()
    });

    const submitRk = async () => {
        const hasErrors = validator.validate(rkConfig.value);
        if (hasErrors) {
            message.error('请检查 Router Key 配置');
            return;
        }
        submitLoading.value = true;
        try {
            const payload = JSON.parse(JSON.stringify(rkConfig.value));
            const result = await window.rpkiApi.addRouterKey(payload);
            if (result.status === 'success') {
                message.success('Router Key 添加成功');
                fetchList();
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
        rkConfig.value = {
            ski: DEFAULT_VALUES.DEFAULT_RPKI_RK_SKI,
            asn: DEFAULT_VALUES.DEFAULT_RPKI_ASN,
            spki: DEFAULT_VALUES.DEFAULT_RPKI_RK_SPKI
        };
    };

    const deleteRk = async record => {
        try {
            const result = await window.rpkiApi.deleteRouterKey({ ski: record.ski, asn: record.asn });
            if (result.status === 'success') {
                message.success('删除成功');
                fetchList();
            } else {
                message.error(result.msg || '删除失败');
            }
        } catch (e) {
            message.error(`删除出错: ${e.message}`);
        }
    };

    const fetchList = async () => {
        try {
            const result = await window.rpkiApi.getRouterKeyList();
            if (result.status === 'success') {
                rkList.value = result.data;
            }
        } catch (e) {
            console.error(e);
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
