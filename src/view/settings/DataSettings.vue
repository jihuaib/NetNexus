<template>
    <div class="database-settings">
        <BgpDataSettings />
        <BmpDataSettings />
    </div>
</template>

<script setup>
    import BgpDataSettings from './BgpDataSettings.vue';
    import BmpDataSettings from './BmpDataSettings.vue';

    defineOptions({ name: 'DataSettings' });
</script>

<style scoped>
    .database-settings {
        display: grid;
        min-width: 0;
        gap: 24px;
    }
</style>
