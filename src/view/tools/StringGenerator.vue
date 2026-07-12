<template>
    <div class="nn-container string-generator-page" data-testid="string-generator-page">
        <nn-card title="字符串生成配置" class="string-generator-card" data-testid="string-generator-card">
            <nn-form
                :model="formState"
                :label-col="labelCol"
                :wrapper-col="wrapperCol"
                class="string-generator-form"
                @finish="handleFinish"
            >
                <!-- 字符串模板输入 -->
                <nn-form-item label="字符串模板" name="template">
                    <nn-tooltip :title="validationErrors.template" :open="!!validationErrors.template">
                        <ScrollTextarea
                            v-model:model-value="formState.template"
                            data-testid="string-template-input"
                            :height="120"
                            :status="validationErrors.template ? 'error' : ''"
                        />
                    </nn-tooltip>
                </nn-form-item>

                <!-- 参数配置行 -->
                <nn-row>
                    <nn-col :span="8">
                        <nn-form-item label="占位符" name="placeholder">
                            <nn-tooltip :title="validationErrors.placeholder" :open="!!validationErrors.placeholder">
                                <nn-input
                                    v-model:value="formState.placeholder"
                                    data-testid="string-placeholder-input"
                                    :status="validationErrors.placeholder ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <nn-form-item label="开始" name="start">
                            <nn-tooltip :title="validationErrors.start" :open="!!validationErrors.start">
                                <nn-input
                                    v-model:value="formState.start"
                                    data-testid="string-start-input"
                                    :status="validationErrors.start ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                    <nn-col :span="8">
                        <nn-form-item label="结束" name="end">
                            <nn-tooltip :title="validationErrors.end" :open="!!validationErrors.end">
                                <nn-input
                                    v-model:value="formState.end"
                                    data-testid="string-end-input"
                                    :status="validationErrors.end ? 'error' : ''"
                                />
                            </nn-tooltip>
                        </nn-form-item>
                    </nn-col>
                </nn-row>

                <!-- 操作按钮 -->
                <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                    <nn-space>
                        <nn-button type="primary" html-type="submit" data-testid="string-generate-button">
                            立即生成
                        </nn-button>
                        <nn-button type="default" data-testid="string-history-button" @click="showGenerateHistory">
                            生成历史
                        </nn-button>
                    </nn-space>
                </nn-form-item>

                <!-- 结果显示 -->
                <nn-form-item label="生成结果" class="generator-result-item">
                    <div class="generator-result-textarea-wrap">
                        <ScrollTextarea
                            v-model:model-value="result"
                            data-testid="string-result-textarea"
                            height="100%"
                        />
                    </div>
                </nn-form-item>
            </nn-form>
        </nn-card>
    </div>

    <!-- 生成历史弹窗 -->
    <nn-modal
        v-model:open="generateHistoryModalVisible"
        title="生成历史"
        :mask-closable="false"
        class="modal-xlarge"
        @cancel="closeHistoryModal"
    >
        <div data-testid="string-history-modal">
            <nn-table
                :columns="historyColumns"
                :data-source="generateHistory"
                data-testid="string-history-table"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    position: ['bottomCenter'],
                    showTotal: total => '共 ' + total + ' 条，每页 20 条'
                }"
                :scroll="{ y: 200 }"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'action'">
                        <nn-button type="link" data-testid="string-history-use-button" @click="loadHistoryItem(record)">
                            使用
                        </nn-button>
                    </template>
                    <template v-else-if="column.key === 'template'">
                        <div>{{ truncateString(record.template, 40) }}</div>
                    </template>
                </template>
            </nn-table>
        </div>
        <template #footer>
            <nn-button type="primary" data-testid="string-history-close-button" @click="closeHistoryModal">
                关闭
            </nn-button>
            <nn-button
                v-if="generateHistory.length > 0"
                danger
                data-testid="string-history-clear-button"
                @click="clearHistory"
            >
                清空历史
            </nn-button>
        </template>
    </nn-modal>
</template>

