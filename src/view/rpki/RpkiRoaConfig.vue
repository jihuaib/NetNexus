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
                        <a-form-item class="rpki-form-actions" :wrapper-col="{ span: 24 }">
                            <a-space>
                                <a-button type="primary" html-type="submit" :loading="submitLoading">添加ROA</a-button>
                                <a-button @click="showRoaImportModal">
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
                <a-card :title="roaListTitle">
                    <template #extra>
                        <a-button
                            class="roa-delete-all-button"
                            danger
                            :disabled="roaStorageTotal === 0"
                            :loading="deleteAllLoading"
                            @click="confirmDeleteAllRoa"
                        >
                            批量删除
                        </a-button>
                    </template>
                    <div>
                        <div class="roa-query-toolbar">
                            <a-space wrap>
                                <a-radio-group v-model:value="roaQuery.ipType" size="small">
                                    <a-radio-button value="">全部</a-radio-button>
                                    <a-radio-button :value="String(IP_TYPE.IPV4)">IPv4</a-radio-button>
                                    <a-radio-button :value="String(IP_TYPE.IPV6)">IPv6</a-radio-button>
                                </a-radio-group>
                                <a-input
                                    v-model:value="roaQuery.prefixFilter"
                                    allow-clear
                                    placeholder="Prefix 或 Prefix/Mask"
                                    class="roa-query-input"
                                    @press-enter="searchRoaList"
                                />
                                <a-input
                                    v-model:value="roaQuery.asn"
                                    allow-clear
                                    placeholder="ASN"
                                    class="roa-query-small-input"
                                    @press-enter="searchRoaList"
                                />
                                <a-button type="primary" @click="searchRoaList">查询</a-button>
                                <a-button @click="resetRoaQuery">重置</a-button>
                            </a-space>
                        </div>
                        <a-table
                            class="roa-table"
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

        <RpkiRoaImportModal v-model:open="roaImportModalVisible" @imported="handleRoaImported" />
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, watch } from 'vue';
    import { Modal, message } from 'ant-design-vue';
    import { UploadOutlined } from '@ant-design/icons-vue';
    import RpkiRoaImportModal from '../../components/RpkiRoaImportModal.vue';
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
    const deleteAllLoading = ref(false);
    const tableLoading = ref(false);
    const roaImportModalVisible = ref(false);
    const ROA_PAGE_SIZE = 20;

    // ROA列表
    const roaList = ref([]);
    const roaStorageTotal = ref(0);
    const roaPagination = ref({
        current: 1,
        pageSize: ROA_PAGE_SIZE,
        total: 0,
        showSizeChanger: false,
        showTotal: total => `共 ${total} 条，每页 ${ROA_PAGE_SIZE} 条`,
        position: ['bottomCenter']
    });
    const createEmptyRoaQuery = () => ({
        ipType: '',
        prefixFilter: '',
        asn: ''
    });
    const roaQuery = ref(createEmptyRoaQuery());
    const appliedRoaQuery = ref(createEmptyRoaQuery());
    const hasAppliedRoaQuery = computed(() => {
        return Object.values(appliedRoaQuery.value).some(value => String(value || '').trim() !== '');
    });
    const roaListTitle = computed(() => {
        if (hasAppliedRoaQuery.value) {
            return `ROA列表（匹配 ${roaPagination.value.total} / 共 ${roaStorageTotal.value} 条）`;
        }
        return `ROA列表（共 ${roaStorageTotal.value || roaPagination.value.total} 条）`;
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
            key: 'action',
            fixed: 'right',
            width: 80
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

    const showRoaImportModal = () => {
        roaImportModalVisible.value = true;
    };

    const handleRoaImported = () => {
        fetchRoaList(1);
    };

    const confirmDeleteAllRoa = () => {
        Modal.confirm({
            title: '确认批量删除ROA？',
            content: `将删除全部 ${roaStorageTotal.value} 条 ROA。RPKI服务运行时会向客户端批量发送撤销报文。`,
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

    const normalizeRoaQuery = query => {
        return {
            ipType: query.ipType || '',
            prefixFilter: (query.prefixFilter || '').trim(),
            asn: (query.asn || '').trim()
        };
    };

    const searchRoaList = () => {
        appliedRoaQuery.value = normalizeRoaQuery(roaQuery.value);
        fetchRoaList(1);
    };

    const resetRoaQuery = () => {
        roaQuery.value = createEmptyRoaQuery();
        appliedRoaQuery.value = createEmptyRoaQuery();
        fetchRoaList(1);
    };

    const handleTableChange = pagination => {
        fetchRoaList(pagination.current);
    };

    // 获取ROA列表
    const fetchRoaList = async (page = roaPagination.value.current) => {
        tableLoading.value = true;
        try {
            const result = await window.rpkiApi.getRoaList({
                page,
                pageSize: ROA_PAGE_SIZE,
                ...appliedRoaQuery.value
            });
            if (result.status === 'success') {
                if (Array.isArray(result.data)) {
                    roaList.value = result.data;
                    roaStorageTotal.value = result.data.length;
                    roaPagination.value = {
                        ...roaPagination.value,
                        current: page,
                        pageSize: ROA_PAGE_SIZE,
                        total: result.data.length
                    };
                    return;
                }

                roaList.value = result.data.items || [];
                roaStorageTotal.value = result.data.storageTotal ?? result.data.total ?? 0;
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
    .rpki-form-actions :deep(.ant-form-item-control-input-content) {
        display: flex;
        justify-content: center;
    }

    .roa-query-toolbar {
        display: block;
        margin-bottom: 16px;
    }

    .roa-table {
        margin-top: 16px;
    }

    .roa-query-input {
        width: 220px;
    }

    .roa-query-small-input {
        width: 120px;
    }

    .roa-delete-all-button:disabled,
    .roa-delete-all-button.ant-btn-disabled {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
        opacity: 1 !important;
    }

    .roa-delete-all-button:disabled:hover,
    .roa-delete-all-button.ant-btn-disabled:hover,
    .roa-delete-all-button:disabled:focus,
    .roa-delete-all-button.ant-btn-disabled:focus {
        color: #8c8c8c !important;
        background: #f0f0f0 !important;
        border-color: #bfbfbf !important;
    }

    :deep(.ant-table-body) {
        height: 300px !important;
        overflow-y: auto !important;
    }
</style>
