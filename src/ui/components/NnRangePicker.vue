<template>
    <span ref="rootRef" v-bind="attrs" class="nn-range-picker" :class="pickerClass">
        <input
            class="nn-range-picker-input"
            type="text"
            :value="startDisplay"
            :placeholder="normalizedPlaceholder[0]"
            :disabled="disabled"
            :readonly="true"
            role="combobox"
            :aria-controls="panelId"
            :aria-expanded="open ? 'true' : 'false'"
            :aria-label="normalizedPlaceholder[0]"
            @click="openPanel('start')"
            @keydown="handleInputKeydown('start', $event)"
        />
        <span class="nn-range-picker-separator" aria-hidden="true">→</span>
        <input
            class="nn-range-picker-input"
            type="text"
            :value="endDisplay"
            :placeholder="normalizedPlaceholder[1]"
            :disabled="disabled"
            :readonly="true"
            role="combobox"
            :aria-controls="panelId"
            :aria-expanded="open ? 'true' : 'false'"
            :aria-label="normalizedPlaceholder[1]"
            @click="openPanel('end')"
            @keydown="handleInputKeydown('end', $event)"
        />
        <button
            v-if="allowClear && hasDraftValue && !disabled"
            type="button"
            class="nn-range-picker-clear"
            aria-label="清除日期范围"
            @mousedown.prevent
            @click.stop="clearValue"
        >
            ×
        </button>
        <button
            v-else
            type="button"
            class="nn-range-picker-calendar"
            :disabled="disabled"
            aria-label="打开日期选择器"
            @mousedown.prevent
            @click.stop="togglePanel"
        >
            <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                    d="M4 1.5v2M12 1.5v2M2.5 6h11M3.5 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                />
            </svg>
        </button>
    </span>

    <Teleport to="body">
        <div
            v-if="mounted && open"
            :id="panelId"
            ref="panelRef"
            class="nn-range-picker-panel"
            :style="panelStyle"
            role="dialog"
            aria-modal="false"
            aria-label="选择日期范围"
            @mousedown.stop
        >
            <div class="nn-range-picker-panel-header">
                <button type="button" class="nn-range-picker-nav" aria-label="上一年" @click="shiftYear(-1)">«</button>
                <button type="button" class="nn-range-picker-nav" aria-label="上一月" @click="shiftMonth(-1)">‹</button>
                <span class="nn-range-picker-month-label">{{ viewMonthLabel }}</span>
                <button type="button" class="nn-range-picker-nav" aria-label="下一月" @click="shiftMonth(1)">›</button>
                <button type="button" class="nn-range-picker-nav" aria-label="下一年" @click="shiftYear(1)">»</button>
            </div>

            <div class="nn-range-picker-weekdays" aria-hidden="true">
                <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
            </div>
            <div class="nn-range-picker-days" role="grid" :aria-label="viewMonthLabel">
                <button
                    v-for="day in visibleDays"
                    :key="day.key"
                    type="button"
                    class="nn-range-picker-day"
                    :class="getDayClass(day.date)"
                    role="gridcell"
                    :aria-label="day.label"
                    :aria-selected="isSelectedDate(day.date) ? 'true' : 'false'"
                    @click="selectDate(day.date)"
                >
                    {{ day.date.getDate() }}
                </button>
            </div>

            <div v-if="showTime" class="nn-range-picker-time-panel">
                <label>
                    <span>{{ normalizedPlaceholder[0] }}</span>
                    <input
                        type="time"
                        step="1"
                        :value="startTime"
                        :disabled="!startDate"
                        aria-label="开始时间"
                        @input="updateDraftTime('start', $event.target.value)"
                    />
                </label>
                <label>
                    <span>{{ normalizedPlaceholder[1] }}</span>
                    <input
                        type="time"
                        step="1"
                        :value="endTime"
                        :disabled="!endDate"
                        aria-label="结束时间"
                        @input="updateDraftTime('end', $event.target.value)"
                    />
                </label>
            </div>

            <div class="nn-range-picker-panel-footer">
                <button type="button" class="nn-range-picker-text-button" @click="selectToday">今天</button>
                <span class="nn-range-picker-footer-spacer" />
                <button type="button" class="nn-range-picker-text-button" @click="cancelSelection">取消</button>
                <button type="button" class="nn-range-picker-confirm" :disabled="!canConfirm" @click="confirmSelection">
                    确定
                </button>
            </div>
        </div>
    </Teleport>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';

    defineOptions({
        name: 'NnRangePicker',
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: Array,
            default: null
        },
        showTime: {
            type: [Boolean, Object],
            default: false
        },
        format: {
            type: String,
            default: ''
        },
        placeholder: {
            type: Array,
            default: () => ['开始日期', '结束日期']
        },
        allowClear: {
            type: Boolean,
            default: true
        },
        disabled: {
            type: Boolean,
            default: false
        },
        status: {
            type: String,
            default: ''
        }
    });

    const emit = defineEmits(['update:value', 'change', 'openChange']);
    const attrs = useAttrs();
    const rootRef = ref(null);
    const panelRef = ref(null);
    const mounted = ref(false);
    const open = ref(false);
    const activeTarget = ref('start');
    const startDraft = ref('');
    const endDraft = ref('');
    const viewMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const panelPosition = ref({ top: 0, left: 0, width: 328 });
    const panelId = `nn-range-picker-${Math.random().toString(36).slice(2, 10)}`;
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

    const padNumber = value => String(value).padStart(2, '0');

    const toDate = value => {
        if (!value) {
            return null;
        }

        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : new Date(value);
        }

        if (typeof value.toDate === 'function') {
            const date = value.toDate();
            return date instanceof Date && !Number.isNaN(date.getTime()) ? new Date(date) : null;
        }

        if (typeof value.toISOString === 'function') {
            const date = new Date(value.toISOString());
            return Number.isNaN(date.getTime()) ? null : date;
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    };

    const toInputValue = value => {
        const date = toDate(value);
        if (!date) {
            return '';
        }

        const datePart = `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
        if (!props.showTime) {
            return datePart;
        }

        return `${datePart}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
    };

    const parseInputValue = value => {
        if (!value) {
            return null;
        }

        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!match) {
            return null;
        }

        const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
        const parts = [year, month, day, hour, minute, second].map(Number);
        const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
        const isValid =
            date.getFullYear() === parts[0] &&
            date.getMonth() === parts[1] - 1 &&
            date.getDate() === parts[2] &&
            date.getHours() === parts[3] &&
            date.getMinutes() === parts[4] &&
            date.getSeconds() === parts[5];

        return isValid ? date : null;
    };

    const getFormatPattern = () => props.format || (props.showTime ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD');

    const formatDate = date => {
        if (!date) {
            return '';
        }

        const replacements = {
            YYYY: String(date.getFullYear()),
            MM: padNumber(date.getMonth() + 1),
            DD: padNumber(date.getDate()),
            HH: padNumber(date.getHours()),
            mm: padNumber(date.getMinutes()),
            ss: padNumber(date.getSeconds())
        };

        return getFormatPattern().replace(/YYYY|MM|DD|HH|mm|ss/g, token => replacements[token]);
    };

    const startDate = computed(() => parseInputValue(startDraft.value));
    const endDate = computed(() => parseInputValue(endDraft.value));
    const startDisplay = computed(() => formatDate(startDate.value));
    const endDisplay = computed(() => formatDate(endDate.value));
    const startTime = computed(() =>
        startDate.value
            ? `${padNumber(startDate.value.getHours())}:${padNumber(startDate.value.getMinutes())}:${padNumber(startDate.value.getSeconds())}`
            : ''
    );
    const endTime = computed(() =>
        endDate.value
            ? `${padNumber(endDate.value.getHours())}:${padNumber(endDate.value.getMinutes())}:${padNumber(endDate.value.getSeconds())}`
            : ''
    );
    const hasDraftValue = computed(() => Boolean(startDraft.value || endDraft.value));
    const canConfirm = computed(
        () => Boolean(startDate.value && endDate.value) && endDate.value.getTime() >= startDate.value.getTime()
    );
    const normalizedPlaceholder = computed(() => [
        props.placeholder?.[0] || '开始日期',
        props.placeholder?.[1] || '结束日期'
    ]);
    const pickerClass = computed(() => ({
        'nn-range-picker-open': open.value,
        'nn-range-picker-disabled': props.disabled,
        'nn-range-picker-status-error': props.status === 'error'
    }));
    const panelStyle = computed(() => ({
        top: `${panelPosition.value.top}px`,
        left: `${panelPosition.value.left}px`,
        width: `${panelPosition.value.width}px`
    }));
    const viewMonthLabel = computed(() => `${viewMonth.value.getFullYear()}年 ${viewMonth.value.getMonth() + 1}月`);
    const visibleDays = computed(() => {
        const year = viewMonth.value.getFullYear();
        const month = viewMonth.value.getMonth();
        const firstDay = new Date(year, month, 1);
        const mondayOffset = (firstDay.getDay() + 6) % 7;
        const gridStart = new Date(year, month, 1 - mondayOffset);

        return Array.from({ length: 42 }, (_, index) => {
            const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
            return {
                date,
                key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
                label: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
            };
        });
    });

    const isSameDay = (left, right) =>
        Boolean(
            left &&
                right &&
                left.getFullYear() === right.getFullYear() &&
                left.getMonth() === right.getMonth() &&
                left.getDate() === right.getDate()
        );
    const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const isSelectedDate = date => isSameDay(date, startDate.value) || isSameDay(date, endDate.value);
    const getDayClass = date => {
        const time = startOfDay(date);
        const start = startDate.value ? startOfDay(startDate.value) : null;
        const end = endDate.value ? startOfDay(endDate.value) : null;

        return {
            'nn-range-picker-day-outside': date.getMonth() !== viewMonth.value.getMonth(),
            'nn-range-picker-day-today': isSameDay(date, new Date()),
            'nn-range-picker-day-start': start !== null && time === start,
            'nn-range-picker-day-end': end !== null && time === end,
            'nn-range-picker-day-in-range': start !== null && end !== null && time > start && time < end
        };
    };

    const syncFromValue = value => {
        startDraft.value = toInputValue(value?.[0]);
        endDraft.value = toInputValue(value?.[1]);
    };

    const setViewMonth = date => {
        const normalized = toDate(date) || new Date();
        viewMonth.value = new Date(normalized.getFullYear(), normalized.getMonth(), 1);
    };

    const updatePanelPosition = async () => {
        if (!open.value || !rootRef.value) {
            return;
        }

        const rootRect = rootRef.value.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const margin = 8;
        const gap = 6;
        const width = Math.min(Math.max(328, rootRect.width), Math.max(280, viewportWidth - margin * 2));

        panelPosition.value = {
            top: Math.round(rootRect.bottom + gap),
            left: Math.round(Math.min(Math.max(margin, rootRect.left), viewportWidth - width - margin)),
            width
        };

        await nextTick();
        const panelHeight = panelRef.value?.getBoundingClientRect().height || 390;
        const placeAbove = rootRect.bottom + gap + panelHeight > viewportHeight - margin;
        const top = placeAbove ? rootRect.top - panelHeight - gap : rootRect.bottom + gap;
        panelPosition.value = {
            ...panelPosition.value,
            top: Math.round(Math.max(margin, Math.min(top, viewportHeight - panelHeight - margin)))
        };
    };

    const setOpen = nextOpen => {
        if (open.value === nextOpen) {
            return;
        }

        open.value = nextOpen;
        emit('openChange', nextOpen);
        if (nextOpen) {
            updatePanelPosition();
        }
    };

    const openPanel = target => {
        if (props.disabled) {
            return;
        }

        if (!open.value) {
            syncFromValue(props.value);
        }
        activeTarget.value = target;
        setViewMonth(target === 'end' ? endDate.value || startDate.value : startDate.value || endDate.value);
        setOpen(true);
    };

    const togglePanel = () => {
        if (open.value) {
            cancelSelection();
        } else {
            openPanel(startDate.value && !endDate.value ? 'end' : 'start');
        }
    };

    const emitValue = nextValue => {
        emit('update:value', nextValue);
        emit('change', nextValue, nextValue ? nextValue.map(date => formatDate(date)) : ['', '']);
    };

    const confirmSelection = () => {
        if (!canConfirm.value) {
            return;
        }

        emitValue([new Date(startDate.value), new Date(endDate.value)]);
        setOpen(false);
    };

    const cancelSelection = () => {
        syncFromValue(props.value);
        setOpen(false);
    };

    const clearValue = () => {
        startDraft.value = '';
        endDraft.value = '';
        setOpen(false);
        emitValue(null);
    };

    const withSelectedDay = (date, previous) =>
        new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            previous?.getHours() || 0,
            previous?.getMinutes() || 0,
            previous?.getSeconds() || 0
        );

    const selectDate = date => {
        const nextDate = withSelectedDay(date, activeTarget.value === 'end' ? endDate.value : startDate.value);

        if (activeTarget.value === 'start' || !startDate.value) {
            startDraft.value = toInputValue(nextDate);
            if (endDate.value && startOfDay(endDate.value) < startOfDay(nextDate)) {
                endDraft.value = '';
            }
            activeTarget.value = 'end';
        } else if (startOfDay(nextDate) < startOfDay(startDate.value)) {
            startDraft.value = toInputValue(nextDate);
            endDraft.value = '';
            activeTarget.value = 'end';
        } else {
            endDraft.value = toInputValue(nextDate);
            activeTarget.value = 'start';
        }

        setViewMonth(date);
    };

    const updateDraftTime = (target, value) => {
        const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
        const current = target === 'start' ? startDate.value : endDate.value;
        if (!match || !current) {
            return;
        }

        const nextDate = new Date(current);
        nextDate.setHours(Number(match[1]), Number(match[2]), Number(match[3] || 0), 0);
        if (target === 'start') {
            startDraft.value = toInputValue(nextDate);
        } else {
            endDraft.value = toInputValue(nextDate);
        }
    };

    const selectToday = () => {
        const now = new Date();
        const nextDate = props.showTime ? now : new Date(now.getFullYear(), now.getMonth(), now.getDate());
        selectDate(nextDate);
    };

    const shiftMonth = amount => {
        viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + amount, 1);
    };

    const shiftYear = amount => {
        viewMonth.value = new Date(viewMonth.value.getFullYear() + amount, viewMonth.value.getMonth(), 1);
    };

    const handleInputKeydown = (target, event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
            event.preventDefault();
            openPanel(target);
        } else if (event.key === 'Escape' && open.value) {
            event.preventDefault();
            cancelSelection();
        }
    };

    const handleDocumentPointerDown = event => {
        if (open.value && !rootRef.value?.contains(event.target) && !panelRef.value?.contains(event.target)) {
            cancelSelection();
        }
    };

    const handleDocumentKeydown = event => {
        if (open.value && event.key === 'Escape') {
            event.preventDefault();
            cancelSelection();
        }
    };

    watch(
        () => [props.value, props.showTime],
        () => {
            if (!open.value) {
                syncFromValue(props.value);
            }
        },
        { immediate: true, deep: true }
    );

    onMounted(() => {
        mounted.value = true;
        document.addEventListener('pointerdown', handleDocumentPointerDown);
        document.addEventListener('keydown', handleDocumentKeydown);
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', handleDocumentPointerDown);
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', updatePanelPosition);
        window.removeEventListener('scroll', updatePanelPosition, true);
    });
