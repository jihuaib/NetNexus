<template>
    <nn-textarea
        ref="textareaRef"
        v-bind="$attrs"
        :value="modelValue"
        :placeholder="placeholder"
        :style="textareaStyle"
        :auto-size="false"
        @input="updateValue"
    />
</template>

<script setup>
    import { computed, ref, watch } from 'vue';

    defineOptions({
        inheritAttrs: false
    });

    // 定义 props
    const props = defineProps({
        modelValue: {
            type: String,
            default: ''
        },
        width: {
            type: [String, Number],
            default: '100%' // 默认宽度 100%
        },
        height: {
            type: [String, Number],
            default: 150 // 默认高度 150px
        },
        placeholder: {
            type: String,
            default: ''
        }
    });

    // 定义 emit 事件
    const emit = defineEmits(['update:modelValue']);

    const textareaRef = ref(null);

    // 触发父组件更新值
    const updateValue = e => {
        emit('update:modelValue', e.target.value);
    };

    // 计算样式
    const textareaStyle = computed(() => ({
        width: typeof props.width === 'number' ? `${props.width}px` : props.width,
        height: typeof props.height === 'number' ? `${props.height}px` : props.height,
        overflow: 'auto', // 超出显示滚动条
        resize: 'none' // 禁止调整大小
    }));

    // 监听modelValue变化，自动滚动到底部
    watch(
        () => props.modelValue,
        () => {
            if (textareaRef.value) {
                const textarea = textareaRef.value.$el;
                textarea.scrollTop = textarea.scrollHeight;
            }
        }
    );
</script>
