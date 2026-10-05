<template>
    <BgpRouteWorkspacePage ref="workspace" profile-key="ipv4-label" />
</template>

<script setup>
    import { ref } from 'vue';
    import BgpRouteWorkspacePage from './BgpRouteWorkspacePage.vue';

    defineOptions({ name: 'RouteIpv4Label' });
    const workspace = ref(null);
    defineExpose({ clearValidationErrors: () => workspace.value?.clearValidationErrors() });
</script>
