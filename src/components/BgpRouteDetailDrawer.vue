<template>
    <nn-drawer :open="open" title="BGP路由详情" width="640px" placement="right" @close="close">
        <nn-spin :spinning="loading">
            <nn-empty v-if="!route" description="暂无详情" />
            <pre v-else class="json-detail">{{ routeJson }}</pre>
        </nn-spin>
    </nn-drawer>
</template>

<script setup>
    import { computed } from 'vue';
    import { ADDRESS_FAMILY_NAME } from '../const/bgpConst';

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        loading: {
            type: Boolean,
            default: false
        },
        route: {
            type: Object,
            default: null
        }
    });

    const emit = defineEmits(['update:open']);

    const routeJson = computed(() => {
        if (!props.route) {
            return '';
        }

        return JSON.stringify(
            {
                ...props.route,
                addressFamilyName: ADDRESS_FAMILY_NAME[props.route.addressFamily] || props.route.addressFamily
            },
            null,
            2
        );
    });

    const close = () => {
        emit('update:open', false);
    };
</script>

<style scoped>
    .json-detail {
        background: var(--nn-color-bg-console);
        border-radius: 6px;
        color: var(--nn-color-text-console);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.6;
        margin: 0;
        max-height: calc(100vh - 116px);
        overflow: auto;
        padding: 12px;
        white-space: pre-wrap;
        word-break: break-word;
    }
</style>
