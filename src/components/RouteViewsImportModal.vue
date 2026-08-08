<template>
    <nn-modal
        v-model:open="open"
        title="导入 BGP MRT 路由文件"
        :confirm-loading="importing"
        width="600px"
        height="612px"
        ok-text="开始导入"
        cancel-text="取消"
        @ok="handleImport"
    >
        <div class="mrt-import-container">
            <nn-alert message="数据来源说明" type="info" show-icon style="margin-bottom: 16px">
                <template #description>
                    您可以从
                    <a class="external-link" @click="openRouteViews">RouteViews Archive</a>
                    下载最新的 RIB 数据。 通常位于
                    <code>bgpdata/YYYY.MM/RIBS/</code>
                    目录下。
                    <br />
                    支持格式：
                    <code>.gz</code>
                    或解压后的原始文件 (如
                    <code>rib.2024...</code>
                    )。
                    <br />
                    <span class="import-warning">
                        注意：
                        <code>.bz2</code>
                        文件请先解压，解压后即便没有后缀名也可导入。
                    </span>
                </template>
            </nn-alert>

            <!-- 文件来源选择 -->
            <nn-form layout="vertical" style="margin-top: 16px">
                <nn-radio-group v-model:value="fileSource" button-style="solid">
                    <nn-radio-button value="default">默认文件</nn-radio-button>
                    <nn-radio-button value="custom">自定义文件</nn-radio-button>
                </nn-radio-group>
            </nn-form>

            <!-- 默认文件选择 -->
            <div v-if="fileSource === 'default'" class="file-selector">
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
                <div v-if="!selectedDefaultFile" class="empty-selection" style="margin-top: 12px">
                    请选择一个预置的 MRT 文件
                </div>
            </div>

            <!-- 自定义文件选择 -->
            <div v-else class="file-selector">
                <nn-button type="primary" @click="selectLocalFile">
                    <template #icon><FileSearchOutlined /></template>
                    选择本地 MRT 文件
                </nn-button>
                <div v-if="selectedFilePath" class="selected-path">
                    <span class="label">已选文件:</span>
                    <span class="path">{{ selectedFilePath }}</span>
                    <nn-button type="link" size="small" danger @click="clearSelection">清除</nn-button>
                </div>
                <div v-else class="empty-selection">
                    尚未选择文件，请点击上方按钮选择一个
                    <code>.gz</code>
                    或解压后的原始文件。
                </div>
            </div>

            <div class="import-options" style="margin-top: 20px">
                <nn-form layout="vertical">
                    <nn-form-item label="导入数量限制 (建议 10,000 - 100,000)">
                        <nn-input-number v-model:value="importLimit" :min="1" :max="1000000" style="width: 100%" />
                    </nn-form-item>
                    <div v-if="importing" class="importing-feedback">
                        <nn-spin size="small" />
                        <span class="status-text">{{ importingStatus }}</span>
                    </div>
                </nn-form>
            </div>
        </div>
    </nn-modal>
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
    const importingStatus = ref('');
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

    const clearSelection = () => {
        selectedFilePath.value = '';
    };

    const openRouteViews = () => {
        // Use electron shell to open URL
        window.bgpApi.openExternal('https://archive.routeviews.org/');
    };

    const handleImport = async () => {
        const filePath = effectiveFilePath.value;

        if (!filePath) {
            notify.warning('请先选择一个 MRT 文件');
            return;
        }
        if (filePath.endsWith('.bz2')) {
            notify.warning('检测到 .bz2 文件，请先使用 7-Zip 或 WinRAR 解压后再导入');
            return;
        }

        importing.value = true;
        importingStatus.value = '解析中...';

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
    .mrt-import-container {
        padding: 8px;
    }

    .import-warning {
        color: var(--nn-color-warning);
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

    .external-link {
        color: var(--nn-color-link);
        text-decoration: underline;
        cursor: pointer;
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

    code {
        color: var(--nn-color-text);
        background-color: var(--nn-color-bg-code);
        padding: 2px 4px;
        border-radius: 3px;
        font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace;
    }
</style>
