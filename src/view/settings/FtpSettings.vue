<template>
    <nn-settings class="ftp-settings">
        <nn-settings-section title="用户存储" description="控制本地保留的 FTP 用户记录数量。">
            <nn-settings-item title="最大存储条数" label-for="ftp-user-limit" align="center" :actions-width="180">
                <template #actions>
                    <nn-input-number
                        id="ftp-user-limit"
                        v-model:value="settingsForm.maxFtpUser"
                        :min="10"
                        :max="1000"
                        style="width: 100%"
                    />
                </template>
            </nn-settings-item>
        </nn-settings-section>

        <div class="settings-page-actions">
            <nn-button type="primary" @click="saveSettings">保存设置</nn-button>
        </div>
    </nn-settings>
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
</style>
