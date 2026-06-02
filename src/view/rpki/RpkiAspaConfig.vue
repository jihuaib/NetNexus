<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="RPKI ASPA 配置 (协议 v2)">
                    <a-form
                        :model="aspaConfig"
                        :label-col="labelCol"
                        :wrapper-col="wrapperCol"
                        @finish="submitAspa"
                    >
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
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加 ASPA
                                </a-button>
                                <a-button @click="resetForm">重置</a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <a-row class="mt-margin-top-10">
            <a-col :span="24">
                <a-card title="ASPA 列表">
                    <a-table
                        :columns="aspaColumns"
                        :data-source="aspaList"
                        :row-key="record => `${record.customerAsn}`"
                        :pagination="{ pageSize: 10, showSizeChanger: false, position: ['bottomCenter'] }"
                        :scroll="{ y: 200 }"
                        size="small"
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
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
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
    const aspaList = ref([]);
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
                message.success('ASPA 添加成功');
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
        aspaConfig.value = {
            customerAsn: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_CUSTOMER_ASN,
            providerAsnsRaw: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_PROVIDER_ASNS,
            afiFlags: DEFAULT_VALUES.DEFAULT_RPKI_ASPA_AFI_FLAGS
        };
    };

    const deleteAspa = async record => {
        try {
            const result = await window.rpkiApi.deleteAspa({ customerAsn: record.customerAsn });
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
            const result = await window.rpkiApi.getAspaList();
            if (result.status === 'success') {
                aspaList.value = result.data;
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
    :deep(.ant-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
