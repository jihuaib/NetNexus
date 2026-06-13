import { createApp, nextTick } from 'vue';
import Alert from 'ant-design-vue/es/alert';
import Badge from 'ant-design-vue/es/badge';
import Button from 'ant-design-vue/es/button';
import Card from 'ant-design-vue/es/card';
import Checkbox from 'ant-design-vue/es/checkbox';
import Col from 'ant-design-vue/es/col';
import DatePicker from 'ant-design-vue/es/date-picker';
import Descriptions from 'ant-design-vue/es/descriptions';
import Divider from 'ant-design-vue/es/divider';
import Drawer from 'ant-design-vue/es/drawer';
import Dropdown from 'ant-design-vue/es/dropdown';
import Empty from 'ant-design-vue/es/empty';
import Form from 'ant-design-vue/es/form';
import Input from 'ant-design-vue/es/input';
import InputNumber from 'ant-design-vue/es/input-number';
import List from 'ant-design-vue/es/list';
import Menu from 'ant-design-vue/es/menu';
import Modal from 'ant-design-vue/es/modal';
import Popconfirm from 'ant-design-vue/es/popconfirm';
import Radio from 'ant-design-vue/es/radio';
import Row from 'ant-design-vue/es/row';
import Select from 'ant-design-vue/es/select';
import Space from 'ant-design-vue/es/space';
import Spin from 'ant-design-vue/es/spin';
import Statistic from 'ant-design-vue/es/statistic';
import Switch from 'ant-design-vue/es/switch';
import Table from 'ant-design-vue/es/table';
import Tabs from 'ant-design-vue/es/tabs';
import Tag from 'ant-design-vue/es/tag';
import Tooltip from 'ant-design-vue/es/tooltip';
import Tree from 'ant-design-vue/es/tree';
import Typography from 'ant-design-vue/es/typography';
import 'ant-design-vue/dist/reset.css';
import './assets/styles/common.css';
import App from './App.vue';
import router from './router';
import store from './store';
import EventBus from './utils/eventBus';
// 引入弹出框缩放自适应处理工具
import './utils/modalResizeHandler';

// 初始化全局事件监听器
if (window.commonApi && window.commonApi.onUnifiedEvent) {
    window.commonApi.onUnifiedEvent(({ type, data }) => {
        EventBus.emit(type, data);
    });
}

const app = createApp(App);
const antdComponents = [
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Col,
    DatePicker,
    Descriptions,
    Divider,
    Drawer,
    Dropdown,
    Empty,
    Form,
    Input,
    InputNumber,
    List,
    Menu,
    Modal,
    Popconfirm,
    Radio,
    Row,
    Select,
    Space,
    Spin,
    Statistic,
    Switch,
    Table,
    Tabs,
    Tag,
    Tooltip,
    Tree,
    Typography
];

antdComponents.forEach(component => {
    app.use(component);
});

async function mountApp() {
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
