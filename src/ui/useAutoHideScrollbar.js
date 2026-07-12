import { onBeforeUnmount, ref } from 'vue';

const DEFAULT_HIDE_DELAY = 800;

export function useAutoHideScrollbar(hideDelay = DEFAULT_HIDE_DELAY) {
    const scrollbarActive = ref(false);
    let hideTimer = null;

    const clearHideTimer = () => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };

    const hideScrollbar = () => {
        clearHideTimer();
        scrollbarActive.value = false;
    };

    const showScrollbar = () => {
        scrollbarActive.value = true;
        clearHideTimer();
        hideTimer = setTimeout(() => {
            hideTimer = null;
            scrollbarActive.value = false;
        }, hideDelay);
    };

    onBeforeUnmount(clearHideTimer);

    return {
        scrollbarActive,
        showScrollbar,
        hideScrollbar
    };
}