</script>

<style scoped>
    .nn-range-picker {
        display: inline-flex;
        align-items: center;
        width: 100%;
        max-width: 100%;
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        vertical-align: middle;
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            background-color 0.2s;
    }

    .nn-range-picker:hover:not(.nn-range-picker-disabled),
    .nn-range-picker-open {
        border-color: var(--nn-color-primary);
    }

    .nn-range-picker:focus-within:not(.nn-range-picker-disabled),
    .nn-range-picker-open {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-range-picker-status-error {
        border-color: var(--nn-color-error);
    }

    .nn-range-picker-status-error:focus-within {
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-range-picker-disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-range-picker-input {
        flex: 1 1 0;
        width: 0;
        min-width: 88px;
        height: 30px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 30px;
        outline: none;
        text-overflow: ellipsis;
    }

    .nn-range-picker-input::placeholder {
        color: var(--nn-color-text-placeholder);
    }

    .nn-range-picker-input:disabled {
        cursor: not-allowed;
    }

    .nn-range-picker-separator {
        flex: none;
        margin: 0 8px;
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .nn-range-picker-clear,
    .nn-range-picker-calendar {
        display: inline-grid;
        flex: none;
        width: 18px;
        height: 18px;
        margin-left: 4px;
        padding: 0;
        place-items: center;
        border: 0;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
    }

    .nn-range-picker-clear {
        border-radius: 50%;
        background: var(--nn-color-text-muted);
        color: var(--nn-color-bg-surface);
        font: inherit;
        font-size: 14px;
        line-height: 18px;
    }

    .nn-range-picker-clear:hover {
        background: var(--nn-color-text-secondary);
    }

    .nn-range-picker-calendar:hover {
        color: var(--nn-color-primary);
    }

    .nn-range-picker-calendar:disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-range-picker-calendar svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.25;
    }

    .nn-range-picker-panel {
        position: fixed;
        z-index: 1080;
        box-sizing: border-box;
        min-width: 280px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-elevated);
        color: var(--nn-color-text);
        box-shadow: var(--nn-shadow-floating);
        font-family: var(--nn-font-family);
        font-size: 14px;
    }

    .nn-range-picker-panel-header {
        display: grid;
        grid-template-columns: 30px 30px minmax(0, 1fr) 30px 30px;
        align-items: center;
        min-height: 42px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .nn-range-picker-month-label {
        color: var(--nn-color-text-strong);
        font-weight: 600;
        text-align: center;
    }

    .nn-range-picker-nav,
    .nn-range-picker-text-button {
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
        font: inherit;
    }

    .nn-range-picker-nav {
        width: 28px;
        height: 28px;
        padding: 0;
        font-size: 18px;
        line-height: 28px;
    }

    .nn-range-picker-nav:hover,
    .nn-range-picker-text-button:hover {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-range-picker-weekdays,
    .nn-range-picker-days {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
    }

    .nn-range-picker-weekdays {
        padding: 8px 10px 2px;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        text-align: center;
    }

    .nn-range-picker-weekdays span {
        line-height: 28px;
    }

    .nn-range-picker-days {
        gap: 2px 0;
        padding: 0 10px 8px;
    }

    .nn-range-picker-day {
        position: relative;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
    }

    .nn-range-picker-day:hover {
        z-index: 1;
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-range-picker-day-outside {
        color: var(--nn-color-text-placeholder);
    }

    .nn-range-picker-day-in-range {
        border-radius: 0;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
    }

    .nn-range-picker-day-start,
    .nn-range-picker-day-end {
        z-index: 1;
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
        font-weight: 600;
    }

    .nn-range-picker-day-start:hover,
    .nn-range-picker-day-end:hover {
        background: var(--nn-color-primary-hover);
        color: var(--nn-color-text-inverse);
    }

    .nn-range-picker-day-today:not(.nn-range-picker-day-start):not(.nn-range-picker-day-end) {
        box-shadow: inset 0 0 0 1px var(--nn-color-primary);
        color: var(--nn-color-primary);
    }

    .nn-range-picker-time-panel {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        padding: 10px 12px;
        border-top: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-subtle);
    }

    .nn-range-picker-time-panel label {
        display: grid;
        gap: 4px;
        min-width: 0;
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .nn-range-picker-time-panel input {
        box-sizing: border-box;
        width: 100%;
        height: 30px;
        padding: 0 8px;
        border: 1px solid var(--nn-color-border);
        border-radius: 5px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        font: inherit;
        outline: none;
        color-scheme: inherit;
    }

    .nn-range-picker-time-panel input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-range-picker-time-panel input:disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-range-picker-panel-footer {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 42px;
        padding: 5px 10px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .nn-range-picker-text-button,
    .nn-range-picker-confirm {
        min-height: 28px;
        padding: 3px 10px;
    }

    .nn-range-picker-footer-spacer {
        flex: 1;
    }

    .nn-range-picker-confirm {
        border: 1px solid var(--nn-color-primary);
        border-radius: 5px;
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
        cursor: pointer;
        font: inherit;
    }

    .nn-range-picker-confirm:hover:not(:disabled) {
        border-color: var(--nn-color-primary-hover);
        background: var(--nn-color-primary-hover);
    }

    .nn-range-picker-confirm:disabled {
        border-color: var(--nn-color-border);
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-range-picker-nav:focus-visible,
    .nn-range-picker-day:focus-visible,
    .nn-range-picker-text-button:focus-visible,
    .nn-range-picker-confirm:focus-visible,
    .nn-range-picker-calendar:focus-visible,
    .nn-range-picker-clear:focus-visible {
        outline: 2px solid var(--nn-color-primary);
        outline-offset: 1px;
    }

    :global(html[data-theme='dark'] .nn-range-picker-panel),
    :global(html[data-theme-preset='dark'] .nn-range-picker-panel),
    :global(html[data-theme='dark'] .nn-range-picker-time-panel input),
    :global(html[data-theme-preset='dark'] .nn-range-picker-time-panel input) {
        color-scheme: dark;
    }

    :global(html[data-theme='light'] .nn-range-picker-panel),
    :global(html[data-theme='light'] .nn-range-picker-time-panel input) {
        color-scheme: light;
    }

    @media (max-width: 640px) {
        .nn-range-picker {
            padding-inline: 8px;
        }

        .nn-range-picker-separator {
            margin: 0 4px;
        }

        .nn-range-picker-panel {
            max-width: calc(100vw - 16px);
        }
    }
</style>
