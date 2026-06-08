<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="SNMP Trap 服务器配置">
                    <a-form :model="formData" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row :gutter="24">
                            <a-col :span="24">
                                <a-form-item label="监听端口" name="port">
                                    <a-tooltip
                                        :title="validationSnmpConfigErrors.port"
                                        :open="!!validationSnmpConfigErrors.port"
                                    >
                                        <a-input
                                            v-model:value="formData.port"
                                            placeholder="请输入监听端口"
                                            :status="validationSnmpConfigErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-row :gutter="24">
                            <a-col :span="24">
                                <a-form-item label="SNMP版本" name="supportedVersions">
                                    <a-tooltip
                                        :title="validationSnmpConfigErrors.supportedVersions"
                                        :open="!!validationSnmpConfigErrors.supportedVersions"
                                    >
                                        <a-checkbox-group
                                            v-model:value="formData.supportedVersions"
                                            :status="validationSnmpConfigErrors.supportedVersions ? 'error' : ''"
                                        >
                                            <a-checkbox value="v1">SNMPv1</a-checkbox>
                                            <a-checkbox value="v2c">SNMPv2c</a-checkbox>
                                            <a-checkbox value="v3">SNMPv3</a-checkbox>
                                        </a-checkbox-group>
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <!-- SNMPv1/v2c 配置 -->
                        <a-row
                            v-if="
                                formData.supportedVersions.includes('v1') || formData.supportedVersions.includes('v2c')
                            "
                            :gutter="24"
                        >
                            <a-col :span="24">
                                <a-card title="SNMPv1/v2c 配置" class="mt-margin-top-10">
                                    <a-form-item label="Community" name="community">
                                        <a-tooltip
                                            :title="validationSnmpConfigErrors.community"
                                            :open="!!validationSnmpConfigErrors.community"
                                        >
                                            <a-input
                                                v-model:value="formData.community"
                                                placeholder="请输入Community字符串"
                                                allow-clear
                                                :status="validationSnmpConfigErrors.community ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>
                                </a-card>
                            </a-col>
                        </a-row>

                        <!-- SNMPv3 配置 -->
                        <a-row v-if="formData.supportedVersions.includes('v3')" :gutter="24">
                            <a-col :span="24">
                                <a-card title="SNMPv3 配置" class="mt-margin-top-10">
                                    <a-form-item label="用户名" name="v3Username">
                                        <a-tooltip
                                            :title="validationSnmpConfigErrors.v3Username"
                                            :open="!!validationSnmpConfigErrors.v3Username"
                                        >
                                            <a-input
                                                v-model:value="formData.v3Username"
                                                placeholder="请输入SNMPv3用户名"
                                                allow-clear
                                                :status="validationSnmpConfigErrors.v3Username ? 'error' : ''"
                                            />
                                        </a-tooltip>
                                    </a-form-item>

                                    <a-form-item label="安全级别" name="securityLevel">
                                        <a-radio-group v-model:value="formData.securityLevel">
                                            <a-radio value="noAuthNoPriv">无认证无加密</a-radio>
                                            <a-radio value="authNoPriv">认证无加密</a-radio>
                                            <a-radio value="authPriv">认证加密</a-radio>
                                        </a-radio-group>
                                    </a-form-item>

                                    <div v-if="formData.securityLevel !== 'noAuthNoPriv'">
                                        <a-row>
                                            <a-col :span="12">
                                                <a-form-item label="认证协议" name="authProtocol">
                                                    <a-select
                                                        v-model:value="formData.authProtocol"
                                                        placeholder="请选择认证协议"
                                                    >
                                                        <a-select-option value="MD5">MD5</a-select-option>
                                                        <a-select-option value="SHA">SHA</a-select-option>
                                                        <a-select-option value="SHA224">SHA224</a-select-option>
                                                        <a-select-option value="SHA256">SHA256</a-select-option>
                                                        <a-select-option value="SHA384">SHA384</a-select-option>
                                                        <a-select-option value="SHA512">SHA512</a-select-option>
                                                    </a-select>
                                                </a-form-item>
                                            </a-col>
                                            <a-col :span="12">
                                                <a-form-item label="认证密码" name="authPassword">
                                                    <a-tooltip
                                                        :title="validationSnmpConfigErrors.authPassword"
                                                        :open="!!validationSnmpConfigErrors.authPassword"
                                                    >
                                                        <a-input-password
                                                            v-model:value="formData.authPassword"
                                                            placeholder="请输入认证密码"
                                                            allow-clear
                                                            :status="
                                                                validationSnmpConfigErrors.authPassword ? 'error' : ''
                                                            "
                                                        />
                                                    </a-tooltip>
                                                </a-form-item>
                                            </a-col>
                                        </a-row>
                                    </div>

                                    <div v-if="formData.securityLevel === 'authPriv'">
                                        <a-row>
                                            <a-col :span="12">
                                                <a-form-item label="加密协议" name="privProtocol">
                                                    <a-select
                                                        v-model:value="formData.privProtocol"
                                                        placeholder="请选择加密协议"
                                                    >
                                                        <a-select-option value="DES">DES</a-select-option>
                                                        <a-select-option value="AES">AES</a-select-option>
                                                        <a-select-option value="AES192">AES192</a-select-option>
                                                        <a-select-option value="AES256">AES256</a-select-option>
                                                    </a-select>
                                                </a-form-item>
                                            </a-col>
                                            <a-col :span="12">
                                                <a-form-item label="加密密码" name="privPassword">
                                                    <a-tooltip
                                                        :title="validationSnmpConfigErrors.privPassword"
                                                        :open="!!validationSnmpConfigErrors.privPassword"
                                                    >
                                                        <a-input-password
                                                            v-model:value="formData.privPassword"
                                                            placeholder="请输入加密密码"
                                                            allow-clear
                                                            :status="
                                                                validationSnmpConfigErrors.privPassword ? 'error' : ''
                                                            "
                                                        />
                                                    </a-tooltip>
                                                </a-form-item>
                                            </a-col>
                                        </a-row>
                                    </div>
                                </a-card>
                            </a-col>
                        </a-row>

                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }" class="mt-margin-top-10">
                            <a-space>
                                <a-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="isServerRunning"
                                    @click="startSnmp"
                                >
                                    启动服务
                                </a-button>
                                <a-button type="primary" danger :disabled="!isServerRunning" @click="stopSnmp">
                                    停止服务
                                </a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- 服务状态 -->
        <a-row class="mt-margin-top-10">
            <a-col :span="24">
                <a-card title="服务状态">
                    <a-descriptions :column="2" bordered>
                        <a-descriptions-item label="服务状态">
                            <a-tag :color="isServerRunning ? 'green' : 'red'">
                                {{ isServerRunning ? '运行中' : '已停止' }}
                            </a-tag>
                        </a-descriptions-item>
                        <a-descriptions-item label="监听端口">
                            {{ formData.port }}
                        </a-descriptions-item>
                        <a-descriptions-item label="支持版本">
                            <a-space>
                                <a-tag v-for="version in formData.supportedVersions" :key="version" color="blue">
                                    {{ version.toUpperCase() }}
                                </a-tag>
                            </a-space>
                        </a-descriptions-item>
                        <a-descriptions-item label="接收到的Trap数量">
                            {{ trapCount }}
                        </a-descriptions-item>
                    </a-descriptions>
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_VALUES, SNMP_SECURITY_LEVEL, SNMP_SUB_EVT_TYPES, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import { FormValidator, createSnmpConfigValidationRules } from '../../utils/validationCommon';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SnmpConfig' });

    const labelCol = { style: { width: '120px' } };
    const wrapperCol = { span: 40 };

    const serverLoading = ref(false);
    const isServerRunning = ref(false);
    const trapCount = ref(0);

    const formData = ref({
        port: DEFAULT_VALUES.DEFAULT_SNMP_PORT,
        supportedVersions: ['v2c'],
        community: DEFAULT_VALUES.DEFAULT_COMMUNITY,
        v3Username: '',
        securityLevel: SNMP_SECURITY_LEVEL.NO_AUTH_NO_PRIV,
        authProtocol: 'SHA',
        authPassword: '',
        privProtocol: 'AES',
        privPassword: ''
    });

    const validationSnmpConfigErrors = ref({
        port: '',
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

    const loadConfig = async () => {
        try {
            const result = await window.snmpApi.getSnmpConfig();
            if (result.status === 'success' && result.data) {
                formData.value = result.data;
            }
        } catch (error) {
            message.error('加载配置失败: ' + error.message);
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

    const startSnmp = async () => {
        try {
            const hasErrors = validatorSnmpConfig.validate(formData.value);
            if (hasErrors) {
                message.error('请检查输入的数据');
                return;
            }

            const payload = JSON.parse(JSON.stringify(formData.value));
            const result = await window.snmpApi.saveSnmpConfig(payload);
            if (result.status !== 'success') {
                message.error(result.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const startResult = await window.snmpApi.startSnmp(payload);
            if (startResult.status === 'success') {
                isServerRunning.value = true;
                trapCount.value = 0;
                message.success('SNMP服务启动成功');
            } else {
                message.error(startResult.msg || 'SNMP服务启动失败');
            }
        } catch (error) {
            message.error('SNMP服务启动失败: ' + error.message);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopSnmp = async () => {
        try {
            const result = await window.snmpApi.stopSnmp();

            if (result.status === 'success') {
                message.success('SNMP服务器停止成功');
                isServerRunning.value = false;
                trapCount.value = 0;
            } else {
                message.error(result.msg || 'SNMP服务停止失败');
            }
        } catch (error) {
            message.error(`SNMP服务停止出错: ${error.message}`);
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

<style scoped></style>
