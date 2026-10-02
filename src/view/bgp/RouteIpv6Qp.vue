<template>
    <BgpRouteWorkspacePage ref="workspacePage" profile-key="ipv6-qp" />
</template>

<script setup>
    import { ref } from 'vue';
    import BgpRouteWorkspacePage from './BgpRouteWorkspacePage.vue';

    defineOptions({ name: 'RouteIpv6Qp' });
    const workspacePage = ref(null);
    defineExpose({
        clearValidationErrors: () => workspacePage.value?.clearValidationErrors()
    });
</script>
