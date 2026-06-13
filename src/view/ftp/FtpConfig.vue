<template>
    <div class="mt-container adaptive-list-page">
        <a-row class="adaptive-form-row">
            <a-col :span="24">
                <a-card title="FTP服务器配置">
                    <a-form :model="ftpConfig" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row>
                            <a-col :span="24">
                                <a-form-item label="服务器端口" name="port">
                                    <a-tooltip
                                        :title="validationFtpConfigErrors.port"
                                        :open="!!validationFtpConfigErrors.port"
                                    >
                                        <a-input
                                            v-model:value="ftpConfig.port"
                                            :status="validationFtpConfigErrors.port ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button
                                    type="primary"
                                    :loading="serverLoading"
                                    :disabled="serverRunning"
                                    @click="startFtp"
                                >
                                    启动服务器
                                </a-button>
                                <a-button type="primary" danger :disabled="!serverRunning" @click="stopFtp">
                                    停止服务器
                                </a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- 用户配置 -->
        <a-row class="adaptive-form-row">
            <a-col :span="24">
                <a-card title="用户配置">
                    <a-form :model="ftpUserConfig" :label-col="labelCol" :wrapper-col="wrapperCol">
                        <a-row>
                            <a-col :span="8">
                                <a-form-item label="根目录" name="rootDir">
                                    <a-tooltip
                                        :title="validationFtpUserErrors.rootDir"
                                        :open="!!validationFtpUserErrors.rootDir"
                                    >
                                        <a-input-group compact>
                                            <a-input
                                                v-model:value="ftpUserConfig.rootDir"
                                                :status="validationFtpUserErrors.rootDir ? 'error' : ''"
                                                style="width: calc(100% - 40px)"
                                                readonly
                                            />
                                            <a-button type="primary" @click="selectDirectory">
                                                <folder-outlined />
                                            </a-button>
                                        </a-input-group>
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="用户名" name="username">
                                    <a-tooltip
                                        :title="validationFtpUserErrors.username"
                                        :open="!!validationFtpUserErrors.username"
                                    >
                                        <a-input
                                            v-model:value="ftpUserConfig.username"
                                            :status="validationFtpUserErrors.username ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                            <a-col :span="8">
                                <a-form-item label="密码" name="password">
                                    <a-tooltip
                                        :title="validationFtpUserErrors.password"
                                        :open="!!validationFtpUserErrors.password"
                                    >
                                        <a-input-password
                                            v-model:value="ftpUserConfig.password"
                                            :status="validationFtpUserErrors.password ? 'error' : ''"
                                        />
                                    </a-tooltip>
                                </a-form-item>
                            </a-col>
                        </a-row>
                        <a-form-item :wrapper-col="{ offset: 10, span: 20 }">
                            <a-space>
                                <a-button type="primary" @click="addUser">添加用户</a-button>
                                <a-button type="default" @click="showUserList">用户列表</a-button>
                            </a-space>
                        </a-form-item>
                    </a-form>
                </a-card>
            </a-col>
        </a-row>

        <!-- FTP客户端列表 -->
        <a-row class="adaptive-list-row">
            <a-col :span="24">
                <a-card title="FTP客户端列表" class="adaptive-list-card">
                    <div>
                        <a-table
                            :columns="clientColumns"
                            :data-source="clientList"
                            :row-key="record => `${record.remoteIp}|${record.remotePort}`"
                            :pagination="{
                                pageSize: 20,
                                showSizeChanger: false,
                                position: ['bottomCenter'],
                                showTotal: total => '共 ' + total + ' 条，每页 20 条'
                            }"
                            :scroll="{ y: '100%' }"
                            size="small"
                            class="adaptive-table"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'action'">
                                    <a-button type="link" @click="viewClientDetails(record)">详情</a-button>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </a-card>
            </a-col>
        </a-row>

        <!-- 用户列表弹窗 -->
        <a-modal
            v-model:open="userListModalVisible"
            title="用户列表"
            :mask-closable="false"
            class="modal-xlarge"
            @cancel="closeUserListModal"
        >
            <div>
                <a-table
                    :columns="userListColumns"
                    :data-source="userList"
                    :pagination="{
                        pageSize: 20,
                        showSizeChanger: false,
                        position: ['bottomCenter'],
                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                    }"
                    :scroll="{ y: 200 }"
                    size="small"
                >
                    <template #bodyCell="{ column, record, index }">
                        <template v-if="column.key === 'password'">
                            <span
                                :title="passwordVisibility[index] ? '点击隐藏密码' : '点击显示密码'"
                                @click="togglePasswordVisibility(index)"
                            >
                                {{ passwordVisibility[index] ? record.password : '****' }}
                            </span>
                        </template>
                        <template v-if="column.key === 'action'">
                            <a-button type="link" @click="loadUserItem(record)">使用</a-button>
                            <a-button type="link" danger @click="deleteUser(record)">删除</a-button>
                        </template>
                    </template>
                </a-table>
            </div>
            <template #footer>
                <a-button type="primary" @click="closeUserListModal">关闭</a-button>
            </template>
        </a-modal>
    </div>
