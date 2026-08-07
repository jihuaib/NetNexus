<template>
    <div class="nn-container snmp-config-page">
        <div class="snmp-config-layout">
            <nn-card title="SNMP 配置" class="snmp-config-card">
                <nn-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol" class="snmp-config-form">
                    <div class="config-section">
                        <div class="config-section-title">查询目标</div>
                        <nn-row :gutter="12">
                            <nn-col :span="12">
                                <nn-form-item label="目标地址" name="targetHost">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.targetHost"
                                        :open="!!validationSnmpConfigErrors.targetHost"
                                    >
                                        <nn-input
                                            v-model:value="formData.targetHost"
                                            placeholder="例如 127.0.0.1"
                                            allow-clear
                                            :status="validationSnmpConfigErrors.targetHost ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="12">
                                <nn-form-item label="查询端口" name="queryPort">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.queryPort"
                                        :open="!!validationSnmpConfigErrors.queryPort"
                                    >
                                        <nn-input
                                            v-model:value="formData.queryPort"
                                            placeholder="请输入查询端口"
                                            :status="validationSnmpConfigErrors.queryPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                    </div>

                    <div class="config-section">
                        <div class="config-section-title">Trap服务</div>
                        <nn-row :gutter="12">
                            <nn-col :span="8">
                                <nn-form-item label="Trap端口" name="port">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.port"
                                        :open="!!validationSnmpConfigErrors.port"
                                    >
                                        <nn-input
                                            v-model:value="formData.port"
                                            placeholder="请输入Trap端口"
                                            :status="validationSnmpConfigErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="16">
                                <nn-form-item label="SNMP版本" name="supportedVersions">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.supportedVersions"
                                        :open="!!validationSnmpConfigErrors.supportedVersions"
                                    >
                                        <nn-radio-group v-model:value="selectedSnmpVersion" class="version-radio-group">
                                            <nn-radio value="v1">SNMPv1</nn-radio>
                                            <nn-radio value="v2c">SNMPv2c</nn-radio>
                                            <nn-radio value="v3">SNMPv3</nn-radio>
                                        </nn-radio-group>
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                    </div>

                    <div
                        v-if="formData.supportedVersions.includes('v1') || formData.supportedVersions.includes('v2c')"
                        class="config-section"
                    >
                        <div class="config-section-title">SNMPv1/v2c</div>
                        <nn-row :gutter="12">
                            <nn-col :span="24">
                                <nn-form-item label="Community" name="community">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.community"
                                        :open="!!validationSnmpConfigErrors.community"
                                    >
                                        <nn-input
                                            v-model:value="formData.community"
                                            placeholder="请输入Community字符串"
                                            allow-clear
                                            :status="validationSnmpConfigErrors.community ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                    </div>

                    <div v-if="formData.supportedVersions.includes('v3')" class="config-section">
                        <div class="config-section-title">SNMPv3</div>
                        <nn-row :gutter="12">
                            <nn-col :span="10">
                                <nn-form-item label="用户名" name="v3Username">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.v3Username"
                                        :open="!!validationSnmpConfigErrors.v3Username"
                                    >
                                        <nn-input
                                            v-model:value="formData.v3Username"
                                            placeholder="请输入SNMPv3用户名"
                                            allow-clear
                                            :status="validationSnmpConfigErrors.v3Username ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="14">
                                <nn-form-item label="安全级别" name="securityLevel">
                                    <nn-radio-group v-model:value="formData.securityLevel" class="security-radio-group">
                                        <nn-radio value="noAuthNoPriv">无认证无加密</nn-radio>
                                        <nn-radio value="authNoPriv">认证无加密</nn-radio>
                                        <nn-radio value="authPriv">认证加密</nn-radio>
                                    </nn-radio-group>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row v-if="formData.securityLevel !== 'noAuthNoPriv'" :gutter="12">
                            <nn-col :span="8">
                                <nn-form-item label="认证协议" name="authProtocol">
                                    <nn-select v-model:value="formData.authProtocol" placeholder="请选择认证协议">
                                        <nn-select-option value="MD5">MD5</nn-select-option>
                                        <nn-select-option value="SHA">SHA</nn-select-option>
                                        <nn-select-option value="SHA224">SHA224</nn-select-option>
                                        <nn-select-option value="SHA256">SHA256</nn-select-option>
                                        <nn-select-option value="SHA384">SHA384</nn-select-option>
                                        <nn-select-option value="SHA512">SHA512</nn-select-option>
                                    </nn-select>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="16">
                                <nn-form-item label="认证密码" name="authPassword">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.authPassword"
                                        :open="!!validationSnmpConfigErrors.authPassword"
                                    >
                                        <nn-input-password
                                            v-model:value="formData.authPassword"
                                            placeholder="请输入认证密码"
                                            allow-clear
                                            :status="validationSnmpConfigErrors.authPassword ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <nn-row v-if="formData.securityLevel === 'authPriv'" :gutter="12">
                            <nn-col :span="8">
                                <nn-form-item label="加密协议" name="privProtocol">
                                    <nn-select v-model:value="formData.privProtocol" placeholder="请选择加密协议">
                                        <nn-select-option value="DES">DES</nn-select-option>
                                        <nn-select-option value="AES">AES</nn-select-option>
                                        <nn-select-option value="AES192">AES192</nn-select-option>
                                        <nn-select-option value="AES256">AES256</nn-select-option>
                                    </nn-select>
                                </nn-form-item>
                            </nn-col>
                            <nn-col :span="16">
                                <nn-form-item label="加密密码" name="privPassword">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.privPassword"
                                        :open="!!validationSnmpConfigErrors.privPassword"
                                    >
                                        <nn-input-password
                                            v-model:value="formData.privPassword"
                                            placeholder="请输入加密密码"
                                            allow-clear
                                            :status="validationSnmpConfigErrors.privPassword ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                    </div>

                    <div class="snmp-config-actions">
                        <nn-space>
                            <nn-button :loading="saveLoading" @click="saveConfig()">保存配置</nn-button>
                            <nn-button
                                type="primary"
                                :loading="serverLoading"
                                :disabled="isServerRunning"
                                @click="startSnmp"
                            >
                                启动Trap服务
                            </nn-button>
                            <nn-button type="primary" danger :disabled="!isServerRunning" @click="stopSnmp">
                                停止Trap服务
                            </nn-button>
                        </nn-space>
                    </div>
                </nn-form>
            </nn-card>

            <nn-card title="运行状态" class="snmp-status-card">
                <nn-descriptions :column="1" bordered size="small" class="snmp-status-descriptions">
                    <nn-descriptions-item label="Trap服务">
                        <nn-tag :color="isServerRunning ? 'green' : 'red'">
                            {{ isServerRunning ? '运行中' : '已停止' }}
                        </nn-tag>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Trap端口">
                        {{ formData.port }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="查询目标">
                        {{ formData.targetHost }}:{{ formData.queryPort }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="支持版本">
                        <div class="status-version-tags">
                            <nn-tag v-for="version in formData.supportedVersions" :key="version" color="blue">
                                {{ version.toUpperCase() }}
                            </nn-tag>
                        </div>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Trap数量">
                        {{ trapCount }}
                    </nn-descriptions-item>
                </nn-descriptions>
            </nn-card>
        </div>
    </div>
</template>

<script setup>
    import { computed, ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_VALUES, SNMP_SECURITY_LEVEL, SNMP_SUB_EVT_TYPES, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import { FormValidator, createSnmpConfigValidationRules } from '../../utils/validationCommon';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SnmpConfig' });

    const labelCol = { style: { width: '82px' } };
    const wrapperCol = { style: { flex: 1, minWidth: 0 } };

    const saveLoading = ref(false);
    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const trapCount = ref(0);

    const normalizeSupportedVersions = versions => {
        const list = Array.isArray(versions) ? versions : [versions].filter(Boolean);
        if (list.includes('v2c')) {
            return ['v2c'];
        }
        if (list.includes('v1')) {
            return ['v1'];
        }
        if (list.includes('v3')) {
            return ['v3'];
        }
        return [DEFAULT_VALUES.DEFAULT_VERSION];
    };

    const formData = ref({
        targetHost: DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
        port: DEFAULT_VALUES.DEFAULT_SNMP_PORT,
        queryPort: DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT,
        supportedVersions: [DEFAULT_VALUES.DEFAULT_VERSION],
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY,
        v3Username: '',
        securityLevel: SNMP_SECURITY_LEVEL.NO_AUTH_NO_PRIV,
        authProtocol: 'SHA',
        authPassword: '',
        privProtocol: 'AES',
        privPassword: ''
    });

    const validationSnmpConfigErrors = ref({
        targetHost: '',
        port: '',
        queryPort: '',
        supportedVersions: '',
        community: '',
        v3Username: '',
        securityLevel: '',
        authProtocol: '',
        authPassword: '',
        privProtocol: '',
        privPassword: ''
    });

    // 初始化验证器
    let validatorSnmpConfig = new FormValidator(validationSnmpConfigErrors);
    validatorSnmpConfig.addRules(createSnmpConfigValidationRules());

    const selectedSnmpVersion = computed({
        get: () => normalizeSupportedVersions(formData.value.supportedVersions)[0],
        set: version => {
            formData.value.supportedVersions = version ? [version] : [];
        }
    });

    const loadConfig = async () => {
        try {
            const result = await window.snmpApi.getSnmpConfig();
            if (result.status === 'success' && result.data) {
                const storedConfig = { ...result.data };
                delete storedConfig.targetPort;
                delete storedConfig.enableQueryMonitor;
                storedConfig.supportedVersions = normalizeSupportedVersions(storedConfig.supportedVersions);
                formData.value = {
                    ...formData.value,
                    ...storedConfig,
                    targetHost: result.data.targetHost || DEFAULT_VALUES.DEFAULT_SNMP_TARGET_HOST,
                    queryPort: result.data.queryPort || DEFAULT_VALUES.DEFAULT_SNMP_QUERY_PORT
                };
            }
        } catch (error) {
            notify.error('加载配置失败: ' + error.message);
        }
    };

    const getTrapTotal = payload => {
        if (Array.isArray(payload)) {
            return payload.length;
        }

        const total = Number(payload?.totalTraps);
        if (Number.isFinite(total)) {
            return total;
        }

        return Array.isArray(payload?.list) ? payload.list.length : 0;
    };

    const loadTrapCount = async () => {
        try {
            const result = await window.snmpApi.getTrapList();
            if (result.status === 'success') {
                trapCount.value = getTrapTotal(result.data);
            }
        } catch (error) {
            console.error(error);
        }
    };

    const buildConfigPayload = () => JSON.parse(JSON.stringify(formData.value));

    const saveConfig = async (options = {}) => {
        try {
            const hasErrors = validatorSnmpConfig.validate(formData.value);
            if (hasErrors) {
                notify.error('请检查输入的数据');
                return false;
            }

            saveLoading.value = !options.silent;
            const payload = buildConfigPayload();
            const result = await window.snmpApi.saveSnmpConfig(payload);
            if (result.status !== 'success') {
                notify.error(result.msg || '配置文件保存失败');
                return false;
            }

            if (!options.silent) {
                notify.success(result.msg || '配置保存成功');
            }
            return payload;
        } catch (error) {
            notify.error('配置保存失败: ' + error.message);
            return false;
        } finally {
            saveLoading.value = false;
        }
    };

    const startSnmp = async () => {
        try {
            const payload = await saveConfig({ silent: true });
            if (!payload) {
                return;
            }

            serverLoading.value = true;

            const startResult = await window.snmpApi.startSnmp(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                trapCount.value = 0;
                notify.success('Trap服务启动成功');
            } else {
                notify.error(startResult.msg || 'Trap服务启动失败');
            }
        } catch (error) {
            notify.error('Trap服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopSnmp = async () => {
        try {
            const result = await window.snmpApi.stopSnmp();

            if (result.status === 'success') {
                notify.success('Trap服务停止成功');
                isServerRunning.value = false;
                trapCount.value = 0;
            } else {
                notify.error(result.msg || 'Trap服务停止失败');
            }
        } catch (error) {
            notify.error(`Trap服务停止出错: ${error.message}`);
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            validatorSnmpConfig.clearErrors();
        }
    });

    const handleSnmpEvent = respData => {
        if (respData.status === 'success') {
            const payload = respData.data || {};
            const type = payload.type;
            if (type === SNMP_SUB_EVT_TYPES.TRAP_RECEIVED) {
                trapCount.value++;
            } else if (type === SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED) {
                trapCount.value += Number(payload.data?.changedCount) || 0;
            } else if (type === SNMP_SUB_EVT_TYPES.STATS_UPDATED) {
                const total = Number(payload.data?.totalTraps ?? payload.data?.historyCount);
                if (Number.isFinite(total)) {
                    trapCount.value = total;
                }
            } else if (type === SNMP_SUB_EVT_TYPES.HISTORY_CLEARED) {
                trapCount.value = 0;
            } else if (type === SNMP_SUB_EVT_TYPES.SERVER_STATUS && payload.data?.status === 'stopped') {
                trapCount.value = 0;
                isServerRunning.value = false;
            }
        }
    };

    onActivated(async () => {
        EventBus.on('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_CONFIG, handleSnmpEvent);
        await loadTrapCount();
    });

    onDeactivated(() => {
        EventBus.off('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_CONFIG);
    });

    onMounted(() => {
        loadConfig();
    });
</script>

<style scoped>
    .snmp-config-page {
        height: 100%;
        overflow: hidden;
    }

    .snmp-config-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        gap: 10px;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-card,
    .snmp-status-card {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-card :deep(.nn-card-body),
    .snmp-status-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-form :deep(.nn-form-item) {
        margin-bottom: 8px;
    }

    .snmp-config-form :deep(.nn-form-item-label) {
        padding-bottom: 0;
    }

    .snmp-config-form :deep(.nn-form-item-label > label) {
        height: 32px;
    }

    .snmp-config-form :deep(.nn-radio-wrapper),
    .snmp-config-form :deep(.nn-checkbox-wrapper) {
        margin-inline-end: 12px;
        white-space: nowrap;
    }

    .config-section {
        flex-shrink: 0;
        min-width: 0;
        padding: 8px 10px 0;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .config-section-title {
        margin-bottom: 6px;
        color: var(--nn-color-text-strong);
        font-weight: 600;
        line-height: 20px;
    }

    .version-radio-group,
    .security-radio-group {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        min-height: 32px;
    }

    .snmp-config-actions {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 0 10px;
    }

    .snmp-status-descriptions :deep(.nn-descriptions-item-label) {
        width: 92px;
    }

    .status-version-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }

    .status-version-tags :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    @media (max-width: 1100px) {
        .snmp-config-layout {
            grid-template-columns: minmax(0, 1fr) 280px;
        }

        .snmp-config-form :deep(.nn-radio-wrapper),
        .snmp-config-form :deep(.nn-checkbox-wrapper) {
            margin-inline-end: 8px;
        }
    }
</style>
