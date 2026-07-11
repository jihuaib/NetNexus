<template>
    <div class="mt-container adaptive-list-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="RPKI Router Key 配置 (协议 v1+)">
                    <nn-form :model="rkConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="submitRk">
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="SKI" name="ski">
                                    <nn-tooltip :title="validationErrors.ski" :open="!!validationErrors.ski">
                                        <nn-input
                                            v-model:value="rkConfig.ski"
                                            placeholder="20 字节 hex (40 字符)"
                                            :status="validationErrors.ski ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="ASN" name="asn">
                                    <nn-tooltip :title="validationErrors.asn" :open="!!validationErrors.asn">
                                        <nn-input
                                            v-model:value="rkConfig.asn"
                                            :status="validationErrors.asn ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="SPKI" name="spki">
                                    <nn-tooltip :title="validationErrors.spki" :open="!!validationErrors.spki">
                                        <nn-textarea
                                            v-model:value="rkConfig.spki"
                                            placeholder="Subject Public Key Info, DER 编码 hex"
                                            :rows="3"
                                            :status="validationErrors.spki ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <nn-space>
                                <nn-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加 Router Key
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
                <nn-card title="Router Key 列表" class="adaptive-list-card">
                    <nn-table
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
                                <nn-button type="link" danger @click="deleteRk(record)">删除</nn-button>
                            </template>
                        </template>
                    </nn-table>
                </nn-card>
            </nn-col>
        </nn-row>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
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
            notify.error('请检查 Router Key 配置');
            return;
        }
        submitLoading.value = true;
        try {
            const payload = JSON.parse(JSON.stringify(rkConfig.value));
            const result = await window.rpkiApi.addRouterKey(payload);
            if (result.status === 'success') {
                notify.success('Router Key 添加成功');
                fetchList();
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
                notify.success('删除成功');
                fetchList();
            } else {
                notify.error(result.msg || '删除失败');
            }
        } catch (e) {
            notify.error(`删除出错: ${e.message}`);
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