</template>

<script setup>
    import { ref, onMounted, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import FolderOutlined from '@ant-design/icons-vue/es/icons/FolderOutlined';
    import {
        FormValidator,
        createFtpConfigValidationRules,
        createFtpUserValidationRules
    } from '../../utils/validationCommon';
    import { DEFAULT_VALUES, FTP_SUB_EVT_TYPES, FTP_EVENT_PAGE_ID } from '../../const/ftpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({
        name: 'FtpConfig'
    });

    const labelCol = { style: { width: '100px' } };
    const wrapperCol = { span: 40 };

    const ftpConfig = ref({
        port: DEFAULT_VALUES.DEFAULT_FTP_PORT
    });

    const ftpUserConfig = ref({
        rootDir: DEFAULT_VALUES.DEFAULT_FTP_ROOT_DIR,
        username: DEFAULT_VALUES.DEFAULT_FTP_USERNAME,
        password: DEFAULT_VALUES.DEFAULT_FTP_PASSWORD
    });

    const serverLoading = ref(false);
    const serverRunning = ref(false);

    // 客户端列表
    const clientList = ref([]);
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
            title: '用户名',
            dataIndex: 'username',
            key: 'username',
            ellipsis: true
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            ellipsis: true
        },
        {
            title: '连接时间',
            dataIndex: 'connectedTime',
            key: 'connectedTime',
            ellipsis: true
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    const validationFtpUserErrors = ref({
        rootDir: '',
        username: '',
        password: ''
    });

    const validationFtpConfigErrors = ref({
        port: ''
    });

    let validatorFtpConfig = new FormValidator(validationFtpConfigErrors);
    validatorFtpConfig.addRules(createFtpConfigValidationRules());

    let validatorFtpUser = new FormValidator(validationFtpUserErrors);
    validatorFtpUser.addRules(createFtpUserValidationRules());

    const startFtp = async () => {
        let hasErrors = validatorFtpConfig.validate(ftpConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }

        hasErrors = validatorFtpUser.validate(ftpUserConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }

        try {
            const ftpConfigPayload = JSON.parse(JSON.stringify(ftpConfig.value));
            const saveResult = await window.ftpApi.saveFtpConfig(ftpConfigPayload);
            if (saveResult.status !== 'success') {
                message.error(saveResult.msg || '配置文件保存失败');
                return;
            }

            serverLoading.value = true;

            const ftpUserConfigPayload = JSON.parse(JSON.stringify(ftpUserConfig.value));
            const result = await window.ftpApi.startFtp(ftpConfigPayload, ftpUserConfigPayload);

            if (result.status === 'success') {
                message.success('FTP服务器启动成功');
                serverRunning.value = true;
            } else {
                message.error(result.msg || 'FTP服务器启动失败');
            }
        } catch (error) {
            message.error(`FTP服务器启动出错: ${error.message}`);
        } finally {
            serverLoading.value = false;
        }
    };

    // 暴露清空验证错误的方法给父组件
    defineExpose({
        clearValidationErrors: () => {
            if (validatorFtpConfig) {
                validatorFtpConfig.clearErrors();
            }
            if (validatorFtpUser) {
                validatorFtpUser.clearErrors();
            }
        }
    });

    const stopFtp = async () => {
        try {
            const result = await window.ftpApi.stopFtp();

            if (result.status === 'success') {
                message.success('FTP服务器停止成功');
                serverRunning.value = false;
                clientList.value = [];
            } else {
                message.error(result.msg || 'FTP服务器停止失败');
            }
        } catch (error) {
            message.error(`FTP服务器停止出错: ${error.message}`);
        }
    };

    const onFtpEvt = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data.type === FTP_SUB_EVT_TYPES.FTP_SUB_EVT_CONNCET) {
                if (data.opType === 'add') {
                    clientList.value = [...clientList.value, data.data];
                } else if (data.opType === 'remove') {
                    // 断开连接
                    clientList.value = clientList.value.filter(
                        client =>
                            !(client.remoteIp === data.data.remoteIp && client.remotePort === data.data.remotePort)
                    );
                } else if (data.event === 'update') {
                    // 更新客户端状态
                    const index = clientList.value.findIndex(
                        client => client.remoteIp === data.data.remoteIp && client.remotePort === data.data.remotePort
                    );

                    if (index !== -1) {
                        const newList = [...clientList.value];
                        newList[index] = data.data;
                        clientList.value = newList;
                    }
                }
            }
        }
    };

    const selectDirectory = async () => {
        try {
            const result = await window.commonApi.selectDirectory();
            if (result.status === 'success') {
                const data = result.data;
                if (data.filePaths && data.filePaths.length > 0) {
                    ftpUserConfig.value.rootDir = data.filePaths[0];
                }
            }
        } catch (error) {
            message.error(`选择目录失败: ${error.message}`);
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.ftpApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;
            }
        } catch (error) {
            console.error(error);
            message.error('加载数据失败');
        }
    };

    onActivated(async () => {
        EventBus.on('ftp:event', FTP_EVENT_PAGE_ID.PAGE_ID_FTP_CONFIG, onFtpEvt);
        await loadClientList();
    });

    onDeactivated(() => {
        EventBus.off('ftp:event', FTP_EVENT_PAGE_ID.PAGE_ID_FTP_CONFIG);
    });

    onMounted(async () => {
        try {
            // 加载配置
            const result = await window.ftpApi.getFtpConfig();
            if (result.status === 'success' && result.data) {
                ftpConfig.value = result.data;
            }

            const userListResult = await window.ftpApi.getFtpUserList();
            if (userListResult.status === 'success' && userListResult.data && userListResult.data.length > 0) {
                ftpUserConfig.value = userListResult.data[0];
            }
        } catch (error) {
            console.error('初始化FTP配置出错:', error);
        }
    });

    const addUser = async () => {
        let hasErrors = validatorFtpUser.validate(ftpUserConfig.value);
        if (hasErrors) {
            message.error('请检查配置信息是否正确');
            return;
        }
        const payload = JSON.parse(JSON.stringify(ftpUserConfig.value));
        const result = await window.ftpApi.addFtpUser(payload);
        if (result.status === 'success') {
            message.success(result.msg || '用户添加成功');
        } else {
            message.error(result.msg || '用户添加失败');
        }
    };

    const showUserList = async () => {
        const result = await window.ftpApi.getFtpUserList();
        if (result.status === 'success') {
            userList.value = result.data || [];
            // 初始化密码显示状态数组，默认都隐藏
            passwordVisibility.value = new Array(userList.value.length).fill(false);
            userListModalVisible.value = true;
        } else {
            message.error(result.msg || '用户列表获取失败');
        }
    };

    // 用户列表相关状态
    const userList = ref([]);
    const userListModalVisible = ref(false);
    const passwordVisibility = ref([]);
    const userListColumns = [
        {
            title: '根目录',
            dataIndex: 'rootDir',
            key: 'rootDir'
        },
        {
            title: '用户名',
            dataIndex: 'username',
            key: 'username'
        },
        {
            title: '密码',
            dataIndex: 'password',
            key: 'password'
        },
        {
            title: '操作',
            key: 'action'
        }
    ];

    // 关闭用户列表弹窗
    const closeUserListModal = () => {
        userListModalVisible.value = false;
    };

    // 切换密码显示状态
    const togglePasswordVisibility = index => {
        passwordVisibility.value[index] = !passwordVisibility.value[index];
    };

    // 加载用户列表项
    const loadUserItem = record => {
        if (!record) return;

        // 更新表单数据
        ftpUserConfig.value = {
            rootDir: record.rootDir || '',
            username: record.username || '',
            password: record.password || ''
        };

        // 关闭弹窗
        closeUserListModal();
    };

    const deleteUser = async record => {
        const payload = JSON.parse(JSON.stringify(record));
        const result = await window.ftpApi.deleteFtpUser(payload);
        if (result.status === 'success') {
            message.success(result.msg || '用户删除成功');
            // 删除用户后，更新用户列表
            const deletedIndex = userList.value.findIndex(item => item.username === record.username);
            userList.value = userList.value.filter(item => item.username !== record.username);
            // 同时更新密码显示状态数组
            if (deletedIndex !== -1) {
                passwordVisibility.value.splice(deletedIndex, 1);
            }
        } else {
            message.error(result.msg || '用户删除失败');
        }
    };

    const viewClientDetails = _record => {
        // todo
    };
</script>

<style scoped>
    .adaptive-list-page {
        height: calc(100vh - 70px);
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
    }

    .adaptive-form-row {
        flex: 0 0 auto;
    }

    .adaptive-list-row {
        flex: 1 1 0;
        min-height: 0;
    }

    .adaptive-list-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .adaptive-list-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-list-card :deep(.ant-card-body),
    .adaptive-list-card :deep(.ant-card-body > div) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.ant-spin-nested-loading),
    .adaptive-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
    }

    .adaptive-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.ant-table-container),
    .adaptive-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
