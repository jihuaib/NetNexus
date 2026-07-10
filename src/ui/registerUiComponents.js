import DatePicker from 'ant-design-vue/es/date-picker';
import Drawer from 'ant-design-vue/es/drawer';
import Form from 'ant-design-vue/es/form';
import Input from 'ant-design-vue/es/input';
import Menu from 'ant-design-vue/es/menu';
import Modal from 'ant-design-vue/es/modal';
import Select from 'ant-design-vue/es/select';
import Table from 'ant-design-vue/es/table';
import Tree from 'ant-design-vue/es/tree';
import 'ant-design-vue/dist/reset.css';
import NnAlert from './components/NnAlert.vue';
import NnBadge from './components/NnBadge.vue';
import NnButton from './components/NnButton.vue';
import NnCard from './components/NnCard.vue';
import NnCheckbox from './components/NnCheckbox.vue';
import NnCheckboxGroup from './components/NnCheckboxGroup.vue';
import NnCol from './components/NnCol.vue';
import NnDescriptions from './components/NnDescriptions.vue';
import NnDescriptionsItem from './components/NnDescriptionsItem.vue';
import NnDivider from './components/NnDivider.vue';
import NnDropdown from './components/NnDropdown.vue';
import NnEmpty from './components/NnEmpty.vue';
import NnInputNumber from './components/NnInputNumber.vue';
import NnList from './components/NnList.vue';
import NnListItem from './components/NnListItem.vue';
import NnListItemMeta from './components/NnListItemMeta.vue';
import NnPopconfirm from './components/NnPopconfirm.vue';
import NnRadio from './components/NnRadio.vue';
import NnRadioButton from './components/NnRadioButton.vue';
import NnRadioGroup from './components/NnRadioGroup.vue';
import NnRow from './components/NnRow.vue';
import NnSegmented from './components/NnSegmented.vue';
import NnSpace from './components/NnSpace.vue';
import NnSpin from './components/NnSpin.vue';
import NnStatistic from './components/NnStatistic.vue';
import NnSwitch from './components/NnSwitch.vue';
import NnTag from './components/NnTag.vue';
import NnTabs from './components/NnTabs.vue';
import NnTabPane from './components/NnTabPane.vue';
import NnTooltip from './components/NnTooltip.vue';
import NnTypographyText from './components/NnTypographyText.vue';

const uiComponents = [
    DatePicker,
    Drawer,
    Form,
    Input,
    Menu,
    Modal,
    Select,
    Table,
    Tree
];

export function registerUiComponents(app) {
    uiComponents.forEach(component => {
        app.use(component);
    });
    app.component('NnAlert', NnAlert);
    app.component('NnBadge', NnBadge);
    app.component('NnButton', NnButton);
    app.component('NnCard', NnCard);
    app.component('NnCheckbox', NnCheckbox);
    app.component('NnCheckboxGroup', NnCheckboxGroup);
    app.component('NnCol', NnCol);
    app.component('NnDescriptions', NnDescriptions);
    app.component('NnDescriptionsItem', NnDescriptionsItem);
    app.component('NnDivider', NnDivider);
    app.component('NnDropdown', NnDropdown);
    app.component('NnEmpty', NnEmpty);
    app.component('NnInputNumber', NnInputNumber);
    app.component('NnList', NnList);
    app.component('NnListItem', NnListItem);
    app.component('NnListItemMeta', NnListItemMeta);
    app.component('NnPopconfirm', NnPopconfirm);
    app.component('NnRadio', NnRadio);
    app.component('NnRadioButton', NnRadioButton);
    app.component('NnRadioGroup', NnRadioGroup);
    app.component('NnRow', NnRow);
    app.component('NnSegmented', NnSegmented);
    app.component('NnSpace', NnSpace);
    app.component('NnSpin', NnSpin);
    app.component('NnStatistic', NnStatistic);
    app.component('NnSwitch', NnSwitch);
    app.component('NnTag', NnTag);
    app.component('NnTabs', NnTabs);
    app.component('NnTabPane', NnTabPane);
    app.component('NnTooltip', NnTooltip);
    app.component('NnTypographyText', NnTypographyText);
}
