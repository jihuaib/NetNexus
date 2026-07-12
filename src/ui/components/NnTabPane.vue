<template>
    <section
        v-show="active"
        :id="panelId"
        class="nn-tabs-tabpane"
        :class="{ 'nn-tabs-tabpane-active': active }"
        role="tabpanel"
        :aria-labelledby="ariaLabelledby || undefined"
        :aria-label="ariaLabelledby ? undefined : String(tab)"
    >
        <slot v-if="shouldRender" />
    </section>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';

    const props = defineProps({
        tab: {
            type: [String, Number],
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        forceRender: {
            type: Boolean,
            default: false
        },
        active: {
            type: Boolean,
            default: false
        },
        panelId: {
            type: String,
            default: ''
        },
        ariaLabelledby: {
            type: String,
            default: ''
        }
    });

    const wasActive = ref(props.forceRender);
    const shouldRender = computed(() => props.forceRender || wasActive.value);

    watch(
        () => props.active,
        active => {
            if (active) {
                wasActive.value = true;
            }
        },
        { immediate: true }
    );
</script>

<style scoped>
    .nn-tabs-tabpane {
        min-width: 0;
    }
</style>
