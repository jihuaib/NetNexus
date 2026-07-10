<template>
    <span ref="rootRef" class="nn-popconfirm">
        <span class="nn-popconfirm-trigger" @click.stop="toggleOpen">
            <slot />
        </span>
        <span v-if="open" class="nn-popconfirm-popup" role="dialog" @click.stop>
            <span class="nn-popconfirm-arrow" />
            <span class="nn-popconfirm-title">{{ title }}</span>
            <span class="nn-popconfirm-actions">
                <NnButton size="small" @click="handleCancel">{{ cancelText }}</NnButton>
                <NnButton type="primary" size="small" @click="handleConfirm">{{ okText }}</NnButton>
            </span>
        </span>
    </span>
</template>

<script setup>
    import { onBeforeUnmount, onMounted, ref } from 'vue';
    import NnButton from './NnButton.vue';

    defineProps({
        title: {
            type: String,
            default: ''
        },
        okText: {
            type: String,
            default: '确定'
        },
        cancelText: {
            type: String,
            default: '取消'
        }
    });

    const emit = defineEmits(['confirm', 'cancel', 'openChange']);

    const rootRef = ref(null);
    const open = ref(false);

    const setOpen = nextOpen => {
        open.value = nextOpen;
        emit('openChange', nextOpen);
    };

    const toggleOpen = () => {
        setOpen(!open.value);
    };

    const handleConfirm = event => {
        emit('confirm', event);
        setOpen(false);
    };

    const handleCancel = event => {
        emit('cancel', event);
        setOpen(false);
    };

    const handleDocumentClick = event => {
        if (open.value && rootRef.value && !rootRef.value.contains(event.target)) {
            setOpen(false);
        }
    };

    onMounted(() => {
        document.addEventListener('click', handleDocumentClick);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('click', handleDocumentClick);
    });
</script>

<style scoped>
    .nn-popconfirm {
        position: relative;
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-popconfirm-trigger {
        display: inline-flex;
        max-width: 100%;
    }

    .nn-popconfirm-popup {
        position: absolute;
        right: 0;
        top: calc(100% + 10px);
        z-index: 1060;
        display: grid;
        gap: 10px;
        width: max-content;
        min-width: 180px;
        max-width: min(280px, 80vw);
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        color: var(--nn-color-text);
        box-shadow: var(--nn-shadow-floating);
        font-size: 14px;
        line-height: 1.45;
    }

    .nn-popconfirm-arrow {
        position: absolute;
        right: 14px;
        top: -5px;
        width: 10px;
        height: 10px;
        border-top: 1px solid var(--nn-color-border-light);
        border-left: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-elevated);
        transform: rotate(45deg);
    }

    .nn-popconfirm-title {
        display: block;
        color: var(--nn-color-text);
        overflow-wrap: anywhere;
    }

    .nn-popconfirm-actions {
        display: inline-flex;
        justify-content: flex-end;
        gap: 8px;
    }
</style>
