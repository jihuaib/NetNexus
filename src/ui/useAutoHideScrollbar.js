import { onBeforeUnmount, ref, watch } from 'vue';

const DEFAULT_HIDE_DELAY = 800;

export function useAutoHideScrollbar(scrollElementRef, hideDelay = DEFAULT_HIDE_DELAY) {
    const scrollbarXActive = ref(false);
    const scrollbarYActive = ref(false);
    const horizontalState = { active: scrollbarXActive, hideTimer: null };
    const verticalState = { active: scrollbarYActive, hideTimer: null };
    let lastScrollLeft = 0;
    let lastScrollTop = 0;

    const clearHideTimer = state => {
        if (state.hideTimer !== null) {
            clearTimeout(state.hideTimer);
            state.hideTimer = null;
        }
    };

    const activateScrollbar = state => {
        state.active.value = true;
        clearHideTimer(state);
        state.hideTimer = setTimeout(() => {
            state.hideTimer = null;
            state.active.value = false;
        }, hideDelay);
    };

    const syncScrollPosition = element => {
        lastScrollLeft = element?.scrollLeft ?? 0;
        lastScrollTop = element?.scrollTop ?? 0;
    };

    const handleScroll = event => {
        const element = event.currentTarget;
        if (!element) {
            return;
        }
        const nextScrollLeft = element.scrollLeft;
        const nextScrollTop = element.scrollTop;
        const scrolledHorizontally = nextScrollLeft !== lastScrollLeft;
        const scrolledVertically = nextScrollTop !== lastScrollTop;

        lastScrollLeft = nextScrollLeft;
        lastScrollTop = nextScrollTop;

        if (scrolledHorizontally) {
            activateScrollbar(horizontalState);
        }
        if (scrolledVertically) {
            activateScrollbar(verticalState);
        }
    };

    watch(scrollElementRef, syncScrollPosition, { flush: 'post' });
    onBeforeUnmount(() => {
        clearHideTimer(horizontalState);
        clearHideTimer(verticalState);
    });

    return {
        scrollbarXActive,
        scrollbarYActive,
        handleScroll
    };
}
