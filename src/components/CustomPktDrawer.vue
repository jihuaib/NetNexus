<template>
    <nn-drawer :title="title" placement="right" :open="open" width="500" @close="onClose">
        <nn-form layout="vertical">
            <nn-form-item :label="inputLabel" :validate-status="validateStatus" :help="validateMessage">
                <nn-textarea v-model:value="localInputValue" :rows="rows" :placeholder="placeholder" />
            </nn-form-item>
        </nn-form>
        <template #footer>
            <nn-space>
                <nn-button @click="onClose">取消</nn-button>
                <nn-button type="primary" @click="onSubmit">确定</nn-button>
            </nn-space>
        </template>
    </nn-drawer>
</template>

<script setup>
    import { ref, watch } from 'vue';
    import { validatePacketData } from '../utils/validationCommon';

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        inputValue: {
            type: String,
            default: ''
        },
        title: {
            type: String,
            default: '报文输入'
        },
        inputLabel: {
            type: String,
            default: '报文内容'
        },
        rows: {
            type: Number,
            default: 8
        },
        numbersPerLine: {
            type: Number,
            default: 16
        },
        placeholder: {
            type: String,
            default: '请输入16进制数字, 用空格分隔, 例如: 11 22 33 44 55 66 77'
        }
    });

    const emit = defineEmits(['update:open', 'update:inputValue', 'submit']);

    const localInputValue = ref(props.inputValue);

    watch(
        () => props.inputValue,
        newValue => {
            localInputValue.value = newValue;
        }
    );

    const validateStatus = ref('');
    const validateMessage = ref('');

    const onClose = () => {
        emit('update:open', false);
        validateStatus.value = '';
        validateMessage.value = '';
    };

    const onSubmit = () => {
        const result = validatePacketData(localInputValue.value);
        validateStatus.value = result.status;
        validateMessage.value = result.message;

        if (result.status === 'success') {
            emit('update:inputValue', localInputValue.value);
            emit('submit', localInputValue.value);
            onClose();
        }
    };
</script>
