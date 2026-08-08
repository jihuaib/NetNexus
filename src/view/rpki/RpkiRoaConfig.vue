<template>
    <div class="nn-container adaptive-list-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="RPKI ROA配置">
                    <nn-form
                        :model="roaConfig"
                        :label-col="labelCol"
                        :wrapper-col="wrapperCol"
                        @finish="submitRoaConfig"
                    >
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="IP类型" name="ipType">
                                    <nn-radio-group v-model:value="roaConfig.ipType">
                                        <nn-radio :value="IP_TYPE.IPV4">IPv4</nn-radio>
                                        <nn-radio :value="IP_TYPE.IPV6">IPv6</nn-radio>
                                    </nn-radio-group>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="12">
                                <nn-form-item label="IP" name="ip">
                                    <nn-tooltip :title="validationErrors.ip" :open="!!validationErrors.ip">
                                        <nn-input
                                            v-model:value="roaConfig.ip"
                                            :status="validationErrors.ip ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="12">
                                <nn-form-item label="mask" name="mask">
                                    <nn-tooltip :title="validationErrors.mask" :open="!!validationErrors.mask">
                                        <nn-input
                                            v-model:value="roaConfig.mask"
                                            :status="validationErrors.mask ? 'error' : ''"
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
                                            v-model:value="roaConfig.asn"
                                            :status="validationErrors.asn ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="最大前缀长度" name="maxLength">
                                    <nn-tooltip
                                        :title="validationErrors.maxLength"
                                        :open="!!validationErrors.maxLength"
                                    >
                                        <nn-input
                                            v-model:value="roaConfig.maxLength"
                                            :status="validationErrors.maxLength ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-form-item class="rpki-form-actions" :wrapper-col="{ span: 24 }">
                            <nn-space>
                                <nn-button type="primary" html-type="submit" :loading="submitLoading">
                                    添加ROA
                                </nn-button>
                                <nn-button @click="showRoaImportModal">
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

        <!-- ROA列表 -->
        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card :title="roaListTitle" class="adaptive-list-card">
                    <template #extra>
                        <nn-button
                            class="roa-delete-all-button"
                            danger
                            :disabled="roaStorageTotal === 0"
                            :loading="deleteAllLoading"
                            @click="confirmDeleteAllRoa"
                        >
                            批量删除
                        </nn-button>
                    </template>
                    <div>
                        <div class="roa-query-toolbar">
                            <nn-space wrap>
                                <nn-radio-group v-model:value="roaQuery.ipType" size="small">
                                    <nn-radio-button value="">全部</nn-radio-button>
                                    <nn-radio-button :value="String(IP_TYPE.IPV4)">IPv4</nn-radio-button>
                                    <nn-radio-button :value="String(IP_TYPE.IPV6)">IPv6</nn-radio-button>
                                </nn-radio-group>
                                <nn-input
                                    v-model:value="roaQuery.prefixFilter"
                                    allow-clear
                                    placeholder="Prefix 或 Prefix/Mask"
                                    class="roa-query-input"
                                    @press-enter="searchRoaList"
                                />
                                <nn-input
                                    v-model:value="roaQuery.asn"
                                    allow-clear
                                    placeholder="ASN"
                                    class="roa-query-small-input"
                                    @press-enter="searchRoaList"
                                />
                                <nn-button type="primary" @click="searchRoaList">查询</nn-button>
                                <nn-button @click="resetRoaQuery">重置</nn-button>
                            </nn-space>
                        </div>
                        <nn-table
                            class="roa-table adaptive-table"
                            :columns="roaColumns"
                            :data-source="roaList"
                            :row-key="
                                record =>
                                    `${record.asn}-${record.ip}-${record.mask}-${record.maxLength}-${record.ipType}`
                            "
                            :pagination="roaPagination"
                            :scroll="{ y: '100%' }"
                            :loading="tableLoading"
                            size="small"
                            @change="handleTableChange"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <nn-button type="link" danger @click="deleteRoa(record)">删除</nn-button>
                                </template>
                                <template v-else-if="column.key === 'ipType'">
                                    <span>{{ record.ipType === IP_TYPE.IPV4 ? 'IPv4' : 'IPv6' }}</span>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <RpkiRoaImportModal v-model:open="roaImportModalVisible" @imported="handleRoaImported" />
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, watch } from 'vue';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { UploadOutlined } from 'netnexus-ui/icons';
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
            notify.error('请检查ROA配置信息是否正确');
            return;
        }

        submitLoading.value = true;
        try {
            const payload = JSON.parse(JSON.stringify(roaConfig.value));
            const result = await window.rpkiApi.addRoa(payload);
            if (result.status === 'success') {
                notify.success('ROA添加成功');
                // 刷新ROA列表
                fetchRoaList(roaPagination.value.current);
            } else {
                notify.error(result.msg || 'ROA添加失败');
            }
        } catch (error) {
            notify.error(`ROA添加出错: ${error.message}`);
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
                notify.success('ROA删除成功');
                const nextPage =
                    roaList.value.length === 1 && roaPagination.value.current > 1
                        ? roaPagination.value.current - 1
                        : roaPagination.value.current;
                fetchRoaList(nextPage);
            } else {
                notify.error(result.msg || 'ROA删除失败');
            }
        } catch (error) {
            notify.error(`ROA删除出错: ${error.message}`);
        }
    };

    const showRoaImportModal = () => {
        roaImportModalVisible.value = true;
    };

    const handleRoaImported = () => {
        fetchRoaList(1);
    };

    const confirmDeleteAllRoa = () => {
        dialog.confirm({
            title: '确认批量删除ROA？',
            content: `将删除全部 ${roaStorageTotal.value} 条 ROA。RPKI服务运行时会通知客户端重新同步缓存。`,
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
                notify.success(`ROA批量删除成功：删除 ${result.data?.deleted || 0} 条`);
                fetchRoaList(1);
            } else {
                notify.error(result.msg || 'ROA批量删除失败');
            }
        } catch (error) {
            notify.error(`ROA批量删除出错: ${error.message}`);
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

    .adaptive-list-card :deep(.nn-card-body),
    .adaptive-list-card :deep(.nn-card-body > div) {
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

    .roa-query-toolbar {
        flex: 0 0 auto;
        display: block;
        margin-bottom: 16px;
    }

    .roa-table {
        flex: 1 1 0;
        margin-top: 0;
    }

    .roa-query-input {
        width: 220px;
    }

    .roa-query-small-input {
        width: 120px;
    }

    .roa-delete-all-button:disabled,
    .roa-delete-all-button.nn-button-disabled {
        color: var(--nn-color-text-muted) !important;
        background: var(--nn-color-bg-disabled) !important;
        border-color: var(--nn-color-border) !important;
        opacity: 1 !important;
    }

    .roa-delete-all-button:disabled:hover,
    .roa-delete-all-button.nn-button-disabled:hover,
    .roa-delete-all-button:disabled:focus,
    .roa-delete-all-button.nn-button-disabled:focus {
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
