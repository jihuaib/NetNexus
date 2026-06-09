<template>
    <div class="keychain-settings-container">
        <a-card title="Keychain 配置">
            <a-alert
                type="info"
                message="什么是 Keychain？"
                description="Keychain 允许配置多个密钥，每个密钥有不同的生效时间段。系统会根据当前时间自动选择有效的密钥，实现密钥的自动轮换。"
                show-icon
                style="margin-bottom: 24px"
            />

            <!-- Keychain 列表 -->
            <a-table
                :columns="keychainColumns"
                :data-source="keychains"
                :pagination="{ pageSize: 20, showSizeChanger: false, position: ['bottomCenter'], showTotal: total => '共 ' + total + ' 条，每页 20 条' }"
                :scroll="{ y: 360 }"
                :expanded-row-keys="expandedKeys"
                row-key="id"
                @expand="onExpand"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'keyCount'">
                        <a-tag>{{ record.keys.length }} 个密钥</a-tag>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-space>
                            <a-button type="link" size="small" @click="editKeychainInfo(record)">编辑</a-button>
                            <a-popconfirm title="确定删除此 Keychain？" @confirm="deleteKeychain(record.id)">
                                <a-button type="link" danger size="small">删除</a-button>
                            </a-popconfirm>
                        </a-space>
                    </template>
                </template>

                <!-- 展开的密钥列表 -->
                <template #expandedRowRender="{ record }">
                    <div style="margin: 16px 0">
                        <a-button type="primary" size="small" style="margin-bottom: 12px" @click="addKey(record)">
                            <template #icon><PlusOutlined /></template>
                            添加密钥
                        </a-button>

                        <a-table
                            :columns="keyColumns"
                            :data-source="record.keys"
                            :pagination="{ pageSize: 20, showSizeChanger: false, position: ['bottomCenter'], showTotal: total => '共 ' + total + ' 条，每页 20 条' }"
                            :scroll="{ y: 240 }"
                            size="small"
                            :row-key="key => key.keyId"
                        >
                            <template #bodyCell="{ column, record: keyRecord }">
                                <template v-if="column.key === 'password'">
                                    <span>{{ maskPassword(keyRecord.password) }}</span>
                                </template>
                                <template v-else-if="column.key === 'sendLifetime'">
                                    <span>{{ formatLifetime(keyRecord.sendLifetime) }}</span>
                                </template>
                                <template v-else-if="column.key === 'acceptLifetime'">
                                    <span>{{ formatLifetime(keyRecord.acceptLifetime) }}</span>
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <a-space>
                                        <a-button type="link" size="small" @click="editKey(record, keyRecord)">
                                            编辑
                                        </a-button>
                                        <a-popconfirm
                                            title="确定删除此密钥？"
                                            @confirm="deleteKey(record, keyRecord.keyId)"
                                        >
                                            <a-button type="link" danger size="small">删除</a-button>
                                        </a-popconfirm>
                                    </a-space>
                                </template>
                            </template>
                        </a-table>
                    </div>
                </template>
            </a-table>

            <a-button type="dashed" block style="margin-top: 16px" @click="addKeychain">
                <template #icon><PlusOutlined /></template>
                添加 Keychain
            </a-button>
        </a-card>

        <!-- Keychain 信息编辑对话框 -->
        <a-modal
            v-model:open="keychainDialogVisible"
            :title="editingKeychainId ? '编辑 Keychain' : '新建 Keychain'"
            @ok="saveKeychainInfo"
        >
            <a-form :label-col="{ span: 6 }" :wrapper-col="{ span: 18 }">
                <a-form-item label="名称" required>
                    <a-input v-model:value="editingKeychainInfo.name" placeholder="例如: BMP-Keychain-1" />
                </a-form-item>
                <a-form-item label="描述">
                    <a-textarea v-model:value="editingKeychainInfo.description" :rows="3" />
                </a-form-item>
            </a-form>
        </a-modal>

        <!-- 密钥编辑对话框 -->
        <a-modal
            v-model:open="keyDialogVisible"
            :title="editingKeyId !== null ? '编辑密钥' : '添加密钥'"
            width="600px"
            @ok="saveKey"
        >
            <a-form :label-col="{ span: 8 }" :wrapper-col="{ span: 16 }">
                <a-form-item label="Key ID" required>
                    <a-input-number v-model:value="editingKey.keyId" :min="0" :max="255" style="width: 100%" />
                </a-form-item>

                <a-form-item label="算法" required>
                    <a-select v-model:value="editingKey.algorithm" style="width: 100%">
                        <a-select-option value="hmac-sha-1">HMAC-SHA-1</a-select-option>
                        <a-select-option value="hmac-sha-256">HMAC-SHA-256</a-select-option>
                    </a-select>
                </a-form-item>

                <a-form-item label="密码" required>
                    <a-input-password v-model:value="editingKey.password" />
                </a-form-item>

                <a-form-item label="发送时间段">
                    <a-space direction="vertical" style="width: 100%">
                        <a-checkbox v-model:checked="editingKey.sendLifetime.always">始终发送</a-checkbox>
                        <a-range-picker
                            v-if="!editingKey.sendLifetime.always"
                            v-model:value="editingKey.sendLifetime.range"
                            show-time
                            format="YYYY-MM-DD HH:mm:ss"
                            style="width: 100%"
                        />
                    </a-space>
                </a-form-item>

                <a-form-item label="接受时间段">
                    <a-space direction="vertical" style="width: 100%">
                        <a-checkbox v-model:checked="editingKey.acceptLifetime.always">始终接受</a-checkbox>
                        <a-range-picker
                            v-if="!editingKey.acceptLifetime.always"
                            v-model:value="editingKey.acceptLifetime.range"
                            show-time
                            format="YYYY-MM-DD HH:mm:ss"
                            style="width: 100%"
                        />
                    </a-space>
                </a-form-item>
            </a-form>
        </a-modal>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { PlusOutlined } from '@ant-design/icons-vue';
    import dayjs from 'dayjs';

    defineOptions({
        name: 'KeychainSettings'
    });

    const keychains = ref([]);
    const expandedKeys = ref([]);

    // Keychain 对话框
    const keychainDialogVisible = ref(false);
    const editingKeychainId = ref(null);
    const editingKeychainInfo = ref({ name: '', description: '' });

    // 密钥对话框
    const keyDialogVisible = ref(false);
    const editingKeychainForKey = ref(null);
    const editingKeyId = ref(null);
    const editingKey = ref({
        keyId: 0,
        algorithm: 'hmac-sha-256',
        password: '',
        sendLifetime: { always: true, range: null },
        acceptLifetime: { always: true, range: null }
    });

    const keychainColumns = [
        { title: 'Keychain 名称', dataIndex: 'name', key: 'name' },
        { title: '描述', dataIndex: 'description', key: 'description' },
        { title: '密钥数量', key: 'keyCount', width: 120 },
        { title: '操作', key: 'action', width: 150 }
    ];

    const keyColumns = [
        { title: 'Key ID', dataIndex: 'keyId', key: 'keyId', width: 80 },
        { title: '算法', dataIndex: 'algorithm', key: 'algorithm', width: 150 },
        { title: '密码', key: 'password', width: 150 },
        { title: '发送时间段', key: 'sendLifetime', width: 200 },
        { title: '接受时间段', key: 'acceptLifetime', width: 200 },
        { title: '操作', key: 'action', width: 120 }
    ];

    onMounted(async () => {
        await loadKeychains();
    });

    const loadKeychains = async () => {
        try {
            const result = await window.commonApi.loadKeychains();
            if (result.status === 'success') {
                keychains.value = result.data || [];
            }
        } catch (error) {
            message.error('加载 Keychain 失败');
        }
    };

    const onExpand = (expanded, record) => {
        if (expanded) {
            expandedKeys.value = [record.id];
        } else {
            expandedKeys.value = [];
        }
    };

    // Keychain 操作
    const addKeychain = () => {
        editingKeychainId.value = null;
        editingKeychainInfo.value = { name: '', description: '' };
        keychainDialogVisible.value = true;
    };

    const editKeychainInfo = record => {
        editingKeychainId.value = record.id;
        editingKeychainInfo.value = { name: record.name, description: record.description };
        keychainDialogVisible.value = true;
    };

    const saveKeychainInfo = async () => {
        if (!editingKeychainInfo.value.name) {
            message.error('请输入 Keychain 名称');
            return;
        }

        const keychain = editingKeychainId.value
            ? keychains.value.find(k => k.id === editingKeychainId.value)
            : { id: `kc-${Date.now()}`, keys: [], createdAt: new Date().toISOString() };

        const updatedKeychain = {
            ...keychain,
            name: editingKeychainInfo.value.name,
            description: editingKeychainInfo.value.description,
            updatedAt: new Date().toISOString()
        };

        try {
            const result = await window.commonApi.saveKeychain(updatedKeychain);
            if (result.status === 'success') {
                message.success('Keychain 保存成功');
                keychainDialogVisible.value = false;
                await loadKeychains();
            } else {
                message.error(result.msg || '保存失败');
            }
        } catch (error) {
            message.error('保存 Keychain 失败');
        }
    };

    const deleteKeychain = async id => {
        try {
            const result = await window.commonApi.deleteKeychain(id);
            if (result.status === 'success') {
                message.success('Keychain 删除成功');
                await loadKeychains();
            } else {
                message.error(result.msg || '删除失败');
            }
        } catch (error) {
            message.error('删除 Keychain 失败');
        }
    };

    // 密钥操作
    const addKey = keychain => {
        editingKeychainForKey.value = keychain;
        editingKeyId.value = null;
        editingKey.value = {
            keyId: keychain.keys.length,
            algorithm: 'hmac-sha-256',
            password: '',
            sendLifetime: { always: true, range: null },
            acceptLifetime: { always: true, range: null }
        };
        keyDialogVisible.value = true;
    };

    const editKey = (keychain, key) => {
        editingKeychainForKey.value = keychain;
        editingKeyId.value = key.keyId;
        editingKey.value = {
            keyId: key.keyId,
            algorithm: key.algorithm,
            password: key.password,
            sendLifetime: {
                always: key.sendLifetime.start === 'always',
                range:
                    key.sendLifetime.start !== 'always'
                        ? [dayjs(key.sendLifetime.start), dayjs(key.sendLifetime.end)]
                        : null
            },
            acceptLifetime: {
                always: key.acceptLifetime.start === 'always',
                range:
                    key.acceptLifetime.start !== 'always'
                        ? [dayjs(key.acceptLifetime.start), dayjs(key.acceptLifetime.end)]
                        : null
            }
        };
        keyDialogVisible.value = true;
    };

    const saveKey = async () => {
        if (!editingKey.value.password) {
            message.error('请输入密码');
            return;
        }

        // if (editingKey.value.password.length < 16) {
        //     message.error('密码至少需要 16 个字符');
        //     return;
        // }

        const keyToSave = {
            keyId: editingKey.value.keyId,
            algorithm: editingKey.value.algorithm,
            password: editingKey.value.password,
            sendLifetime: {
                start: editingKey.value.sendLifetime.always
                    ? 'always'
                    : editingKey.value.sendLifetime.range[0].toISOString(),
                end: editingKey.value.sendLifetime.always
                    ? 'forever'
                    : editingKey.value.sendLifetime.range[1].toISOString()
            },
            acceptLifetime: {
                start: editingKey.value.acceptLifetime.always
                    ? 'always'
                    : editingKey.value.acceptLifetime.range[0].toISOString(),
                end: editingKey.value.acceptLifetime.always
                    ? 'forever'
                    : editingKey.value.acceptLifetime.range[1].toISOString()
            }
        };

        const keychain = { ...editingKeychainForKey.value };
        if (editingKeyId.value !== null) {
            const index = keychain.keys.findIndex(k => k.keyId === editingKeyId.value);
            keychain.keys[index] = keyToSave;
        } else {
            keychain.keys.push(keyToSave);
        }
        keychain.updatedAt = new Date().toISOString();

        const payload = JSON.parse(JSON.stringify(keychain));

        try {
            const result = await window.commonApi.saveKeychain(payload);
            if (result.status === 'success') {
                message.success('密钥保存成功');
                keyDialogVisible.value = false;
                await loadKeychains();
            } else {
                message.error(result.msg || '保存失败');
            }
        } catch (error) {
            message.error('保存密钥失败');
        }
    };

    const deleteKey = async (keychain, keyId) => {
        const updated = { ...keychain };
        updated.keys = updated.keys.filter(k => k.keyId !== keyId);
        updated.updatedAt = new Date().toISOString();

        try {
            const result = await window.commonApi.saveKeychain(updated);
            if (result.status === 'success') {
                message.success('密钥删除成功');
                await loadKeychains();
            } else {
                message.error(result.msg || '删除失败');
            }
        } catch (error) {
            message.error('删除密钥失败');
        }
    };

    // 工具函数
    const maskPassword = password => {
        return password ? '●'.repeat(Math.min(password.length, 16)) : '';
    };

    const formatLifetime = lifetime => {
        if (lifetime.start === 'always') {
            return '始终有效';
        }
        const start = dayjs(lifetime.start).format('YYYY-MM-DD HH:mm');
        const end = dayjs(lifetime.end).format('YYYY-MM-DD HH:mm');
        return `${start} ~ ${end}`;
    };
</script>

<style scoped>
    .keychain-settings-container {
        max-width: 100%;
    }

    :deep(.ant-table-body) {
        overflow-y: auto !important;
    }
</style>
