<template>
    <nn-file-import-modal
        v-model:open="open"
        v-model:file-path="selectedFilePath"
        title="导入 ROA JSON 文件"
        description-title="导入设置"
        description="选择本地 ROA JSON 文件，并设置本次最多新增导入的 ROA 条数。"
        select-text="选择 ROA JSON 文件"
        empty-text="尚未选择文件，请点击上方按钮选择一个 JSON 文件。"
        invalid-message="请先选择 ROA JSON 文件"
        :loading="importing"
        :validator="validateImport"
        width="560px"
        @request-select="selectLocalFile"
        @submit="handleImport"
    >
        <template #select-icon><FileSearchOutlined /></template>
        <template #options>
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
            </nn-form>
        </template>
    </nn-file-import-modal>
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
            const result = await window.rpkiApi.selectRoaJsonFile();
            if (result.status === 'success' && result.data) {
                selectedFilePath.value = result.data;
            } else if (result.status === 'error') {
                notify.error(result.msg || '选择文件失败');
            }
        } catch (error) {
            notify.error(`选择文件失败: ${error.message}`);
        }
    };

    const validateImport = filePath => {
        if (!filePath) return '请先选择 ROA JSON 文件';
        if (!filePath.toLowerCase().endsWith('.json')) return '请选择扩展名为 .json 的 ROA 文件';
        if (importMode.value === 'limited' && (!importLimit.value || importLimit.value < 1)) {
            return '请输入有效的导入数量';
        }
        return true;
    };

    const handleImport = async filePath => {
        importing.value = true;
        try {
            const result = await window.rpkiApi.importRoaJson({
                filePath,
                limit: importMode.value === 'limited' ? importLimit.value : null
            });

            if (result.status !== 'success') {
                notify.error(result.msg || 'ROA JSON导入失败');
                return;
            }

            if (result.data?.cancelled) {
                return;
            }

            const stats = result.data || {};
            notify.success(
                `ROA导入完成：新增 ${stats.imported || 0} 条，重复 ${stats.duplicate || 0} 条，无效 ${stats.invalid || 0} 条`
            );
            emit('imported', stats);
            open.value = false;
        } catch (error) {
            notify.error(`ROA JSON导入出错: ${error.message}`);
        } finally {
            importing.value = false;
        }
    };
</script>
