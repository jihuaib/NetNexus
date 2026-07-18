import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

export function usePaneResize({
    containerRef,
    orientation,
    reverse = false,
    defaultRatio = 0.5,
    minFirst = 0,
    minSecond = 0,
    dividerSize = 0,
    activeWhen = () => true
}) {
    const paneSize = ref(0);
    const minSize = ref(minFirst);
    const maxSize = ref(minFirst);
    const resizing = ref(false);
    const axis = orientation === 'horizontal' ? 'height' : 'width';
    const cursor = orientation === 'horizontal' ? 'row-resize' : 'col-resize';
    let initialized = false;
    let resizeObserver = null;
    let previousBodyCursor = '';
    let previousBodyUserSelect = '';
    let activePointerId = null;

    const containerSize = () => containerRef.value?.getBoundingClientRect?.()[axis] || 0;

    const updateBounds = ({ reset = false } = {}) => {
        if (!activeWhen()) {
            stopResize();
            return;
        }
        const total = containerSize();
        if (total <= 0) return;

        const available = Math.max(0, total - dividerSize);
        const nextMaximum = Math.max(0, available - minSecond);
        const nextMinimum = Math.min(minFirst, nextMaximum);
        minSize.value = Math.round(nextMinimum);
        maxSize.value = Math.round(Math.max(nextMinimum, nextMaximum));

        if (!initialized || reset) {
            paneSize.value = Math.round(clamp(available * defaultRatio, nextMinimum, nextMaximum));
            initialized = true;
            return;
        }

        paneSize.value = Math.round(clamp(paneSize.value, nextMinimum, nextMaximum));
    };

    const removePointerListeners = () => {
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerEnd);
        document.removeEventListener('pointercancel', handlePointerEnd);
        window.removeEventListener('blur', stopResize);
    };

    const restoreDocumentInteraction = () => {
        if (!resizing.value) return;
        document.body.style.cursor = previousBodyCursor;
        document.body.style.userSelect = previousBodyUserSelect;
        resizing.value = false;
    };

    const updateFromPointer = event => {
        const rect = containerRef.value?.getBoundingClientRect?.();
        if (!rect) return;
        const pointerPosition =
            orientation === 'horizontal'
                ? reverse
                    ? rect.bottom - event.clientY
                    : event.clientY - rect.top
                : reverse
                  ? rect.right - event.clientX
                  : event.clientX - rect.left;
        paneSize.value = Math.round(clamp(pointerPosition - dividerSize / 2, minSize.value, maxSize.value));
    };

    function handlePointerMove(event) {
        if (!resizing.value || event.pointerId !== activePointerId) return;
        event.preventDefault();
        updateFromPointer(event);
    }

    function handlePointerEnd(event) {
        if (event.pointerId !== activePointerId) return;
        stopResize();
    }

    function stopResize() {
        removePointerListeners();
        restoreDocumentInteraction();
        activePointerId = null;
    }

    const startResize = event => {
        if (!activeWhen() || event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        stopResize();
        updateBounds();
        previousBodyCursor = document.body.style.cursor;
        previousBodyUserSelect = document.body.style.userSelect;
        document.body.style.cursor = cursor;
        document.body.style.userSelect = 'none';
        activePointerId = event.pointerId;
        resizing.value = true;
        updateFromPointer(event);
        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerEnd);
        document.addEventListener('pointercancel', handlePointerEnd);
        window.addEventListener('blur', stopResize);
    };

    const handleResizeKeydown = event => {
        updateBounds();
        const step = event.shiftKey ? 48 : 16;
        let nextSize = null;

        if (event.key === 'Home') nextSize = minSize.value;
        else if (event.key === 'End') nextSize = maxSize.value;
        else if (orientation === 'horizontal' && event.key === 'ArrowUp')
            nextSize = paneSize.value + (reverse ? step : -step);
        else if (orientation === 'horizontal' && event.key === 'ArrowDown')
            nextSize = paneSize.value + (reverse ? -step : step);
        else if (orientation !== 'horizontal' && event.key === 'ArrowLeft')
            nextSize = paneSize.value + (reverse ? step : -step);
        else if (orientation !== 'horizontal' && event.key === 'ArrowRight')
            nextSize = paneSize.value + (reverse ? -step : step);

        if (nextSize === null) return;
        event.preventDefault();
        paneSize.value = Math.round(clamp(nextSize, minSize.value, maxSize.value));
    };

    const resetResize = () => updateBounds({ reset: true });

    onMounted(() => {
        nextTick(() => {
            updateBounds();
            if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
                resizeObserver = new ResizeObserver(() => updateBounds());
                resizeObserver.observe(containerRef.value);
            }
        });
        window.addEventListener('resize', updateBounds);
    });

    onBeforeUnmount(() => {
        stopResize();
        resizeObserver?.disconnect();
        window.removeEventListener('resize', updateBounds);
    });

    return {
        paneSize,
        minSize,
        maxSize,
        resizing,
        startResize,
        handleResizeKeydown,
        resetResize,
        stopResize,
        updateBounds
    };
}
