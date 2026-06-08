<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="RPKI ROA配置">
                    <a-form
                        :model="roaConfig"
                        :label-col="labelCol"
                        :wrapper-col="wrapperCol"
                        @finish="submitRoaConfig"
                    >
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="IP类型" name="ipType">
                                    <a-radio-group v-model:value="roaConfig.ipType">
                                        <a-radio :value="IP_TYPE.IPV4">IPv4</a-radio>
                                        <a-radio :value="IP_TYPE.IPV6">IPv6</a-radio>
                                    </a-radio-group>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="12">
                                <a-form-item label="IP" name="ip">
                                    <a-tooltip :title="validationErrors.ip" :open="!!validationErrors.ip">
                                        <a-input
                                            v-model:value="roaConfig.ip"
                                            :status="validationErrors.ip ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="12">
                                <a-form-item label="mask" name="mask">
                                    <a-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                        <a-input
                                            v-model:value="roaConfig.mask"
                                            :status="validationErrors.mask ? 'error' : ''"
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
                                            v-model:value="roaConfig.asn"
                                            :status="validationErrors.asn ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="最大前缀长度" name="maxLength">
                                    <a-tooltip :title="validationErrors.maxLength" :open="!!validationErrors.maxLength">
                                        <a-input
                                            v-model:value="roaConfig.maxLength"
                                            :status="validationErrors.maxLength ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button type="primary" html-type="submit" :loading="submitLoading">添加ROA</a-button>
                                <a-button :loading="importLoading" @click="importRoaJson">
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

        <!-- ROA列表 -->
        <a-row class="mt-margin-top-10">
            <a-col :span="24">
                <a-card :title="`ROA列表（共 ${roaPagination.total} 条）`">
                    <template #extra>
                        <a-button
                            danger
                            :disabled="roaPagination.total === 0"
                            :loading="deleteAllLoading"
                            @click="confirmDeleteAllRoa"
                        >
                            批量删除
                        </a-button>
                    </template>
                    <div>
                        <a-table
                            :columns="roaColumns"
                            :data-source="roaList"
                            :row-key="record => `${record.asn}-${record.ip}-${record.mask}-${record.maxLength}-${record.ipType}`"
                            :pagination="roaPagination"
                            :scroll="{ y: 200 }"
                            :loading="tableLoading"
                            size="small"
                            @change="handleTableChange"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <a-button type="link" danger @click="deleteRoa(record)">删除</a-button>
                                </template>
                                <template v-else-if="column.key === 'ipType'">
                                    <span>{{ record.ipType === IP_TYPE.IPV4 ? 'IPv4' : 'IPv6' }}</span>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup>
    import { ref, onMounted, watch } from 'vue';
    import { Modal, message } from 'ant-design-vue';
    import { UploadOutlined } from '@ant-design/icons-vue';
    import { FormValidator, createRpkiRoaConfigValidationRules } from '../../utils/validationCommon';
    import { DEFAULT_VALUES } from '../../const/rpkiConst';
    import { IP_TYPE } from '../../const/bgpConst';

    defineOptions({
        name: 'RpkiRoaConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const roaConfig = ref({
        ipType: IP_TYPE.IPV4,
        asn: DEFAULT_VALUES.DEFAULT_RPKI_ASN,
        ip: DEFAULT_VALUES.DEFAULT_RPKI_IPV4,
        mask: DEFAULT_VALUES.DEFAULT_RPKI_MASKV4,
        maxLength: DEFAULT_VALUES.DEFAULT_RPKI_MAX_LENGTHV4
    });

    const submitLoading = ref(false);
    const importLoading = ref(false);
    const deleteAllLoading = ref(false);
    const tableLoading = ref(false);
    const ROA_PAGE_SIZE = 10;

    // ROA列表
    const roaList = ref([]);
    const roaPagination = ref({
        current: 1,
        pageSize: ROA_PAGE_SIZE,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter']
    });
    const roaColumns = [
        {
            title: 'IP类型',
            dataIndex: 'ipType',
            key: 'ipType',
            width: 80
        },
        {
            title: 'ASN',
            dataIndex: 'asn',
            key: 'asn',
            ellipsis: true
        },
        {
            title: 'IP',
            dataIndex: 'ip',
            key: 'ip',
            ellipsis: true
        },
        {
            title: 'mask',
            dataIndex: 'mask',
            key: 'mask',
            ellipsis: true
        },
        {
            title: '最大前缀长度',
            dataIndex: 'maxLength',
            key: 'maxLength',
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const validationErrors = ref({
        asn: '',
        ip: '',
        mask: '',
        maxLength: ''
    });

    // 创建通用验证器（用于表单整体验证）
    let validator = new FormValidator(validationErrors);
    validator.addRules(createRpkiRoaConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    watch(
        () => roaConfig.value.ipType,
        newType => {
            if (newType === IP_TYPE.IPV4) {
                roaConfig.value.ip = DEFAULT_VALUES.DEFAULT_RPKI_IPV4;
                roaConfig.value.mask = DEFAULT_VALUES.DEFAULT_RPKI_MASKV4;
                roaConfig.value.maxLength = DEFAULT_VALUES.DEFAULT_RPKI_MAX_LENGTHV4;
            } else {
                roaConfig.value.ip = DEFAULT_VALUES.DEFAULT_RPKI_IPV6;
                roaConfig.value.mask = DEFAULT_VALUES.DEFAULT_RPKI_MASKV6;
                roaConfig.value.maxLength = DEFAULT_VALUES.DEFAULT_RPKI_MAX_LENGTHV6;
            }
            if (validator) {
                validator.clearErrors();
            }
        }
    );

    // 提交ROA配置
    const submitRoaConfig = async () => {
        // 使用新的验证系统
        const hasErrors = validator.validate(roaConfig.value);
        if (hasErrors) {
            message.error('请检查ROA配置信息是否正确');
            return;
        }

        submitLoading.value = true;
        try {
            const payload = JSON.parse(JSON.stringify(roaConfig.value));
            const result = await window.rpkiApi.addRoa(payload);
            if (result.status === 'success') {
                message.success('ROA添加成功');
                // 刷新ROA列表
                fetchRoaList(roaPagination.value.current);
            } else {
                message.error(result.msg || 'ROA添加失败');
            }
        } catch (error) {
            message.error(`ROA添加出错: ${error.message}`);
        } finally {
            submitLoading.value = false;
        }
    };

    // 重置表单
    const resetForm = () => {
        roaConfig.value = {
            ipType: roaConfig.value.ipType, // 保持当前选择的IP类型
            asn: DEFAULT_VALUES.DEFAULT_RPKI_ASN,
            ip:
                roaConfig.value.ipType === IP_TYPE.IPV4
                    ? DEFAULT_VALUES.DEFAULT_RPKI_IPV4
                    : DEFAULT_VALUES.DEFAULT_RPKI_IPV6,
            mask:
                roaConfig.value.ipType === IP_TYPE.IPV4
                    ? DEFAULT_VALUES.DEFAULT_RPKI_MASKV4
                    : DEFAULT_VALUES.DEFAULT_RPKI_MASKV6,
            maxLength:
                roaConfig.value.ipType === IP_TYPE.IPV4
                    ? DEFAULT_VALUES.DEFAULT_RPKI_MAX_LENGTHV4
                    : DEFAULT_VALUES.DEFAULT_RPKI_MAX_LENGTHV6
        };
    };

    // 删除ROA
    const deleteRoa = async record => {
        try {
            const result = await window.rpkiApi.deleteRoa({
                asn: record.asn,
                ip: record.ip,
                mask: record.mask,
                maxLength: record.maxLength,
                ipType: record.ipType
            });

            if (result.status === 'success') {
                message.success('ROA删除成功');
                const nextPage =
                    roaList.value.length === 1 && roaPagination.value.current > 1
                        ? roaPagination.value.current - 1
                        : roaPagination.value.current;
                fetchRoaList(nextPage);
            } else {
                message.error(result.msg || 'ROA删除失败');
            }
        } catch (error) {
            message.error(`ROA删除出错: ${error.message}`);
        }
    };

    const importRoaJson = async () => {
        importLoading.value = true;
        try {
            const result = await window.rpkiApi.importRoaJson();
            if (result.status !== 'success') {
                message.error(result.msg || 'ROA JSON导入失败');
                return;
            }

            if (result.data?.cancelled) {
                return;
            }

            const stats = result.data || {};
            message.success(
                `ROA导入完成：新增 ${stats.imported || 0} 条，重复 ${stats.duplicate || 0} 条，无效 ${stats.invalid || 0} 条`
            );
            fetchRoaList(1);
        } catch (error) {
            message.error(`ROA JSON导入出错: ${error.message}`);
        } finally {
            importLoading.value = false;
        }
    };

    const confirmDeleteAllRoa = () => {
        Modal.confirm({
            title: '确认批量删除ROA？',
            content: `将删除全部 ${roaPagination.value.total} 条 ROA。RPKI服务运行时会向客户端批量发送撤销报文。`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: deleteAllRoa
        });
    };

    const deleteAllRoa = async () => {
        deleteAllLoading.value = true;
        try {
            const result = await window.rpkiApi.deleteAllRoa();
            if (result.status === 'success') {
                message.success(`ROA批量删除成功：删除 ${result.data?.deleted || 0} 条`);
                fetchRoaList(1);
            } else {
                message.error(result.msg || 'ROA批量删除失败');
            }
        } catch (error) {
            message.error(`ROA批量删除出错: ${error.message}`);
        } finally {
            deleteAllLoading.value = false;
        }
    };

    const handleTableChange = pagination => {
        fetchRoaList(pagination.current);
    };

    // 获取ROA列表
    const fetchRoaList = async (page = roaPagination.value.current) => {
        tableLoading.value = true;
        try {
            const result = await window.rpkiApi.getRoaList({ page, pageSize: ROA_PAGE_SIZE });
            if (result.status === 'success') {
                if (Array.isArray(result.data)) {
                    roaList.value = result.data;
                    roaPagination.value = {
                        ...roaPagination.value,
                        current: page,
                        pageSize: ROA_PAGE_SIZE,
                        total: result.data.length
                    };
                    return;
                }

                roaList.value = result.data.items || [];
                roaPagination.value = {
                    ...roaPagination.value,
                    current: result.data.page || page,
                    pageSize: ROA_PAGE_SIZE,
                    total: result.data.total || 0
                };
            } else {
                console.error('获取ROA列表失败:', result.msg);
            }
        } catch (error) {
            console.error('获取ROA列表失败:', error);
        } finally {
            tableLoading.value = false;
        }
    };

    onMounted(async () => {
        fetchRoaList();
    });
</script>

<style scoped>
    :deep(.ant-table-body) {
        height: 300px !important;
        overflow-y: auto !important;
    }
</style>
