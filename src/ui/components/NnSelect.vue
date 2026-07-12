<template>
    <div
        ref="triggerRef"
        v-bind="attrs"
        class="nn-select"
        :class="selectClass"
        role="combobox"
        :tabindex="disabled ? -1 : 0"
        :aria-controls="dropdownId"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-disabled="disabled ? 'true' : undefined"
        :aria-activedescendant="activeDescendant"
        @click="toggleDropdown"
        @keydown="handleKeydown"
    >
        <div class="nn-select-selection">
            <template v-if="isMultiple && selectedOptions.length > 0">
                <span
                    v-for="option in selectedOptions"
                    :key="option.key"
                    class="nn-select-tag"
                    :class="{ 'nn-select-tag-disabled': option.disabled }"
                >
                    <span class="nn-select-tag-label" :title="option.labelText">{{ option.labelText }}</span>
                    <button
                        v-if="!disabled && !option.disabled"
                        type="button"
                        class="nn-select-tag-remove"
                        :aria-label="`移除 ${option.labelText}`"
                        tabindex="-1"
                        @mousedown.prevent
                        @click.stop="removeValue(option.value)"
                    >
                        ×
                    </button>
                </span>
            </template>
            <span v-else-if="!isMultiple && selectedOptions.length > 0" class="nn-select-single-value">
                {{ selectedOptions[0].labelText }}
            </span>
            <span v-else class="nn-select-placeholder">{{ placeholder }}</span>
        </div>

        <span v-if="loading" class="nn-select-spinner" aria-label="加载中" />
        <button
            v-else-if="allowClear && hasValue && !disabled"
            type="button"
            class="nn-select-clear"
            aria-label="清除选择"
            tabindex="-1"
            @mousedown.prevent
            @click.stop="clearValue"
        >
            ×
        </button>
        <span v-else class="nn-select-arrow" :class="{ 'nn-select-arrow-open': open }" aria-hidden="true" />
    </div>

    <Teleport to="body">
        <div
            v-if="mounted && open"
            :id="dropdownId"
            ref="dropdownRef"
            class="nn-select-dropdown"
            :style="dropdownStyle"
            role="listbox"
            :aria-multiselectable="isMultiple ? 'true' : undefined"
            @mousedown.prevent
        >
            <div v-if="loading" class="nn-select-dropdown-state" role="status">
                <span class="nn-select-spinner" aria-hidden="true" />
                <span>加载中</span>
            </div>
            <template v-else-if="normalizedOptions.length > 0">
                <div
                    v-for="(option, index) in normalizedOptions"
                    :id="getOptionId(index)"
                    :key="option.key"
                    class="nn-select-option"
                    :class="getOptionClass(option, index)"
                    role="option"
                    :aria-selected="isOptionSelected(option) ? 'true' : 'false'"
                    :aria-disabled="option.disabled ? 'true' : undefined"
                    @mouseenter="setHighlightedIndex(index)"
                    @click="selectOption(option)"
                >
                    <NnRenderContent :content="option.content" />
                    <span v-if="isOptionSelected(option)" class="nn-select-option-check" aria-hidden="true">✓</span>
                </div>
            </template>
            <div v-else class="nn-select-dropdown-state">暂无数据</div>
        </div>
    </Teleport>
</template>