<script setup>
    import ScrollTextarea from '../../components/ScrollTextarea.vue';
    import { ref, toRaw } from 'vue';
    import { notify } from '../../utils/notify';
    import { FormValidator, createStringGeneratorValidationRules } from '../../utils/validationCommon';

    defineOptions({
        name: 'StringGenerator'
    });

    const _emit = defineEmits(['openSettings']);

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const validationErrors = ref({
        template: '',
        placeholder: '',
        start: '',
        end: ''
    });

    let validator = new FormValidator(validationErrors);
    // 创建验证器实例
    validator.addRules(createStringGeneratorValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    const formState = ref({
        template: 'ip address 1.1.1.{A} 24',
        placeholder: '{A}',
        start: '1',
        end: '2'
    });

    const result = ref('');

    const handleFinish = async () => {
        try {
            const hasError = validator.validate(formState.value);
            if (hasError) {
                notify.error('请检查配置信息是否正确');
                return;
            }

            const payload = JSON.parse(JSON.stringify(toRaw(formState.value)));
            const resp = await window.toolsApi.generateString(payload);

            if (resp.status === 'success') {
                result.value = resp.data.join('\r\n');
            } else {
                notify.error(resp.msg || '生成失败');
            }
        } catch (e) {
            notify.error(e.message || String(e));
            console.error('生成错误:', e);
        }
    };

    // 历史记录相关状态
    const generateHistory = ref(false);
    const generateHistoryModalVisible = ref(false);
    const historyColumns = [
        {
            title: '字符串模板',
            dataIndex: 'template',
            key: 'template'
        },
        {
            title: '占位符',
            dataIndex: 'placeholder',
            key: 'placeholder'
        },
        {
            title: '开始',
            dataIndex: 'start',
            key: 'start'
        },
        {
            title: '结束',
            dataIndex: 'end',
            key: 'end'
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const showGenerateHistory = async () => {
        try {
            const resp = await window.toolsApi.getGenerateStringHistory();
            if (resp.status === 'success') {
                generateHistory.value = resp.data || [];
                generateHistoryModalVisible.value = true;
            } else {
                notify.error(resp.msg || '获取历史记录失败');
            }
        } catch (e) {
            notify.error(e.message || String(e));
            console.error('获取历史记录错误:', e);
        }
    };

    // 关闭历史记录弹窗
    const closeHistoryModal = () => {
        generateHistoryModalVisible.value = false;
    };

    // 清空历史记录
    const clearHistory = async () => {
        const resp = await window.toolsApi.clearGenerateStringHistory();
        if (resp.status === 'success') {
            generateHistory.value = [];
        }
    };

    // 加载历史记录项
    const loadHistoryItem = record => {
        if (!record) return;

        // 更新表单数据
        formState.value = {
            template: record.template || '',
            placeholder: record.placeholder || '',
            start: record.start || '',
            end: record.end || ''
        };

        // 关闭弹窗
        closeHistoryModal();

        // 自动执行生成
        handleFinish();
    };

    // 截断显示内容
    const truncateString = (str, maxLength) => {
        if (!str) return '';
        return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
    };
</script>

<style scoped>
    .string-generator-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .string-generator-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .string-generator-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .string-generator-form {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .string-generator-form :deep(.nn-form-item) {
        flex: 0 0 auto;
    }

    .generator-result-item {
        flex: 1 1 0 !important;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .generator-result-item :deep(.nn-form-item-row),
    .generator-result-item :deep(.nn-form-item-control),
    .generator-result-item :deep(.nn-form-item-control-input),
    .generator-result-item :deep(.nn-form-item-control-input-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .generator-result-item :deep(.nn-form-item-label) {
        flex: 0 0 auto;
    }

    .generator-result-item :deep(.nn-form-item-control-input) {
        align-items: stretch;
    }

    .generator-result-textarea-wrap {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
    }

    .generator-result-textarea-wrap :deep(textarea.nn-input) {
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        height: auto !important;
    }

    :deep(.nn-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }
</style>
