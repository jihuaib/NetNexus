<template>
    <div class="ftp-settings">
        <a-card title="FTP设置" class="settings-card">
            <a-form :model="settingsForm" layout="vertical">
                <a-form-item label="FTP用户最大存储条数" name="maxFtpUser">
                    <a-input-number v-model:value="settingsForm.maxFtpUser" :min="10" :max="1000" style="width: 100%" />
                </a-form-item>

                <a-form-item>
                    <a-button type="primary" @click="saveSettings">保存设置</a-button>
                </a-form-item>
            </a-form>
        </a-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { message } from 'ant-design-vue';
    import { DEFAULT_FTP_SETTINGS } from '../../const/ftpConst';

    // 工具设置组件
    const settingsForm = ref({
        maxFtpUser: DEFAULT_FTP_SETTINGS.maxFtpUser
    });

    // 获取设置
    const getSettings = async () => {
        try {
            const settings = await window.commonApi.getFtpSettings();
            if (settings.status === 'success' && settings.data) {
                if (settings.data) {
                    settingsForm.value.maxFtpUser = settings.data.maxFtpUser;
                }
            }
        } catch (error) {
            console.error('获取工具设置失败', error);
        }
    };

    // 保存设置
    const saveSettings = async () => {
        try {
            const payload = JSON.parse(JSON.stringify(settingsForm.value));
            await window.commonApi.saveFtpSettings(payload);
            message.success('设置已保存');
        } catch (error) {
            console.error('保存设置失败', error);
            message.error('保存设置失败');
        }
    };

    onMounted(() => {
        getSettings();
    });
</script>

<style scoped>
    .ftp-settings {
        max-width: 100%;
    }

    :deep(.ant-form-item-label > label) {
        font-size: 12px;
    }
</style>
