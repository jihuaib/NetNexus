<template>
    <div class="nn-container snmp-config-page">
        <div class="snmp-config-layout">
            <div class="snmp-config-stack">
                <nn-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol" class="snmp-config-form">
                    <nn-card title="查询目标" class="snmp-config-card query-target-card">
                        <nn-row :gutter="12">
                            <nn-col :span="12">
                                <nn-form-item label="目标地址" name="targetHost">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.targetHost"
                                        :open="!!validationSnmpConfigErrors.targetHost"
                                    >
                                        <nn-input
                                            v-model:value="formData.targetHost"
                                            :disabled="snmpRuntime.running || runtimeLoading"
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
                                            :disabled="snmpRuntime.running || runtimeLoading"
                                            placeholder="请输入查询端口"
                                            :status="validationSnmpConfigErrors.queryPort ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <div class="service-control-row snmp-runtime-actions" data-testid="snmp-runtime-actions">
                            <nn-button
                                type="primary"
                                :loading="runtimeLoading && !snmpRuntime.running"
                                :disabled="
                                    configLoading || !snmpRuntime.initialized || snmpRuntime.running || runtimeLoading
                                "
                                aria-label="启动SNMP进程"
                                data-testid="snmp-runtime-start-button"
                                @click="startSnmpProcess"
                            >
                                启动进程
                            </nn-button>
                            <nn-button
                                type="primary"
                                danger
                                :loading="runtimeLoading && snmpRuntime.running"
                                :disabled="!snmpRuntime.running || runtimeLoading"
                                aria-label="停止SNMP进程"
                                data-testid="snmp-runtime-stop-button"
                                @click="stopSnmpProcess"
                            >
                                停止进程
                            </nn-button>
                        </div>
                    </nn-card>

                    <nn-card
                        title="Trap 服务与协议认证"
                        class="snmp-config-card trap-auth-card trap-service-card protocol-card"
                    >
                        <nn-row :gutter="12">
                            <nn-col :span="8">
                                <nn-form-item label="Trap端口" name="port">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.port"
                                        :open="!!validationSnmpConfigErrors.port"
                                    >
                                        <nn-input
                                            v-model:value="formData.port"
                                            :disabled="snmpRuntime.trapRunning || trapLoading"
                                            placeholder="请输入Trap端口"
                                            :status="validationSnmpConfigErrors.port ? 'error' : ''"
                                        />
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>
                        <div class="card-section-title">协议认证</div>
                        <nn-row :gutter="12">
                            <nn-col :span="24">
                                <nn-form-item label="SNMP版本" name="supportedVersions">
                                    <nn-tooltip
                                        :title="validationSnmpConfigErrors.supportedVersions"
                                        :open="!!validationSnmpConfigErrors.supportedVersions"
                                    >
                                        <nn-radio-group
                                            v-model:value="selectedSnmpVersion"
                                            :disabled="snmpRuntime.running || runtimeLoading"
                                            class="version-radio-group"
                                        >
                                            <nn-radio value="v1">SNMPv1</nn-radio>
                                            <nn-radio value="v2c">SNMPv2c</nn-radio>
                                            <nn-radio value="v3">SNMPv3</nn-radio>
                                        </nn-radio-group>
                                    </nn-tooltip>
                                </nn-form-item>
                            </nn-col>
                        </nn-row>

                        <div
                            v-if="
                                formData.supportedVersions.includes('v1') || formData.supportedVersions.includes('v2c')
                            "
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
                                                :disabled="snmpRuntime.running || runtimeLoading"
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
                                                :disabled="snmpRuntime.running || runtimeLoading"
                                                placeholder="请输入SNMPv3用户名"
                                                allow-clear
                                                :status="validationSnmpConfigErrors.v3Username ? 'error' : ''"
                                            />
                                        </nn-tooltip>
                                    </nn-form-item>
                                </nn-col>
                                <nn-col :span="14">
                                    <nn-form-item label="安全级别" name="securityLevel">
                                        <nn-radio-group
                                            v-model:value="formData.securityLevel"
                                            :disabled="snmpRuntime.running || runtimeLoading"
                                            class="security-radio-group"
                                        >
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
                                        <nn-select
                                            v-model:value="formData.authProtocol"
                                            :disabled="snmpRuntime.running || runtimeLoading"
                                            placeholder="请选择认证协议"
                                        >
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
                                                :disabled="snmpRuntime.running || runtimeLoading"
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
                                        <nn-select
                                            v-model:value="formData.privProtocol"
                                            :disabled="snmpRuntime.running || runtimeLoading"
                                            placeholder="请选择加密协议"
                                        >
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
                                                :disabled="snmpRuntime.running || runtimeLoading"
                                                placeholder="请输入加密密码"
                                                allow-clear
                                                :status="validationSnmpConfigErrors.privPassword ? 'error' : ''"
                                            />
                                        </nn-tooltip>
                                    </nn-form-item>
                                </nn-col>
                            </nn-row>
                        </div>

                        <div class="service-control-row snmp-trap-actions" data-testid="snmp-trap-actions">
                            <nn-button
                                type="primary"
                                :loading="trapLoading && !snmpRuntime.trapRunning"
                                :disabled="
                                    configLoading || !snmpRuntime.ready || snmpRuntime.trapRunning || trapLoading
                                "
                                aria-label="启动Trap服务"
                                data-testid="snmp-trap-start-button"
                                @click="startTrapService"
                            >
                                启动服务
                            </nn-button>
                            <nn-button
                                type="primary"
                                danger
                                :loading="trapLoading && snmpRuntime.trapRunning"
                                :disabled="!snmpRuntime.trapRunning || trapLoading"
                                aria-label="停止Trap服务"
                                data-testid="snmp-trap-stop-button"
                                @click="stopTrapService"
                            >
                                停止服务
                            </nn-button>
                        </div>
                    </nn-card>
                </nn-form>
            </div>

            <nn-card title="运行状态" class="snmp-status-card">
                <nn-descriptions :column="1" bordered size="small" class="snmp-status-descriptions">
                    <nn-descriptions-item label="SNMP进程">
                        <nn-tag :color="runtimeStatusColor">{{ runtimeStatusText }}</nn-tag>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Trap服务">
                        <nn-tag :color="snmpRuntime.trapRunning ? 'green' : 'default'">
                            {{ snmpRuntime.trapRunning ? '运行中' : '已停止' }}
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
    import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import { notify } from '../../utils/notify';
    import { DEFAULT_VALUES, SNMP_SECURITY_LEVEL, SNMP_SUB_EVT_TYPES, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import { FormValidator, createSnmpConfigValidationRules } from '../../utils/validationCommon';
    import EventBus from '../../utils/eventBus';
    import { applySnmpRuntimeState, useSnmpRuntime } from './useSnmpRuntime';

    defineOptions({ name: 'SnmpConfig' });

    const labelCol = { style: { width: '82px' } };
    const wrapperCol = { style: { flex: 1, minWidth: 0 } };

    const configLoading = ref(true);
    const runtimeLoading = ref(false);
    const trapLoading = ref(false);
    const trapCount = ref(0);
    const lastSavedTrapPort = ref(DEFAULT_VALUES.DEFAULT_SNMP_PORT);
    const snmpRuntime = useSnmpRuntime();
    let trapCountRequestRevision = 0;
    let pageActive = false;

    const runtimeStatusText = computed(() => {
        if (snmpRuntime.ready) return '已就绪';
        if (snmpRuntime.running) return '启动中';
        return '已停止';
    });
    const runtimeStatusColor = computed(() => {
        if (snmpRuntime.ready) return 'green';
        if (snmpRuntime.running) return 'processing';
        return 'default';
    });

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

    const snmpConfigRules = createSnmpConfigValidationRules();
    const validatorSnmpConfig = new FormValidator(validationSnmpConfigErrors);
    validatorSnmpConfig.addRules(snmpConfigRules);
    const validatorSnmpProcess = new FormValidator(validationSnmpConfigErrors);
    validatorSnmpProcess.addRules(
        Object.fromEntries(Object.entries(snmpConfigRules).filter(([field]) => field !== 'port'))
    );
    const validatorSnmpTrap = new FormValidator(validationSnmpConfigErrors);
    validatorSnmpTrap.addRule('port', snmpConfigRules.port);

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
                lastSavedTrapPort.value = result.data.port || DEFAULT_VALUES.DEFAULT_SNMP_PORT;
            }
        } catch (error) {
            notify.error('加载配置失败: ' + error.message);
        } finally {
            configLoading.value = false;
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
        const requestRevision = ++trapCountRequestRevision;
        const runtimeRevision = snmpRuntime.runtimeRevision;
        if (!snmpRuntime.ready) {
            trapCount.value = 0;
            return;
        }
        try {
            const result = await window.snmpApi.getTrapList();
            if (
                requestRevision === trapCountRequestRevision &&
                runtimeRevision === snmpRuntime.runtimeRevision &&
                snmpRuntime.ready &&
                result.status === 'success'
            ) {
                trapCount.value = getTrapTotal(result.data);
            }
        } catch (error) {
            console.error(error);
        }
    };

    const buildConfigPayload = scope => {
        const payload = JSON.parse(JSON.stringify(formData.value));
        if (scope === 'process') payload.port = lastSavedTrapPort.value;
        return payload;
    };

    const getValidator = scope => {
        if (scope === 'process') return validatorSnmpProcess;
        if (scope === 'trap') return validatorSnmpTrap;
        return validatorSnmpConfig;
    };

    const saveConfig = async scope => {
        try {
            const hasErrors = getValidator(scope).validate(formData.value);
            if (hasErrors) {
                notify.error('请检查输入的数据');
                return false;
            }

            const payload = buildConfigPayload(scope);
            const result = await window.snmpApi.saveSnmpConfig(payload);
            if (result.status !== 'success') {
                notify.error(result.msg || '配置文件保存失败');
                return false;
            }

            if (scope !== 'process') lastSavedTrapPort.value = payload.port;
            return payload;
        } catch (error) {
            notify.error('配置保存失败: ' + error.message);
            return false;
        }
    };

    const startSnmpProcess = async () => {
        if (configLoading.value || !snmpRuntime.initialized || runtimeLoading.value || snmpRuntime.running) return;
        try {
            runtimeLoading.value = true;
            const payload = await saveConfig('process');
            if (!payload) {
                return;
            }

            const startResult = await window.snmpApi.startSnmp(payload);
            if (startResult.status === 'success') {
                applySnmpRuntimeState(
                    startResult.data || { running: true, ready: true, trapRunning: snmpRuntime.trapRunning }
                );
                notify.success(startResult.msg || 'SNMP进程启动成功');
            } else {
                notify.error(startResult.msg || 'SNMP进程启动失败');
            }
        } catch (error) {
            notify.error('SNMP进程启动失败: ' + error.message);
        } finally {
            runtimeLoading.value = false;
        }
    };

    const stopSnmpProcess = async () => {
        if (runtimeLoading.value || !snmpRuntime.running) return;
        try {
            runtimeLoading.value = true;
            const result = await window.snmpApi.stopSnmp();

            if (result.status === 'success') {
                applySnmpRuntimeState({ running: false, ready: false, trapRunning: false });
                notify.success(result.msg || 'SNMP进程停止成功');
            } else {
                notify.error(result.msg || 'SNMP进程停止失败');
            }
        } catch (error) {
            notify.error(`SNMP进程停止出错: ${error.message}`);
        } finally {
            runtimeLoading.value = false;
        }
    };

    const startTrapService = async () => {
        if (configLoading.value || trapLoading.value || !snmpRuntime.ready || snmpRuntime.trapRunning) return;
        try {
            trapLoading.value = true;
            const payload = await saveConfig('trap');
            if (!payload) return;

            const result = await window.snmpApi.startSnmpTrap(payload);
            if (result.status === 'success') {
                applySnmpRuntimeState(
                    result.data || {
                        running: snmpRuntime.running,
                        ready: snmpRuntime.ready,
                        trapRunning: true
                    }
                );
                notify.success(result.msg || 'Trap服务启动成功');
            } else {
                notify.error(result.msg || 'Trap服务启动失败');
            }
        } catch (error) {
            notify.error('Trap服务启动失败: ' + error.message);
        } finally {
            trapLoading.value = false;
        }
    };

    const stopTrapService = async () => {
        if (trapLoading.value || !snmpRuntime.trapRunning) return;
        try {
            trapLoading.value = true;
            const result = await window.snmpApi.stopSnmpTrap();
            if (result.status === 'success') {
                applySnmpRuntimeState(
                    result.data || {
                        running: snmpRuntime.running,
                        ready: snmpRuntime.ready,
                        trapRunning: false
                    }
                );
                notify.success(result.msg || 'Trap服务停止成功');
            } else {
                notify.error(result.msg || 'Trap服务停止失败');
            }
        } catch (error) {
            notify.error('Trap服务停止失败: ' + error.message);
        } finally {
            trapLoading.value = false;
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
            if (type === SNMP_SUB_EVT_TYPES.HISTORY_CLEARED) {
                trapCount.value = 0;
            } else if (!snmpRuntime.ready || !snmpRuntime.trapRunning) {
                return;
            } else if (type === SNMP_SUB_EVT_TYPES.TRAP_RECEIVED) {
                trapCount.value++;
            } else if (type === SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED) {
                trapCount.value += Number(payload.data?.changedCount) || 0;
            } else if (type === SNMP_SUB_EVT_TYPES.STATS_UPDATED) {
                const total = Number(payload.data?.totalTraps ?? payload.data?.historyCount);
                if (Number.isFinite(total)) {
                    trapCount.value = total;
                }
            } else if (type === SNMP_SUB_EVT_TYPES.SERVER_STATUS && payload.data?.status === 'stopped') {
                trapCount.value = 0;
            }
        }
    };

    const activatePage = async () => {
        if (pageActive) return;
        pageActive = true;
        EventBus.on('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_CONFIG, handleSnmpEvent);
        await loadTrapCount();
    };

    const deactivatePage = () => {
        if (!pageActive) return;
        pageActive = false;
        trapCountRequestRevision += 1;
        EventBus.off('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_CONFIG);
    };

    watch(
        () => snmpRuntime.runtimeRevision,
        () => {
            trapCountRequestRevision += 1;
            if (!snmpRuntime.ready) {
                trapCount.value = 0;
                return;
            }
            if (pageActive) void loadTrapCount();
        }
    );

    watch(
        () => snmpRuntime.trapRevision,
        () => {
            if (snmpRuntime.ready && snmpRuntime.trapRunning && pageActive) void loadTrapCount();
        }
    );

    onActivated(activatePage);
    onDeactivated(deactivatePage);
    onBeforeUnmount(deactivatePage);

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

    .snmp-config-stack,
    .snmp-status-card {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-stack {
        overflow-y: auto;
        padding-right: 2px;
    }

    .snmp-config-card {
        flex: 0 0 auto;
        min-width: 0;
    }

    .snmp-config-card :deep(.nn-card-body) {
        padding-bottom: 10px;
    }

    .snmp-status-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .snmp-config-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 100%;
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

    .card-section-title {
        margin: 2px 0 8px;
        padding-top: 8px;
        border-top: 1px solid var(--nn-color-border-light);
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

    .service-control-row {
        display: flex;
        min-height: 32px;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 7px;
    }

    .snmp-trap-actions {
        margin-top: 10px;
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
