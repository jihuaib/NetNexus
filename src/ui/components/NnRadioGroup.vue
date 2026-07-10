<template>
    <div class="nn-radio-group" :class="groupClass" role="radiogroup">
        <template v-if="normalizedOptions.length > 0">
            <component
                :is="optionType === 'button' ? NnRadioButton : NnRadio"
                v-for="option in normalizedOptions"
                :key="String(option.value)"
                :value="option.value"
                :disabled="option.disabled"
            >
                {{ option.label }}
            </component>
        </template>
        <slot v-else />
    </div>
</template>

<script setup>
    import { computed, provide } from 'vue';
    import NnRadio from './NnRadio.vue';
    import NnRadioButton from './NnRadioButton.vue';

    const props = defineProps({
        value: {
            type: [String, Number, Boolean],
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        size: {
            type: String,
            default: 'default'
        },
        buttonStyle: {
            type: String,
            default: 'outline'
        },
        optionType: {
            type: String,
            default: 'default'
        },
        options: {
            type: Array,
            default: () => []
        }
    });

    const emit = defineEmits(['update:value', 'change']);

    const currentValue = computed(() => props.value);
    const isDisabled = computed(() => props.disabled);
    const groupSize = computed(() => props.size);

    const normalizedOptions = computed(() =>
        props.options.map(option => {
            if (option && typeof option === 'object') {
                return {
                    label: option.label,
                    value: option.value,
                    disabled: Boolean(option.disabled)
                };
            }

            return {
                label: option,
                value: option,
                disabled: false
            };
        })
    );

    const groupClass = computed(() => ({
        'nn-radio-group-disabled': props.disabled,
        'nn-radio-group-small': props.size === 'small',
        'nn-radio-group-solid': props.buttonStyle === 'solid'
    }));

    const setValue = value => {
        if (props.disabled || value === props.value) {
            return;
        }

        emit('update:value', value);
        emit('change', { target: { value } });
    };

    provide('nnRadioGroupContext', {
        value: currentValue,
        disabled: isDisabled,
        size: groupSize,
        setValue
    });
</script>

<style scoped>
    .nn-radio-group {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-radio-group-small {
        gap: 4px;
    }
</style>
