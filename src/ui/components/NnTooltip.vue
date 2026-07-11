<template>
    <span
        ref="rootRef"
        class="nn-tooltip"
        :class="tooltipClass"
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
        @focusin="handleFocusIn"
        @focusout="handleFocusOut"
    >
        <span ref="triggerRef" class="nn-tooltip-trigger" :aria-describedby="visible ? tooltipId : undefined">
            <slot />
        </span>
        <Teleport to="body">
            <span
                v-if="visible"
                :id="tooltipId"
                ref="popupRef"
                class="nn-tooltip-popup"
                :class="`nn-tooltip-popup-${resolvedPlacement}`"
                :style="popupStyle"
                role="tooltip"
            >
                <span class="nn-tooltip-arrow" />
                <span class="nn-tooltip-inner">
                    <slot name="title">{{ title }}</slot>
                </span>
            </span>
        </Teleport>
    </span>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useSlots, watch } from 'vue';

    const props = defineProps({
        title: {
            type: [String, Number],
            default: ''
        },
        open: {
            type: Boolean,
            default: undefined
        },
        placement: {
            type: String,
            default: 'top',
            validator: value => ['top', 'bottom', 'left', 'right'].includes(value)
        }
    });

    const slots = useSlots();
    const rootRef = ref(null);
    const triggerRef = ref(null);
    const popupRef = ref(null);
    const hovered = ref(false);
    const focused = ref(false);
    const controlledDismissed = ref(false);
    const resolvedPlacement = ref(props.placement);
    const popupPosition = ref({ top: 0, left: 0, arrowX: 0, arrowY: 0 });
    const tooltipId = `nn-tooltip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

    const viewportMargin = 8;
    const popupGap = 8;
    const arrowMargin = 8;

    const isControlled = computed(() => props.open !== undefined);
    const hasContent = computed(() => props.title !== '' || Boolean(slots.title));

    const visible = computed(() => {
        if (!hasContent.value) {
            return false;
        }

        if (isControlled.value) {
            return props.open && !controlledDismissed.value;
        }

        return hovered.value || focused.value;
    });

    const tooltipClass = computed(() => ({
        'nn-tooltip-controlled': isControlled.value,
        'nn-tooltip-open': visible.value
    }));

    const popupStyle = computed(() => ({
        top: `${popupPosition.value.top}px`,
        left: `${popupPosition.value.left}px`,
        '--nn-tooltip-arrow-x': `${popupPosition.value.arrowX}px`,
        '--nn-tooltip-arrow-y': `${popupPosition.value.arrowY}px`
    }));

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const oppositePlacement = placement => {
        const opposites = {
            top: 'bottom',
            bottom: 'top',
            left: 'right',
            right: 'left'
        };

        return opposites[placement];
    };

    const getAvailableSpace = triggerRect => ({
        top: triggerRect.top - viewportMargin - popupGap,
        bottom: window.innerHeight - triggerRect.bottom - viewportMargin - popupGap,
        left: triggerRect.left - viewportMargin - popupGap,
        right: window.innerWidth - triggerRect.right - viewportMargin - popupGap
    });

    const getRequiredSpace = (placement, popupRect) =>
        placement === 'top' || placement === 'bottom' ? popupRect.height : popupRect.width;

    const updatePopupPosition = async () => {
        await nextTick();

        if (!visible.value) return;

        const trigger = triggerRef.value;
        const popup = popupRef.value;
        if (!trigger || !popup) return;

        const triggerRect = trigger.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const availableSpace = getAvailableSpace(triggerRect);
        const requestedPlacement = props.placement;
        const opposite = oppositePlacement(requestedPlacement);
        const requestedSpace = getRequiredSpace(requestedPlacement, popupRect);
        let placement = requestedPlacement;

        if (
            requestedSpace > availableSpace[requestedPlacement] &&
            availableSpace[opposite] > availableSpace[requestedPlacement]
        ) {
            placement = opposite;
        }

        const triggerCenterX = triggerRect.left + triggerRect.width / 2;
        const triggerCenterY = triggerRect.top + triggerRect.height / 2;
        let top;
        let left;

        if (placement === 'top') {
            top = triggerRect.top - popupRect.height - popupGap;
            left = triggerCenterX - popupRect.width / 2;
        } else if (placement === 'bottom') {
            top = triggerRect.bottom + popupGap;
            left = triggerCenterX - popupRect.width / 2;
        } else if (placement === 'left') {
            top = triggerCenterY - popupRect.height / 2;
            left = triggerRect.left - popupRect.width - popupGap;
        } else {
            top = triggerCenterY - popupRect.height / 2;
            left = triggerRect.right + popupGap;
        }

        const maxLeft = Math.max(viewportMargin, window.innerWidth - popupRect.width - viewportMargin);
        const maxTop = Math.max(viewportMargin, window.innerHeight - popupRect.height - viewportMargin);
        left = clamp(left, viewportMargin, maxLeft);
        top = clamp(top, viewportMargin, maxTop);

        popupPosition.value = {
            top: Math.round(top),
            left: Math.round(left),
            arrowX: Math.round(
                clamp(triggerCenterX - left, arrowMargin, Math.max(arrowMargin, popupRect.width - arrowMargin))
            ),
            arrowY: Math.round(
                clamp(triggerCenterY - top, arrowMargin, Math.max(arrowMargin, popupRect.height - arrowMargin))
            )
        };
        resolvedPlacement.value = placement;
    };

    const resetControlledDismissal = () => {
        if (isControlled.value && props.open) {
            controlledDismissed.value = false;
        }
    };

    const handleMouseEnter = () => {
        hovered.value = true;
        resetControlledDismissal();
    };

    const handleMouseLeave = () => {
        hovered.value = false;
    };

    const handleFocusIn = () => {
        focused.value = true;
        resetControlledDismissal();
    };

    const handleFocusOut = event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
            focused.value = false;
        }
    };

    const dismissTooltip = () => {
        hovered.value = false;
        focused.value = false;

        if (isControlled.value && props.open) {
            controlledDismissed.value = true;
        }
    };

    const handleDocumentPointerDown = event => {
        if (visible.value && rootRef.value && !rootRef.value.contains(event.target)) {
            dismissTooltip();
        }
    };

    const handleDocumentKeydown = event => {
        if (visible.value && event.key === 'Escape') {
            event.preventDefault();
            dismissTooltip();
        }
    };

    watch(
        () => props.open,
        () => {
            controlledDismissed.value = false;
        }
    );

    watch(
        [visible, () => props.title, () => props.placement],
        ([isVisible]) => {
            if (isVisible) updatePopupPosition();
        },
        { flush: 'post' }
    );

    onMounted(() => {
        document.addEventListener('pointerdown', handleDocumentPointerDown);
        document.addEventListener('keydown', handleDocumentKeydown);
        window.addEventListener('resize', updatePopupPosition);
        window.addEventListener('scroll', updatePopupPosition, true);

        if (visible.value) updatePopupPosition();
    });

    onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', handleDocumentPointerDown);
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', updatePopupPosition);
        window.removeEventListener('scroll', updatePopupPosition, true);
    });
</script>

<style scoped>
    .nn-tooltip {
        position: relative;
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-tooltip-controlled {
        display: block;
        width: 100%;
    }

    .nn-tooltip-trigger {
        display: inline-flex;
        width: 100%;
        max-width: 100%;
        min-width: 0;
    }

    .nn-tooltip:not(.nn-tooltip-controlled) .nn-tooltip-trigger {
        width: auto;
    }

    .nn-tooltip-popup {
        position: fixed;
        z-index: 1000;
        width: max-content;
        max-width: min(320px, 80vw);
        pointer-events: none;
    }

    .nn-tooltip-inner {
        display: block;
        min-height: 24px;
        padding: 8px 12px;
        border-radius: 4px;
        background: var(--nn-color-tooltip-bg);
        color: var(--nn-color-tooltip-text);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-tooltip-arrow {
        position: absolute;
        width: 8px;
        height: 8px;
        background: var(--nn-color-tooltip-bg);
        transform: rotate(45deg);
    }

    .nn-tooltip-popup-top .nn-tooltip-arrow,
    .nn-tooltip-popup-bottom .nn-tooltip-arrow {
        left: var(--nn-tooltip-arrow-x);
        transform: translateX(-50%) rotate(45deg);
    }

    .nn-tooltip-popup-left .nn-tooltip-arrow,
    .nn-tooltip-popup-right .nn-tooltip-arrow {
        top: var(--nn-tooltip-arrow-y);
        transform: translateY(-50%) rotate(45deg);
    }

    .nn-tooltip-popup-top .nn-tooltip-arrow {
        bottom: -4px;
    }

    .nn-tooltip-popup-bottom .nn-tooltip-arrow {
        top: -4px;
    }

    .nn-tooltip-popup-left .nn-tooltip-arrow {
        right: -4px;
    }

    .nn-tooltip-popup-right .nn-tooltip-arrow {
        left: -4px;
    }
</style>