<script setup>
    import {
        Comment,
        computed,
        Fragment,
        isVNode,
        nextTick,
        onBeforeUnmount,
        onMounted,
        ref,
        Text,
        useAttrs,
        useSlots,
        watch
    } from 'vue';
    import NnRenderContent from './NnRenderContent';
    import NnSelectOption from './NnSelectOption.vue';

    defineOptions({
        name: 'NnSelect',
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: null,
            default: undefined
        },
        options: {
            type: Array,
            default: () => []
        },
        mode: {
            type: String,
            default: ''
        },
        allowClear: {
            type: Boolean,
            default: false
        },
        disabled: {
            type: Boolean,
            default: false
        },
        loading: {
            type: Boolean,
            default: false
        },
        placeholder: {
            type: String,
            default: ''
        },
        status: {
            type: String,
            default: ''
        }
    });

    const emit = defineEmits(['update:value', 'change', 'dropdownVisibleChange']);
    const attrs = useAttrs();
    const slots = useSlots();
    const triggerRef = ref(null);
    const dropdownRef = ref(null);
    const mounted = ref(false);
    const open = ref(false);
    const highlightedIndex = ref(-1);
    const dropdownStyle = ref({});
    const dropdownId = `nn-select-${Math.random().toString(36).slice(2, 10)}`;

    const isMultiple = computed(() => props.mode === 'multiple' || props.mode === 'tags');
    const currentValues = computed(() => {
        if (isMultiple.value) {
            return Array.isArray(props.value) ? props.value : [];
        }

        return props.value === undefined || props.value === null ? [] : [props.value];
    });

    const valuesEqual = (left, right) => Object.is(left, right);
    const containsValue = (values, value) => values.some(item => valuesEqual(item, value));

    const getTextContent = content => {
        if (content === undefined || content === null || typeof content === 'boolean') {
            return '';
        }

        if (typeof content === 'string' || typeof content === 'number') {
            return String(content);
        }

        if (Array.isArray(content)) {
            return content.map(getTextContent).join('');
        }

        if (isVNode(content)) {
            if (content.type === Comment) {
                return '';
            }
            if (content.type === Text || typeof content.children === 'string') {
                return getTextContent(content.children);
            }
            if (Array.isArray(content.children)) {
                return getTextContent(content.children);
            }
            if (typeof content.children?.default === 'function') {
                return getTextContent(content.children.default());
            }
        }

        return '';
    };

    const flattenSlotNodes = nodes =>
        (Array.isArray(nodes) ? nodes : []).flatMap(node => {
            if (!isVNode(node) || node.type === Comment) {
                return [];
            }

            if (node.type === Fragment) {
                return flattenSlotNodes(node.children);
            }

            const typeName = node.type?.name || node.type?.__name || node.type;
            const isSelectOption =
                node.type === NnSelectOption || typeName === 'NnSelectOption' || typeName === 'nn-select-option';
            return isSelectOption ? [node] : [];
        });

    const slotOptions = computed(() =>
        flattenSlotNodes(slots.default?.() || []).map((node, index) => {
            const slotContent = typeof node.children?.default === 'function' ? node.children.default() : node.children;
            const value = node.props?.value;
            const explicitLabel = node.props?.label;
            const content = slotContent || explicitLabel || value;
            const labelText = getTextContent(content) || String(explicitLabel ?? value ?? '');

            return {
                key: `slot-${index}-${String(value)}`,
                value,
                disabled: Boolean(node.props?.disabled),
                content,
                labelText,
                raw: {
                    value,
                    label: explicitLabel || labelText,
                    disabled: Boolean(node.props?.disabled)
                }
            };
        })
    );

    const propOptions = computed(() =>
        props.options.map((option, index) => {
            const isObjectOption = option && typeof option === 'object';
            const value = isObjectOption ? option.value : option;
            const label = isObjectOption ? option.label : option;

            return {
                key: `prop-${index}-${String(value)}`,
                value,
                disabled: Boolean(isObjectOption && option.disabled),
                content: label ?? value,
                labelText: getTextContent(label ?? value) || String(value ?? ''),
                raw: isObjectOption ? option : { label, value }
            };
        })
    );

    const normalizedOptions = computed(() => [...propOptions.value, ...slotOptions.value]);

    const selectedOptions = computed(() =>
        currentValues.value.map((value, index) => {
            const matchedOption = normalizedOptions.value.find(option => valuesEqual(option.value, value));
            return (
                matchedOption || {
                    key: `value-${index}-${String(value)}`,
                    value,
                    disabled: false,
                    content: String(value),
                    labelText: String(value),
                    raw: { value, label: String(value) }
                }
            );
        })
    );

    const hasValue = computed(() => currentValues.value.length > 0);
    const selectClass = computed(() => ({
        'nn-select-open': open.value,
        'nn-select-disabled': props.disabled,
        'nn-select-loading': props.loading,
        'nn-select-multiple': isMultiple.value,
        'nn-select-status-error': props.status === 'error'
    }));
    const activeDescendant = computed(() =>
        open.value && highlightedIndex.value >= 0 ? getOptionId(highlightedIndex.value) : undefined
    );

    const isOptionSelected = option => containsValue(currentValues.value, option.value);
    const getOptionId = index => `${dropdownId}-option-${index}`;
    const getOptionClass = (option, index) => ({
        'nn-select-option-selected': isOptionSelected(option),
        'nn-select-option-disabled': option.disabled,
        'nn-select-option-active': index === highlightedIndex.value
    });

    const findEnabledIndex = (startIndex, direction) => {
        const optionCount = normalizedOptions.value.length;
        if (optionCount === 0) {
            return -1;
        }

        let index = startIndex;
        for (let attempts = 0; attempts < optionCount; attempts += 1) {
            index = (index + direction + optionCount) % optionCount;
            if (!normalizedOptions.value[index]?.disabled) {
                return index;
            }
        }

        return -1;
    };

    const setInitialHighlight = () => {
        const selectedIndex = normalizedOptions.value.findIndex(option => isOptionSelected(option) && !option.disabled);
        highlightedIndex.value = selectedIndex >= 0 ? selectedIndex : findEnabledIndex(-1, 1);
    };

    const setHighlightedIndex = index => {
        if (!normalizedOptions.value[index]?.disabled) {
            highlightedIndex.value = index;
        }
    };

    const updateDropdownPosition = () => {
        if (!open.value || !triggerRef.value) {
            return;
        }

        const rect = triggerRef.value.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const margin = 8;
        const gap = 4;
        const width = Math.min(Math.max(rect.width, 120), Math.max(120, viewportWidth - margin * 2));
        const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
        const belowSpace = viewportHeight - rect.bottom - margin - gap;
        const aboveSpace = rect.top - margin - gap;
        const measuredHeight = Math.min(dropdownRef.value?.scrollHeight || 256, 256);
        const placeAbove = belowSpace < Math.min(160, measuredHeight) && aboveSpace > belowSpace;
        const availableHeight = Math.max(80, placeAbove ? aboveSpace : belowSpace);
        const maxHeight = Math.min(256, availableHeight);
        const top = placeAbove
            ? Math.max(margin, rect.top - Math.min(measuredHeight, maxHeight) - gap)
            : rect.bottom + gap;

        dropdownStyle.value = {
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            maxHeight: `${maxHeight}px`
        };
    };

    const setOpen = nextOpen => {
        if (props.disabled || open.value === nextOpen) {
            return;
        }

        open.value = nextOpen;
        emit('dropdownVisibleChange', nextOpen);
        if (nextOpen) {
            setInitialHighlight();
            nextTick(() => {
                updateDropdownPosition();
                nextTick(updateDropdownPosition);
            });
        } else {
            highlightedIndex.value = -1;
        }
    };

    const toggleDropdown = () => {
        if (!props.disabled) {
            setOpen(!open.value);
        }
    };

    const emitValue = (nextValue, optionPayload) => {
        emit('update:value', nextValue);
        emit('change', nextValue, optionPayload);
    };

    const selectOption = option => {
        if (props.disabled || option.disabled) {
            return;
        }

        if (isMultiple.value) {
            const selected = isOptionSelected(option);
            const nextValue = selected
                ? currentValues.value.filter(value => !valuesEqual(value, option.value))
                : [...currentValues.value, option.value];
            const optionPayload = normalizedOptions.value
                .filter(item => containsValue(nextValue, item.value))
                .map(item => item.raw);
            emitValue(nextValue, optionPayload);
            return;
        }

        emitValue(option.value, option.raw);
        setOpen(false);
        nextTick(() => triggerRef.value?.focus());
    };

    const removeValue = value => {
        if (!isMultiple.value || props.disabled) {
            return;
        }

        const nextValue = currentValues.value.filter(item => !valuesEqual(item, value));
        const optionPayload = normalizedOptions.value
            .filter(option => containsValue(nextValue, option.value))
            .map(option => option.raw);
        emitValue(nextValue, optionPayload);
    };

    const clearValue = () => {
        if (props.disabled) {
            return;
        }

        emitValue(isMultiple.value ? [] : undefined, isMultiple.value ? [] : undefined);
        setOpen(false);
        nextTick(() => triggerRef.value?.focus());
    };

    const handleKeydown = event => {
        if (props.disabled) {
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open.value) {
                setOpen(true);
                return;
            }

            highlightedIndex.value = findEnabledIndex(highlightedIndex.value, event.key === 'ArrowDown' ? 1 : -1);
            return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!open.value) {
                setOpen(true);
                return;
            }

            const option = normalizedOptions.value[highlightedIndex.value];
            if (option) {
                selectOption(option);
            }
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            return;
        }

        if (event.key === 'Tab') {
            setOpen(false);
        }
    };

    const handleDocumentPointerDown = event => {
        if (open.value && !triggerRef.value?.contains(event.target) && !dropdownRef.value?.contains(event.target)) {
            setOpen(false);
        }
    };

    const handleViewportChange = () => {
        if (open.value) {
            updateDropdownPosition();
        }
    };

    watch(
        () => props.disabled,
        disabled => {
            if (disabled && open.value) {
                open.value = false;
                emit('dropdownVisibleChange', false);
            }
        }
    );

    watch(normalizedOptions, () => {
        if (open.value) {
            setInitialHighlight();
            nextTick(updateDropdownPosition);
        }
    });

    onMounted(() => {
        mounted.value = true;
        document.addEventListener('pointerdown', handleDocumentPointerDown, true);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
        window.removeEventListener('resize', handleViewportChange);
        window.removeEventListener('scroll', handleViewportChange, true);
    });

    defineExpose({
        focus: () => triggerRef.value?.focus(),
        blur: () => triggerRef.value?.blur()
    });
