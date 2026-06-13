<template>
    <div class="server-deployment-container">
        <a-card title="Linux 服务器部署" class="settings-card">
            <!-- 说明部分 -->
            <a-alert
                type="info"
                message="为什么需要部署？"
                description="某些协议功能（如 BMP 的 MD5 认证）需要在 Linux 服务器上部署代理程序。部署一次后，可供多个协议模块使用。"
                show-icon
                style="margin-bottom: 24px"
            />

            <!-- 部署配置表单 -->
            <a-form :model="deployConfig" :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <a-form-item label="Linux 服务器地址" required>
                    <a-input v-model:value="deployConfig.serverAddress" placeholder="例如: 192.168.1.100" />
                </a-form-item>

                <a-form-item label="SSH 用户名" required>
                    <a-input v-model:value="deployConfig.sshUsername" placeholder="root" />
                </a-form-item>

                <a-form-item label="SSH 密码" required>
                    <a-input-password v-model:value="deployConfig.sshPassword" />
                </a-form-item>

                <a-form-item :wrapper-col="{ offset: 6, span: 18 }">
                    <a-space>
                        <a-button type="primary" :loading="deploying" @click="deployToServer">
                            <template #icon>
                                <CloudUploadOutlined />
                            </template>
                            部署到服务器
                        </a-button>
                        <a-button :loading="testing" @click="testConnection">
                            <template #icon>
                                <ApiOutlined />
                            </template>
                            测试连接
                        </a-button>
                    </a-space>
                </a-form-item>
            </a-form>

            <!-- 部署状态 -->
            <a-card v-if="deploymentStatus" title="部署状态" style="margin-top: 24px">
                <a-descriptions bordered :column="2">
                    <a-descriptions-item label="状态">
                        <a-tag :color="deploymentStatus.success ? 'success' : 'error'">
                            {{ deploymentStatus.success ? '已部署' : '部署失败' }}
                        </a-tag>
                    </a-descriptions-item>
                    <a-descriptions-item label="部署时间">
                        {{ deploymentStatus.deployedAt ? new Date(deploymentStatus.deployedAt).toLocaleString() : '-' }}
                    </a-descriptions-item>
                    <a-descriptions-item label="服务器地址" :span="2">
                        {{ deploymentStatus.serverAddress }}
                    </a-descriptions-item>
                </a-descriptions>
            </a-card>

            <!-- 部署说明 -->
            <a-card title="部署内容" style="margin-top: 24px">
                <a-list size="small" :data-source="deploymentSteps">
                    <template #renderItem="{ item }">
                        <a-list-item>
                            <a-list-item-meta>
                                <template #avatar>
                                    <CheckCircleOutlined style="color: #52c41a; font-size: 16px" />
                                </template>
                                <template #title>{{ item }}</template>
                            </a-list-item-meta>
                        </a-list-item>
                    </template>
                </a-list>

                <a-alert
                    type="success"
                    message="只需部署一次"
                    description="部署完成后，代理程序会一直运行在 Linux 服务器上。除非更换服务器或需要更新代理程序，否则不需要重新部署。"
                    show-icon
                    style="margin-top: 16px"
                />
            </a-card>

            <!-- 数据流向 -->
            <a-card title="数据流向" style="margin-top: 24px">
                <pre style="background: #f5f5f5; padding: 16px; border-radius: 4px; overflow-x: auto">
┌─────────────────────────┐
│      Router             │  路由器主动连接
│                         │
└────────┬────────────────┘
         │ TCP + MD5 签名
         ↓
┌─────────────────────────┐
│  Linux Server           │  验证 MD5 并转发
│                         │
│  tcp-md5-helper         │
└────────┬────────────────┘
         │ SSH 加密转发
         ↓
