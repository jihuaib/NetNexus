<template>
    <span ref="rootRef" class="nn-dropdown" @mouseenter="handleMouseEnter" @mouseleave="handleMouseLeave">
        <span
            class="nn-dropdown-trigger"
            :aria-expanded="open ? 'true' : 'false'"
            @click="handleClick"
            @contextmenu.prevent="handleContextMenu"
        >
            <slot />
        </span>
        <Teleport to="body">
            <span
                v-if="open"
                ref="popupRef"
                class="nn-dropdown-popup"
                :style="popupStyle"
                @click="handleOverlayClick"
                @mouseenter="cancelHoverClose"
                @mouseleave="handleMouseLeave"
            >
                <slot name="overlay" />
            </span>
        </Teleport>
    </span>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

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
    const popupRef = ref(null);
    const open = ref(false);
    const popupPosition = ref({ top: 0, left: 0, minWidth: 120 });
    let hoverCloseTimer = null;
    let contextMenuPoint = null;

    const normalizedTriggers = computed(() => new Set(props.trigger));

    const popupStyle = computed(() => ({
        top: `${popupPosition.value.top}px`,
        left: `${popupPosition.value.left}px`,
        minWidth: `${popupPosition.value.minWidth}px`
    }));

    const updatePopupPosition = async () => {
        await nextTick();
        const root = rootRef.value;
        const popup = popupRef.value;
        if (!root || !popup) return;

        const rootRect = root.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const viewportMargin = 8;
        let top;
        let left;

        if (contextMenuPoint) {
            top = contextMenuPoint.y;
            left = contextMenuPoint.x;
        } else {
            const placeAbove = props.placement.startsWith('top');
            const alignRight = props.placement.endsWith('Right');
            top = placeAbove ? rootRect.top - popupRect.height - 6 : rootRect.bottom + 6;
            left = alignRight ? rootRect.right - popupRect.width : rootRect.left;
        }

        if (top + popupRect.height > window.innerHeight - viewportMargin) {
            top = Math.max(viewportMargin, rootRect.top - popupRect.height - 6);
        }
        if (top < viewportMargin) {
            top = Math.min(window.innerHeight - popupRect.height - viewportMargin, rootRect.bottom + 6);
        }
        left = Math.min(
            Math.max(viewportMargin, left),
            Math.max(viewportMargin, window.innerWidth - popupRect.width - viewportMargin)
        );

        popupPosition.value = {
            top: Math.round(top),
            left: Math.round(left),
            minWidth: Math.max(120, Math.round(rootRect.width))
        };
    };

    const setOpen = nextOpen => {
        open.value = nextOpen;
        emit('openChange', nextOpen);
        if (nextOpen) updatePopupPosition();
        else contextMenuPoint = null;
    };

    const handleClick = () => {
        if (normalizedTriggers.value.has('click')) {
            setOpen(!open.value);
        }
    };

    const handleContextMenu = event => {
        if (normalizedTriggers.value.has('contextmenu')) {
            contextMenuPoint = { x: event.clientX, y: event.clientY };
            setOpen(true);
        }
    };

    const cancelHoverClose = () => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    };

    const handleMouseEnter = () => {
        cancelHoverClose();
        if (normalizedTriggers.value.has('hover')) setOpen(true);
    };

    const handleMouseLeave = () => {
        if (!normalizedTriggers.value.has('hover')) return;
        cancelHoverClose();
        hoverCloseTimer = setTimeout(() => setOpen(false), 120);
    };

    const handleOverlayClick = () => {
        setOpen(false);
    };

    const handleDocumentClick = event => {
        if (
            open.value &&
            rootRef.value &&
            !rootRef.value.contains(event.target) &&
            !popupRef.value?.contains(event.target)
        ) {
            setOpen(false);
        }
    };

    const handleDocumentKeydown = event => {
        if (open.value && event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
        }
    };

    onMounted(() => {
        document.addEventListener('click', handleDocumentClick);
        document.addEventListener('keydown', handleDocumentKeydown);
        window.addEventListener('resize', updatePopupPosition);
        window.addEventListener('scroll', updatePopupPosition, true);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('click', handleDocumentClick);
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', updatePopupPosition);
        window.removeEventListener('scroll', updatePopupPosition, true);
        cancelHoverClose();
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
        position: fixed;
        z-index: 1050;
        min-width: 120px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-dropdown-popup :deep(.nn-menu) {
        min-width: 100%;
        border: 0;
        background: transparent;
        box-shadow: none;
    }
</style>
