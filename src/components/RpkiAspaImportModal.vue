<template>
    <nn-modal
        v-model:open="open"
        title="导入 ASPA JSON 文件"
        :confirm-loading="importing"
        width="560px"
        ok-text="开始导入"
        cancel-text="取消"
        @ok="handleImport"
    >
        <div class="aspa-import-container">
            <nn-alert message="导入设置" type="info" show-icon style="margin-bottom: 16px">
                <template #description>选择本地 ASPA JSON 文件，并设置本次最多处理的 ASPA 条数。</template>
            </nn-alert>

            <div class="file-selector">
                <nn-button type="primary" @click="selectLocalFile">
                    <template #icon><FileSearchOutlined /></template>
                    选择 ASPA JSON 文件
                </nn-button>
                <div v-if="selectedFilePath" class="selected-path">
                    <span class="label">已选文件:</span>
                    <span class="path">{{ selectedFilePath }}</span>
                    <nn-button type="link" size="small" danger @click="clearSelection">清除</nn-button>
                </div>
                <div v-else class="empty-selection">尚未选择文件，请点击上方按钮选择一个 JSON 文件。</div>
            </div>

            <div class="import-options">
                <nn-form layout="vertical">
                    <nn-form-item label="导入方式">
                        <nn-radio-group v-model:value="importMode" button-style="solid">
                            <nn-radio-button value="limited">限制条数</nn-radio-button>
                            <nn-radio-button value="all">全量导入</nn-radio-button>
                        </nn-radio-group>
                    </nn-form-item>
                    <nn-form-item v-if="importMode === 'limited'" label="导入数量限制">
                        <nn-input-number v-model:value="importLimit" :min="1" :max="1000000" style="width: 100%" />
                    </nn-form-item>
                    <div v-if="importing" class="importing-feedback">
                        <nn-spin size="small" />
                        <span class="status-text">导入中...</span>
                    </div>
                </nn-form>
            </div>
        </div>
    </nn-modal>
</template>

<script setup>
    import { ref, watch } from 'vue';
    import { notify } from '../utils/notify';
    import { FileSearchOutlined } from 'netnexus-ui/icons';
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
            const result = await window.rpkiApi.selectAspaJsonFile();
            if (result.status === 'success' && result.data) {
                selectedFilePath.value = result.data;
            } else if (result.status === 'error') {
                notify.error(result.msg || '选择文件失败');
            }
        } catch (error) {
            notify.error(`选择文件失败: ${error.message}`);
        }
    };

    const clearSelection = () => {
        selectedFilePath.value = '';
    };

    const handleImport = async () => {
        if (!selectedFilePath.value) {
            notify.warning('请先选择 ASPA JSON 文件');
            return;
        }

        if (importMode.value === 'limited' && (!importLimit.value || importLimit.value < 1)) {
            notify.warning('请输入有效的导入数量');
            return;
        }

        importing.value = true;
        try {
            const result = await window.rpkiApi.importAspaJson({
                filePath: selectedFilePath.value,
                limit: importMode.value === 'limited' ? importLimit.value : null
            });

            if (result.status !== 'success') {
                notify.error(result.msg || 'ASPA JSON导入失败');
                return;
            }

            if (result.data?.cancelled) {
                return;
            }

            const stats = result.data || {};
            notify.success(
                `ASPA导入完成：新增 ${stats.imported || 0} 条，覆盖 ${stats.overwritten || 0} 条，无效 ${stats.invalid || 0} 条`
            );
            emit('imported', stats);
            open.value = false;
        } catch (error) {
            notify.error(`ASPA JSON导入出错: ${error.message}`);
        } finally {
            importing.value = false;
        }
    };
</script>

<style scoped>
    .aspa-import-container {
        padding: 8px;
    }

    .file-selector {
        background: var(--nn-color-bg-subtle);
        border: 1px dashed var(--nn-color-border);
        border-radius: 4px;
        padding: 24px;
        text-align: center;
    }

    .selected-path {
        margin-top: 16px;
        background: var(--nn-color-bg-surface);
        padding: 8px 12px;
        border-radius: 4px;
        border: 1px solid var(--nn-color-border-light);
        display: flex;
        align-items: center;
        gap: 8px;
        word-break: break-all;
    }

    .selected-path .label {
        color: var(--nn-color-text-muted);
        white-space: nowrap;
    }

    .selected-path .path {
        flex: 1;
        font-family: monospace;
    }

    .empty-selection {
        margin-top: 12px;
        color: var(--nn-color-text-placeholder);
    }

    .import-options {
        margin-top: 20px;
    }

    .importing-feedback {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        color: var(--nn-color-primary);
    }

    .status-text {
        font-size: 13px;
    }
</style>
