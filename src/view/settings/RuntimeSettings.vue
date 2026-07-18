<template>
    <div class="runtime-settings">
        <nn-card title="运行时诊断" class="settings-card">
            <nn-alert
                :type="statusAlert.type"
                show-icon
                :message="statusAlert.message"
                :description="statusAlert.description"
                class="runtime-status-alert"
            />

            <nn-descriptions :column="2" bordered size="small" class="runtime-details">
                <nn-descriptions-item label="状态">
                    <nn-tag :color="statusMeta.color">{{ statusMeta.text }}</nn-tag>
                </nn-descriptions-item>
                <nn-descriptions-item label="用途">YANG 权威编译与语义校验</nn-descriptions-item>
                <nn-descriptions-item label="引擎">
                    {{ compilerStatus.engine || 'libyang' }}
                </nn-descriptions-item>
                <nn-descriptions-item label="版本">
                    {{ compilerStatus.version || '-' }}
                </nn-descriptions-item>
                <nn-descriptions-item label="可执行文件">
                    {{ compilerStatus.executable || 'yanglint' }}
                </nn-descriptions-item>
                <nn-descriptions-item label="来源">
                    {{ compilerSourceLabel }}
                </nn-descriptions-item>
                <nn-descriptions-item label="运行时路径" :span="2">
                    <nn-typography-text v-if="compilerStatus.path" copyable class="runtime-path">
                        {{ compilerStatus.path }}
                    </nn-typography-text>
                    <span v-else>-</span>
                </nn-descriptions-item>
                <nn-descriptions-item label="错误" :span="2">
                    <span :class="{ 'runtime-error': compilerError }">{{ compilerError || '-' }}</span>
                </nn-descriptions-item>
            </nn-descriptions>

            <div class="runtime-actions">
                <nn-button :loading="compilerStatus.checking" @click="recheckCompiler">
                    <template #icon><ReloadOutlined /></template>
                    重新检测
                </nn-button>
                <span class="runtime-action-hint">libyang 不可用时，YANG 编译会保持停用，不会回退到简化解析器。</span>
            </div>
        </nn-card>
    </div>
</template>

<script setup>
    import { computed, onActivated, onMounted } from 'vue';
    import { YANG_COMPILER_STATUS_META } from '../../const/yangConst';
    import { ReloadOutlined } from '../../ui/icons';
    import { notify } from '../../utils/notify';
    import { useYangCompilerStatus } from '../yang/yangCompilerStatus';

    defineOptions({ name: 'RuntimeSettings' });

    const { compilerStatus, refreshCompilerStatus } = useYangCompilerStatus();

    const statusMeta = computed(() => {
        if (compilerStatus.value.checking) return YANG_COMPILER_STATUS_META.checking;
        return compilerStatus.value.available
            ? YANG_COMPILER_STATUS_META.available
            : YANG_COMPILER_STATUS_META.unavailable;
    });

    const compilerSourceLabel = computed(() => {
        const source = String(compilerStatus.value.source || '').toLowerCase();
        if (source === 'bundled') return '内置安装包';
        if (['environment', 'env', 'override'].includes(source)) return '开发环境覆盖';
        if (['path', 'system'].includes(source)) return '系统兼容路径';
        if (source === 'configured') return '显式配置';
        return compilerStatus.value.source || '-';
    });

    const compilerError = computed(() => {
        const error = compilerStatus.value.error;
        if (typeof error === 'string') return error;
        if (error?.message) return error.message;
        return compilerStatus.value.available ? '' : compilerStatus.value.message || '运行时不可用';
    });

    const statusAlert = computed(() => {
        if (compilerStatus.value.checking) {
            return {
                type: 'info',
                message: '正在检查内置 YANG 编译器',
                description: '正在验证 libyang/yanglint 的版本、路径和执行能力。'
            };
        }
        if (compilerStatus.value.available) {
            return {
                type: 'success',
                message: '内置 YANG 编译器运行正常',
                description: `${compilerStatus.value.engine || 'libyang'} ${compilerStatus.value.version || ''}`.trim()
            };
        }
        return {
            type: 'error',
            message: '内置 YANG 编译器不可用',
            description: [compilerError.value, compilerStatus.value.installHint].filter(Boolean).join(' ')
        };
    });

    const recheckCompiler = async () => {
        const status = await refreshCompilerStatus({ force: true });
        if (status.available) notify.success('libyang 运行时检测通过');
        else notify.error(status.message || 'libyang 运行时检测失败');
    };

    onMounted(refreshCompilerStatus);
    onActivated(refreshCompilerStatus);
</script>

<style scoped>
    .runtime-settings {
        max-width: 100%;
    }

    .runtime-status-alert {
        margin-bottom: 16px;
    }

    .runtime-details {
        margin-bottom: 16px;
    }

    .runtime-path {
        word-break: break-all;
    }

    .runtime-error {
        color: var(--nn-color-error);
    }

    .runtime-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .runtime-action-hint {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 1.5;
    }
</style>
