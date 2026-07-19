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
    activeWhen = () => true,
    frameSynchronized = false,
    previewStyleProperty = '',
    previewTargetRef,
    previewStyleValue = value => `${value}px`
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
    let dragRect = null;
    let livePaneSize = 0;
    let pendingPointerCoordinate = null;
    let resizeFrameId = null;
    let boundsFrameId = null;
    let pendingObservedAxisSize = null;
    let pendingBoundsMeasurement = false;
    let lastObservedAxisSize = null;

    const readContainerRect = () => containerRef.value?.getBoundingClientRect?.() || null;
    const resolvePreviewTarget = () => previewTargetRef?.value || containerRef.value;
    const hasDomPreview = () => Boolean(frameSynchronized && previewStyleProperty && resolvePreviewTarget()?.style);

    const writeDomPreview = size => {
        const target = resolvePreviewTarget();
        if (!frameSynchronized || !previewStyleProperty || !target?.style) return false;
        const styleValue =
            typeof previewStyleValue === 'function' ? previewStyleValue(size) : `${size}${previewStyleValue || 'px'}`;
        target.style.setProperty(previewStyleProperty, styleValue);
        return true;
    };

    const commitPaneSize = size => {
        const nextSize = Math.round(size);
        livePaneSize = nextSize;
        paneSize.value = nextSize;
        writeDomPreview(nextSize);
    };

    const previewPaneSize = size => {
        const nextSize = Math.round(size);
        livePaneSize = nextSize;
        if (!writeDomPreview(nextSize)) paneSize.value = nextSize;
    };

    const updateBounds = ({ reset = false, rect = null, axisSize = null } = {}) => {
        if (!activeWhen()) {
            stopResize();
            return;
        }
        const suppliedAxisSize = Number(axisSize);
        const hasSuppliedAxisSize = Number.isFinite(suppliedAxisSize) && suppliedAxisSize > 0;
        const containerRect = rect || (hasSuppliedAxisSize ? null : readContainerRect());
        const total = hasSuppliedAxisSize ? suppliedAxisSize : containerRect?.[axis] || 0;
        if (total <= 0) return;

        if (frameSynchronized && resizing.value) {
            dragRect = containerRect || readContainerRect() || dragRect;
        }

        const available = Math.max(0, total - dividerSize);
        const nextMaximum = Math.max(0, available - minSecond);
        const nextMinimum = Math.min(minFirst, nextMaximum);
        minSize.value = Math.round(nextMinimum);
        maxSize.value = Math.round(Math.max(nextMinimum, nextMaximum));

        if (!initialized || reset) {
            commitPaneSize(clamp(available * defaultRatio, nextMinimum, nextMaximum));
            initialized = true;
            return;
        }

        const currentSize = frameSynchronized && resizing.value ? livePaneSize : paneSize.value;
        const nextSize = clamp(currentSize, nextMinimum, nextMaximum);
        if (frameSynchronized && resizing.value && hasDomPreview()) previewPaneSize(nextSize);
        else commitPaneSize(nextSize);
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

    const pointerCoordinate = event => (orientation === 'horizontal' ? event.clientY : event.clientX);

    const sizeFromPointerCoordinate = (coordinate, rect) => {
        if (!rect) return;
        const pointerPosition =
            orientation === 'horizontal'
                ? reverse
                    ? rect.bottom - coordinate
                    : coordinate - rect.top
                : reverse
                  ? rect.right - coordinate
                  : coordinate - rect.left;
        return clamp(pointerPosition - dividerSize / 2, minSize.value, maxSize.value);
    };

    const updateFromPointer = event => {
        const size = sizeFromPointerCoordinate(pointerCoordinate(event), readContainerRect());
        if (size === undefined) return;
        commitPaneSize(size);
    };

    const updateFromPointerCoordinate = coordinate => {
        const size = sizeFromPointerCoordinate(coordinate, dragRect);
        if (size === undefined) return;
        previewPaneSize(size);
    };

    const flushPendingPointerUpdate = () => {
        if (pendingPointerCoordinate === null) return;
        const coordinate = pendingPointerCoordinate;
        pendingPointerCoordinate = null;
        updateFromPointerCoordinate(coordinate);
    };

    const cancelResizeFrame = () => {
        if (resizeFrameId === null) return;
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(resizeFrameId);
        resizeFrameId = null;
    };

    const flushPendingBoundsUpdate = () => {
        const shouldMeasure = pendingBoundsMeasurement;
        const observedAxisSize = pendingObservedAxisSize;
        pendingBoundsMeasurement = false;
        pendingObservedAxisSize = null;
        updateBounds(shouldMeasure || observedAxisSize === null ? undefined : { axisSize: observedAxisSize });
    };

    const cancelBoundsFrame = () => {
        if (boundsFrameId === null) return;
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(boundsFrameId);
        boundsFrameId = null;
    };

    const queueBoundsUpdate = ({ measure = false, axisSize: nextAxisSize = null } = {}) => {
        if (!frameSynchronized) {
            updateBounds();
            return;
        }
        if (measure) pendingBoundsMeasurement = true;
        if (nextAxisSize !== null && Number.isFinite(Number(nextAxisSize))) {
            pendingObservedAxisSize = Number(nextAxisSize);
        }
        if (boundsFrameId !== null) return;
        if (typeof window.requestAnimationFrame !== 'function') {
            flushPendingBoundsUpdate();
            return;
        }
        boundsFrameId = window.requestAnimationFrame(() => {
            boundsFrameId = null;
            flushPendingBoundsUpdate();
        });
    };

    const handleContainerResize = entries => {
        if (!frameSynchronized) {
            updateBounds();
            return;
        }
        const entry = Array.isArray(entries) ? entries[entries.length - 1] : null;
        const nextAxisSize = Number(entry?.contentRect?.[axis]);
        if (!Number.isFinite(nextAxisSize) || nextAxisSize <= 0) {
            queueBoundsUpdate({ measure: true });
            return;
        }
        if (lastObservedAxisSize !== null && Math.abs(nextAxisSize - lastObservedAxisSize) < 0.5) return;
        lastObservedAxisSize = nextAxisSize;
        queueBoundsUpdate({ axisSize: nextAxisSize });
    };

    const handleViewportResize = () => (frameSynchronized ? queueBoundsUpdate({ measure: true }) : updateBounds());

    const queuePointerUpdate = event => {
        pendingPointerCoordinate = pointerCoordinate(event);
        if (resizeFrameId !== null) return;
        if (typeof window.requestAnimationFrame !== 'function') {
            flushPendingPointerUpdate();
            return;
        }
        resizeFrameId = window.requestAnimationFrame(() => {
            resizeFrameId = null;
            flushPendingPointerUpdate();
        });
    };

    function handlePointerMove(event) {
        if (!resizing.value || event.pointerId !== activePointerId) return;
        event.preventDefault();
        if (frameSynchronized) queuePointerUpdate(event);
        else updateFromPointer(event);
    }

    function handlePointerEnd(event) {
        if (event.pointerId !== activePointerId) return;
        if (frameSynchronized && event.type !== 'pointercancel') {
            pendingPointerCoordinate = pointerCoordinate(event);
        }
        stopResize();
    }

    function stopResize() {
        removePointerListeners();
        if (frameSynchronized) {
            cancelResizeFrame();
            flushPendingPointerUpdate();
            if (resizing.value) commitPaneSize(livePaneSize);
        }
        restoreDocumentInteraction();
        activePointerId = null;
        if (frameSynchronized) {
            dragRect = null;
            pendingPointerCoordinate = null;
        }
    }

    const startResize = event => {
        if (!activeWhen() || event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        stopResize();
        const rect = frameSynchronized ? readContainerRect() : null;
        if (frameSynchronized && !rect) return;
        updateBounds(frameSynchronized ? { rect } : undefined);
        previousBodyCursor = document.body.style.cursor;
        previousBodyUserSelect = document.body.style.userSelect;
        document.body.style.cursor = cursor;
        document.body.style.userSelect = 'none';
        activePointerId = event.pointerId;
        if (frameSynchronized) {
            dragRect = rect;
            livePaneSize = paneSize.value;
        }
        resizing.value = true;
        if (frameSynchronized) queuePointerUpdate(event);
        else updateFromPointer(event);
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
        commitPaneSize(clamp(nextSize, minSize.value, maxSize.value));
    };

    const resetResize = () => updateBounds({ reset: true });

    onMounted(() => {
        nextTick(() => {
            updateBounds();
            if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
                resizeObserver = new ResizeObserver(handleContainerResize);
                resizeObserver.observe(containerRef.value);
            }
        });
        window.addEventListener('resize', handleViewportResize);
    });

    onBeforeUnmount(() => {
        stopResize();
        cancelBoundsFrame();
        resizeObserver?.disconnect();
        window.removeEventListener('resize', handleViewportResize);
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
