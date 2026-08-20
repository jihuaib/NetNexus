<template>
    <nn-settings class="tcp-ao-settings" data-testid="tcp-ao-settings">
        <nn-settings-section
            title="TCP-AO Profiles"
            description="集中管理 BMP 与 RPKI-RTR 共用的 Linux TCP-AO 对端和轮换密钥。密钥在本机加密保存，加载时不会返回明文。"
        >
            <nn-alert
                type="info"
                message="每个 Profile 可配置多把密钥及独立的接收、发送有效期。空白时间表示该方向没有边界。"
                description="保存前，每个 Profile 至少需要一把当前可发送的密钥；最后一把密钥若设置发送结束时间且没有后继密钥，到期时会断开连接并停止服务，不会降级为无认证 TCP。保存会等待正在使用该 Profile 的 BMP 或 RPKI 同步密钥、算法、Key ID、MAC 长度与有效期；全部同步成功后立即生效。失败时持久化修改和运行计划会回滚；无法恢复旧计划的服务将安全停止。运行中不能修改已选 Profile 的对端地址或前缀。同一 Key ID 更换密钥、算法或 MAC 长度会关闭受影响的已有连接，并发握手也可能需要重试；需要无损轮换时请新增 Key ID 并设置重叠的接收时间窗。"
                show-icon
                variant="subtle"
                class="tcp-ao-guidance"
            />

            <div v-if="loading" class="tcp-ao-empty">正在加载 TCP-AO 配置…</div>
            <div v-else-if="profiles.length === 0" class="tcp-ao-empty" data-testid="tcp-ao-empty-state">
                尚未配置 TCP-AO Profile。添加并保存后，可在 BMP 或 RPKI 服务器配置中选择。
            </div>

            <div v-else class="tcp-ao-profile-list">
                <section
                    v-for="(profile, profileIndex) in profiles"
                    :key="profile.id"
                    class="tcp-ao-profile"
                    :aria-label="`TCP-AO Profile ${profileIndex + 1}`"
                    :data-testid="`tcp-ao-profile-${profileIndex}`"
                >
                    <div class="tcp-ao-profile-header">
                        <div>
                            <strong>Profile {{ profileIndex + 1 }}</strong>
                            <nn-tag :color="hasCurrentlySendableKey(profile) ? 'green' : 'orange'">
                                {{ hasCurrentlySendableKey(profile) ? '当前可发送' : '需要有效发送密钥' }}
                            </nn-tag>
                            <nn-tag v-for="consumer in profile.usedBy" :key="consumer" color="blue">
                                {{ consumer }} 使用中
                            </nn-tag>
                        </div>
                        <nn-tooltip :title="profileDeleteDisabledReason(profile)">
                            <span>
                                <nn-button
                                    danger
                                    size="small"
                                    :aria-label="`删除 TCP-AO Profile ${profileIndex + 1}`"
                                    :data-testid="`tcp-ao-delete-profile-${profileIndex}`"
                                    :disabled="isProfileInUse(profile)"
                                    @click="removeProfile(profileIndex)"
                                >
                                    删除 Profile
                                </nn-button>
                            </span>
                        </nn-tooltip>
                    </div>

                    <div class="tcp-ao-profile-metadata">
                        <div class="tcp-ao-field">
                            <label :for="profileFieldId(profile, 'name')">Profile 名称</label>
                            <nn-input
                                :id="profileFieldId(profile, 'name')"
                                v-model:value="profile.name"
                                :aria-label="`Profile ${profileIndex + 1} 名称`"
                                :status="profileFieldError(profile, 'name') ? 'error' : ''"
                                :data-testid="`tcp-ao-profile-name-${profileIndex}`"
                                maxlength="64"
                                placeholder="例如：核心路由器"
                            />
                            <span v-if="profileFieldError(profile, 'name')" class="tcp-ao-field-error" role="alert">
                                {{ profileFieldError(profile, 'name') }}
                            </span>
                        </div>

                        <div class="tcp-ao-field">
                            <label :for="profileFieldId(profile, 'peer')">对端地址/前缀</label>
                            <nn-input
                                :id="profileFieldId(profile, 'peer')"
                                v-model:value="profile.peer"
                                :aria-label="`Profile ${profileIndex + 1} 对端地址或前缀`"
                                :status="profileFieldError(profile, 'peer') ? 'error' : ''"
                                :data-testid="`tcp-ao-profile-peer-${profileIndex}`"
                                placeholder="192.0.2.1、192.0.2.0/24 或 2001:db8::/64"
                            />
                            <span class="tcp-ao-field-hint">
                                在 BMP 中，该地址或前缀也是允许连接的对端范围；同一监听器选择的范围不能重叠。
                            </span>
                            <span v-if="profileFieldError(profile, 'peer')" class="tcp-ao-field-error" role="alert">
                                {{ profileFieldError(profile, 'peer') }}
                            </span>
                        </div>
                    </div>

                    <div v-if="profileFieldError(profile, 'keys')" class="tcp-ao-profile-error" role="alert">
                        {{ profileFieldError(profile, 'keys') }}
                    </div>

                    <div class="tcp-ao-key-list">
                        <article
                            v-for="(keyItem, keyIndex) in profile.keys"
                            :key="keyItem.id"
                            class="tcp-ao-key"
                            :data-testid="`tcp-ao-key-${profileIndex}-${keyIndex}`"
                        >
                            <div class="tcp-ao-key-header">
                                <div>
                                    <strong>密钥 {{ keyIndex + 1 }}</strong>
                                    <nn-tag :color="savedKeyStatusColor(keyItem)">
                                        {{ savedKeyStatusLabel(keyItem) }}
                                    </nn-tag>
                                    <nn-tag v-if="isKeyCurrentlySendable(keyItem)" color="blue">当前发送</nn-tag>
                                </div>
                                <nn-button
                                    danger
                                    size="small"
                                    :aria-label="`删除 Profile ${profileIndex + 1} 的密钥 ${keyIndex + 1}`"
                                    :data-testid="`tcp-ao-delete-key-${profileIndex}-${keyIndex}`"
                                    @click="removeKey(profile, keyIndex)"
                                >
                                    删除密钥
                                </nn-button>
                            </div>

                            <div class="tcp-ao-key-grid">
                                <div class="tcp-ao-field">
                                    <label :for="keyFieldId(profile, keyItem, 'algorithm')">算法</label>
                                    <nn-select
                                        :id="keyFieldId(profile, keyItem, 'algorithm')"
                                        v-model:value="keyItem.algorithm"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} 算法`"
                                        :status="keyFieldError(profile, keyItem, 'algorithm') ? 'error' : ''"
                                        :data-testid="`tcp-ao-key-algorithm-${profileIndex}-${keyIndex}`"
                                        style="width: 100%"
                                        @change="normalizeMacLength(keyItem)"
                                    >
                                        <nn-select-option
                                            v-for="algorithm in algorithmOptions"
                                            :key="algorithm"
                                            :value="algorithm"
                                        >
                                            {{ algorithm }}
                                        </nn-select-option>
                                    </nn-select>
                                    <span
                                        v-if="keyFieldError(profile, keyItem, 'algorithm')"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, 'algorithm') }}
                                    </span>
                                </div>

                                <div class="tcp-ao-field tcp-ao-number-field">
                                    <label :for="keyFieldId(profile, keyItem, 'snd-id')">
                                        本端发送 Key ID（SndID）
                                    </label>
                                    <nn-input-number
                                        :id="keyFieldId(profile, keyItem, 'snd-id')"
                                        v-model:value="keyItem.sndId"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} Send ID`"
                                        :min="0"
                                        :max="255"
                                        :precision="0"
                                        :status="keyFieldError(profile, keyItem, 'sndId') ? 'error' : ''"
                                        :data-testid="`tcp-ao-key-snd-id-${profileIndex}-${keyIndex}`"
                                        style="width: 100%"
                                    />
                                    <span class="tcp-ao-field-hint">本端发送报文时携带的 Key ID。</span>
                                    <span
                                        v-if="keyFieldError(profile, keyItem, 'sndId')"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, 'sndId') }}
                                    </span>
                                </div>

                                <div class="tcp-ao-field tcp-ao-number-field">
                                    <label :for="keyFieldId(profile, keyItem, 'rcv-id')">
                                        期望对端发送 Key ID（RcvID）
                                    </label>
                                    <nn-input-number
                                        :id="keyFieldId(profile, keyItem, 'rcv-id')"
                                        v-model:value="keyItem.rcvId"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} Receive ID`"
                                        :min="0"
                                        :max="255"
                                        :precision="0"
                                        :status="keyFieldError(profile, keyItem, 'rcvId') ? 'error' : ''"
                                        :data-testid="`tcp-ao-key-rcv-id-${profileIndex}-${keyIndex}`"
                                        style="width: 100%"
                                    />
                                    <span class="tcp-ao-field-hint">
                                        对端的 SndID 应设置为此值；对端的 RcvID 应设置为本端 SndID。
                                    </span>
                                    <span
                                        v-if="keyFieldError(profile, keyItem, 'rcvId')"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, 'rcvId') }}
                                    </span>
                                </div>

                                <div class="tcp-ao-field tcp-ao-number-field">
                                    <label :for="keyFieldId(profile, keyItem, 'mac-length')">MAC 长度</label>
                                    <nn-input-number
                                        :id="keyFieldId(profile, keyItem, 'mac-length')"
                                        v-model:value="keyItem.macLength"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} MAC 长度`"
                                        :min="4"
                                        :max="algorithmMaxMacLength(keyItem.algorithm)"
                                        :precision="0"
                                        :status="keyFieldError(profile, keyItem, 'macLength') ? 'error' : ''"
                                        :data-testid="`tcp-ao-key-mac-length-${profileIndex}-${keyIndex}`"
                                        style="width: 100%"
                                    />
                                    <span
                                        v-if="keyFieldError(profile, keyItem, 'macLength')"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, 'macLength') }}
                                    </span>
                                </div>

                                <div class="tcp-ao-field tcp-ao-field-secret">
                                    <label :for="keyFieldId(profile, keyItem, 'key')">
                                        {{ keyItem.hasSavedKey ? '替换密钥（可选）' : '密钥' }}
                                    </label>
                                    <nn-input-password
                                        :id="keyFieldId(profile, keyItem, 'key')"
                                        v-model:value="keyItem.key"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} 明文`"
                                        :status="keyFieldError(profile, keyItem, 'key') ? 'error' : ''"
                                        :data-testid="`tcp-ao-key-secret-${profileIndex}-${keyIndex}`"
                                        autocomplete="new-password"
                                        placeholder="明文仅在本次保存时提交"
                                    />
                                    <span class="tcp-ao-field-hint">
                                        最多 80 个 UTF-8 字节；cmac(aes) 使用 AES-128，必须正好为 16 字节。
                                    </span>
                                    <span
                                        v-if="keyFieldError(profile, keyItem, 'key')"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, 'key') }}
                                    </span>
                                </div>
                            </div>

                            <div class="tcp-ao-time-heading">
                                <strong>密钥有效期</strong>
                                <span>顺序：接收开始 ≤ 发送开始 &lt; 发送结束 ≤ 接收结束；留空表示无界。</span>
                            </div>
                            <div class="tcp-ao-time-grid">
                                <div
                                    v-for="timeField in timeFields"
                                    :key="timeField.key"
                                    class="tcp-ao-field tcp-ao-time-field"
                                >
                                    <label :for="keyFieldId(profile, keyItem, timeField.key)">
                                        {{ timeField.label }}
                                    </label>
                                    <input
                                        :id="keyFieldId(profile, keyItem, timeField.key)"
                                        v-model="keyItem[timeField.key]"
                                        type="datetime-local"
                                        step="1"
                                        class="tcp-ao-datetime-input"
                                        :class="{
                                            'tcp-ao-datetime-input-error': keyFieldError(
                                                profile,
                                                keyItem,
                                                timeField.key
                                            )
                                        }"
                                        :aria-label="`Profile ${profileIndex + 1} 密钥 ${keyIndex + 1} ${timeField.label}`"
                                        :aria-invalid="Boolean(keyFieldError(profile, keyItem, timeField.key))"
                                        :data-testid="`tcp-ao-key-${timeField.testId}-${profileIndex}-${keyIndex}`"
                                    />
                                    <span
                                        v-if="keyFieldError(profile, keyItem, timeField.key)"
                                        class="tcp-ao-field-error"
                                        role="alert"
                                    >
                                        {{ keyFieldError(profile, keyItem, timeField.key) }}
                                    </span>
                                </div>
                            </div>
                            <div
                                v-if="keyFieldError(profile, keyItem, 'general')"
                                class="tcp-ao-key-error"
                                role="alert"
                            >
                                {{ keyFieldError(profile, keyItem, 'general') }}
                            </div>
                        </article>
                    </div>

                    <div class="tcp-ao-key-actions">
                        <nn-button
                            size="small"
                            :disabled="profile.keys.length >= MAX_KEYS_PER_PROFILE"
                            :data-testid="`tcp-ao-add-key-${profileIndex}`"
                            @click="addKey(profile)"
                        >
                            添加密钥
                        </nn-button>
                        <span>{{ profile.keys.length }} / {{ MAX_KEYS_PER_PROFILE }}</span>
                    </div>
                </section>
            </div>

            <div class="tcp-ao-list-actions">
                <nn-button
                    data-testid="tcp-ao-add-profile-button"
                    :disabled="profiles.length >= MAX_PROFILE_COUNT"
                    @click="addProfile"
                >
                    添加 Profile
                </nn-button>
                <span>{{ profiles.length }} / {{ MAX_PROFILE_COUNT }}</span>
            </div>
        </nn-settings-section>

        <div class="settings-page-actions">
            <nn-button
                type="primary"
                data-testid="tcp-ao-save-button"
                :loading="saving"
                :disabled="loading"
                @click="saveSettings"
            >
                保存设置
            </nn-button>
        </div>
    </nn-settings>
</template>

<script setup>
    import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
    import ipaddr from 'ipaddr.js';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';

    const TCP_AO_SETTINGS_CHANGED_EVENT = 'rpki:tcpAoSettingsChanged';
    const MAX_PROFILE_COUNT = 32;
    const MAX_KEYS_PER_PROFILE = 16;
    const MAX_KEY_BYTES = 80;
    const DEFAULT_MAC_LENGTH = 12;
    const SAVE_SUCCESS_MESSAGE = 'TCP-AO 设置已保存并立即应用';
    const SAVE_WITHOUT_RUNTIME_CHANGE_MESSAGE = 'TCP-AO 设置已保存；当前没有需要更新的 TCP-AO 运行计划';
    const OLD_RUNTIME_PLAN_MESSAGE = '修改未应用，正在运行的 BMP/RPKI 继续使用修改前的 TCP-AO 密钥计划';
    const isRuntimeApplyFailure = message => /热重载|热更新|运行时.*(?:失败|错误)|同步.*(?:失败|错误)/u.test(message);
    const mentionsRuntimeFailureOutcome = message =>
        /(?:运行|密钥)计划.*(?:回滚|恢复|保持|修改前)|(?:回滚|恢复|保持).*?(?:运行|密钥)计划|(?:持久化|配置).*已恢复|回滚失败|安全停止|服务已停止/u.test(
            message
        );
    const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    const algorithmOptions = Object.freeze(['hmac(sha1)', 'cmac(aes)', 'hmac(sha256)']);
    const algorithmMacLengthLimits = Object.freeze({
        'hmac(sha1)': 20,
        'cmac(aes)': 16,
        'hmac(sha256)': 32
    });
    const timeFields = Object.freeze([
        { key: 'acceptStart', label: '接收开始', testId: 'accept-start' },
        { key: 'sendStart', label: '发送开始', testId: 'send-start' },
        { key: 'sendEnd', label: '发送结束', testId: 'send-end' },
        { key: 'acceptEnd', label: '接收结束', testId: 'accept-end' }
    ]);

    const profiles = ref([]);
    const profileErrors = ref({});
    const loading = ref(false);
    const saving = ref(false);
    const currentTimeMs = ref(Date.now());

    let generatedIdSequence = 0;
    let clockTimer = null;
    let settingsLoaded = false;
    let profileUsageRequestId = 0;

    const createId = prefix => {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
        generatedIdSequence += 1;
        return `${prefix}-${Date.now().toString(36)}-${generatedIdSequence.toString(36)}`;
    };

    const toDateTimeInput = value => {
        const text = String(value ?? '').trim();
        if (!text) return '';
        const numeric = /^\d+$/.test(text) ? Number(text) : null;
        const date = new Date(numeric === null ? text : numeric > 10_000_000_000 ? numeric : numeric * 1000);
        if (Number.isNaN(date.getTime())) return text;
        const pad = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
            date.getMinutes()
        )}:${pad(date.getSeconds())}`;
    };

    const createKey = (source = {}) => ({
        id: String(source.id || createId('tcp-ao-key')),
        algorithm: algorithmOptions.includes(source.algorithm) ? source.algorithm : algorithmOptions[0],
        sndId: Number.isInteger(Number(source.sndId)) ? Number(source.sndId) : 1,
        rcvId: Number.isInteger(Number(source.rcvId)) ? Number(source.rcvId) : 1,
        macLength: Number.isInteger(Number(source.macLength)) ? Number(source.macLength) : DEFAULT_MAC_LENGTH,
        key: '',
        hasSavedKey: source.hasSavedKey === true,
        savedKeyStatus:
            source.savedKeyStatus === 'unavailable'
                ? 'unavailable'
                : source.hasSavedKey === true
                  ? 'available'
                  : 'missing',
        savedAlgorithm: source.hasSavedKey === true ? source.algorithm : '',
        acceptStart: toDateTimeInput(source.acceptStart),
        sendStart: toDateTimeInput(source.sendStart),
        sendEnd: toDateTimeInput(source.sendEnd),
        acceptEnd: toDateTimeInput(source.acceptEnd)
    });

    const normalizeProfileConsumers = source =>
        Array.isArray(source) ? [...new Set(source.filter(consumer => consumer === 'BMP' || consumer === 'RPKI'))] : [];

    const createProfile = (source = {}) => ({
        id: String(source.id || createId('tcp-ao-profile')),
        name: String(source.name || ''),
        peer: String(source.peer || ''),
        usedBy: normalizeProfileConsumers(source.usedBy),
        keys: Array.isArray(source.keys)
            ? source.keys.slice(0, MAX_KEYS_PER_PROFILE).map(createKey)
            : source.id
              ? []
              : [createKey()]
    });

    const profileFieldId = (profile, field) => `tcp-ao-${profile.id}-${field}`;
    const keyFieldId = (profile, keyItem, field) => `tcp-ao-${profile.id}-${keyItem.id}-${field}`;
    const profileFieldError = (profile, field) => profileErrors.value[profile.id]?.[field] || '';
    const keyFieldError = (profile, keyItem, field) =>
        profileErrors.value[profile.id]?.keyErrors?.[keyItem.id]?.[field] || '';
    const algorithmMaxMacLength = algorithm => algorithmMacLengthLimits[algorithm] || 0;
    const savedKeyStatusColor = keyItem =>
        keyItem.savedKeyStatus === 'unavailable' ? 'red' : keyItem.hasSavedKey ? 'green' : 'orange';
    const savedKeyStatusLabel = keyItem =>
        keyItem.savedKeyStatus === 'unavailable'
            ? '密钥不可用，需重新输入'
            : keyItem.hasSavedKey
              ? '已保存到本机'
              : '尚未保存';

    const normalizeMacLength = keyItem => {
        const maximum = algorithmMaxMacLength(keyItem.algorithm);
        if (!Number.isInteger(Number(keyItem.macLength)) || Number(keyItem.macLength) < 4) {
            keyItem.macLength = Math.min(DEFAULT_MAC_LENGTH, maximum);
        } else if (Number(keyItem.macLength) > maximum) {
            keyItem.macLength = maximum;
        }
    };

    const normalizePeer = value => {
        const text = String(value || '').trim();
        if (!text) throw new Error('请输入对端 IPv4、IPv6 地址或 CIDR 前缀');

        let address;
        let prefixLength;
        if (text.includes('/')) {
            [address, prefixLength] = ipaddr.parseCIDR(text);
            const networkAddress =
                address.kind() === 'ipv4'
                    ? ipaddr.IPv4.networkAddressFromCIDR(text)
                    : ipaddr.IPv6.networkAddressFromCIDR(text);
            if (networkAddress.toString() !== address.toString()) {
                throw new Error('CIDR 前缀必须使用网络地址，主机位应为 0');
            }
        } else {
            address = ipaddr.parse(text);
            prefixLength = address.kind() === 'ipv4' ? 32 : 128;
        }

        return `${address.toString()}/${prefixLength}`;
    };

    const isByteId = value => {
        const number = Number(value);
        return Number.isInteger(number) && number >= 0 && number <= 255;
    };

    const keyByteLength = value => new TextEncoder().encode(String(value || '')).length;
    const parseOptionalTime = value => {
        const text = String(value || '').trim();
        if (!text) return null;
        const timestamp = new Date(text).getTime();
        return Number.isNaN(timestamp) ? Number.NaN : timestamp;
    };

    const normalizeOptionalTimeForSave = value => {
        const text = String(value || '').trim();
        if (!text) return '';
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) throw new Error('密钥有效期格式无效');
        return date.toISOString();
    };

    const hasKeyMaterial = keyItem => Boolean(String(keyItem.key || '')) || keyItem.hasSavedKey === true;
    const isKeyCurrentlySendable = (keyItem, now = currentTimeMs.value) => {
        if (!hasKeyMaterial(keyItem)) return false;
        const sendStart = parseOptionalTime(keyItem.sendStart);
        const sendEnd = parseOptionalTime(keyItem.sendEnd);
        if (Number.isNaN(sendStart) || Number.isNaN(sendEnd)) return false;
        return (sendStart === null || sendStart <= now) && (sendEnd === null || now < sendEnd);
    };
    const hasCurrentlySendableKey = profile => profile.keys.some(keyItem => isKeyCurrentlySendable(keyItem));
    const isProfileInUse = profile => profile.usedBy.length > 0;
    const profileDeleteDisabledReason = profile =>
        isProfileInUse(profile)
            ? `该 Profile 正被 ${profile.usedBy.join('、')} 使用，请先在对应服务配置中取消引用`
            : '';

    const validateKeyTimes = (keyItem, errors) => {
        const timestamps = Object.fromEntries(
            timeFields.map(({ key }) => {
                const timestamp = parseOptionalTime(keyItem[key]);
                if (Number.isNaN(timestamp)) errors[key] = '请输入有效的日期和时间';
                return [key, timestamp];
            })
        );

        const acceptStart = timestamps.acceptStart === null ? Number.NEGATIVE_INFINITY : timestamps.acceptStart;
        const sendStart = timestamps.sendStart === null ? Number.NEGATIVE_INFINITY : timestamps.sendStart;
        const sendEnd = timestamps.sendEnd === null ? Number.POSITIVE_INFINITY : timestamps.sendEnd;
        const acceptEnd = timestamps.acceptEnd === null ? Number.POSITIVE_INFINITY : timestamps.acceptEnd;

        if (acceptStart > sendStart) {
            errors.sendStart = '发送开始不能早于接收开始';
        }
        if (sendStart >= sendEnd) {
            errors.sendEnd = '发送结束必须晚于发送开始';
        }
        if (sendEnd > acceptEnd) {
            errors.acceptEnd = '接收结束不能早于发送结束';
        }

        return { sendStart, sendEnd };
    };

    const validateProfiles = () => {
        const errors = {};
        const normalizedNames = new Map();
        const profileIds = new Set();
        const now = Date.now();

        profiles.value.forEach((profile, profileIndex) => {
            const itemErrors = { keyErrors: {} };
            const id = String(profile.id || '');
            if (!PROFILE_ID_PATTERN.test(id) || profileIds.has(id)) {
                itemErrors.name = 'Profile 标识无效或重复，请删除后重新添加';
            }
            profileIds.add(id);

            const name = String(profile.name || '').trim();
            if (!name) {
                itemErrors.name = '请输入 Profile 名称';
            } else if (name.length > 64) {
                itemErrors.name = 'Profile 名称不能超过 64 个字符';
            } else {
                const nameKey = name.toLocaleLowerCase();
                if (normalizedNames.has(nameKey)) {
                    itemErrors.name = `Profile 名称与第 ${normalizedNames.get(nameKey) + 1} 条重复`;
                } else {
                    normalizedNames.set(nameKey, profileIndex);
                }
            }

            try {
                normalizePeer(profile.peer);
            } catch (error) {
                itemErrors.peer =
                    error.message === 'CIDR 前缀必须使用网络地址，主机位应为 0'
                        ? error.message
                        : '请输入有效的 IPv4、IPv6 地址或 CIDR 前缀';
            }

            if (!Array.isArray(profile.keys) || profile.keys.length === 0) {
                itemErrors.keys = '每个 Profile 至少需要一把密钥';
            } else if (profile.keys.length > MAX_KEYS_PER_PROFILE) {
                itemErrors.keys = `每个 Profile 最多保存 ${MAX_KEYS_PER_PROFILE} 把密钥`;
            }

            const sendIds = new Map();
            const receiveIds = new Map();
            const keyIds = new Set();
            const sendRanges = [];
            let currentSendingKeyCount = 0;
            const addKeyGeneralError = (keyItem, message) => {
                const keyId = keyItem.id;
                const previousMessage = itemErrors.keyErrors[keyId]?.general;
                itemErrors.keyErrors[keyId] = {
                    ...(itemErrors.keyErrors[keyId] || {}),
                    general: previousMessage ? `${previousMessage}；${message}` : message
                };
            };
            profile.keys.forEach((keyItem, keyIndex) => {
                const keyErrors = {};
                const keyId = String(keyItem.id || '');
                if (!PROFILE_ID_PATTERN.test(keyId) || keyIds.has(keyId)) {
                    keyErrors.general = '密钥标识无效或重复，请删除后重新添加';
                }
                keyIds.add(keyId);

                if (!algorithmOptions.includes(keyItem.algorithm)) {
                    keyErrors.algorithm = '请选择受支持的 TCP-AO 算法';
                }
                if (!isByteId(keyItem.sndId)) {
                    keyErrors.sndId = '本端发送 Key ID（SndID）必须是 0-255 之间的整数';
                }
                if (!isByteId(keyItem.rcvId)) {
                    keyErrors.rcvId = '期望对端发送 Key ID（RcvID）必须是 0-255 之间的整数';
                }

                const macLength = Number(keyItem.macLength);
                const maximumMacLength = algorithmMaxMacLength(keyItem.algorithm);
                if (!Number.isInteger(macLength) || macLength < 4 || macLength > maximumMacLength) {
                    keyErrors.macLength = `MAC 长度必须是 4-${maximumMacLength || 4} 之间的整数`;
                }

                const key = String(keyItem.key || '');
                if (!key && !keyItem.hasSavedKey) {
                    keyErrors.key = '请输入 TCP-AO 密钥';
                } else if (
                    !key &&
                    keyItem.hasSavedKey &&
                    keyItem.savedAlgorithm &&
                    keyItem.algorithm !== keyItem.savedAlgorithm
                ) {
                    keyErrors.key = '更换算法时必须重新输入密钥';
                } else if (key) {
                    const byteLength = keyByteLength(key);
                    if (key.includes('\0')) {
                        keyErrors.key = '密钥不能包含 NUL 字符';
                    } else if (byteLength > MAX_KEY_BYTES) {
                        keyErrors.key = `密钥不能超过 ${MAX_KEY_BYTES} 个 UTF-8 字节`;
                    } else if (keyItem.algorithm === 'cmac(aes)' && byteLength !== 16) {
                        keyErrors.key = 'cmac(aes) 密钥必须正好为 16 个 UTF-8 字节';
                    }
                }

                const sendRange = validateKeyTimes(keyItem, keyErrors);

                if (isByteId(keyItem.sndId) && isByteId(keyItem.rcvId)) {
                    const sendId = Number(keyItem.sndId);
                    const receiveId = Number(keyItem.rcvId);
                    if (sendIds.has(sendId)) {
                        keyErrors.sndId = `SndID 与第 ${sendIds.get(sendId) + 1} 把密钥重复`;
                    } else {
                        sendIds.set(sendId, keyIndex);
                    }
                    if (receiveIds.has(receiveId)) {
                        keyErrors.rcvId = `RcvID 与第 ${receiveIds.get(receiveId) + 1} 把密钥重复`;
                    } else {
                        receiveIds.set(receiveId, keyIndex);
                    }
                }

                if (!Object.values(sendRange).some(Number.isNaN)) {
                    sendRanges.push({ keyItem, keyIndex, ...sendRange });
                }

                if (Object.keys(keyErrors).length === 0 && isKeyCurrentlySendable(keyItem, now)) {
                    currentSendingKeyCount += 1;
                }
                if (Object.keys(keyErrors).length > 0) itemErrors.keyErrors[keyId] = keyErrors;
            });

            sendRanges.sort((left, right) => left.sendStart - right.sendStart);
            for (let index = 1; index < sendRanges.length; index += 1) {
                const previous = sendRanges[index - 1];
                const current = sendRanges[index];
                if (current.sendStart < previous.sendEnd) {
                    addKeyGeneralError(current.keyItem, `发送有效期与第 ${previous.keyIndex + 1} 把密钥重叠`);
                }
            }

            const activeRangeIndex = sendRanges.findIndex(range => range.sendStart <= now && now < range.sendEnd);
            if (activeRangeIndex >= 0) {
                for (let index = activeRangeIndex + 1; index < sendRanges.length; index += 1) {
                    const previous = sendRanges[index - 1];
                    const current = sendRanges[index];
                    if (current.sendStart > previous.sendEnd) {
                        addKeyGeneralError(
                            current.keyItem,
                            `未来发送窗口必须紧接第 ${previous.keyIndex + 1} 把密钥，不能留有空档`
                        );
                    }
                }
            }

            if (profile.keys.length > 0 && currentSendingKeyCount === 0) {
                itemErrors.keys = '至少需要一把已保存或已输入、且当前处于发送有效期内的密钥';
            } else if (currentSendingKeyCount > 1) {
                itemErrors.keys = '当前时间只能有一把发送有效的密钥，请修正重叠窗口';
            }

            if (Object.keys(itemErrors.keyErrors).length === 0) delete itemErrors.keyErrors;
            if (Object.keys(itemErrors).length > 0) errors[id] = itemErrors;
        });

        profileErrors.value = errors;
        return Object.keys(errors).length === 0;
    };

    const normalizeKeyForSave = keyItem => ({
        id: String(keyItem.id),
        algorithm: keyItem.algorithm,
        sndId: Number(keyItem.sndId),
        rcvId: Number(keyItem.rcvId),
        macLength: Number(keyItem.macLength),
        key: String(keyItem.key || ''),
        hasSavedKey: keyItem.hasSavedKey === true,
        acceptStart: normalizeOptionalTimeForSave(keyItem.acceptStart),
        sendStart: normalizeOptionalTimeForSave(keyItem.sendStart),
        sendEnd: normalizeOptionalTimeForSave(keyItem.sendEnd),
        acceptEnd: normalizeOptionalTimeForSave(keyItem.acceptEnd)
    });

    const normalizeProfileForSave = profile => ({
        id: String(profile.id),
        name: String(profile.name).trim(),
        peer: normalizePeer(profile.peer),
        keys: profile.keys.map(normalizeKeyForSave)
    });

    const sanitizeProfilesForRenderer = source =>
        (Array.isArray(source) ? source : []).slice(0, MAX_PROFILE_COUNT).map(item => createProfile(item));

    const profilesForEvent = () =>
        profiles.value.map(profile => ({
            id: profile.id,
            name: profile.name,
            peer: profile.peer,
            keys: profile.keys.map(keyItem => ({
                id: keyItem.id,
                algorithm: keyItem.algorithm,
                sndId: keyItem.sndId,
                rcvId: keyItem.rcvId,
                macLength: keyItem.macLength,
                hasSavedKey: keyItem.hasSavedKey,
                savedKeyStatus: keyItem.savedKeyStatus,
                acceptStart: keyItem.acceptStart,
                sendStart: keyItem.sendStart,
                sendEnd: keyItem.sendEnd,
                acceptEnd: keyItem.acceptEnd
            }))
        }));

    const emitProfilesChanged = () => {
        EventBus.emit(TCP_AO_SETTINGS_CHANGED_EVENT, profilesForEvent());
    };

    const wipePlaintextKeys = () => {
        profiles.value.forEach(profile => {
            profile.keys.forEach(keyItem => {
                keyItem.key = '';
            });
        });
    };

    const startClock = () => {
        if (clockTimer !== null) clearInterval(clockTimer);
        currentTimeMs.value = Date.now();
        clockTimer = setInterval(() => {
            currentTimeMs.value = Date.now();
        }, 1000);
    };

    const stopClock = () => {
        if (clockTimer === null) return;
        clearInterval(clockTimer);
        clockTimer = null;
    };

    const requestStoredSettings = async () => {
        if (typeof window.rpkiApi?.loadTcpAoSettings !== 'function') {
            throw new Error('当前后端未提供 TCP-AO 设置接口');
        }
        const result = await window.rpkiApi.loadTcpAoSettings();
        if (result?.status !== 'success') {
            throw new Error(result?.msg || '加载 TCP-AO 设置失败');
        }
        return result.data || {};
    };

    const reconcileProfileUsage = (source, { restoreReferencedProfiles = false } = {}) => {
        const storedProfiles = Array.isArray(source) ? source.slice(0, MAX_PROFILE_COUNT) : [];
        const storedById = new Map(storedProfiles.map(item => [String(item?.id || ''), item]));
        const localIds = new Set(profiles.value.map(profile => profile.id));

        profiles.value.forEach(profile => {
            const stored = storedById.get(profile.id);
            if (stored) profile.usedBy = normalizeProfileConsumers(stored.usedBy);
        });

        if (!restoreReferencedProfiles) return;
        storedProfiles.forEach(stored => {
            const id = String(stored?.id || '');
            if (!id || localIds.has(id) || normalizeProfileConsumers(stored.usedBy).length === 0) return;
            profiles.value.push(createProfile(stored));
            localIds.add(id);
        });
    };

    const refreshProfileUsage = async ({ restoreReferencedProfiles = false, notifyFailure = true } = {}) => {
        if (!settingsLoaded || loading.value) return false;
        const requestId = ++profileUsageRequestId;
        try {
            const data = await requestStoredSettings();
            if (requestId !== profileUsageRequestId) return false;
            reconcileProfileUsage(data.profiles, { restoreReferencedProfiles });
            return true;
        } catch (error) {
            if (requestId !== profileUsageRequestId) return false;
            console.error('刷新 TCP-AO Profile 使用状态失败', error);
            if (notifyFailure) notify.error(error.message || '刷新 TCP-AO Profile 使用状态失败');
            return false;
        }
    };

    const loadSettings = async () => {
        if (loading.value) return;
        loading.value = true;
        profileUsageRequestId += 1;
        try {
            const data = await requestStoredSettings();
            profiles.value = sanitizeProfilesForRenderer(data.profiles);
            profileErrors.value = {};
            settingsLoaded = true;
            emitProfilesChanged();
        } catch (error) {
            console.error('加载 TCP-AO 设置失败', error);
            notify.error(error.message || '加载 TCP-AO 设置失败');
        } finally {
            loading.value = false;
        }
    };

    const addProfile = () => {
        if (profiles.value.length >= MAX_PROFILE_COUNT) return;
        profiles.value.push(createProfile());
    };

    const removeProfile = index => {
        const profile = profiles.value[index];
        if (profile && isProfileInUse(profile)) {
            notify.warning(profileDeleteDisabledReason(profile));
            return;
        }
        const [removed] = profiles.value.splice(index, 1);
        if (removed) {
            const nextErrors = { ...profileErrors.value };
            delete nextErrors[removed.id];
            profileErrors.value = nextErrors;
        }
    };

    const addKey = profile => {
        if (profile.keys.length >= MAX_KEYS_PER_PROFILE) return;
        profile.keys.push(createKey());
    };

    const removeKey = (profile, index) => {
        const [removed] = profile.keys.splice(index, 1);
        if (!removed) return;
        const nextErrors = { ...profileErrors.value };
        const profileError = nextErrors[profile.id];
        if (profileError?.keyErrors) {
            const keyErrors = { ...profileError.keyErrors };
            delete keyErrors[removed.id];
            nextErrors[profile.id] = { ...profileError, keyErrors };
        }
        profileErrors.value = nextErrors;
    };

    const saveSettings = async () => {
        if (!validateProfiles()) {
            notify.error('请修正 TCP-AO Profile 配置');
            return;
        }

        saving.value = true;
        try {
            if (typeof window.rpkiApi?.saveTcpAoSettings !== 'function') {
                throw new Error('当前后端未提供 TCP-AO 设置接口');
            }

            const payloadProfiles = profiles.value.map(normalizeProfileForSave);
            const result = await window.rpkiApi.saveTcpAoSettings({ profiles: payloadProfiles });
            if (result?.status !== 'success') {
                throw new Error(result?.msg || '保存 TCP-AO 设置失败');
            }

            if (Array.isArray(result.data?.profiles)) {
                profiles.value = sanitizeProfilesForRenderer(result.data.profiles);
            } else {
                const usageByProfileId = new Map(profiles.value.map(profile => [profile.id, [...profile.usedBy]]));
                profiles.value = payloadProfiles.map(profile =>
                    createProfile({
                        ...profile,
                        usedBy: usageByProfileId.get(profile.id) || [],
                        keys: profile.keys.map(keyItem => ({
                            ...keyItem,
                            hasSavedKey: keyItem.hasSavedKey || Boolean(keyItem.key)
                        }))
                    })
                );
                await refreshProfileUsage({ notifyFailure: false });
            }
            profileErrors.value = {};
            emitProfilesChanged();
            const runtimeServices = Array.isArray(result.data?.runtimeReload?.services)
                ? result.data.runtimeReload.services
                : [];
            const reportedDisconnectedConnections = Number(result.data?.runtimeReload?.disconnectedConnections);
            const disconnectedConnections = Number.isSafeInteger(reportedDisconnectedConnections)
                ? Math.max(0, reportedDisconnectedConnections)
                : runtimeServices.reduce((total, service) => {
                      const count = Number(service?.disconnectedConnections);
                      return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
                  }, 0);
            if (runtimeServices.some(service => service?.status === 'reloaded')) {
                notify.success(
                    disconnectedConnections > 0
                        ? `${SAVE_SUCCESS_MESSAGE}；有 ${disconnectedConnections} 条连接已安全断开，设备需要重新连接`
                        : SAVE_SUCCESS_MESSAGE
                );
            } else {
                notify.success(SAVE_WITHOUT_RUNTIME_CHANGE_MESSAGE);
            }
        } catch (error) {
            console.error('保存 TCP-AO 设置失败', error);
            const message = String(error?.message || '保存 TCP-AO 设置失败').trim();
            notify.error(
                isRuntimeApplyFailure(message) &&
                    !message.includes(OLD_RUNTIME_PLAN_MESSAGE) &&
                    !mentionsRuntimeFailureOutcome(message)
                    ? `${message}；${OLD_RUNTIME_PLAN_MESSAGE}`
                    : message
            );
            await refreshProfileUsage({ restoreReferencedProfiles: true, notifyFailure: false });
        } finally {
            saving.value = false;
        }
    };

    const resumeBackgroundWork = () => {
        startClock();
        if (loading.value) return;
        if (settingsLoaded) {
            void refreshProfileUsage({ restoreReferencedProfiles: true });
        } else {
            void loadSettings();
        }
    };

    onMounted(loadSettings);
    onActivated(resumeBackgroundWork);
    onDeactivated(() => {
        wipePlaintextKeys();
        stopClock();
    });
    onBeforeUnmount(() => {
        wipePlaintextKeys();
        stopClock();
    });

    defineExpose({
        wipePlaintextKeys,
        pauseBackgroundWork: stopClock,
        resumeBackgroundWork
    });
