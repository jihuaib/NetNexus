<template>
    <span ref="rootRef" class="nn-dropdown" :class="dropdownClass">
        <span class="nn-dropdown-trigger" @click="handleClick" @contextmenu.prevent="handleContextMenu">
            <slot />
        </span>
        <span v-if="open" class="nn-dropdown-popup" @click="handleOverlayClick">
            <slot name="overlay" />
        </span>
    </span>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    const props = defineProps({
        trigger: {
            type: Array,
            default: () => ['hover']
        },
        placement: {
            type: String,
            default: 'bottomLeft'
        }
    });

    const emit = defineEmits(['openChange']);

    const rootRef = ref(null);
    const open = ref(false);

    const normalizedTriggers = computed(() => new Set(props.trigger));

    const dropdownClass = computed(() => ({
        'nn-dropdown-top-right': props.placement === 'topRight',
        'nn-dropdown-bottom-right': props.placement === 'bottomRight'
    }));

    const setOpen = nextOpen => {
        open.value = nextOpen;
        emit('openChange', nextOpen);
    };

    const handleClick = () => {
        if (normalizedTriggers.value.has('click')) {
            setOpen(!open.value);
        }
    };

    const handleContextMenu = () => {
        if (normalizedTriggers.value.has('contextmenu')) {
            setOpen(true);
        }
    };

    const handleOverlayClick = () => {
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
    .nn-dropdown {
        position: relative;
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-dropdown-trigger {
        display: inline-flex;
        max-width: 100%;
    }

    .nn-dropdown-popup {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 1050;
        min-width: 120px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-dropdown-top-right .nn-dropdown-popup {
        top: auto;
        right: 0;
        bottom: calc(100% + 6px);
        left: auto;
    }

    .nn-dropdown-bottom-right .nn-dropdown-popup {
        right: 0;
        left: auto;
    }

    .nn-dropdown-popup :deep(.ant-menu) {
        min-width: 100%;
        border: 0;
        background: transparent;
        box-shadow: none;
    }
</style>
