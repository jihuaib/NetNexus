<template>
    <div class="nn-container adaptive-list-page" data-testid="bmp-config-page">
        <nn-row class="adaptive-form-row">
            <nn-col :span="24">
                <nn-card title="BMP服务器配置">
                    <nn-alert
                        v-if="runtimeFailureMessage"
                        type="error"
                        message="BMP服务已安全停止"
                        :description="runtimeFailureMessage"
                        show-icon
                        variant="subtle"
                        data-testid="bmp-runtime-failure"
                        class="bmp-runtime-alert"
                    />
                    <nn-form :model="bmpConfig" :label-col="labelCol" :wrapper-col="wrapperCol" @finish="startBmp">
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="服务端端口" name="port">
                                    <nn-tooltip :title="validationErrors.port" :open="!!validationErrors.port">
                                        <nn-input
                                            v-model:value="bmpConfig.port"
                                            data-testid="bmp-port-input"
                                            :status="validationErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="认证方式" name="authType">
                                    <nn-radio-group
                                        v-model:value="bmpConfig.authType"
                                        aria-label="BMP认证方式"
                                        data-testid="bmp-auth-type-group"
                                        @change="clearAuthenticationError"
                                    >
                                        <nn-radio value="none">无认证</nn-radio>
                                        <nn-radio value="tcp-ao">TCP-AO（强制双向认证）</nn-radio>
                                    </nn-radio-group>
                                    <div class="nn-helper-text">
                                        TCP-AO 仅在支持该能力的 Linux 内核上生效。启用后只接受所选对端，且不会回退到普通
                                        TCP。
                                    </div>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row v-if="bmpConfig.authType === BMP_AUTH_TYPE.TCP_AO">
                            <nn-col :span="24">
                                <nn-form-item label="TCP-AO 对端" name="tcpAoProfileIds">
                                    <template v-if="tcpAoProfileOptions.length > 0">
                                        <nn-alert
                                            v-if="!tcpAoProfileOptions.some(profile => profile.available)"
                                            type="warning"
                                            message="当前没有可用的 TCP-AO Profile"
                                            description="请检查已保存密钥及发送有效期；下方列表会标明每个 Profile 的不可用原因。"
                                            show-icon
                                            variant="subtle"
                                            data-testid="bmp-tcp-ao-profile-unavailable"
                                            class="tcp-ao-profile-alert"
                                        />
                                        <nn-tooltip
                                            :title="validationErrors.tcpAoProfileIds"
                                            :open="!!validationErrors.tcpAoProfileIds"
                                        >
                                            <nn-select
                                                v-model:value="bmpConfig.tcpAoProfileIds"
                                                mode="multiple"
                                                aria-label="BMP TCP-AO 对端 Profile"
                                                data-testid="bmp-tcp-ao-profile-select"
                                                :loading="tcpAoProfilesLoading"
                                                :status="validationErrors.tcpAoProfileIds ? 'error' : ''"
                                                placeholder="请选择允许连接的对端 Profile"
                                                style="width: min(720px, 100%)"
                                                @change="clearAuthenticationError"
                                            >
                                                <nn-select-option
                                                    v-for="profile in tcpAoProfileOptions"
                                                    :key="profile.id"
                                                    :value="profile.id"
                                                    :disabled="!profile.available"
                                                >
                                                    {{ profile.name }} · {{ profile.peer }} ·
                                                    {{
                                                        profile.available
                                                            ? profile.keySummary
                                                            : profile.unavailableReason
                                                    }}
                                                </nn-select-option>
                                            </nn-select>
                                        </nn-tooltip>
                                        <div v-if="selectedTcpAoProfileSummary" class="tcp-ao-profile-summary">
                                            <nn-tag color="green">
                                                已选择 {{ selectedTcpAoProfiles.length }} 个对端范围
                                            </nn-tag>
                                            <span>{{ selectedTcpAoProfileSummary }}</span>
                                        </div>
                                        <div
                                            v-if="tcpAoSelectionWarning"
                                            class="tcp-ao-selection-warning"
                                            role="alert"
                                            data-testid="bmp-tcp-ao-selection-warning"
                                        >
                                            {{ tcpAoSelectionWarning }}
                                        </div>
                                    </template>
                                    <nn-alert
                                        v-else-if="!tcpAoProfilesLoading"
                                        type="warning"
                                        message="尚无 TCP-AO Profile"
                                        description="请先在设置中添加 Profile 并保存密钥，然后返回此处选择。"
                                        show-icon
                                        variant="subtle"
                                        data-testid="bmp-tcp-ao-profile-empty"
                                        class="tcp-ao-profile-alert"
                                    />
                                    <nn-button
                                        type="link"
                                        data-testid="bmp-open-tcp-ao-settings"
                                        class="tcp-ao-settings-link"
                                        @click="openTcpAoSettings"
                                    >
                                        前往 TCP-AO 设置
                                    </nn-button>
                                    <div class="nn-helper-text">
                                        每个 Profile 的地址或前缀是允许连接的对端范围；同一 BMP 监听器所选范围不能重叠。
                                        对端发送 Key ID 应与本端配置的 RcvID 一致。
                                    </div>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row :gutter="12">
                            <nn-col :span="12">
                                <nn-form-item label="v4 TLV格式" name="bmpV4TlvDraft">
                                    <nn-radio-group v-model:value="bmpConfig.bmpV4TlvDraft" button-style="solid">
                                        <nn-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_20">draft-20</nn-radio-button>
                                        <nn-radio-button :value="BMP_V4_TLV_DRAFT.DRAFT_19">draft-19</nn-radio-button>
                                    </nn-radio-group>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="12">
                                <nn-form-item label="Path TLV类型" name="pathMarkingTlvType">
                                    <nn-tooltip
                                        :title="validationErrors.pathMarkingTlvType"
                                        :open="!!validationErrors.pathMarkingTlvType"
                                    >
                                        <nn-input-number
                                            v-model:value="bmpConfig.pathMarkingTlvType"
                                            :min="1"
                                            :max="16383"
                                            :precision="0"
                                            style="width: 100%"
                                            :status="validationErrors.pathMarkingTlvType ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <nn-row>
                            <nn-col :span="24">
                                <nn-form-item label="持久化路由" name="persistenceEnabled">
                                    <nn-checkbox v-model:checked="bmpConfig.persistenceEnabled" disabled>
                                        SQLite RIB
                                    </nn-checkbox>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <nn-space>
                                <nn-button
                                    type="primary"
                                    html-type="submit"
                                    data-testid="bmp-start-button"
                                    :loading="serverLoading"
                                    :disabled="serverRunning || serverStopping"
                                >
                                    启动服务器
                                </nn-button>
                                <nn-button
                                    type="primary"
                                    danger
                                    data-testid="bmp-stop-button"
                                    :loading="serverStopping"
                                    :disabled="!serverRunning || serverStopping"
                                    @click="stopBmp"
                                >
                                    停止服务器
                                </nn-button>
                            </nn-space>
                        </nn-form-item>
                    </nn-form>
                </nn-card>
            </nn-col>
        </nn-row>

        <!-- BMP客户端列表 -->
        <nn-row class="adaptive-list-row">
            <nn-col :span="24">
                <nn-card title="BMP客户端列表" class="adaptive-list-card">
                    <div>
                        <nn-table
                            class="adaptive-table"
                            data-testid="bmp-client-table"
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="getClientKey"
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ x: 'max-content', y: '100%' }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'bmpVersion'">
                                    <nn-tag :color="record.bmpVersion === 4 ? 'blue' : 'default'">
                                        {{ getBmpVersionName(record.bmpVersion) }}
                                    </nn-tag>
                                </template>
                                <template v-else-if="column.key === 'bmpV4TlvDraft'">
                                    <nn-tag>{{ getBmpV4TlvDraftName(record.bmpV4TlvDraft) }}</nn-tag>
                                </template>
                                <template v-else-if="column.key === 'tlvCount'">
                                    {{ getClientTlvCount(record) }}
                                </template>
                                <template v-else-if="column.key === 'authentication'">
                                    <nn-tooltip :title="getClientAuthenticationDescription(record)">
                                        <nn-tag :color="isTcpAoClient(record) ? 'green' : 'default'">
                                            {{ getClientAuthenticationName(record) }}
                                        </nn-tag>
                                    </nn-tooltip>
                                </template>
                                <template v-else-if="column.key === 'connectionState'">
                                    <nn-tag :color="record.isOnline ? 'green' : 'default'">
                                        {{ record.isOnline ? '在线' : '已断开' }}
                                    </nn-tag>
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <nn-space size="small">
                                        <nn-button
                                            type="link"
                                            data-testid="bmp-client-monitor-button"
                                            :loading="isMonitorOpening(record)"
                                            :disabled="!canOpenClientMonitor(record)"
                                            @click="openClientMonitor(record)"
                                        >
                                            Client 监控
                                        </nn-button>
                                        <nn-button
                                            type="link"
                                            data-testid="bmp-client-detail-button"
                                            @click="viewClientDetails(record)"
                                        >
                                            详情
                                        </nn-button>
                                        <nn-tooltip :title="getClientDeleteDisabledReason(record)">
                                            <span>
                                                <nn-popconfirm
                                                    title="确认删除该客户端的全部数据？"
                                                    description="将删除数据库和内存中的所有关联数据，此操作不可恢复。"
                                                    ok-text="确认删除"
                                                    cancel-text="取消"
                                                    :disabled="!canDeleteClientData(record)"
                                                    @confirm="deleteClientData(record)"
                                                >
                                                    <nn-button
                                                        type="link"
                                                        danger
                                                        data-testid="bmp-client-delete-data-button"
                                                        :loading="deletingClientKey === getClientKey(record)"
                                                        :disabled="
                                                            !canDeleteClientData(record) ||
                                                            deletingClientKey === getClientKey(record)
                                                        "
                                                    >
                                                        删除数据
                                                    </nn-button>
                                                </nn-popconfirm>
                                            </span>
                                        </nn-tooltip>
                                    </nn-space>
                                </template>
                            </template>
                        </nn-table>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="500px"
            @close="closeDetailsDrawer"
        >
            <nn-json-viewer v-if="currentDetails" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount, watch } from 'vue';
    import ipaddr from 'ipaddr.js';
    import { notify } from '../../utils/notify';
    import { FormValidator, createBmpConfigValidationRules } from '../../utils/validationCommon';
    import {
        DEFAULT_VALUES,
        BMP_EVENT_PAGE_ID,
        BMP_V4_TLV_DRAFT,
        getBmpVersionName,
        getBmpV4TlvDraftName,
        getDefaultPathMarkingTlvType
    } from '../../const/bmpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'BmpConfig'
    });

    const emit = defineEmits(['open-settings']);

    const BMP_AUTH_TYPE = Object.freeze({
        NONE: 'none',
        TCP_AO: 'tcp-ao'
    });
    const BMP_RUNTIME_CHANGED_EVENT = 'bmp:runtimeChanged';
    const TCP_AO_SETTINGS_CHANGED_EVENT = 'rpki:tcpAoSettingsChanged';
    const TCP_AO_SETTINGS_LISTENER_ID = 'bmp-config-tcp-ao-settings';
    const MAX_TCP_AO_PROFILE_COUNT = 32;

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const bmpConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_BMP_PORT,
        bmpV4TlvDraft: DEFAULT_VALUES.DEFAULT_BMP_V4_TLV_DRAFT,
        pathMarkingTlvType: getDefaultPathMarkingTlvType(DEFAULT_VALUES.DEFAULT_BMP_V4_TLV_DRAFT),
        persistenceEnabled: true,
        authType: BMP_AUTH_TYPE.NONE,
        tcpAoProfileIds: []
    });

    const tcpAoProfiles = ref([]);
    const tcpAoProfilesLoading = ref(false);
    const currentTimeMs = ref(Date.now());

    const normalizeTcpAoTimestamp = value => {
        if (value === '' || value === null || value === undefined || value === 0 || value === '0') return null;
        if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
            const numeric = Number(value);
            return numeric > 10_000_000_000 ? numeric : numeric * 1000;
        }
        const timestamp = Date.parse(String(value));
        return Number.isNaN(timestamp) ? Number.NaN : timestamp;
    };

    const sanitizeTcpAoKey = keyItem => ({
        id: String(keyItem?.id || ''),
        algorithm: String(keyItem?.algorithm || ''),
        sndId: Number(keyItem?.sndId),
        rcvId: Number(keyItem?.rcvId),
        hasSavedKey: keyItem?.hasSavedKey === true && keyItem?.savedKeyStatus !== 'unavailable',
        sendStart: normalizeTcpAoTimestamp(keyItem?.sendStart),
        sendEnd: normalizeTcpAoTimestamp(keyItem?.sendEnd)
    });

    const sanitizeTcpAoProfile = profile => ({
        id: String(profile?.id || ''),
        name: String(profile?.name || profile?.id || ''),
        peer: String(profile?.peer || ''),
        keys: (Array.isArray(profile?.keys) ? profile.keys : []).map(sanitizeTcpAoKey)
    });

    const isKeyCurrentlySendable = (keyItem, now = Date.now()) =>
        keyItem.hasSavedKey &&
        !Number.isNaN(keyItem.sendStart) &&
        !Number.isNaN(keyItem.sendEnd) &&
        (keyItem.sendStart === null || keyItem.sendStart <= now) &&
        (keyItem.sendEnd === null || now < keyItem.sendEnd);

    const getTcpAoProfileAvailability = profile => {
        if (profile.keys.length === 0) {
            return { available: false, unavailableReason: '没有密钥', currentSendKey: null };
        }
        if (!profile.keys.every(keyItem => keyItem.hasSavedKey)) {
            return { available: false, unavailableReason: '存在未保存或不可用的密钥', currentSendKey: null };
        }
        if (profile.keys.some(keyItem => Number.isNaN(keyItem.sendStart) || Number.isNaN(keyItem.sendEnd))) {
            return { available: false, unavailableReason: '密钥有效期无效', currentSendKey: null };
        }

        const currentSendKeys = profile.keys.filter(keyItem => isKeyCurrentlySendable(keyItem, currentTimeMs.value));
        if (currentSendKeys.length === 0) {
            return { available: false, unavailableReason: '当前没有可发送密钥', currentSendKey: null };
        }
        if (currentSendKeys.length > 1) {
            return { available: false, unavailableReason: '当前有多把发送密钥', currentSendKey: null };
        }
        return { available: true, unavailableReason: '', currentSendKey: currentSendKeys[0] };
    };

    const tcpAoProfileOptions = computed(() =>
        tcpAoProfiles.value.map(profile => {
            const availability = getTcpAoProfileAvailability(profile);
            return {
                ...profile,
                ...availability,
                keySummary: availability.currentSendKey
                    ? `本端 SndID ${availability.currentSendKey.sndId} / 期望对端 SndID ${availability.currentSendKey.rcvId} / ${profile.keys.length} 把密钥`
                    : ''
            };
        })
    );

    const selectedTcpAoProfiles = computed(() => {
        const selectedIds = Array.isArray(bmpConfig.value.tcpAoProfileIds) ? bmpConfig.value.tcpAoProfileIds : [];
        return selectedIds
            .map(profileId => tcpAoProfileOptions.value.find(profile => profile.id === String(profileId)))
            .filter(Boolean);
    });

    const parseTcpAoPeer = peer => {
        const text = String(peer || '').trim();
        if (!text) return null;
        try {
            const [address, prefixLength] = text.includes('/')
                ? ipaddr.parseCIDR(text)
                : [ipaddr.parse(text), ipaddr.parse(text).kind() === 'ipv4' ? 32 : 128];
            return { address, prefixLength, family: address.kind() };
        } catch {
            return null;
        }
    };

    const findOverlappingTcpAoProfiles = profiles => {
        const parsedProfiles = profiles
            .map(profile => ({ profile, peer: parseTcpAoPeer(profile.peer) }))
            .filter(item => item.peer);
        for (let leftIndex = 0; leftIndex < parsedProfiles.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < parsedProfiles.length; rightIndex += 1) {
                const left = parsedProfiles[leftIndex];
                const right = parsedProfiles[rightIndex];
                if (left.peer.family !== right.peer.family) continue;
                const prefixLength = Math.min(left.peer.prefixLength, right.peer.prefixLength);
                if (left.peer.address.match(right.peer.address, prefixLength)) {
                    return [left.profile, right.profile];
                }
            }
        }
        return null;
    };

    const selectedTcpAoProfileSummary = computed(() => {
        if (selectedTcpAoProfiles.value.length === 0) return '';
        let ipv4Count = 0;
        let ipv6Count = 0;
        selectedTcpAoProfiles.value.forEach(profile => {
            const peer = parseTcpAoPeer(profile.peer);
            if (peer?.family === 'ipv4') ipv4Count += 1;
            if (peer?.family === 'ipv6') ipv6Count += 1;
        });
        return `IPv4 ${ipv4Count} 个 / IPv6 ${ipv6Count} 个；所有连接均强制验证 TCP-AO`;
    });

    const tcpAoSelectionWarning = computed(() => {
        const selectedIds = Array.isArray(bmpConfig.value.tcpAoProfileIds) ? bmpConfig.value.tcpAoProfileIds : [];
        const missingIds = selectedIds.filter(
            profileId => !tcpAoProfileOptions.value.some(profile => profile.id === String(profileId))
        );
        if (missingIds.length > 0) return '部分所选 Profile 已被删除，请重新选择。';
        const unavailableProfiles = selectedTcpAoProfiles.value.filter(profile => !profile.available);
        if (unavailableProfiles.length > 0) {
            return `所选 Profile 当前不可用：${unavailableProfiles
                .map(profile => `${profile.name}（${profile.unavailableReason}）`)
                .join('、')}`;
        }
        const overlap = findOverlappingTcpAoProfiles(selectedTcpAoProfiles.value);
        return overlap ? `所选对端范围重叠：${overlap[0].name} 与 ${overlap[1].name}` : '';
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);
    const serverStopping = ref(false);
    const runtimeFailureMessage = ref('');

    const getClientTlvCount = record => {
        return (record.rawTlvs || []).length + (record.terminationTlvs || []).length;
    };

    const isTcpAoClient = record =>
        record?.authentication === BMP_AUTH_TYPE.TCP_AO || record?.transport === BMP_AUTH_TYPE.TCP_AO;

    const getClientAuthenticationName = record => {
        if (!isTcpAoClient(record)) return '无认证';
        const profileName = String(record?.tcpAoProfileName || '').trim();
        return profileName ? `TCP-AO · ${profileName}` : 'TCP-AO';
    };

    const getClientAuthenticationDescription = record => {
        if (!isTcpAoClient(record)) return '普通 TCP 连接';
        const peer = String(record?.tcpAoPeer || '').trim();
        const profileName = String(record?.tcpAoProfileName || record?.tcpAoProfileId || '').trim();
        return [profileName ? `Profile：${profileName}` : '', peer ? `允许的对端范围：${peer}` : '']
            .filter(Boolean)
            .join('；');
    };

    const getClientTransportKey = record =>
        `${record?.localIp || ''}|${record?.localPort || ''}|${record?.remoteIp || ''}|${record?.remotePort || ''}`;

    const getClientKey = record => {
        const sourceId = record?.persistentSourceId || record?.sourceId;
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(record)}`;
    };

    const normalizeBmpV4TlvDraft = draft => {
        return Number(draft) === BMP_V4_TLV_DRAFT.DRAFT_19 ? BMP_V4_TLV_DRAFT.DRAFT_19 : BMP_V4_TLV_DRAFT.DRAFT_20;
    };

    const normalizePathMarkingTlvType = (value, draft) => {
        const type = Number(value);
        return Number.isInteger(type) && type >= 1 && type <= 0x3fff ? type : getDefaultPathMarkingTlvType(draft);
    };

    // Initiation messages list
    const clientList = ref([]);
    const deletingClientKey = ref('');
    const openingMonitorKey = ref('');
    const canOpenMonitorWindow = computed(() => typeof window.windowApi?.openMonitor === 'function');
    const clientColumns = [
        {
            title: '客户端IP',
            dataIndex: 'remoteIp',
            key: 'remoteIp',
            ellipsis: true
        },
        {
            title: '客户端端口',
            dataIndex: 'remotePort',
            key: 'remotePort',
            ellipsis: true
        },
        {
            title: 'BMP版本',
            dataIndex: 'bmpVersion',
            key: 'bmpVersion',
            width: 90
        },
        {
            title: 'v4 TLV',
            dataIndex: 'bmpV4TlvDraft',
            key: 'bmpV4TlvDraft',
            width: 90
        },
        {
            title: '系统名称',
            dataIndex: 'sysName',
            key: 'sysName',
            ellipsis: true
        },
        {
            title: '系统描述',
            dataIndex: 'sysDesc',
            key: 'sysDesc',
            ellipsis: true
        },
        {
            title: '接收时间',
            dataIndex: 'receivedAt',
            key: 'receivedAt',
            ellipsis: true,
            customRender: ({ text }) => {
                if (!text) return '';
                const date = new Date(text);
                return date.toLocaleString();
            }
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 90,
            align: 'right'
        },
        {
            title: '认证',
            key: 'authentication',
            width: 180
        },
        {
            title: '状态',
            key: 'connectionState',
            width: 80,
            align: 'center'
        },
        {
            title: '操作',
            key: 'action',
            width: 280,
            align: 'center'
        }
    ];

    const validationErrors = ref({
        port: '',
        pathMarkingTlvType: '',
        tcpAoProfileIds: ''
    });

    let validator = new FormValidator(validationErrors);
    validator.addRules(createBmpConfigValidationRules());

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validator) {
                validator.clearErrors();
            }
        }
    });

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const normalizeAuthType = value => (value === BMP_AUTH_TYPE.TCP_AO ? BMP_AUTH_TYPE.TCP_AO : BMP_AUTH_TYPE.NONE);

    const normalizeTcpAoProfileIds = value => {
        const source = Array.isArray(value) ? value : value ? [value] : [];
        return source.map(profileId => String(profileId || '').trim()).filter(Boolean);
    };

    const applyTcpAoProfiles = source => {
        tcpAoProfiles.value = (Array.isArray(source) ? source : [])
            .slice(0, MAX_TCP_AO_PROFILE_COUNT)
            .map(sanitizeTcpAoProfile)
            .filter(profile => profile.id);
        clearAuthenticationError();
    };

    const loadTcpAoProfiles = async () => {
        tcpAoProfilesLoading.value = true;
        try {
            const settingsApi = [window.tcpAoApi, window.bmpApi, window.rpkiApi].find(
                api => typeof api?.loadTcpAoSettings === 'function'
            );
            if (!settingsApi) {
                applyTcpAoProfiles([]);
                return;
            }
            const result = await settingsApi.loadTcpAoSettings();
            if (result?.status === 'success') {
                applyTcpAoProfiles(result.data?.profiles);
            } else {
                applyTcpAoProfiles([]);
                console.error('TCP-AO配置加载失败', result?.msg);
            }
        } catch (error) {
            applyTcpAoProfiles([]);
            console.error('TCP-AO配置加载失败', error);
        } finally {
            tcpAoProfilesLoading.value = false;
        }
    };

    const clearAuthenticationError = () => {
        validationErrors.value.tcpAoProfileIds = '';
    };

    const validateAuthentication = () => {
        clearAuthenticationError();
        if (bmpConfig.value.authType !== BMP_AUTH_TYPE.TCP_AO) return false;

        const selectedIds = normalizeTcpAoProfileIds(bmpConfig.value.tcpAoProfileIds);
        if (selectedIds.length === 0) {
            validationErrors.value.tcpAoProfileIds = '请至少选择一个 TCP-AO 对端 Profile';
            return true;
        }
        if (selectedIds.length > MAX_TCP_AO_PROFILE_COUNT || new Set(selectedIds).size !== selectedIds.length) {
            validationErrors.value.tcpAoProfileIds = `请选择 1-${MAX_TCP_AO_PROFILE_COUNT} 个不重复的 Profile`;
            return true;
        }
        if (selectedTcpAoProfiles.value.length !== selectedIds.length) {
            validationErrors.value.tcpAoProfileIds = '部分所选 TCP-AO Profile 不存在，请重新选择';
            return true;
        }
        const unavailableProfiles = selectedTcpAoProfiles.value.filter(profile => !profile.available);
        if (unavailableProfiles.length > 0) {
            validationErrors.value.tcpAoProfileIds = `所选 Profile 当前不可用：${unavailableProfiles
                .map(profile => profile.name)
                .join('、')}`;
            return true;
        }
        const overlap = findOverlappingTcpAoProfiles(selectedTcpAoProfiles.value);
        if (overlap) {
            validationErrors.value.tcpAoProfileIds = `所选对端范围不能重叠：${overlap[0].name} 与 ${overlap[1].name}`;
            return true;
        }
        return false;
    };

    const buildConfigPayload = () => {
        const authType = normalizeAuthType(bmpConfig.value.authType);
        return {
            port: bmpConfig.value.port,
            bmpV4TlvDraft: normalizeBmpV4TlvDraft(bmpConfig.value.bmpV4TlvDraft),
            pathMarkingTlvType: normalizePathMarkingTlvType(
                bmpConfig.value.pathMarkingTlvType,
                bmpConfig.value.bmpV4TlvDraft
            ),
            persistenceEnabled: true,
            authType,
            tcpAoProfileIds:
                authType === BMP_AUTH_TYPE.TCP_AO ? normalizeTcpAoProfileIds(bmpConfig.value.tcpAoProfileIds) : []
        };
    };

    const openTcpAoSettings = () => {
        emit('open-settings', 'tcp-ao');
    };

    const startBmp = async () => {
        const hasConfigErrors = validator.validate(bmpConfig.value);
        const hasAuthenticationErrors = validateAuthentication();
        if (hasConfigErrors || hasAuthenticationErrors) {
            notify.error('请检查配置信息是否正确');
            return;
        }

        try {
            runtimeFailureMessage.value = '';
            // 启动和普通配置持久化只引用已保存的 Profile；密钥明文永不进入该 payload。
            const payload = buildConfigPayload();
            const saveResult = await window.bmpApi.saveBmpConfig(payload);
            if (saveResult.status !== 'success') {
                notify.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const result = await window.bmpApi.startBmp(payload);
            if (result.status === 'success') {
                serverRunning.value = true;
                await loadClientList();
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'BMP服务器启动失败');
            }
        } catch (error) {
            notify.error(`BMP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopBmp = async () => {
        if (serverStopping.value) {
            return;
        }

        serverStopping.value = true;
        try {
            const result = await window.bmpApi.stopBmp();
            if (result.status === 'success') {
                serverRunning.value = false;
                clearClientRuntimeState();
                runtimeFailureMessage.value = '';
                notify.success(`${result.msg}`);
            } else {
                notify.error(result.msg || 'BMP服务器停止失败');
            }
        } catch (error) {
            notify.error(`BMP服务器停止出错: ${error.message}`);
        } finally {
            serverStopping.value = false;
        }
    };

    const viewClientDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `BMP客户端信息: ${record.remoteIp}:${record.remotePort}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const clearClientRuntimeState = () => {
        clientListRequestId += 1;
        clientList.value = [];
        closeDetailsDrawer();
    };

    const handleRuntimeChanged = state => {
        const wasRunning = serverRunning.value;
        serverRunning.value = Boolean(state?.running);
        if (!serverRunning.value) {
            serverLoading.value = false;
            serverStopping.value = false;
            clearClientRuntimeState();
            const failureReason = state?.unexpected ? String(state.reason || '').trim() : '';
            if (failureReason) {
                runtimeFailureMessage.value = failureReason;
                notify.error(failureReason);
            }
            return;
        }

        runtimeFailureMessage.value = '';
        if (!wasRunning) {
            clearClientRuntimeState();
            if (configActive) void loadClientList();
        }
    };

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
        });

    const isValidMonitorClientKey = clientKey => {
        if (typeof clientKey !== 'string' || clientKey.length === 0 || clientKey.length > 512) {
            return false;
        }
        if (hasControlCharacter(clientKey)) {
            return false;
        }
        if (clientKey.startsWith('source:')) {
            return /^[0-9a-f]{64}$/i.test(clientKey.slice('source:'.length));
        }
        if (!clientKey.startsWith('connection:')) {
            return false;
        }
        const [localIp, localPort, remoteIp, remotePort, ...extra] = clientKey.slice('connection:'.length).split('|');
        return (
            extra.length === 0 &&
            [localIp, localPort, remoteIp, remotePort].every(part => part.length > 0 && part.length <= 128) &&
            [localPort, remotePort].every(port => {
                const value = Number(port);
                return Number.isInteger(value) && value >= 1 && value <= 65535;
            })
        );
    };

    const BMP_CLIENT_MONITOR_ID = 'bmp-client';

    const getMonitorRequestKey = record => `${BMP_CLIENT_MONITOR_ID}:${getClientKey(record)}`;

    const canOpenClientMonitor = record => canOpenMonitorWindow.value && isValidMonitorClientKey(getClientKey(record));

    const isMonitorOpening = record => openingMonitorKey.value === getMonitorRequestKey(record);

    const openClientMonitor = async record => {
        const clientKey = getClientKey(record);
        if (!canOpenClientMonitor(record) || openingMonitorKey.value) {
            return;
        }

        const requestKey = getMonitorRequestKey(record);
        openingMonitorKey.value = requestKey;
        try {
            const result = await window.windowApi.openMonitor(BMP_CLIENT_MONITOR_ID, { clientKey });
            if (result?.status !== 'success') {
                notify.error(result?.msg || '打开独立监控窗口失败');
            }
        } catch (error) {
            notify.error('打开独立监控窗口失败: ' + error.message);
        } finally {
            if (openingMonitorKey.value === requestKey) {
                openingMonitorKey.value = '';
            }
        }
    };

    const getStableClientSourceId = record => record?.persistentSourceId || record?.sourceId || '';

    const hasDeleteClientDataApi = () => typeof window.bmpApi?.deleteClientData === 'function';

    const hasValidClientSourceId = record => /^[0-9a-f]{64}$/i.test(getStableClientSourceId(record));

    const canDeleteClientData = record =>
        hasDeleteClientDataApi() && !record?.isOnline && hasValidClientSourceId(record);

    const getClientDeleteDisabledReason = record => {
        if (!hasDeleteClientDataApi()) {
            return '删除接口尚未加载，请完全重启 NetNexus 后重试';
        }
        if (record?.isOnline) {
            return '在线客户端不可删除，请先断开连接';
        }
        if (!hasValidClientSourceId(record)) {
            return '客户端 sourceId 无效，无法安全删除';
        }
        return '';
    };

    const deleteClientData = async record => {
        const clientKey = getClientKey(record);
        if (!canDeleteClientData(record) || deletingClientKey.value === clientKey) {
            return;
        }

        const deleteRequest = {
            sourceId: getStableClientSourceId(record),
            remoteIp: typeof record?.remoteIp === 'string' ? record.remoteIp : ''
        };

        deletingClientKey.value = clientKey;
        try {
            const result = await window.bmpApi.deleteClientData(deleteRequest);
            if (result.status === 'success') {
                await loadClientList();
                if (currentDetails.value && getClientKey(currentDetails.value) === clientKey) {
                    closeDetailsDrawer();
                }
                notify.success(result.msg || '客户端数据删除成功');
            } else {
                notify.error(result.msg || '客户端数据删除失败');
            }
        } catch (error) {
            notify.error(`客户端数据删除失败: ${error.message}`);
        } finally {
            if (deletingClientKey.value === clientKey) {
                deletingClientKey.value = '';
            }
        }
    };

    const onInitiationHandler = result => {
        const data = result.data;
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(data));
            if (existingIndex !== -1) {
                clientList.value[existingIndex] = data;
            } else {
                clientList.value.push(data);
            }
        } else {
            console.error('initiation handler error', data.msg);
        }
    };

    const onTerminationHandler = result => {
        if (result && result.data) {
            const data = result.data;
            if (result.status === 'success') {
                const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(data));
                if (existingIndex !== -1) {
                    clientList.value[existingIndex] = {
                        ...clientList.value[existingIndex],
                        ...data,
                        connectionState: 'closed',
                        isOnline: false
                    };
                }
            } else {
                console.error('termination handler error', data.msg);
            }
        } else {
            clientList.value = [];
        }
    };

    const loadClientList = async () => {
        const requestId = ++clientListRequestId;
        try {
            const clientListResult = await window.bmpApi.getClientList();
            if (requestId !== clientListRequestId) return;
            if (clientListResult.status === 'success') {
                clientList.value = Array.isArray(clientListResult.data) ? clientListResult.data : [];
            }
        } catch (error) {
            if (requestId !== clientListRequestId) return;
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    watch(
        () => bmpConfig.value.bmpV4TlvDraft,
        (newDraft, oldDraft) => {
            const nextDraft = normalizeBmpV4TlvDraft(newDraft);
            const previousDraft = normalizeBmpV4TlvDraft(oldDraft);
            const currentType = Number(bmpConfig.value.pathMarkingTlvType);
            const previousDefault = getDefaultPathMarkingTlvType(previousDraft);

            if (!Number.isInteger(currentType) || currentType === previousDefault) {
                bmpConfig.value.pathMarkingTlvType = getDefaultPathMarkingTlvType(nextDraft);
            }
        }
    );

    let clientListRequestId = 0;
    let configActive = false;
    let tcpAoClockTimer = null;

    onActivated(async () => {
        configActive = true;
        currentTimeMs.value = Date.now();
        if (tcpAoClockTimer !== null) clearInterval(tcpAoClockTimer);
        tcpAoClockTimer = setInterval(() => {
            currentTimeMs.value = Date.now();
        }, 1000);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onInitiationHandler);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, onTerminationHandler);
        await Promise.all([loadClientList(), loadTcpAoProfiles()]);
    });

    onDeactivated(() => {
        configActive = false;
        if (tcpAoClockTimer !== null) {
            clearInterval(tcpAoClockTimer);
            tcpAoClockTimer = null;
        }
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
    });

    onMounted(async () => {
        EventBus.on(BMP_RUNTIME_CHANGED_EVENT, BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG, handleRuntimeChanged);
        EventBus.on(TCP_AO_SETTINGS_CHANGED_EVENT, TCP_AO_SETTINGS_LISTENER_ID, applyTcpAoProfiles);
        // 加载BMP配置
        const savedConfig = await window.bmpApi.loadBmpConfig();
        if (savedConfig.status === 'success') {
            if (savedConfig.data) {
                bmpConfig.value.port = savedConfig.data.port || DEFAULT_VALUES.DEFAULT_BMP_PORT;
                const savedDraft = normalizeBmpV4TlvDraft(savedConfig.data.bmpV4TlvDraft);
                bmpConfig.value.bmpV4TlvDraft = savedDraft;
                bmpConfig.value.pathMarkingTlvType = normalizePathMarkingTlvType(
                    savedConfig.data.pathMarkingTlvType,
                    savedDraft
                );
                bmpConfig.value.persistenceEnabled = true;
                bmpConfig.value.authType = normalizeAuthType(savedConfig.data.authType);
                bmpConfig.value.tcpAoProfileIds = normalizeTcpAoProfileIds(
                    savedConfig.data.tcpAoProfileIds || savedConfig.data.tcpAoProfileId
                );
            }
        } else {
            console.error('配置文件加载失败', savedConfig.msg);
        }
        await loadTcpAoProfiles();
    });

    onBeforeUnmount(() => {
        if (tcpAoClockTimer !== null) clearInterval(tcpAoClockTimer);
        EventBus.off(BMP_RUNTIME_CHANGED_EVENT, BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
        EventBus.off(TCP_AO_SETTINGS_CHANGED_EVENT, TCP_AO_SETTINGS_LISTENER_ID);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_CONFIG);
    });
</script>

<style scoped>
    .adaptive-list-page {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .bmp-runtime-alert {
        margin-bottom: 12px;
    }

    .tcp-ao-profile-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .tcp-ao-profile-alert {
        max-width: 720px;
        margin-bottom: 8px;
    }

    .tcp-ao-settings-link {
        margin-top: 4px;
        padding-inline: 0;
    }

    .tcp-ao-selection-warning {
        margin-top: 8px;
        color: var(--nn-color-error);
        font-size: 12px;
        line-height: 18px;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.nn-card-body),
    .adaptive-list-card :deep(.nn-card-body > div) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.nn-spin-nested-loading),
    .adaptive-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .adaptive-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.nn-table-container),
    .adaptive-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
