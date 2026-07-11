<template>
    <div class="ftp-settings">
        <nn-card title="FTP设置" class="settings-card">
            <nn-form :model="settingsForm" layout="vertical">
                <nn-form-item label="FTP用户最大存储条数" name="maxFtpUser">
                    <nn-input-number
                        v-model:value="settingsForm.maxFtpUser"
                        :min="10"
                        :max="1000"
                        style="width: 100%"
                    />
                </nn-form-item>

                <nn-form-item>
                    <nn-button type="primary" @click="saveSettings">保存设置</nn-button>
                </nn-form-item>
            </nn-form>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
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
            notify.success('设置已保存');
        } catch (error) {
            console.error('保存设置失败', error);
            notify.error('保存设置失败');
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

    :deep(.nn-form-item-label > label) {
        font-size: 12px;
    }
</style>
