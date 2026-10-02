<template>
    <BgpRouteWorkspacePage ref="workspacePage" profile-key="mvpn" />
</template>

<script setup>
    import { ref } from 'vue';
    import BgpRouteWorkspacePage from './BgpRouteWorkspacePage.vue';

    defineOptions({ name: 'RouteMvpn' });
    const workspacePage = ref(null);
    defineExpose({
        clearValidationErrors: () => workspacePage.value?.clearValidationErrors()
    });
</script>