</script>

<style scoped>
    .nn-select {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        cursor: pointer;
        font-size: 14px;
        line-height: 1.5715;
        outline: none;
        vertical-align: middle;
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            background-color 0.2s;
    }

    .nn-select:hover:not(.nn-select-disabled),
    .nn-select-open:not(.nn-select-disabled) {
        border-color: var(--nn-color-primary);
    }

    .nn-select:focus-visible,
    .nn-select-open {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-select-status-error {
        border-color: var(--nn-color-error);
    }

    .nn-select-status-error:focus-visible,
    .nn-select-status-error.nn-select-open {
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-select-disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-select-selection {
        display: flex;
        flex: 1 1 auto;
        align-items: center;
        min-width: 0;
        overflow: hidden;
    }

    .nn-select-multiple {
        height: auto;
        min-height: 32px;
        padding-block: 2px;
    }

    .nn-select-multiple .nn-select-selection {
        flex-wrap: wrap;
        gap: 2px 4px;
        overflow: visible;
    }

    .nn-select-placeholder {
        overflow: hidden;
        color: var(--nn-color-text-placeholder);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-select-single-value {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-select-tag {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        min-height: 24px;
        padding: 0 5px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text);
        line-height: 22px;
    }

    .nn-select-tag-disabled {
        color: var(--nn-color-text-disabled);
    }

    .nn-select-tag-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-select-tag-remove,
    .nn-select-clear {
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
        font: inherit;
    }

    .nn-select-tag-remove {
        width: 16px;
        height: 16px;
        margin-left: 3px;
        font-size: 14px;
    }

    .nn-select-clear {
        width: 18px;
        height: 18px;
        margin-left: 6px;
        border-radius: 50%;
        font-size: 16px;
    }

    .nn-select-tag-remove:hover,
    .nn-select-clear:hover {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-text);
    }

    .nn-select-arrow {
        flex: none;
        width: 0;
        height: 0;
        margin-left: 8px;
        border-right: 4px solid transparent;
        border-left: 4px solid transparent;
        border-top: 5px solid var(--nn-color-text-muted);
        transition: transform 0.16s ease;
    }

    .nn-select-arrow-open {
        transform: rotate(180deg);
    }

    .nn-select-spinner {
        display: inline-block;
        flex: none;
        width: 14px;
        height: 14px;
        margin-left: 8px;
        border: 2px solid var(--nn-color-border-light);
        border-top-color: var(--nn-color-primary);
        border-radius: 50%;
        animation: nn-select-spin 0.8s linear infinite;
    }

    .nn-select-dropdown {
        position: fixed;
        z-index: 1300;
        min-width: 120px;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5715;
    }

    .nn-select-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 32px;
        padding: 5px 10px;
        border-radius: 4px;
        cursor: pointer;
        overflow-wrap: anywhere;
        transition:
            color 0.16s,
            background-color 0.16s;
    }

    .nn-select-option:hover,
    .nn-select-option-active {
        background: var(--nn-color-bg-hover);
    }

    .nn-select-option-selected {
        background: var(--nn-color-bg-selected);
        color: var(--nn-color-primary);
        font-weight: 600;
    }

    .nn-select-option-disabled {
        background: transparent;
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-select-option-check {
        flex: none;
        margin-left: 10px;
        color: var(--nn-color-primary);
    }

    .nn-select-dropdown-state {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 64px;
        padding: 12px;
        color: var(--nn-color-text-muted);
        text-align: center;
    }

    @keyframes nn-select-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