┌─────────────────────────┐
│  Windows App            │  接收并处理数据
│                         │
└─────────────────────────┘
                </pre>

                <a-descriptions bordered :column="1" size="small">
                    <a-descriptions-item label="步骤 1">
                        BMP 路由器连接到 Linux 服务器的指定端口（带 MD5 签名）
                    </a-descriptions-item>
                    <a-descriptions-item label="步骤 2">Linux 代理验证 MD5 签名，接受连接</a-descriptions-item>
                    <a-descriptions-item label="步骤 3">数据通过 SSH 转发加密传输到 Windows</a-descriptions-item>
                    <a-descriptions-item label="步骤 4">Windows BMP 应用接收并处理 BMP 数据</a-descriptions-item>
                </a-descriptions>
            </a-card>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import CloudUploadOutlined from '@ant-design/icons-vue/es/icons/CloudUploadOutlined';
    import ApiOutlined from '@ant-design/icons-vue/es/icons/ApiOutlined';
    import CheckCircleOutlined from '@ant-design/icons-vue/es/icons/CheckCircleOutlined';

    defineOptions({
        name: 'ServerDeployment'
    });

    const deployConfig = ref({
        serverAddress: '',
        sshUsername: '',
        sshPassword: ''
    });

    const deploying = ref(false);
    const testing = ref(false);
    const deploymentStatus = ref(null);

    const deploymentSteps = [
        '安装 gcc 编译器',
        '上传代理程序源码',
        '编译代理程序',
        '配置自动启动脚本',
        '配置防火墙规则'
    ];

    // 加载保存的配置
    onMounted(async () => {
        try {
            const saved = await window.commonApi.loadDeploymentConfig();
            if (saved.status === 'success' && saved.data) {
                deployConfig.value = { ...deployConfig.value, ...saved.data };
                deploymentStatus.value = saved.data.deploymentStatus || null;
            }
        } catch (error) {
            console.error('Failed to load deployment config:', error);
        }
    });

    // 测试连接
    const testConnection = async () => {
        if (!deployConfig.value.serverAddress || !deployConfig.value.sshUsername || !deployConfig.value.sshPassword) {
            message.error('请填写完整的服务器信息');
            return;
        }

        testing.value = true;
        try {
            message.info('正在测试 SSH 连接...');
            const payload = JSON.parse(JSON.stringify(deployConfig.value));
            const result = await window.commonApi.testSSHConnection(payload);

            if (result.status === 'success') {
                message.success('SSH 连接测试成功！');
            } else {
                message.error(result.msg || 'SSH 连接测试失败');
            }
        } catch (error) {
            message.error(`测试失败: ${error.message}`);
        } finally {
            testing.value = false;
        }
    };

    // 部署到服务器
    const deployToServer = async () => {
        if (!deployConfig.value.serverAddress || !deployConfig.value.sshUsername || !deployConfig.value.sshPassword) {
            message.error('请填写完整的部署信息');
            return;
        }

        deploying.value = true;
        try {
            message.info('正在部署到 Linux 服务器...');
            const payload = JSON.parse(JSON.stringify(deployConfig.value));
            const result = await window.commonApi.deployServer(payload);

            if (result.status === 'success') {
                message.success('部署成功！');

                // 保存部署配置和状态
                deploymentStatus.value = {
                    success: true,
                    deployedAt: new Date().toISOString(),
                    serverAddress: deployConfig.value.serverAddress
                };

                await window.commonApi.saveDeploymentConfig({
                    serverAddress: deployConfig.value.serverAddress,
                    sshUsername: deployConfig.value.sshUsername,
                    sshPassword: deployConfig.value.sshPassword,
                    deploymentStatus: JSON.parse(JSON.stringify(deploymentStatus.value))
                });
            } else {
                message.error(result.msg || '部署失败');
                deploymentStatus.value = {
                    success: false,
                    deployedAt: new Date().toISOString(),
                    serverAddress: deployConfig.value.serverAddress
                };
            }
        } catch (error) {
            message.error(`部署出错: ${error.message}`);
        } finally {
            deploying.value = false;
        }
    };
</script>

<style scoped>
    .server-deployment-container {
        max-width: 100%;
    }

    pre {
        font-family: 'Courier New', monospace;
        line-height: 1.6;
    }
</style>