</script>

<style scoped>
    .tcp-ao-settings {
        max-width: 100%;
    }

    .tcp-ao-guidance {
        margin-bottom: 12px;
    }

    .tcp-ao-empty {
        padding: 24px 16px;
        border: 1px dashed var(--nn-color-border);
        border-radius: 4px;
        color: var(--nn-color-text-secondary);
        text-align: center;
    }

    .tcp-ao-profile-list,
    .tcp-ao-key-list {
        display: grid;
        gap: 12px;
    }

    .tcp-ao-profile {
        padding: 14px;
        border: 1px solid var(--nn-color-border);
        border-radius: 4px;
        background: var(--nn-color-bg-surface);
    }

    .tcp-ao-key {
        padding: 12px;
        border: 1px solid var(--nn-color-border-secondary, var(--nn-color-border));
        border-radius: 4px;
        background: var(--nn-color-bg-container, var(--nn-color-bg-surface));
    }

    .tcp-ao-profile-header,
    .tcp-ao-profile-header > div,
    .tcp-ao-key-header,
    .tcp-ao-key-header > div,
    .tcp-ao-key-actions,
    .tcp-ao-list-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
    }

    .tcp-ao-profile-header,
    .tcp-ao-key-header {
        margin-bottom: 12px;
    }

    .tcp-ao-profile-header > div,
    .tcp-ao-key-header > div {
        flex-wrap: wrap;
        justify-content: flex-start;
    }

    .tcp-ao-profile-metadata,
    .tcp-ao-key-grid,
    .tcp-ao-time-grid {
        display: grid;
        gap: 12px;
    }

    .tcp-ao-profile-metadata {
        grid-template-columns: minmax(180px, 1fr) minmax(280px, 2fr);
        margin-bottom: 12px;
    }

    .tcp-ao-key-grid {
        grid-template-columns: minmax(180px, 1fr) repeat(3, minmax(120px, 0.65fr));
    }

    .tcp-ao-field-secret {
        grid-column: 1 / -1;
    }

    .tcp-ao-time-heading {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: baseline;
        margin: 14px 0 8px;
    }

    .tcp-ao-time-heading span {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .tcp-ao-time-grid {
        grid-template-columns: repeat(4, minmax(170px, 1fr));
    }

    .tcp-ao-field {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
    }

    .tcp-ao-field > label {
        color: var(--nn-color-text);
        font-size: 13px;
        font-weight: 500;
    }

    .tcp-ao-datetime-input {
        box-sizing: border-box;
        width: 100%;
        min-height: 32px;
        padding: 4px 11px;
        border: 1px solid var(--nn-color-border);
        border-radius: 4px;
        color: var(--nn-color-text);
        background: var(--nn-color-bg-container, var(--nn-color-bg-surface));
        font: inherit;
        outline: none;
    }

    .tcp-ao-datetime-input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--nn-color-primary) 18%, transparent);
    }

    .tcp-ao-datetime-input-error {
        border-color: var(--nn-color-error);
    }

    .tcp-ao-field-error,
    .tcp-ao-profile-error,
    .tcp-ao-key-error {
        color: var(--nn-color-error);
        font-size: 12px;
        line-height: 18px;
    }

    .tcp-ao-profile-error,
    .tcp-ao-key-error {
        margin-bottom: 8px;
    }

    .tcp-ao-field-hint {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 18px;
    }

    .tcp-ao-key-actions,
    .tcp-ao-list-actions {
        margin-top: 12px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    @media (max-width: 1100px) {
        .tcp-ao-key-grid,
        .tcp-ao-time-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @media (max-width: 680px) {
        .tcp-ao-profile-metadata,
        .tcp-ao-key-grid,
        .tcp-ao-time-grid {
            grid-template-columns: minmax(0, 1fr);
        }

        .tcp-ao-profile-header,
        .tcp-ao-key-header {
            align-items: flex-start;
        }
    }
</style>
