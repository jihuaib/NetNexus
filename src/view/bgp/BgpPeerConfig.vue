<template>
    <div class="mt-container bgp-peer-page" data-testid="bgp-peer-page">
        <!-- 邻居配置 Card -->
        <a-card title="邻居配置" class="bgp-peer-config-card">
            <a-tabs v-model:active-key="activeConfigTabKey">
                <a-tab-pane :key="IP_TYPE.IPV4" tab="IPv4邻居">
                    <a-form
                        :model="ipv4PeerConfigData"
                        :label-col="labelCol"
                        :wrapper-col="wrapperCol"
                        @finish="configIpv4Peer"
                    >
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="Peer IP" name="peerIp">
                                    <a-tooltip
                                        :title="ipv4PeerConfigvalidationErrors.peerIp"
                                        :open="!!ipv4PeerConfigvalidationErrors.peerIp"
                                    >
                                        <a-input
                                            v-model:value="ipv4PeerConfigData.peerIp"
                                            data-testid="bgp-ipv4-peer-ip-input"
                                            :status="ipv4PeerConfigvalidationErrors.peerIp ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="Peer AS" name="peerAs">
                                    <a-tooltip
                                        :title="ipv4PeerConfigvalidationErrors.peerAs"
                                        :open="!!ipv4PeerConfigvalidationErrors.peerAs"
                                    >
                                        <a-input
                                            v-model:value="ipv4PeerConfigData.peerAs"
                                            data-testid="bgp-ipv4-peer-as-input"
                                            :status="ipv4PeerConfigvalidationErrors.peerAs ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="Hold Time" name="holdTime">
                                    <a-tooltip
                                        :title="ipv4PeerConfigvalidationErrors.holdTime"
                                        :open="!!ipv4PeerConfigvalidationErrors.holdTime"
                                    >
                                        <a-input
                                            v-model:value="ipv4PeerConfigData.holdTime"
                                            data-testid="bgp-ipv4-peer-hold-time-input"
                                            :status="ipv4PeerConfigvalidationErrors.holdTime ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="Open Cap" name="openCap">
                                    <a-space>
                                        <a-checkbox-group
                                            v-model:value="ipv4PeerConfigData.openCap"
                                            :options="ipv4OpenCapOptions"
                                        />
                                        <a-button type="link" @click="showCustomOpenCap">
                                            <template #icon><SettingOutlined /></template>
                                            配置自定义能力
                                        </a-button>
                                    </a-space>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="12">
                                <a-form-item label="Addr Family" name="addressFamily">
                                    <a-select
                                        v-model:value="ipv4PeerConfigData.addressFamily"
                                        mode="multiple"
                                        style="width: 100%"
                                        :options="addressFamilyOptions"
                                    />
                                </a-form-item>
                            </a-col>
                            <a-col :span="12">
                                <a-form-item label="Role" name="role">
                                    <a-select
                                        v-model:value="ipv4PeerConfigData.role"
                                        style="width: 100%"
                                        :options="roleOptions"
                                        :disabled="!ipv4PeerConfigData.openCap.includes(BGP_OPEN_CAP_CODE.BGP_ROLE)"
                                    />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="24">
                                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                                    <a-space size="middle">
                                        <a-button
                                            data-testid="bgp-config-ipv4-peer-button"
                                            type="primary"
                                            html-type="submit"
                                        >
                                            配置IPv4邻居
                                        </a-button>
                                    </a-space>
                                </a-form-item>
                            </a-col>
                        </a-row>
                    </a-form>
                </a-tab-pane>
                <a-tab-pane :key="IP_TYPE.IPV6" tab="IPv6邻居">
                    <a-form
                        :model="ipv6PeerConfigData"
                        :label-col="labelCol"
                        :wrapper-col="wrapperCol"
                        @finish="configIpv6Peer"
                    >
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="Peer IPv6" name="peerIpv6">
                                    <a-tooltip
                                        :title="ipv6PeerConfigvalidationErrors.peerIpv6"
                                        :open="!!ipv6PeerConfigvalidationErrors.peerIpv6"
                                    >
                                        <a-input
                                            v-model:value="ipv6PeerConfigData.peerIpv6"
                                            :status="ipv6PeerConfigvalidationErrors.peerIpv6 ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="Peer AS" name="peerIpv6As">
                                    <a-tooltip
                                        :title="ipv6PeerConfigvalidationErrors.peerIpv6As"
                                        :open="!!ipv6PeerConfigvalidationErrors.peerIpv6As"
                                    >
                                        <a-input
                                            v-model:value="ipv6PeerConfigData.peerIpv6As"
                                            :status="ipv6PeerConfigvalidationErrors.peerIpv6As ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="Hold Time" name="holdTimeIpv6">
                                    <a-tooltip
                                        :title="ipv6PeerConfigvalidationErrors.holdTimeIpv6"
                                        :open="!!ipv6PeerConfigvalidationErrors.holdTimeIpv6"
                                    >
                                        <a-input
                                            v-model:value="ipv6PeerConfigData.holdTimeIpv6"
                                            :status="ipv6PeerConfigvalidationErrors.holdTimeIpv6 ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="Open Cap" name="openCapIpv6">
                                    <a-space>
                                        <a-checkbox-group
                                            v-model:value="ipv6PeerConfigData.openCapIpv6"
                                            :options="ipv6OpenCapOptions"
                                        />
                                        <a-button type="link" @click="showCustomOpenCapIpv6">
                                            <template #icon><SettingOutlined /></template>
                                            配置自定义能力
                                        </a-button>
                                    </a-space>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="12">
                                <a-form-item label="Addr Family" name="addressFamilyIpv6">
                                    <a-select
                                        v-model:value="ipv6PeerConfigData.addressFamilyIpv6"
                                        mode="multiple"
                                        style="width: 100%"
                                        :options="addressFamilyOptionsIpv6"
                                    />
                                </a-form-item>
                            </a-col>
                            <a-col :span="12">
                                <a-form-item label="Role" name="roleIpv6">
                                    <a-select
                                        v-model:value="ipv6PeerConfigData.roleIpv6"
                                        style="width: 100%"
                                        :options="roleOptions"
                                        :disabled="!ipv6PeerConfigData.openCapIpv6.includes(BGP_OPEN_CAP_CODE.BGP_ROLE)"
                                    />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row>
                            <a-col :span="24">
                                <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                                    <a-space size="middle">
                                        <a-button type="primary" html-type="submit">配置IPv6邻居</a-button>
                                    </a-space>
                                </a-form-item>
                            </a-col>
                        </a-row>
                    </a-form>
                </a-tab-pane>
            </a-tabs>
        </a-card>

        <!-- 邻居信息 Card -->
        <a-row class="bgp-peer-info-row">
            <a-col :span="24">
                <a-card title="邻居信息" class="bgp-peer-info-card">
                    <div class="bgp-peer-info-content">
                        <a-tabs v-model:active-key="activePeerInfoTabKey" class="bgp-peer-info-tabs">
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV4_UNC" tab="IPv4-UNC邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv4-UNC邻居列表</span>
                                    <a-tag v-if="ipv4UncPeerList.length > 0" color="blue">
                                        {{ ipv4UncPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    data-testid="bgp-ipv4-unc-peer-table"
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv4UncPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV6_UNC" tab="IPv6-UNC邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv6-UNC邻居列表</span>
                                    <a-tag v-if="ipv6UncPeerList.length > 0" color="blue">
                                        {{ ipv6UncPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv6UncPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV4_MVPN" tab="IPv4-MVPN邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv4-MVPN邻居列表</span>
                                    <a-tag v-if="ipv4MvpnPeerList.length > 0" color="blue">
                                        {{ ipv4MvpnPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv4MvpnPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV6_MVPN" tab="IPv6-MVPN邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv6-MVPN邻居列表</span>
                                    <a-tag v-if="ipv6MvpnPeerList.length > 0" color="blue">
                                        {{ ipv6MvpnPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv6MvpnPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV4_QP" tab="IPv4-QP邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv4-QP邻居列表</span>
                                    <a-tag v-if="ipv4QpPeerList.length > 0" color="blue">
                                        {{ ipv4QpPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv4QpPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                            <a-tab-pane :key="BGP_ADDR_FAMILY.IPV6_QP" tab="IPv6-QP邻居">
                                <div class="bgp-peer-info-header">
                                    <UnorderedListOutlined />
                                    <span class="bgp-peer-info-header-text">IPv6-QP邻居列表</span>
                                    <a-tag v-if="ipv6QpPeerList.length > 0" color="blue">
                                        {{ ipv6QpPeerList.length }}
                                    </a-tag>
                                </div>
                                <a-table
                                    :columns="PeerInfoColumns"
                                    :data-source="ipv6QpPeerList"
                                    :row-key="
                                        record =>
                                            `${record.vrfIndex || ''}-${record.peerIp || ''}-${record.addressFamily || ''}`
                                    "
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :scroll="{ y: '100%' }"
                                    size="small"
                                    class="bgp-peer-table"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'action'">
                                            <a-button type="primary" danger size="small" @click="deletePeer(record)">
                                                <template #icon><DeleteOutlined /></template>
                                                删除
                                            </a-button>
                                        </template>
                                    </template>
                                </a-table>
                            </a-tab-pane>
                        </a-tabs>
                    </div>
                </a-card>
            </a-col>
        </a-row>

        <!-- Custom Open Cap Drawers -->
        <CustomPktDrawer
            v-model:open="customOpenCapVisible"
            v-model:input-value="ipv4PeerConfigData.openCapCustom"
            @submit="handleCustomOpenCapSubmit"
        />
        <CustomPktDrawer
            v-model:open="customOpenCapIpv6Visible"
            v-model:input-value="ipv6PeerConfigData.openCapCustomIpv6"
            @submit="handleCustomOpenCapIpv6Submit"
        />
    </div>
</template>

<script setup>
    import { onActivated, ref, onDeactivated, watch, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import {
        BGP_ADDR_FAMILY,
        BGP_PEER_TYPE,
        BGP_EVENT_PAGE_ID,
        BGP_OPEN_CAP_CODE,
        BGP_ROLE_TYPE,
        DEFAULT_VALUES,
        IP_TYPE
    } from '../../const/bgpConst';
    import UnorderedListOutlined from '@ant-design/icons-vue/es/icons/UnorderedListOutlined';
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import SettingOutlined from '@ant-design/icons-vue/es/icons/SettingOutlined';
    import EventBus from '../../utils/eventBus';
    import CustomPktDrawer from '../../components/CustomPktDrawer.vue';
    import {
        FormValidator,
        createBgpPeerIpv4ConfigValidationRules,
        createBgpPeerIpv6ConfigValidationRules
    } from '../../utils/validationCommon';

    defineOptions({
        name: 'BgpPeerConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    // Configuration options
    const ipv4OpenCapOptions = [
        { label: 'Addr Family', value: BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, disabled: true },
        { label: 'Route-Refresh', value: BGP_OPEN_CAP_CODE.ROUTE_REFRESH },
        { label: 'AS4', value: BGP_OPEN_CAP_CODE.FOUR_OCTET_AS },
        { label: 'Role', value: BGP_OPEN_CAP_CODE.BGP_ROLE }
    ];

    const ipv6OpenCapOptions = [
        { label: 'Addr Family', value: BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS, disabled: true },
        { label: 'Route-Refresh', value: BGP_OPEN_CAP_CODE.ROUTE_REFRESH },
        { label: 'AS4', value: BGP_OPEN_CAP_CODE.FOUR_OCTET_AS },
        { label: 'Role', value: BGP_OPEN_CAP_CODE.BGP_ROLE },
        { label: 'Extended Next Hop Encoding', value: BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING }
    ];

    const roleOptions = [
        { label: 'Provider', value: BGP_ROLE_TYPE.ROLE_PROVIDER },
        { label: 'ROLE_RS', value: BGP_ROLE_TYPE.ROLE_RS },
        { label: 'ROLE_RS-Client', value: BGP_ROLE_TYPE.ROLE_RS_CLIENT },
        { label: 'Customer', value: BGP_ROLE_TYPE.ROLE_RS_CUSTOMER },
        { label: 'Lateral Peer', value: BGP_ROLE_TYPE.ROLE_PEER }
    ];

    const addressFamilyOptions = [
        { label: 'Ipv4-UNC', value: BGP_ADDR_FAMILY.IPV4_UNC, disabled: true },
        { label: 'Ipv6-UNC', value: BGP_ADDR_FAMILY.IPV6_UNC },
        { label: 'IPv4-MVPN', value: BGP_ADDR_FAMILY.IPV4_MVPN },
        { label: 'IPv6-MVPN', value: BGP_ADDR_FAMILY.IPV6_MVPN },
        { label: 'IPv4-QP', value: BGP_ADDR_FAMILY.IPV4_QP },
        { label: 'IPv6-QP', value: BGP_ADDR_FAMILY.IPV6_QP }
    ];

    const addressFamilyOptionsIpv6 = [
        { label: 'Ipv4-UNC', value: BGP_ADDR_FAMILY.IPV4_UNC },
        { label: 'Ipv6-UNC', value: BGP_ADDR_FAMILY.IPV6_UNC, disabled: true },
        { label: 'IPv4-MVPN', value: BGP_ADDR_FAMILY.IPV4_MVPN },
        { label: 'IPv6-MVPN', value: BGP_ADDR_FAMILY.IPV6_MVPN },
        { label: 'IPv4-QP', value: BGP_ADDR_FAMILY.IPV4_QP },
        { label: 'IPv6-QP', value: BGP_ADDR_FAMILY.IPV6_QP }
    ];

    // Peer configuration data
    const activeConfigTabKey = ref(IP_TYPE.IPV4);
    const ipv4PeerConfigData = ref({
        peerIp: DEFAULT_VALUES.PEER_IP,
        peerAs: DEFAULT_VALUES.PEER_AS,
        holdTime: DEFAULT_VALUES.HOLD_TIME,
        openCap: DEFAULT_VALUES.DEFAULT_OPEN_CAP,
        addressFamily: DEFAULT_VALUES.DEFAULT_ADDRESS_FAMILY,
        role: '',
        openCapCustom: ''
    });

    const ipv6PeerConfigData = ref({
        peerIpv6: DEFAULT_VALUES.PEER_IPV6,
        peerIpv6As: DEFAULT_VALUES.PEER_IPV6_AS,
        holdTimeIpv6: DEFAULT_VALUES.HOLD_TIME_IPV6,
        openCapIpv6: DEFAULT_VALUES.DEFAULT_OPEN_CAP_IPV6,
        addressFamilyIpv6: DEFAULT_VALUES.DEFAULT_ADDRESS_FAMILY_IPV6,
        roleIpv6: '',
        openCapCustomIpv6: ''
    });

    // Validation
    const ipv4PeerConfigvalidationErrors = ref({
        peerIp: '',
        peerAs: '',
        holdTime: ''
    });

    const ipv6PeerConfigvalidationErrors = ref({
        peerIpv6: '',
        peerIpv6As: '',
        holdTimeIpv6: ''
    });

    let ipv4PeerValidator = new FormValidator(ipv4PeerConfigvalidationErrors);
    ipv4PeerValidator.addRules(createBgpPeerIpv4ConfigValidationRules());

    let ipv6PeerValidator = new FormValidator(ipv6PeerConfigvalidationErrors);
    ipv6PeerValidator.addRules(createBgpPeerIpv6ConfigValidationRules());

    // Custom Open Cap
    const customOpenCapVisible = ref(false);
    const showCustomOpenCap = () => {
        customOpenCapVisible.value = true;
    };

    const handleCustomOpenCapSubmit = data => {
        ipv4PeerConfigData.value.openCapCustom = data;
    };

    const customOpenCapIpv6Visible = ref(false);
    const showCustomOpenCapIpv6 = () => {
        customOpenCapIpv6Visible.value = true;
    };

    const handleCustomOpenCapIpv6Submit = data => {
        ipv6PeerConfigData.value.openCapCustomIpv6 = data;
    };

    // Watch for role changes
    watch(
        () => ipv4PeerConfigData.value.openCap,
        newValue => {
            if (!newValue.includes(BGP_OPEN_CAP_CODE.BGP_ROLE)) {
                ipv4PeerConfigData.value.role = '';
            } else {
                if (ipv4PeerConfigData.value.role === '') {
                    ipv4PeerConfigData.value.role = BGP_ROLE_TYPE.ROLE_PROVIDER;
                }
            }
        },
        { deep: true }
    );

    watch(
        () => ipv6PeerConfigData.value.openCapIpv6,
        newValue => {
            if (!newValue.includes(BGP_OPEN_CAP_CODE.BGP_ROLE)) {
                ipv6PeerConfigData.value.roleIpv6 = '';
            } else {
                if (ipv6PeerConfigData.value.roleIpv6 === '') {
                    ipv6PeerConfigData.value.roleIpv6 = BGP_ROLE_TYPE.ROLE_PROVIDER;
                }
            }
        },
        { deep: true }
    );

    // Configuration methods
    const configIpv4Peer = async () => {
        const hasErrors = ipv4PeerValidator.validate(ipv4PeerConfigData.value);
        if (hasErrors) {
            message.error('请检查IPv4 Peer配置信息是否正确');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(ipv4PeerConfigData.value));
            const saveResult = await window.bgpApi.saveIpv4PeerConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.configIpv4Peer(payload);
            if (result.status === 'success') {
                message.success(result.msg);
                await refreshPeerInfo();
            } else {
                message.error(result.msg || 'IPv4 Peer配置失败');
            }
        } catch (e) {
            message.error(e);
        }
    };

    const configIpv6Peer = async () => {
        const hasErrors = ipv6PeerValidator.validate(ipv6PeerConfigData.value);
        if (hasErrors) {
            message.error('请检查IPv6 Peer配置信息是否正确');
            return;
        }

        try {
            const payload = JSON.parse(JSON.stringify(ipv6PeerConfigData.value));
            const saveResult = await window.bgpApi.saveIpv6PeerConfig(payload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            const result = await window.bgpApi.configIpv6Peer(payload);
            if (result.status === 'success') {
                message.success(result.msg);
                await refreshPeerInfo();
            } else {
                message.error(result.msg || 'IPv6 Peer配置失败');
            }
        } catch (e) {
            message.error(e);
        }
    };

    // Peer info display
    const ipv4UncPeerList = ref([]);
    const ipv6UncPeerList = ref([]);
    const ipv4MvpnPeerList = ref([]);
    const ipv6MvpnPeerList = ref([]);
    const ipv4QpPeerList = ref([]);
    const ipv6QpPeerList = ref([]);
    const activePeerInfoTabKey = ref(BGP_ADDR_FAMILY.IPV4_UNC);
    const PeerInfoColumns = [
        {
            title: 'Local IP',
            dataIndex: 'localIp',
            ellipsis: true
        },
        {
            title: 'Local AS',
            dataIndex: 'localAs',
            ellipsis: true
        },
        {
            title: 'Peer IP',
            dataIndex: 'peerIp',
            key: 'peerIp',
            ellipsis: true
        },
        {
            title: 'Peer AS',
            dataIndex: 'peerAs',
            ellipsis: true
        },
        {
            title: 'Peer Type',
            dataIndex: 'peerType',
            ellipsis: true,
            customRender: ({ text }) => {
                if (text === BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                    return 'IBGP';
                } else if (text === BGP_PEER_TYPE.PEER_TYPE_EBGP) {
                    return 'EBGP';
                } else {
                    return 'UNKNOWN';
                }
            }
        },
        {
            title: 'Router ID',
            dataIndex: 'routerId',
            ellipsis: true
        },
        {
            title: 'Peer State',
            dataIndex: 'peerState',
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const onPeerChange = result => {
        const data = result.data;
        if (result.status === 'success') {
            // 根据地址族类型更新对应的表格数据
            if (data.addressFamily === BGP_ADDR_FAMILY.IPV4_UNC) {
                const index = ipv4UncPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv4UncPeerList.value[index] = { ...ipv4UncPeerList.value[index], ...data };
                }
            } else if (data.addressFamily === BGP_ADDR_FAMILY.IPV6_UNC) {
                const index = ipv6UncPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv6UncPeerList.value[index] = { ...ipv6UncPeerList.value[index], ...data };
                }
            } else if (data.addressFamily === BGP_ADDR_FAMILY.IPV4_MVPN) {
                const index = ipv4MvpnPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv4MvpnPeerList.value[index] = { ...ipv4MvpnPeerList.value[index], ...data };
                }
            } else if (data.addressFamily === BGP_ADDR_FAMILY.IPV6_MVPN) {
                const index = ipv6MvpnPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv6MvpnPeerList.value[index] = { ...ipv6MvpnPeerList.value[index], ...data };
                }
            } else if (data.addressFamily === BGP_ADDR_FAMILY.IPV4_QP) {
                const index = ipv4QpPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv4QpPeerList.value[index] = { ...ipv4QpPeerList.value[index], ...data };
                }
            } else if (data.addressFamily === BGP_ADDR_FAMILY.IPV6_QP) {
                const index = ipv6QpPeerList.value.findIndex(
                    peer =>
                        `${peer.vrfIndex || ''}-${peer.peerIp || ''}-${peer.addressFamily || ''}` ===
                        `${data.vrfIndex || ''}-${data.peerIp || ''}-${data.addressFamily || ''}`
                );
                if (index !== -1) {
                    ipv6QpPeerList.value[index] = { ...ipv6QpPeerList.value[index], ...data };
                }
            }
        } else {
            message.error(data.msg);
        }
    };

    const refreshPeerInfo = async () => {
        const peerInfo = await window.bgpApi.getPeerInfo();
        if (peerInfo.status === 'success') {
            // 处理 IPv4-UNC 邻居信息
            ipv4UncPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV4_UNC])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV4_UNC]]
                : [];

            // 处理 IPv6-UNC 邻居信息
            ipv6UncPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV6_UNC])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV6_UNC]]
                : [];

            // 处理 IPv4-MVPN 邻居信息
            ipv4MvpnPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV4_MVPN])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV4_MVPN]]
                : [];

            // 处理 IPv6-MVPN 邻居信息
            ipv6MvpnPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV6_MVPN])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV6_MVPN]]
                : [];

            // 处理 IPv4-QP 邻居信息
            ipv4QpPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV4_QP])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV4_QP]]
                : [];

            // 处理 IPv6-QP 邻居信息
            ipv6QpPeerList.value = Array.isArray(peerInfo.data[BGP_ADDR_FAMILY.IPV6_QP])
                ? [...peerInfo.data[BGP_ADDR_FAMILY.IPV6_QP]]
                : [];
        } else {
            console.error(peerInfo.msg || 'Peer信息查询失败');
            ipv4UncPeerList.value = [];
            ipv6UncPeerList.value = [];
            ipv4MvpnPeerList.value = [];
            ipv6MvpnPeerList.value = [];
            ipv4QpPeerList.value = [];
            ipv6QpPeerList.value = [];
        }
    };

    const deletePeer = async record => {
        const payload = JSON.parse(JSON.stringify(record));
        const result = await window.bgpApi.deletePeer(payload);
        if (result.status === 'success') {
            message.success(result.msg);
            await refreshPeerInfo();
        } else {
            message.error(result.msg || '删除Peer失败');
        }
    };

    // Load saved configurations
    const loadConfigurations = async () => {
        // Load IPv4 Peer config
        const savedIpv4PeerConfig = await window.bgpApi.loadIpv4PeerConfig();
        if (savedIpv4PeerConfig.status === 'success' && savedIpv4PeerConfig.data) {
            ipv4PeerConfigData.value.peerIp = savedIpv4PeerConfig.data.peerIp;
            ipv4PeerConfigData.value.peerAs = savedIpv4PeerConfig.data.peerAs;
            ipv4PeerConfigData.value.holdTime = savedIpv4PeerConfig.data.holdTime;
            ipv4PeerConfigData.value.openCap = Array.isArray(savedIpv4PeerConfig.data.openCap)
                ? [...savedIpv4PeerConfig.data.openCap]
                : [];
            ipv4PeerConfigData.value.addressFamily = Array.isArray(savedIpv4PeerConfig.data.addressFamily)
                ? [...savedIpv4PeerConfig.data.addressFamily]
                : [];
            ipv4PeerConfigData.value.role = savedIpv4PeerConfig.data.role || '';
            ipv4PeerConfigData.value.openCapCustom = savedIpv4PeerConfig.data.openCapCustom || '';
        }

        // Load IPv6 Peer config
        const savedIpv6PeerConfig = await window.bgpApi.loadIpv6PeerConfig();
        if (savedIpv6PeerConfig.status === 'success' && savedIpv6PeerConfig.data) {
            ipv6PeerConfigData.value.peerIpv6 = savedIpv6PeerConfig.data.peerIpv6;
            ipv6PeerConfigData.value.peerIpv6As = savedIpv6PeerConfig.data.peerIpv6As;
            ipv6PeerConfigData.value.holdTimeIpv6 = savedIpv6PeerConfig.data.holdTimeIpv6;
            ipv6PeerConfigData.value.openCapIpv6 = Array.isArray(savedIpv6PeerConfig.data.openCapIpv6)
                ? [...savedIpv6PeerConfig.data.openCapIpv6]
                : [];
            ipv6PeerConfigData.value.addressFamilyIpv6 = Array.isArray(savedIpv6PeerConfig.data.addressFamilyIpv6)
                ? [...savedIpv6PeerConfig.data.addressFamilyIpv6]
                : [];
            ipv6PeerConfigData.value.roleIpv6 = savedIpv6PeerConfig.data.roleIpv6 || '';
            ipv6PeerConfigData.value.openCapCustomIpv6 = savedIpv6PeerConfig.data.openCapCustomIpv6 || '';
        }
    };

    onMounted(async () => {
        await loadConfigurations();
    });

    onDeactivated(() => {
        EventBus.off('bgp:peerChange', BGP_EVENT_PAGE_ID.PAGE_ID_BGP_PEER_INFO);
    });

    onActivated(async () => {
        EventBus.on('bgp:peerChange', BGP_EVENT_PAGE_ID.PAGE_ID_BGP_PEER_INFO, onPeerChange);
        await refreshPeerInfo();
    });
</script>

<style scoped>
    .bgp-peer-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .bgp-peer-config-card {
        flex: 0 0 auto;
    }

    .bgp-peer-info-row {
        flex: 1 1 0;
        min-height: 0;
        margin-top: 0;
    }

    .bgp-peer-info-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .bgp-peer-info-card {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-peer-info-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .bgp-peer-info-content,
    .bgp-peer-info-tabs {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-peer-info-tabs :deep(.ant-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .bgp-peer-info-tabs :deep(.ant-tabs-content-holder),
    .bgp-peer-info-tabs :deep(.ant-tabs-content),
    .bgp-peer-info-tabs :deep(.ant-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-peer-info-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding: 8px;
        background-color: #f5f5f5;
        border-radius: 4px;
    }

    .bgp-peer-info-header-text {
        margin-right: 8px;
        font-weight: 500;
    }

    .bgp-peer-table,
    .bgp-peer-table :deep(.ant-spin-nested-loading),
    .bgp-peer-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .bgp-peer-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .bgp-peer-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bgp-peer-table :deep(.ant-table-container),
    .bgp-peer-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .bgp-peer-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .bgp-peer-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .bgp-peer-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .bgp-peer-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
