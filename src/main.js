import { createApp, nextTick } from 'vue';
import './assets/styles/theme.css';
import './assets/styles/ui-services.css';
import './assets/styles/common.css';
import App from './App.vue';
import router from './router';
import store from './store';
import EventBus from './utils/eventBus';
import { registerUiComponents } from './ui/registerUiComponents';
import { initializeTheme, syncThemeFromGeneralSettings } from './utils/themeManager';
// 引入弹出框缩放自适应处理工具
import './utils/modalResizeHandler';

// 初始化全局事件监听器
if (window.commonApi && window.commonApi.onUnifiedEvent) {
    window.commonApi.onUnifiedEvent(({ type, data }) => {
        EventBus.emit(type, data);
    });
}

initializeTheme();

const app = createApp(App);
registerUiComponents(app);

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
    window.commonApi?.notifyRendererReady?.();
}

mountApp();
