import { createApp, nextTick } from 'vue';
import NetNexusUi, { initializeTheme } from 'netnexus-ui';
import 'netnexus-ui/reset.css';
import 'netnexus-ui/base.css';
import 'netnexus-ui/style.css';
import './assets/styles/common.css';
import App from './App.vue';
import router from './router';
import store from './store';
import EventBus from './utils/eventBus';
import { YANG_EVENT } from './const/yangConst';
import { installNetconfNotificationCollector } from './view/yang/useNetconfNotificationHistory';
import { syncThemeFromGeneralSettings } from './utils/themeManager';
// 引入弹出框缩放自适应处理工具
import './utils/modalResizeHandler';

// 初始化全局事件监听器
const disposeNotificationCollector = installNetconfNotificationCollector(EventBus, YANG_EVENT);
let disposeUnifiedEvent = null;
if (window.commonApi && window.commonApi.onUnifiedEvent) {
    disposeUnifiedEvent = window.commonApi.onUnifiedEvent(({ type, data }) => {
        EventBus.emit(type, data);
    });
}
const disposeGlobalEventListeners = () => {
    window.removeEventListener('beforeunload', disposeGlobalEventListeners);
    disposeUnifiedEvent?.();
    disposeUnifiedEvent = null;
    disposeNotificationCollector();
};
window.addEventListener('beforeunload', disposeGlobalEventListeners, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeGlobalEventListeners);

initializeTheme();

const app = createApp(App);
app.use(NetNexusUi);

function waitForPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

async function mountApp() {
    await syncThemeFromGeneralSettings();
    app.use(router).use(store);
    try {
        await router.isReady();
    } catch (error) {
        console.error('路由初始化失败:', error);
    }

    app.mount('#app');
    await nextTick();
    // Vue's nextTick only guarantees that the DOM patch has completed. Keep the splash visible
    // until Chromium has submitted the mounted UI, otherwise Windows can flash a black surface
    // while the hidden main window is maximized and shown.
    await waitForPaint();
    window.commonApi?.notifyRendererReady?.();
}

mountApp();
