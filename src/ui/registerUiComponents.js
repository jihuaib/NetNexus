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
import NnDrawer from './components/NnDrawer.vue';
import NnDropdown from './components/NnDropdown.vue';
import NnEmpty from './components/NnEmpty.vue';
import NnForm from './components/NnForm.vue';
import NnFormItem from './components/NnFormItem.vue';
import NnFormItemRest from './components/NnFormItemRest.vue';
import NnInput from './components/NnInput.vue';
import NnInputGroup from './components/NnInputGroup.vue';
import NnInputNumber from './components/NnInputNumber.vue';
import NnInputPassword from './components/NnInputPassword.vue';
import NnInputSearch from './components/NnInputSearch.vue';
import NnList from './components/NnList.vue';
import NnListItem from './components/NnListItem.vue';
import NnListItemMeta from './components/NnListItemMeta.vue';
import NnMenu from './components/NnMenu.vue';
import NnMenuDivider from './components/NnMenuDivider.vue';
import NnMenuItem from './components/NnMenuItem.vue';
import NnModal from './components/NnModal.vue';
import NnPopconfirm from './components/NnPopconfirm.vue';
import NnRadio from './components/NnRadio.vue';
import NnRadioButton from './components/NnRadioButton.vue';
import NnRadioGroup from './components/NnRadioGroup.vue';
import NnRangePicker from './components/NnRangePicker.vue';
import NnRow from './components/NnRow.vue';
import NnSegmented from './components/NnSegmented.vue';
import NnSelect from './components/NnSelect.vue';
import NnSelectOption from './components/NnSelectOption.vue';
import NnSpace from './components/NnSpace.vue';
import NnSpin from './components/NnSpin.vue';
import NnStatistic from './components/NnStatistic.vue';
import NnSwitch from './components/NnSwitch.vue';
import NnTable from './components/NnTable.vue';
import NnTabPane from './components/NnTabPane.vue';
import NnTabs from './components/NnTabs.vue';
import NnTag from './components/NnTag.vue';
import NnTextarea from './components/NnTextarea.vue';
import NnTooltip from './components/NnTooltip.vue';
import NnTree from './components/NnTree.vue';
import NnTypographyText from './components/NnTypographyText.vue';

export const uiComponents = {
    NnAlert,
    NnBadge,
    NnButton,
    NnCard,
    NnCheckbox,
    NnCheckboxGroup,
    NnCol,
    NnDescriptions,
    NnDescriptionsItem,
    NnDivider,
    NnDrawer,
    NnDropdown,
    NnEmpty,
    NnForm,
    NnFormItem,
    NnFormItemRest,
    NnInput,
    NnInputGroup,
    NnInputNumber,
    NnInputPassword,
    NnInputSearch,
    NnList,
    NnListItem,
    NnListItemMeta,
    NnMenu,
    NnMenuDivider,
    NnMenuItem,
    NnModal,
    NnPopconfirm,
    NnRadio,
    NnRadioButton,
    NnRadioGroup,
    NnRangePicker,
    NnRow,
    NnSegmented,
    NnSelect,
    NnSelectOption,
    NnSpace,
    NnSpin,
    NnStatistic,
    NnSwitch,
    NnTable,
    NnTabPane,
    NnTabs,
    NnTag,
    NnTextarea,
    NnTooltip,
    NnTree,
    NnTypographyText
};

export function registerUiComponents(app) {
    Object.entries(uiComponents).forEach(([name, component]) => {
        app.component(name, component);
    });
}
