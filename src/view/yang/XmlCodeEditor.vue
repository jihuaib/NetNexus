<template>
    <div
        class="xml-code-editor"
        :class="[
            $attrs.class,
            {
                'xml-code-editor-disabled': disabled,
                'xml-code-editor-readonly': readonly,
                'xml-code-editor-borderless': !bordered,
                'xml-code-editor-status-error': status === 'error',
                'xml-code-editor-status-warning': status === 'warning'
            }
        ]"
        :style="$attrs.style"
        data-xml-editor
    >
        <pre
            ref="highlightRef"
            class="xml-code-editor-highlight"
            data-xml-highlight-layer
            aria-hidden="true"
        ><XmlHighlight :value="displayValue" /></pre>
        <textarea
            ref="textareaRef"
            v-bind="inputAttributes"
            class="xml-code-editor-input"
            data-xml-input
            :value="displayValue"
            :rows="rows"
            :placeholder="placeholder"
            :disabled="disabled"
            :readonly="readonly"
            :maxlength="maxlength"
            wrap="off"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            @input="handleInput"
            @scroll="syncHighlightScroll"
            @focus="emit('focus', $event)"
            @blur="emit('blur', $event)"
            @keydown="handleKeydown"
            @keyup="emit('keyup', $event)"
        />
    </div>
</template>

<script setup>
    import { computed, nextTick, onMounted, ref, useAttrs, watch } from 'vue';
    import XmlHighlight from './XmlHighlight.vue';

    defineOptions({
        name: 'XmlCodeEditor',
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: [String, Number],
            default: ''
        },
        rows: {
            type: [Number, String],
            default: 8
        },
        placeholder: {
            type: String,
            default: ''
        },
        status: {
            type: String,
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        readonly: {
            type: Boolean,
            default: false
        },
        maxlength: {
            type: [Number, String],
            default: undefined
        },
        bordered: {
            type: Boolean,
            default: true
        }
    });

    const emit = defineEmits(['update:value', 'input', 'change', 'pressEnter', 'focus', 'blur', 'keydown', 'keyup']);
    const attrs = useAttrs();
    const textareaRef = ref(null);
    const highlightRef = ref(null);
    const displayValue = computed(() => (props.value === null || props.value === undefined ? '' : String(props.value)));
    const inputAttributes = computed(() =>
        Object.fromEntries(Object.entries(attrs).filter(([key]) => !['class', 'style'].includes(key)))
    );

    const syncHighlightScroll = event => {
        const textarea = event?.target || textareaRef.value;
        const highlight = highlightRef.value;
        if (!textarea || !highlight) return;
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
    };

    const handleInput = event => {
        emit('update:value', event.target.value);
        emit('input', event);
        emit('change', event);
        nextTick(() => syncHighlightScroll(event));
    };

    const handleKeydown = event => {
        emit('keydown', event);
        if (event.key === 'Enter') emit('pressEnter', event);
    };

    watch(
        () => props.value,
        () => nextTick(syncHighlightScroll)
    );

    onMounted(syncHighlightScroll);

    const focus = options => textareaRef.value?.focus(options);
    const blur = () => textareaRef.value?.blur();
    const select = () => textareaRef.value?.select();

    defineExpose({
        textarea: textareaRef,
        highlight: highlightRef,
        focus,
        blur,
        select
    });
</script>

<style scoped>
    .xml-code-editor {
        position: relative;
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        border-radius: 6px;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.5;
        tab-size: 2;
    }

    .xml-code-editor-highlight,
    .xml-code-editor-input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        min-height: inherit;
        margin: 0;
        padding: 4px 11px;
        border: 1px solid transparent;
        border-radius: inherit;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
        line-height: inherit;
        tab-size: inherit;
        white-space: pre;
    }

    .xml-code-editor-highlight {
        position: absolute;
        z-index: 0;
        inset: 0;
        overflow: hidden;
        background: var(--nn-color-bg-code);
        pointer-events: none;
    }

    .xml-code-editor-highlight::after {
        content: ' ';
    }

    .xml-code-editor-input {
        position: relative;
        z-index: 1;
        display: block;
        overflow: auto;
        border-color: var(--nn-color-border);
        background: transparent;
        caret-color: var(--nn-color-text);
        color: transparent;
        outline: none;
        resize: vertical;
        -webkit-text-fill-color: transparent;
    }

    .xml-code-editor-input:hover:not(:disabled):not(:read-only) {
        border-color: var(--nn-color-primary);
    }

    .xml-code-editor-input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .xml-code-editor-input::placeholder {
        color: var(--nn-color-text-placeholder);
        opacity: 1;
        -webkit-text-fill-color: var(--nn-color-text-placeholder);
    }

    .xml-code-editor-input::selection {
        background: color-mix(in srgb, var(--nn-color-primary) 28%, transparent);
        color: transparent;
        -webkit-text-fill-color: transparent;
    }

    .xml-code-editor-disabled {
        background: var(--nn-color-bg-disabled);
    }

    .xml-code-editor-disabled .xml-code-editor-highlight {
        background: var(--nn-color-bg-disabled);
        opacity: 0.72;
    }

    .xml-code-editor-input:disabled {
        cursor: not-allowed;
    }

    .xml-code-editor-readonly .xml-code-editor-input {
        cursor: default;
        resize: none;
    }

    .xml-code-editor-borderless .xml-code-editor-input {
        border-color: transparent;
    }

    .xml-code-editor-status-error .xml-code-editor-input,
    .xml-code-editor-status-error .xml-code-editor-input:hover {
        border-color: var(--nn-color-error);
    }

    .xml-code-editor-status-error .xml-code-editor-input:focus {
        box-shadow: var(--nn-focus-shadow-error);
    }

    .xml-code-editor-status-warning .xml-code-editor-input,
    .xml-code-editor-status-warning .xml-code-editor-input:hover {
        border-color: var(--nn-color-warning);
    }
</style>
