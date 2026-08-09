<template>
    <nn-file-import-modal
        v-model:open="open"
        :file-path="effectiveFilePath"
        title="导入 BGP MRT 路由文件"
        description-title="数据来源说明"
        :loading="importing"
        :show-picker="fileSource === 'custom'"
        select-text="选择本地 MRT 文件"
        empty-text="尚未选择文件，请选择一个 .gz 或解压后的原始文件。"
        status-text="解析中…"
        :validator="validateImport"
        width="600px"
        height="612px"
        @request-select="selectLocalFile"
        @update:file-path="updateLocalFilePath"
        @submit="handleImport"
    >
        <template #description>
            您可以从
            <a class="external-link" @click="openRouteViews">RouteViews Archive</a>
            下载最新的 RIB 数据。通常位于
            <code>bgpdata/YYYY.MM/RIBS/</code>
            目录下。
            <br />
            支持格式：
            <code>.gz</code>
            或解压后的原始文件（如
            <code>rib.2024...</code>
            ）。
            <br />
            <span class="import-warning">
                注意：
                <code>.bz2</code>
                文件请先解压，解压后即便没有后缀名也可导入。
            </span>
        </template>

        <template #source>
            <div class="route-views-source">
                <nn-radio-group v-model:value="fileSource" button-style="solid">
                    <nn-radio-button value="default">默认文件</nn-radio-button>
                    <nn-radio-button value="custom">自定义文件</nn-radio-button>
                </nn-radio-group>

                <div v-if="fileSource === 'default'" class="route-views-default-file">
                    <nn-select
                        v-model:value="selectedDefaultFile"
                        placeholder="选择预置的 MRT 文件"
                        style="width: 100%"
                        :loading="loadingDefaultFiles"
                    >
                        <nn-select-option v-for="file in defaultFiles" :key="file.path" :value="file.path">
                            {{ file.name }} ({{ formatFileSize(file.size) }})
                        </nn-select-option>
                    </nn-select>
                    <p v-if="!selectedDefaultFile" class="empty-selection">请选择一个预置的 MRT 文件</p>
                </div>
            </div>
        </template>

        <template #select-icon><FileSearchOutlined /></template>
        <template #options>
            <nn-form layout="vertical">
                <nn-form-item label="导入数量限制（建议 10,000 - 100,000）">
                    <nn-input-number v-model:value="importLimit" :min="1" :max="1000000" style="width: 100%" />
                </nn-form-item>
            </nn-form>
        </template>
    </nn-file-import-modal>
</template>

<script setup>
    import { ref, watch, onMounted, computed } from 'vue';
    import { notify } from '../utils/notify';
    import { FileSearchOutlined } from 'netnexus-ui/icons';
    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        addressFamily: {
            type: Number,
            default: 1
        }
    });

    const emit = defineEmits(['update:open', 'imported']);

    const open = ref(props.open);
    const importing = ref(false);
    const importLimit = ref(10000);
    const selectedFilePath = ref('');
    const fileSource = ref('default');
    const selectedDefaultFile = ref('');
    const defaultFiles = ref([]);
    const loadingDefaultFiles = ref(false);

    const formatFileSize = bytes => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const effectiveFilePath = computed(() => {
        return fileSource.value === 'default' ? selectedDefaultFile.value : selectedFilePath.value;
    });

    watch(
        () => props.open,
        newVal => {
            open.value = newVal;
        }
    );

    watch(open, newVal => {
        emit('update:open', newVal);
    });

    onMounted(async () => {
        await loadDefaultFiles();
    });

    const loadDefaultFiles = async () => {
        loadingDefaultFiles.value = true;
        try {
            const result = await window.bgpApi.getDefaultMrtFiles();
            if (result.status === 'success') {
                defaultFiles.value = result.data || [];
                // Auto-select first file if available
                if (defaultFiles.value.length > 0) {
                    selectedDefaultFile.value = defaultFiles.value[0].path;
                }
            } else {
                notify.warning('无法加载默认文件列表');
            }
        } catch (e) {
            console.error('加载默认文件失败:', e);
        } finally {
            loadingDefaultFiles.value = false;
        }
    };

    const selectLocalFile = async () => {
        try {
            const result = await window.bgpApi.selectMrtFile();
            if (result.status === 'success' && result.data) {
                selectedFilePath.value = result.data;
            } else if (result.status === 'error') {
                notify.error(result.msg);
            }
        } catch (e) {
            notify.error(`选择文件失败: ${e.message}`);
        }
    };

    const updateLocalFilePath = filePath => {
        selectedFilePath.value = filePath;
    };

    const openRouteViews = () => {
        // Use electron shell to open URL
        window.bgpApi.openExternal('https://archive.routeviews.org/');
    };

    const validateImport = filePath => {
        if (!filePath) return '请先选择一个 MRT 文件';
        if (filePath.toLowerCase().endsWith('.bz2')) {
            return '检测到 .bz2 文件，请先使用 7-Zip 或 WinRAR 解压后再导入';
        }
        return true;
    };

    const handleImport = async filePath => {
        importing.value = true;

        try {
            const result = await window.bgpApi.importRouteViewsData(filePath, importLimit.value, props.addressFamily);

            if (result.status === 'success') {
                notify.success(result.msg);
                emit('imported');
                open.value = false;
                selectedFilePath.value = ''; // Reset for next time
            } else {
                notify.error(result.msg);
            }
        } catch (e) {
            notify.error(`导入失败: ${e.message}`);
        } finally {
            importing.value = false;
        }
    };
</script>

<style scoped>
    .route-views-source {
        display: grid;
        min-width: 0;
        gap: 12px;
    }

    .route-views-default-file {
        min-width: 0;
    }

    .empty-selection {
        margin: 8px 0 0;
        color: var(--nn-color-text-placeholder);
        font-size: 12px;
    }

    .import-warning {
        color: var(--nn-color-warning);
    }

    .external-link {
        color: var(--nn-color-link);
        text-decoration: underline;
        cursor: pointer;
    }

    code {
        color: var(--nn-color-text);
        background-color: var(--nn-color-bg-code);
        padding: 2px 4px;
        border-radius: 2px;
        font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace;
    }
</style>
