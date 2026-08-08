<template>
    <nn-drawer :open="open" title="BGP路由详情" width="640px" placement="right" @close="close">
        <nn-spin :spinning="loading">
            <nn-empty v-if="!route" description="暂无详情" />
            <nn-json-viewer v-else class="json-detail" :value="routeJson" wrap />
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

        return {
            ...props.route,
            addressFamilyName: ADDRESS_FAMILY_NAME[props.route.addressFamily] || props.route.addressFamily
        };
    });

    const close = () => {
        emit('update:open', false);
    };
</script>
