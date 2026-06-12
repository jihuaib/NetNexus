<template>
    <div class="mt-container adaptive-config-page">
        <!-- 服务器配置 -->
        <a-row class="adaptive-config-row">
            <a-col :span="24">
                <a-card title="DHCP服务器配置">
                    <a-form :model="dhcpConfig" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row>
                            <a-col :span="6">
                                <a-form-item label="服务器IP">
                                    <a-input v-model:value="dhcpConfig.serverIp" placeholder="留空自动探测" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="监听端口">
                                    <a-tooltip
                                        :title="validationErrors.serverPort"
                                        :open="!!validationErrors.serverPort"
                                    >
                                        <a-input-number
                                            v-model:value="dhcpConfig.serverPort"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :status="validationErrors.serverPort ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="子网掩码">
                                    <a-tooltip
                                        :title="validationErrors.subnetMask"
                                        :open="!!validationErrors.subnetMask"
                                    >
                                        <a-input
                                            v-model:value="dhcpConfig.subnetMask"
                                            placeholder="255.255.255.0"
                                            :status="validationErrors.subnetMask ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="网关">
                                    <a-input v-model:value="dhcpConfig.gateway" placeholder="192.168.1.1" />
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="IP池起始">
                                    <a-tooltip :title="validationErrors.poolStart" :open="!!validationErrors.poolStart">
                                        <a-input
                                            v-model:value="dhcpConfig.poolStart"
                                            placeholder="192.168.1.100"
                                            :status="validationErrors.poolStart ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="IP池结束">
                                    <a-tooltip :title="validationErrors.poolEnd" :open="!!validationErrors.poolEnd">
                                        <a-input
                                            v-model:value="dhcpConfig.poolEnd"
                                            placeholder="192.168.1.200"
                                            :status="validationErrors.poolEnd ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="租约时间(秒)">
                                    <a-tooltip :title="validationErrors.leaseTime" :open="!!validationErrors.leaseTime">
                                        <a-input-number
                                            v-model:value="dhcpConfig.leaseTime"
                                            :min="60"
                                            :max="2592000"
                                            style="width: 100%"
                                            :status="validationErrors.leaseTime ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="DNS服务器1">
                                    <a-input v-model:value="dhcpConfig.dns1" placeholder="8.8.8.8" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="DNS服务器2">
                                    <a-input v-model:value="dhcpConfig.dns2" placeholder="8.8.4.4" />
                                </a-form-item>
                            </a-col>
                        </a-row>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- DHCPv6 配置 -->
        <a-row class="adaptive-config-fill-row">
            <a-col :span="24">
                <a-card title="DHCPv6配置" class="adaptive-config-fill-card">
                    <a-form :model="dhcp6Config" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row>
                            <a-col :span="6">
                                <a-form-item label="IPv6池起始">
                                    <a-input v-model:value="dhcp6Config.poolStart" placeholder="2001:db8::100" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="IPv6池结束">
                                    <a-input v-model:value="dhcp6Config.poolEnd" placeholder="2001:db8::1ff" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="监听端口">
                                    <a-tooltip
                                        :title="validationErrors.v6ServerPort"
                                        :open="!!validationErrors.v6ServerPort"
                                    >
                                        <a-input-number
                                            v-model:value="dhcp6Config.serverPort"
                                            :min="1"
                                            :max="65535"
                                            style="width: 100%"
                                            :status="validationErrors.v6ServerPort ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="6">
                                <a-form-item label="首选生命周期">
                                    <a-input-number
                                        v-model:value="dhcp6Config.preferredLifetime"
                                        :min="60"
                                        style="width: 100%"
                                        addon-after="秒"
                                    />
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="有效生命周期">
                                    <a-input-number
                                        v-model:value="dhcp6Config.validLifetime"
                                        :min="60"
                                        style="width: 100%"
                                        addon-after="秒"
                                    />
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="DNS服务器1">
                                    <a-input v-model:value="dhcp6Config.dns1" placeholder="2001:4860:4860::8888" />
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="DNS服务器2">
                                    <a-input v-model:value="dhcp6Config.dns2" placeholder="2001:4860:4860::8844" />
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <div style="margin-top: 8px; color: rgba(0, 0, 0, 0.45)">
                            非标准监听端口仅适用于测试或自定义客户端。真实 DHCP/DHCPv6 客户端通常固定访问 67/547 端口。
                        </div>
                        <div style="margin-top: 12px; display: flex; justify-content: center">
                            <a-space>
                                <a-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                    @click="startDhcp"
                                >
                                    启动服务器
                                </a-button>
                                <a-button type="primary" danger :disabled="!serverRunning" @click="stopDhcp">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </div>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_VALUES, DEFAULT_V6_VALUES } from '../../const/dhcpConst';

    defineOptions({ name: 'DhcpConfig' });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const dhcpConfig = ref({
        serverPort: DEFAULT_VALUES.DEFAULT_SERVER_PORT,
        serverIp: '',
        poolStart: DEFAULT_VALUES.DEFAULT_POOL_START,
        poolEnd: DEFAULT_VALUES.DEFAULT_POOL_END,
        subnetMask: DEFAULT_VALUES.DEFAULT_SUBNET_MASK,
        gateway: DEFAULT_VALUES.DEFAULT_GATEWAY,
        dns1: DEFAULT_VALUES.DEFAULT_DNS1,
        dns2: DEFAULT_VALUES.DEFAULT_DNS2,
        leaseTime: DEFAULT_VALUES.DEFAULT_LEASE_TIME
    });

    const dhcp6Config = ref({
        serverPort: DEFAULT_V6_VALUES.DEFAULT_V6_SERVER_PORT,
        poolStart: DEFAULT_V6_VALUES.DEFAULT_V6_POOL_START,
        poolEnd: DEFAULT_V6_VALUES.DEFAULT_V6_POOL_END,
        preferredLifetime: DEFAULT_V6_VALUES.DEFAULT_V6_PREFERRED_LIFETIME,
        validLifetime: DEFAULT_V6_VALUES.DEFAULT_V6_VALID_LIFETIME,
        dns1: DEFAULT_V6_VALUES.DEFAULT_V6_DNS1,
        dns2: DEFAULT_V6_VALUES.DEFAULT_V6_DNS2
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);

    const validationErrors = ref({
        serverPort: '',
        poolStart: '',
        poolEnd: '',
        subnetMask: '',
        leaseTime: '',
        v6ServerPort: ''
    });

    const validateConfig = () => {
        const errors = {};
        const ipReg = /^(\d{1,3}\.){3}\d{1,3}$/;
        const v4Port = Number(dhcpConfig.value.serverPort);
        const v6Port = Number(dhcp6Config.value.serverPort);

        if (!ipReg.test(dhcpConfig.value.poolStart)) {
            errors.poolStart = '请输入有效的IP地址';
        }
        if (!ipReg.test(dhcpConfig.value.poolEnd)) {
            errors.poolEnd = '请输入有效的IP地址';
        }
        if (!ipReg.test(dhcpConfig.value.subnetMask)) {
            errors.subnetMask = '请输入有效的子网掩码';
        }
        if (!Number.isInteger(v4Port) || v4Port < 1 || v4Port > 65535) {
            errors.serverPort = '端口范围1-65535';
        }
        if (!dhcpConfig.value.leaseTime || dhcpConfig.value.leaseTime < 60) {
            errors.leaseTime = '租约时间不能小于60秒';
        }
        if (!Number.isInteger(v6Port) || v6Port < 1 || v6Port > 65535) {
            errors.v6ServerPort = '端口范围1-65535';
        }

        validationErrors.value = errors;
        return Object.keys(errors).length === 0;
    };

    const startDhcp = async () => {
        if (!validateConfig()) {
            message.error('请检查配置信息是否正确');
            return;
        }

        try {
            const config = JSON.parse(JSON.stringify(dhcpConfig.value));
            config.v6 = JSON.parse(JSON.stringify(dhcp6Config.value));
            const saveResult = await window.dhcpApi.saveDhcpConfig(config);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置保存失败');
                return;
            }

            serverLoading.value = true;
            const result = await window.dhcpApi.startDhcp(config);

            if (result.status === 'success') {
                message.success('DHCP服务器启动成功');
                serverRunning.value = true;
            } else {
                message.error(result.msg || 'DHCP服务器启动失败');
            }
        } catch (error) {
            message.error(`DHCP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    const stopDhcp = async () => {
        try {
            const result = await window.dhcpApi.stopDhcp();
            if (result.status === 'success') {
                message.success('DHCP服务器已停止');
                serverRunning.value = false;
            } else {
                message.error(result.msg || 'DHCP服务器停止失败');
            }
        } catch (error) {
            message.error(`DHCP服务器停止出错: ${error.message}`);
        }
    };

    defineExpose({
        clearValidationErrors: () => {
            validationErrors.value = {
                serverPort: '',
                poolStart: '',
                poolEnd: '',
                subnetMask: '',
                leaseTime: '',
                v6ServerPort: ''
            };
        }
    });

    onMounted(async () => {
        try {
            const result = await window.dhcpApi.getDhcpConfig();
            if (result.status === 'success' && result.data) {
                const saved = result.data;
                const { v6, ...v4Config } = saved;
                dhcpConfig.value = {
                    serverPort: DEFAULT_VALUES.DEFAULT_SERVER_PORT,
                    serverIp: '',
                    poolStart: DEFAULT_VALUES.DEFAULT_POOL_START,
                    poolEnd: DEFAULT_VALUES.DEFAULT_POOL_END,
                    subnetMask: DEFAULT_VALUES.DEFAULT_SUBNET_MASK,
                    gateway: DEFAULT_VALUES.DEFAULT_GATEWAY,
                    dns1: DEFAULT_VALUES.DEFAULT_DNS1,
                    dns2: DEFAULT_VALUES.DEFAULT_DNS2,
                    leaseTime: DEFAULT_VALUES.DEFAULT_LEASE_TIME,
                    ...v4Config
                };
                if (v6) {
                    dhcp6Config.value = {
                        serverPort: DEFAULT_V6_VALUES.DEFAULT_V6_SERVER_PORT,
                        poolStart: DEFAULT_V6_VALUES.DEFAULT_V6_POOL_START,
                        poolEnd: DEFAULT_V6_VALUES.DEFAULT_V6_POOL_END,
                        preferredLifetime: DEFAULT_V6_VALUES.DEFAULT_V6_PREFERRED_LIFETIME,
                        validLifetime: DEFAULT_V6_VALUES.DEFAULT_V6_VALID_LIFETIME,
                        dns1: DEFAULT_V6_VALUES.DEFAULT_V6_DNS1,
                        dns2: DEFAULT_V6_VALUES.DEFAULT_V6_DNS2,
                        ...v6
                    };
                }
            }
        } catch (error) {
            console.error('加载DHCP配置出错:', error);
        }
    });
</script>

<style scoped>
    .adaptive-config-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-config-row {
        flex: 0 0 auto;
    }

    .adaptive-config-fill-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-config-fill-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-config-fill-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-config-fill-card :deep(.ant-card-body) {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
</style>
