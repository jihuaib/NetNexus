<template>
    <a-modal
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
            <a-alert message="数据来源说明" type="info" show-icon style="margin-bottom: 16px">
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
                    <span style="color: #faad14">
                        注意：
                        <code>.bz2</code>
                        文件请先解压，解压后即便没有后缀名也可导入。
                    </span>
                </template>
            </a-alert>

            <!-- 文件来源选择 -->
            <a-form layout="vertical" style="margin-top: 16px">
                <a-radio-group v-model:value="fileSource" button-style="solid">
                    <a-radio-button value="default">默认文件</a-radio-button>
                    <a-radio-button value="custom">自定义文件</a-radio-button>
                </a-radio-group>
            </a-form>

            <!-- 默认文件选择 -->
            <div v-if="fileSource === 'default'" class="file-selector">
                <a-select
                    v-model:value="selectedDefaultFile"
                    placeholder="选择预置的 MRT 文件"
                    style="width: 100%"
                    :loading="loadingDefaultFiles"
                >
                    <a-select-option v-for="file in defaultFiles" :key="file.path" :value="file.path">
                        {{ file.name }} ({{ formatFileSize(file.size) }})
                    </a-select-option>
                </a-select>
                <div v-if="!selectedDefaultFile" class="empty-selection" style="margin-top: 12px">
                    请选择一个预置的 MRT 文件
                </div>
            </div>

            <!-- 自定义文件选择 -->
            <div v-else class="file-selector">
                <a-button type="primary" @click="selectLocalFile">
                    <template #icon><FileSearchOutlined /></template>
                    选择本地 MRT 文件
                </a-button>
                <div v-if="selectedFilePath" class="selected-path">
                    <span class="label">已选文件:</span>
                    <span class="path">{{ selectedFilePath }}</span>
                    <a-button type="link" size="small" danger @click="clearSelection">清除</a-button>
                </div>
                <div v-else class="empty-selection">
                    尚未选择文件，请点击上方按钮选择一个
                    <code>.gz</code>
                    或解压后的原始文件。
                </div>
            </div>

            <div class="import-options" style="margin-top: 20px">
                <a-form layout="vertical">
                    <a-form-item label="导入数量限制 (建议 10,000 - 100,000)">
                        <a-input-number v-model:value="importLimit" :min="1" :max="1000000" style="width: 100%" />
                    </a-form-item>
                    <div v-if="importing" class="importing-feedback">
                        <a-spin size="small" />
                        <span class="status-text">{{ importingStatus }}</span>
                    </div>
                </a-form>
            </div>
        </div>
    </a-modal>
</template>

<script setup>
    import { ref, watch, onMounted, computed } from 'vue';
    import { message } from 'ant-design-vue';
    import FileSearchOutlined from '@ant-design/icons-vue/es/icons/FileSearchOutlined';

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
                message.warning('无法加载默认文件列表');
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
                message.error(result.msg);
            }
        } catch (e) {
            message.error(`选择文件失败: ${e.message}`);
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
            message.warning('请先选择一个 MRT 文件');
            return;
        }
        if (filePath.endsWith('.bz2')) {
            message.warning('检测到 .bz2 文件，请先使用 7-Zip 或 WinRAR 解压后再导入');
            return;
        }

        importing.value = true;
        importingStatus.value = '解析中...';

        try {
            const result = await window.bgpApi.importRouteViewsData(filePath, importLimit.value, props.addressFamily);

            if (result.status === 'success') {
                message.success(result.msg);
                emit('imported');
                open.value = false;
                selectedFilePath.value = ''; // Reset for next time
            } else {
                message.error(result.msg);
            }
        } catch (e) {
            message.error(`导入失败: ${e.message}`);
        } finally {
            importing.value = false;
        }
    };
</script>

<style scoped>
    .mrt-import-container {
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

    .external-link {
        color: #1890ff;
        text-decoration: underline;
        cursor: pointer;
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

    code {
        background-color: #f5f5f5;
        padding: 2px 4px;
        border-radius: 3px;
        font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace;
    }
</style>
