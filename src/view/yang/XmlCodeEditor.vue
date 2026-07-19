<template>
    <div
        class="xml-code-editor"
        :class="[
            $attrs.class,
            {
                'xml-code-editor-disabled': disabled,
                'xml-code-editor-readonly': readonly,
                'xml-code-editor-borderless': !bordered,
                'xml-code-editor-line-numbers': lineNumbers,
                'xml-code-editor-status-error': status === 'error',
                'xml-code-editor-status-warning': status === 'warning'
            }
        ]"
        :style="[$attrs.style, editorStyle]"
        data-xml-editor
        :data-xml-viewer="readonly ? '' : undefined"
    >
        <pre
            ref="highlightRef"
            class="xml-code-editor-highlight"
            data-xml-highlight-layer
            data-xml-code-content
            aria-hidden="true"
        ><XmlHighlight :value="displayValue" /></pre>
        <div
            v-if="lineNumbers"
            ref="gutterRef"
            class="xml-code-editor-gutter"
            data-xml-line-number-gutter
            aria-hidden="true"
        >
            <div class="xml-code-editor-gutter-content">
                <span
                    v-for="row in diagnosticRows"
                    :key="row.line"
                    class="xml-code-line-number"
                    :class="{ 'xml-code-line-number-error': row.message }"
                    :data-line-number="row.line"
                    :data-xml-line-number="row.line"
                />
            </div>
        </div>
        <div
            v-if="lineNumbers"
            ref="diagnosticsRef"
            class="xml-code-editor-diagnostics-layer"
            data-xml-diagnostics-layer
            role="status"
            aria-live="polite"
        >
            <div class="xml-code-editor-diagnostics-content">
                <div
                    v-for="row in diagnosticRows"
                    :key="row.line"
                    class="xml-code-editor-diagnostic-row"
                    :class="{ 'xml-code-editor-diagnostic-row-error': row.message }"
                >
                    <span
                        v-if="row.message"
                        class="xml-code-editor-diagnostic"
                        data-xml-diagnostic
                        :data-line="row.line"
                        :data-column="row.column"
                        :title="row.message"
                    >
                        {{ row.message }}
                    </span>
                </div>
            </div>
        </div>
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
        },
        lineNumbers: {
            type: Boolean,
            default: false
        },
        diagnostics: {
            type: Array,
            default: () => []
        }
    });

    const emit = defineEmits(['update:value', 'input', 'change', 'pressEnter', 'focus', 'blur', 'keydown', 'keyup']);
    const attrs = useAttrs();
    const textareaRef = ref(null);
    const highlightRef = ref(null);
    const gutterRef = ref(null);
    const diagnosticsRef = ref(null);
    const displayValue = computed(() => (props.value === null || props.value === undefined ? '' : String(props.value)));
    const lineCount = computed(() => Math.max(1, displayValue.value.split('\n').length));
    const editorStyle = computed(() => {
        if (!props.lineNumbers) return undefined;
        const gutterCharacters = Math.max(3, String(lineCount.value).length) + 3;
        return { '--xml-code-gutter-width': `${gutterCharacters}ch` };
    });
    const lineAtIndex = rawIndex => {
        const index = Math.max(0, Math.min(Number(rawIndex) || 0, displayValue.value.length));
        return displayValue.value.slice(0, index).split('\n').length;
    };
    const diagnosticRows = computed(() => {
        const rows = Array.from({ length: lineCount.value }, (_value, index) => ({
            line: index + 1,
            column: null,
            messages: []
        }));
        props.diagnostics.forEach(diagnostic => {
            const rawLine = Number(diagnostic?.line) || lineAtIndex(diagnostic?.index);
            const line = Math.max(1, Math.min(rawLine, rows.length));
            const row = rows[line - 1];
            const message = String(diagnostic?.message || '').trim();
            if (message && !row.messages.includes(message)) row.messages.push(message);
            const column = Math.max(1, Number(diagnostic?.column) || 1);
            row.column = row.column === null ? column : Math.min(row.column, column);
        });
        return rows.map(row => ({
            line: row.line,
            column: row.column || 1,
            message: row.messages.join('；')
        }));
    });
    const inputAttributes = computed(() =>
        Object.fromEntries(Object.entries(attrs).filter(([key]) => !['class', 'style'].includes(key)))
    );

    const syncHighlightScroll = event => {
        const textarea = event?.target || textareaRef.value;
        const highlight = highlightRef.value;
        if (!textarea || !highlight) return;
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
        if (gutterRef.value) gutterRef.value.scrollTop = textarea.scrollTop;
        if (diagnosticsRef.value) diagnosticsRef.value.scrollTop = textarea.scrollTop;
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
    watch(
        () => props.diagnostics,
        () => nextTick(syncHighlightScroll),
        { deep: true }
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
        --xml-code-line-height: 1.5em;
        --xml-code-padding-block: 4px;
        --xml-code-padding-inline: 11px;
        --xml-code-gutter-width: 42px;
        line-height: var(--xml-code-line-height);
        tab-size: 2;
    }

    .xml-code-editor-highlight,
    .xml-code-editor-input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        min-height: inherit;
        margin: 0;
        padding: var(--xml-code-padding-block) var(--xml-code-padding-inline);
        border: 1px solid transparent;
        border-radius: inherit;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
        line-height: var(--xml-code-line-height);
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

    .xml-code-editor-line-numbers .xml-code-editor-highlight,
    .xml-code-editor-line-numbers .xml-code-editor-input {
        padding-left: calc(var(--xml-code-gutter-width) + var(--xml-code-padding-inline));
    }

    .xml-code-editor-gutter,
    .xml-code-editor-diagnostics-layer {
        position: absolute;
        overflow: hidden;
        pointer-events: none;
    }

    .xml-code-editor-gutter {
        z-index: 3;
        top: 1px;
        bottom: 1px;
        left: 1px;
        width: var(--xml-code-gutter-width);
        border-right: 1px solid var(--nn-color-border-light);
        background: color-mix(in srgb, var(--nn-color-bg-muted) 88%, var(--nn-color-bg-code));
        color: var(--nn-color-text-muted);
        font-variant-numeric: tabular-nums;
        text-align: right;
        user-select: none;
    }

    .xml-code-editor-gutter-content,
    .xml-code-editor-diagnostics-content {
        box-sizing: border-box;
        min-height: 100%;
        padding-top: var(--xml-code-padding-block);
        padding-bottom: var(--xml-code-padding-block);
    }

    .xml-code-line-number {
        position: relative;
        display: block;
        box-sizing: border-box;
        width: 100%;
        height: var(--xml-code-line-height);
        padding-right: 8px;
        line-height: var(--xml-code-line-height);
    }

    .xml-code-line-number::before {
        content: attr(data-line-number);
    }

    .xml-code-line-number-error {
        background: color-mix(in srgb, var(--nn-color-error) 10%, transparent);
        color: var(--nn-color-error);
        font-weight: 600;
    }

    .xml-code-line-number-error::after {
        position: absolute;
        top: 50%;
        right: 2px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--nn-color-error);
        content: '';
        transform: translateY(-50%);
    }

    .xml-code-editor-diagnostics-layer {
        z-index: 2;
        inset: 1px;
    }

    .xml-code-editor-diagnostic-row {
        display: flex;
        box-sizing: border-box;
        width: 100%;
        height: var(--xml-code-line-height);
        align-items: center;
        justify-content: flex-end;
        padding-right: calc(var(--xml-code-padding-inline) + 12px);
        padding-left: calc(var(--xml-code-gutter-width) + var(--xml-code-padding-inline));
        line-height: var(--xml-code-line-height);
    }

    .xml-code-editor-diagnostic-row-error {
        background: linear-gradient(
            90deg,
            transparent 0,
            color-mix(in srgb, var(--nn-color-error) 7%, transparent) 18%,
            color-mix(in srgb, var(--nn-color-error) 11%, transparent) 100%
        );
        box-shadow: inset 0 -1px color-mix(in srgb, var(--nn-color-error) 32%, transparent);
    }

    .xml-code-editor-diagnostic {
        max-width: 58%;
        overflow: hidden;
        padding: 0 5px;
        border: 1px solid color-mix(in srgb, var(--nn-color-error) 45%, transparent);
        border-radius: 3px;
        background: color-mix(in srgb, var(--nn-color-bg-surface) 92%, var(--nn-color-error));
        color: var(--nn-color-error);
        font-family: var(--nn-font-family);
        font-size: 10px;
        font-weight: 500;
        line-height: calc(var(--xml-code-line-height) - 4px);
        pointer-events: auto;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: help;
    }

    .xml-code-editor-diagnostic::before {
        content: '错误：';
        font-weight: 600;
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
