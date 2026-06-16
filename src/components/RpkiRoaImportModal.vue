<template>
    <a-modal
        v-model:open="open"
        title="导入 ROA JSON 文件"
        :confirm-loading="importing"
        width="560px"
        ok-text="开始导入"
        cancel-text="取消"
        @ok="handleImport"
    >
        <div class="roa-import-container">
            <a-alert message="导入设置" type="info" show-icon style="margin-bottom: 16px">
                <template #description>选择本地 ROA JSON 文件，并设置本次最多新增导入的 ROA 条数。</template>
            </a-alert>

            <div class="file-selector">
                <a-button type="primary" @click="selectLocalFile">
                    <template #icon><FileSearchOutlined /></template>
                    选择 ROA JSON 文件
                </a-button>
                <div v-if="selectedFilePath" class="selected-path">
                    <span class="label">已选文件:</span>
                    <span class="path">{{ selectedFilePath }}</span>
                    <a-button type="link" size="small" danger @click="clearSelection">清除</a-button>
                </div>
                <div v-else class="empty-selection">尚未选择文件，请点击上方按钮选择一个 JSON 文件。</div>
            </div>

            <div class="import-options">
                <a-form layout="vertical">
                    <a-form-item label="导入方式">
                        <a-radio-group v-model:value="importMode" button-style="solid">
                            <a-radio-button value="limited">限制条数</a-radio-button>
                            <a-radio-button value="all">全量导入</a-radio-button>
                        </a-radio-group>
                    </a-form-item>
                    <a-form-item v-if="importMode === 'limited'" label="导入数量限制">
                        <a-input-number v-model:value="importLimit" :min="1" :max="1000000" style="width: 100%" />
                    </a-form-item>
                    <div v-if="importing" class="importing-feedback">
                        <a-spin size="small" />
                        <span class="status-text">导入中...</span>
                    </div>
                </a-form>
            </div>
        </div>
    </a-modal>
</template>

<script setup>
    import { ref, watch } from 'vue';
    import { message } from 'ant-design-vue';
    import FileSearchOutlined from '@ant-design/icons-vue/es/icons/FileSearchOutlined';

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:open', 'imported']);

    const open = ref(props.open);
    const importing = ref(false);
    const importMode = ref('limited');
    const importLimit = ref(10000);
    const selectedFilePath = ref('');

    watch(
        () => props.open,
        newVal => {
            open.value = newVal;
        }
    );

    watch(open, newVal => {
        emit('update:open', newVal);
    });

    const selectLocalFile = async () => {
        try {
            const result = await window.rpkiApi.selectRoaJsonFile();
            if (result.status === 'success' && result.data) {
                selectedFilePath.value = result.data;
            } else if (result.status === 'error') {
                message.error(result.msg || '选择文件失败');
            }
        } catch (error) {
            message.error(`选择文件失败: ${error.message}`);
        }
    };

    const clearSelection = () => {
        selectedFilePath.value = '';
    };

    const handleImport = async () => {
        if (!selectedFilePath.value) {
            message.warning('请先选择 ROA JSON 文件');
            return;
        }

        if (importMode.value === 'limited' && (!importLimit.value || importLimit.value < 1)) {
            message.warning('请输入有效的导入数量');
            return;
        }

        importing.value = true;
        try {
            const result = await window.rpkiApi.importRoaJson({
                filePath: selectedFilePath.value,
                limit: importMode.value === 'limited' ? importLimit.value : null
            });

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
            emit('imported', stats);
            open.value = false;
        } catch (error) {
            message.error(`ROA JSON导入出错: ${error.message}`);
        } finally {
            importing.value = false;
        }
    };
</script>

<style scoped>
    .roa-import-container {
        padding: 8px;
    }

    .file-selector {
        background: #fafafa;
        border: 1px dashed #d9d9d9;
        border-radius: 4px;
        padding: 24px;
        text-align: center;
    }

    .selected-path {
        margin-top: 16px;
        background: #fff;
        padding: 8px 12px;
        border-radius: 4px;
        border: 1px solid #e8e8e8;
        display: flex;
        align-items: center;
        gap: 8px;
        word-break: break-all;
    }

    .selected-path .label {
        color: #8c8c8c;
        white-space: nowrap;
    }

    .selected-path .path {
        flex: 1;
        font-family: monospace;
    }

    .empty-selection {
        margin-top: 12px;
        color: #bfbfbf;
    }

    .import-options {
        margin-top: 20px;
    }

    .importing-feedback {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        color: #1890ff;
    }

    .status-text {
        font-size: 13px;
    }
</style>
