<template>
    <div class="nn-table-wrapper" :class="tableWrapperClass">
        <div class="nn-spin-nested-loading">
            <div v-if="isLoading" class="nn-table-loading-mask" role="status" aria-live="polite">
                <span class="nn-table-loading-spinner" aria-hidden="true" />
                <span>加载中</span>
            </div>

            <div class="nn-spin-container" :class="{ 'nn-spin-container-loading': isLoading }">
                <div class="nn-table">
                    <div class="nn-table-container">
                        <div
                            ref="contentRef"
                            class="nn-table-content"
                            :class="{ 'nn-scrollbar-active': scrollbarActive }"
                            :style="contentStyle"
                            @pointerenter="showScrollbar"
                            @pointermove="showScrollbar"
                            @pointerleave="hideScrollbar"
                            @scroll.passive="showScrollbar"
                        >
                            <table :style="tableStyle">
                                <colgroup>
                                    <col
                                        v-for="tableColumn in normalizedColumns"
                                        :key="tableColumn.__nnKey"
                                        :style="getColumnStyle(tableColumn)"
                                    />
                                </colgroup>
                                <thead class="nn-table-thead">
                                    <tr>
                                        <th
                                            v-for="tableColumn in normalizedColumns"
                                            :key="tableColumn.__nnKey"
                                            class="nn-table-cell"
                                            :class="getHeaderClass(tableColumn)"
                                            :style="getFixedStyle(tableColumn)"
                                            :title="
                                                typeof tableColumn.title === 'string' ? tableColumn.title : undefined
                                            "
                                            :aria-sort="getAriaSort(tableColumn)"
                                            @click="handleSort(tableColumn)"
                                        >
                                            <span class="nn-table-header-content">
                                                <NnRenderContent :content="tableColumn.title" />
                                                <span
                                                    v-if="tableColumn.sorter"
                                                    class="nn-table-sorter"
                                                    aria-hidden="true"
                                                >
                                                    <span :class="{ active: isSortOrder(tableColumn, 'ascend') }">
                                                        ▲
                                                    </span>
                                                    <span :class="{ active: isSortOrder(tableColumn, 'descend') }">
                                                        ▼
                                                    </span>
                                                </span>
                                                <span
                                                    v-if="hasFilters(tableColumn)"
                                                    class="nn-table-filter-wrap"
                                                    @click.stop
                                                >
                                                    <button
                                                        type="button"
                                                        class="nn-table-filter-button"
                                                        :class="{ active: hasActiveFilter(tableColumn) }"
                                                        :aria-label="`${tableColumn.title || ''}筛选`"
                                                        @click="toggleFilter(tableColumn)"
                                                    >
                                                        ▾
                                                    </button>
                                                    <span
                                                        v-if="openFilterKey === tableColumn.__nnKey"
                                                        class="nn-table-filter-popup"
                                                    >
                                                        <label
                                                            v-for="filter in tableColumn.filters"
                                                            :key="String(filter.value)"
                                                            class="nn-table-filter-option"
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                :checked="isFilterChecked(tableColumn, filter.value)"
                                                                @change="toggleFilterValue(tableColumn, filter.value)"
                                                            />
                                                            <span>{{ filter.text }}</span>
                                                        </label>
                                                        <span class="nn-table-filter-actions">
                                                            <button
                                                                type="button"
                                                                @click="clearColumnFilter(tableColumn)"
                                                            >
                                                                重置
                                                            </button>
                                                            <button
                                                                type="button"
                                                                @click="applyColumnFilter(tableColumn)"
                                                            >
                                                                确定
                                                            </button>
                                                        </span>
                                                    </span>
                                                </span>
                                            </span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody class="nn-table-tbody">
                                    <tr
                                        v-for="(tableRecord, rowIndex) in displayedRows"
                                        :key="getRowKey(tableRecord, rowIndex)"
                                        class="nn-table-row"
                                        :class="getRowClass(tableRecord, rowIndex)"
                                        v-bind="getRowAttributes(tableRecord, rowIndex)"
                                    >
                                        <td
                                            v-for="tableColumn in normalizedColumns"
                                            :key="tableColumn.__nnKey"
                                            class="nn-table-cell"
                                            :class="getCellClass(tableColumn)"
                                            :style="getFixedStyle(tableColumn)"
                                            :title="getCellTitle(tableRecord, tableColumn)"
                                        >
                                            <NnRenderContent
                                                :content="resolveCellContent(tableRecord, tableColumn, rowIndex)"
                                            />
                                        </td>
                                    </tr>
                                    <tr v-if="displayedRows.length === 0" class="nn-table-placeholder">
                                        <td :colspan="Math.max(normalizedColumns.length, 1)">
                                            <slot name="emptyText">
                                                <NnEmpty class="nn-table-empty" description="暂无数据" />
                                            </slot>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <nav
                    v-if="showPagination"
                    class="nn-pagination nn-table-pagination"
                    :class="paginationClass"
                    aria-label="表格分页"
                >
                    <span v-if="paginationTotalText" class="nn-pagination-total">{{ paginationTotalText }}</span>
                    <button
                        type="button"
                        class="nn-pagination-button"
                        :disabled="currentPage <= 1"
                        aria-label="上一页"
                        @click="changePage(currentPage - 1)"
                    >
                        ‹
                    </button>
                    <button
                        v-for="page in visiblePages"
                        :key="page"
                        type="button"
                        class="nn-pagination-button"
                        :class="{ active: page === currentPage }"
                        :aria-current="page === currentPage ? 'page' : undefined"
                        @click="changePage(page)"
                    >
                        {{ page }}
                    </button>
                    <button
                        type="button"
                        class="nn-pagination-button"
                        :disabled="currentPage >= totalPages"
                        aria-label="下一页"
                        @click="changePage(currentPage + 1)"
                    >
                        ›
                    </button>
                    <select
                        v-if="paginationConfig.showSizeChanger"
                        class="nn-pagination-size"
                        :value="pageSize"
                        aria-label="每页条数"
                        @change="changePageSize"
                    >
                        <option v-for="sizeOption in pageSizeOptions" :key="sizeOption" :value="sizeOption">
                            {{ sizeOption }} 条/页
                        </option>
                    </select>
                    <label v-if="paginationConfig.showQuickJumper" class="nn-pagination-jumper">
                        <span>跳至</span>
                        <input
                            v-model="quickPageInput"
                            type="number"
                            min="1"
                            :max="totalPages"
                            aria-label="跳转页码"
                            @change="changeQuickPage"
                            @keydown.enter.prevent="changeQuickPage"
                        />
                        <span>页</span>
                    </label>
                </nav>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { Comment, computed, onBeforeUnmount, onMounted, ref, Text, useSlots, watch } from 'vue';
    import { useAutoHideScrollbar } from '../useAutoHideScrollbar';
    import NnEmpty from './NnEmpty.vue';
    import NnRenderContent from './NnRenderContent';

    const props = defineProps({
        columns: {
            type: Array,
            default: () => []
        },
        dataSource: {
            type: Array,
            default: () => []
        },
        pagination: {
            type: [Boolean, Object],
            default: undefined
        },
        loading: {
            type: [Boolean, Object],
            default: false
        },
        scroll: {
            type: Object,
            default: () => ({})
        },
        rowKey: {
            type: [String, Function],
            default: 'key'
        },
        rowClassName: {
            type: [String, Function],
            default: ''
        },
        customRow: {
            type: Function,
            default: undefined
        },
        size: {
            type: String,
            default: 'middle'
        },
        bordered: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['change']);
    const slots = useSlots();
    const { scrollbarActive, showScrollbar, hideScrollbar } = useAutoHideScrollbar();
    const contentRef = ref(null);
    const localCurrentPage = ref(1);
    const localPageSize = ref(10);
    const quickPageInput = ref('1');
    const sortState = ref({ key: '', order: null, column: null });
    const filterState = ref({});
    const pendingFilterState = ref({});
    const openFilterKey = ref('');

    const getColumnKey = (column, index) => String(column.key ?? column.dataIndex ?? `column-${index}`);

    const normalizedColumns = computed(() => {
        const source = Array.isArray(props.columns) ? props.columns : [];
        const flatColumns = source.flatMap(column =>
            Array.isArray(column.children) && column.children.length > 0 ? column.children : [column]
        );
        const rightOffsets = new Map();
        let right = 0;

        for (let index = flatColumns.length - 1; index >= 0; index -= 1) {
            const column = flatColumns[index];
            if (column.fixed === 'right') {
                rightOffsets.set(column, right);
                right += Number(column.width) || 0;
            }
        }

        let left = 0;
        return flatColumns.map((column, index) => {
            const normalized = {
                ...column,
                __nnKey: getColumnKey(column, index),
                __nnRight: rightOffsets.get(column)
            };

            if (column.fixed === true || column.fixed === 'left') {
                normalized.__nnLeft = left;
                left += Number(column.width) || 0;
            }

            return normalized;
        });
    });

    const paginationConfig = computed(() =>
        props.pagination && typeof props.pagination === 'object' ? props.pagination : {}
    );
    const showPagination = computed(() => props.pagination !== false && totalRows.value > 0);
    const pageSize = computed(() => Number(paginationConfig.value.pageSize) || localPageSize.value || 10);
    const currentPage = computed(() => Number(paginationConfig.value.current) || localCurrentPage.value || 1);
    const totalRows = computed(() => Number(paginationConfig.value.total) || processedRows.value.length);
    const totalPages = computed(() => Math.max(1, Math.ceil(totalRows.value / pageSize.value)));
    const isRemotePagination = computed(
        () =>
            Number.isFinite(Number(paginationConfig.value.total)) &&
            Number(paginationConfig.value.total) > processedRows.value.length
    );

    const isLoading = computed(() =>
        typeof props.loading === 'object' ? Boolean(props.loading?.spinning) : Boolean(props.loading)
    );

    const getRecordValue = (record, dataIndex) => {
        if (Array.isArray(dataIndex)) {
            return dataIndex.reduce((value, key) => value?.[key], record);
        }

        if (typeof dataIndex === 'string' && dataIndex.includes('.')) {
            return dataIndex.split('.').reduce((value, key) => value?.[key], record);
        }

        return dataIndex === undefined ? undefined : record?.[dataIndex];
    };

    const filteredRows = computed(() =>
        props.dataSource.filter(record =>
            normalizedColumns.value.every(column => {
                const values = filterState.value[column.__nnKey];
                if (!values?.length || typeof column.onFilter !== 'function') {
                    return true;
                }
                return values.some(value => column.onFilter(value, record));
            })
        )
    );

    const processedRows = computed(() => {
        const rows = [...filteredRows.value];
        const { column, order } = sortState.value;
        if (!column || !order || typeof column.sorter !== 'function') {
            return rows;
        }

        rows.sort(column.sorter);
        return order === 'descend' ? rows.reverse() : rows;
    });

    const displayedRows = computed(() => {
        if (!showPagination.value || isRemotePagination.value) {
            return processedRows.value;
        }
        const start = (currentPage.value - 1) * pageSize.value;
        return processedRows.value.slice(start, start + pageSize.value);
    });

    const contentStyle = computed(() => {
        const style = {};
        if (props.scroll?.x) {
            style.overflowX = 'auto';
        }
        if (props.scroll?.y) {
            style.maxHeight = typeof props.scroll.y === 'number' ? `${props.scroll.y}px` : props.scroll.y;
            style.overflowY = 'auto';
        }
        return style;
    });

    const tableStyle = computed(() => {
        const x = props.scroll?.x;
        if (typeof x === 'number') {
            return { minWidth: `${x}px` };
        }
        if (x === 'max-content' || x === true) {
            return { minWidth: 'max-content' };
        }
        if (typeof x === 'string' && x !== '100%') {
            return { minWidth: x };
        }
        return {};
    });

    const tableWrapperClass = computed(() => ({
        'nn-table-small': props.size === 'small',
        'nn-table-bordered': props.bordered
    }));

    const paginationClass = computed(() => ({
        'nn-pagination-center': paginationConfig.value.position?.includes('bottomCenter')
    }));

    const paginationTotalText = computed(() => {
        const showTotal = paginationConfig.value.showTotal;
        if (typeof showTotal !== 'function') {
            return '';
        }
        const start = totalRows.value === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1;
        const end = Math.min(totalRows.value, currentPage.value * pageSize.value);
        return showTotal(totalRows.value, [start, end]);
    });

    const visiblePages = computed(() => {
        const count = totalPages.value;
        if (count <= 7) {
            return Array.from({ length: count }, (_, index) => index + 1);
        }
        const start = Math.max(1, Math.min(currentPage.value - 2, count - 4));
        return Array.from({ length: 5 }, (_, index) => start + index);
    });

    const pageSizeOptions = computed(() =>
        (paginationConfig.value.pageSizeOptions || ['10', '20', '50', '100'])
            .map(Number)
            .filter(value => Number.isInteger(value) && value > 0)
    );

    const emitChange = (paginationOverrides = {}) => {
        const pagination = {
            current: paginationOverrides.current ?? currentPage.value,
            pageSize: paginationOverrides.pageSize ?? pageSize.value,
            total: totalRows.value
        };
        const filters = { ...filterState.value };
        const sorter = sortState.value.order
            ? {
                  column: sortState.value.column,
                  columnKey: sortState.value.key,
                  field: sortState.value.column?.dataIndex,
                  order: sortState.value.order
              }
            : {};

        emit('change', pagination, filters, sorter, { currentDataSource: processedRows.value });
    };

    const changePage = page => {
        const nextPage = Math.max(1, Math.min(totalPages.value, Number(page) || 1));
        if (nextPage === currentPage.value) {
            return nextPage;
        }
        localCurrentPage.value = nextPage;
        paginationConfig.value.onChange?.(nextPage, pageSize.value);
        emitChange({ current: nextPage });
        return nextPage;
    };

    const changePageSize = event => {
        const nextPageSize = Number(event.target.value) || 10;
        localPageSize.value = nextPageSize;
        localCurrentPage.value = 1;
        paginationConfig.value.onShowSizeChange?.(1, nextPageSize);
        paginationConfig.value.onChange?.(1, nextPageSize);
        emitChange({ current: 1, pageSize: nextPageSize });
    };

    const changeQuickPage = () => {
        quickPageInput.value = String(changePage(quickPageInput.value));
    };

    const handleSort = column => {
        if (!column.sorter) {
            return;
        }
        const orders = Array.isArray(column.sortDirections) ? column.sortDirections : ['ascend', 'descend', null];
        const currentIndex = sortState.value.key === column.__nnKey ? orders.indexOf(sortState.value.order) : -1;
        const order = orders[(currentIndex + 1) % orders.length] ?? null;
        sortState.value = { key: column.__nnKey, order, column };
        localCurrentPage.value = 1;
        emitChange({ current: 1 });
    };

    const hasFilters = column => Array.isArray(column.filters) && column.filters.length > 0;
    const hasActiveFilter = column => Boolean(filterState.value[column.__nnKey]?.length);
    const isSortOrder = (column, order) => sortState.value.key === column.__nnKey && sortState.value.order === order;
    const getAriaSort = column => {
        if (!column.sorter) return undefined;
        if (isSortOrder(column, 'ascend')) return 'ascending';
        if (isSortOrder(column, 'descend')) return 'descending';
        return 'none';
    };

    const toggleFilter = column => {
        const nextKey = openFilterKey.value === column.__nnKey ? '' : column.__nnKey;
        openFilterKey.value = nextKey;
        pendingFilterState.value = {
            ...pendingFilterState.value,
            [column.__nnKey]: [...(filterState.value[column.__nnKey] || [])]
        };
    };

    const isFilterChecked = (column, value) =>
        (pendingFilterState.value[column.__nnKey] || []).some(item => Object.is(item, value));

    const toggleFilterValue = (column, value) => {
        const current = [...(pendingFilterState.value[column.__nnKey] || [])];
        const index = current.findIndex(item => Object.is(item, value));
        if (index >= 0) current.splice(index, 1);
        else current.push(value);
        pendingFilterState.value = { ...pendingFilterState.value, [column.__nnKey]: current };
    };

    const applyColumnFilter = column => {
        filterState.value = {
            ...filterState.value,
            [column.__nnKey]: [...(pendingFilterState.value[column.__nnKey] || [])]
        };
        openFilterKey.value = '';
        localCurrentPage.value = 1;
        emitChange({ current: 1 });
    };

    const clearColumnFilter = column => {
        pendingFilterState.value = { ...pendingFilterState.value, [column.__nnKey]: [] };
        filterState.value = { ...filterState.value, [column.__nnKey]: [] };
        openFilterKey.value = '';
        localCurrentPage.value = 1;
        emitChange({ current: 1 });
    };

    const getColumnStyle = column => {
        if (column.width === undefined) return {};
        const width = typeof column.width === 'number' ? `${column.width}px` : column.width;
        return { width, minWidth: width };
    };

    const getFixedStyle = column => {
        if (column.fixed === true || column.fixed === 'left') {
            return { position: 'sticky', left: `${column.__nnLeft || 0}px`, zIndex: 2 };
        }
        if (column.fixed === 'right') {
            return { position: 'sticky', right: `${column.__nnRight || 0}px`, zIndex: 2 };
        }
        return {};
    };

    const getHeaderClass = column => ({
        'nn-table-column-sortable': Boolean(column.sorter),
        'nn-table-cell-ellipsis': Boolean(column.ellipsis),
        [`nn-table-cell-${column.align}`]: Boolean(column.align),
        'nn-table-cell-fixed': Boolean(column.fixed)
    });

    const getCellClass = column => ({
        'nn-table-cell-ellipsis': Boolean(column.ellipsis),
        [`nn-table-cell-${column.align}`]: Boolean(column.align),
        'nn-table-cell-fixed': Boolean(column.fixed)
    });

    const getRowKey = (record, index) => {
        if (typeof props.rowKey === 'function') return props.rowKey(record, index);
        return record?.[props.rowKey] ?? record?.key ?? index;
    };

    const getRowClass = (record, index) =>
        typeof props.rowClassName === 'function' ? props.rowClassName(record, index) : props.rowClassName;

    const getRowAttributes = (record, index) => {
        const attributes = typeof props.customRow === 'function' ? props.customRow(record, index) : {};
        return attributes && typeof attributes === 'object' ? attributes : {};
    };

    const getCellTitle = (record, column) => {
        if (!column.ellipsis) return undefined;
        const value = getRecordValue(record, column.dataIndex);
        return value === null || value === undefined || typeof value === 'object' ? undefined : String(value);
    };

    const hasMeaningfulNodes = nodes =>
        Array.isArray(nodes) &&
        nodes.some(node => {
            if (!node || node.type === Comment) return false;
            if (node.type === Text) return String(node.children || '').trim().length > 0;
            if (Array.isArray(node.children)) return hasMeaningfulNodes(node.children);
            return true;
        });

    const resolveCellContent = (record, column, index) => {
        const text = getRecordValue(record, column.dataIndex);
        const slotContent = slots.bodyCell?.({ column, record, index, text, value: text });
        if (hasMeaningfulNodes(slotContent)) {
            return slotContent;
        }

        if (typeof column.customRender === 'function') {
            const rendered = column.customRender({ text, value: text, record, index, column });
            if (rendered && typeof rendered === 'object' && 'children' in rendered && !rendered.__v_isVNode) {
                return rendered.children;
            }
            return rendered;
        }

        if (text === null || text === undefined) return '';
        if (Array.isArray(text)) return text.join(', ');
        if (typeof text === 'object') return JSON.stringify(text);
        return text;
    };

    const closeFilterOnOutsideClick = event => {
        if (openFilterKey.value && !event.target.closest('.nn-table-filter-wrap')) {
            openFilterKey.value = '';
        }
    };

    watch(
        () => paginationConfig.value.current,
        value => {
            if (Number(value) > 0) localCurrentPage.value = Number(value);
        },
        { immediate: true }
    );

    watch(
        () => paginationConfig.value.pageSize,
        value => {
            if (Number(value) > 0) localPageSize.value = Number(value);
        },
        { immediate: true }
    );

    watch(
        currentPage,
        value => {
            quickPageInput.value = String(value);
        },
        { immediate: true }
    );

    watch(totalPages, value => {
        if (localCurrentPage.value > value) localCurrentPage.value = value;
    });

    onMounted(() => document.addEventListener('click', closeFilterOnOutsideClick));
    onBeforeUnmount(() => document.removeEventListener('click', closeFilterOnOutsideClick));
</script>

<style scoped>
    .nn-table-wrapper {
        position: relative;
        width: 100%;
        max-width: 100%;
        color: var(--nn-color-text);
        font-size: 14px;
    }

    .nn-spin-nested-loading,
    .nn-spin-container,
    .nn-table,
    .nn-table-container,
    .nn-table-content {
        min-width: 0;
        max-width: 100%;
    }

    .nn-spin-container {
        transition: opacity 0.16s ease;
    }

    .nn-spin-container-loading {
        opacity: 0.62;
        pointer-events: none;
    }

    .nn-table-loading-mask {
        position: absolute;
        inset: 0;
        z-index: 6;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--nn-color-primary);
        font-size: 13px;
        pointer-events: none;
    }

    .nn-table-loading-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid currentcolor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: nn-table-spin 0.75s linear infinite;
    }

    .nn-table-content {
        overflow: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        scrollbar-color: transparent transparent;
        scrollbar-width: thin;
    }

    .nn-table-content::-webkit-scrollbar {
        width: 6px;
        height: 6px;
    }

    .nn-table-content::-webkit-scrollbar-track,
    .nn-table-content::-webkit-scrollbar-corner {
        background: transparent;
    }

    .nn-table-content::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: transparent;
    }

    .nn-table-content.nn-scrollbar-active {
        scrollbar-color: var(--nn-color-text-placeholder) transparent;
    }

    .nn-table-content.nn-scrollbar-active::-webkit-scrollbar-thumb {
        background: var(--nn-color-text-placeholder);
    }

    .nn-table-content::-webkit-scrollbar-thumb:hover {
        background: var(--nn-color-text-muted);
    }

    table {
        width: 100%;
        border-spacing: 0;
        border-collapse: separate;
        table-layout: fixed;
    }

    .nn-table-cell {
        box-sizing: border-box;
        padding: 9px 12px;
        overflow-wrap: break-word;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        line-height: 1.45;
        text-align: left;
        transition: background-color 0.16s ease;
    }

    .nn-table-thead .nn-table-cell {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-strong);
        font-weight: 600;
        white-space: nowrap;
    }

    .nn-table-thead .nn-table-cell-fixed {
        z-index: 4 !important;
    }

    .nn-table-tbody .nn-table-cell-fixed {
        z-index: 2;
        box-shadow: -1px 0 0 var(--nn-color-border-light);
    }

    .nn-table-tbody > tr:last-child > .nn-table-cell {
        border-bottom: 0;
    }

    .nn-table-row {
        cursor: pointer;
    }

    .nn-table-row:hover > .nn-table-cell {
        background: var(--nn-color-bg-hover);
    }

    .nn-table-cell-ellipsis {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-table-cell-center {
        text-align: center;
    }

    .nn-table-cell-right {
        text-align: right;
    }

    .nn-table-small {
        font-size: 13px;
    }

    .nn-table-small .nn-table-cell {
        padding: 6px 8px;
    }

    .nn-table-bordered .nn-table-cell:not(:last-child) {
        border-right: 1px solid var(--nn-color-border-light);
    }

    .nn-table-header-content {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        gap: 5px;
    }

    .nn-table-column-sortable {
        cursor: pointer;
        user-select: none;
    }

    .nn-table-sorter {
        display: inline-flex;
        flex-direction: column;
        color: var(--nn-color-text-placeholder);
        font-size: 8px;
        line-height: 7px;
    }

    .nn-table-sorter .active {
        color: var(--nn-color-primary);
    }

    .nn-table-filter-wrap {
        position: relative;
        display: inline-flex;
    }

    .nn-table-filter-button {
        width: 20px;
        height: 20px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
    }

    .nn-table-filter-button:hover,
    .nn-table-filter-button.active {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-table-filter-popup {
        position: absolute;
        top: calc(100% + 7px);
        right: 0;
        z-index: 10;
        display: grid;
        min-width: 160px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-table-filter-option {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        color: var(--nn-color-text);
        cursor: pointer;
        font-weight: 400;
    }

    .nn-table-filter-option:hover {
        background: var(--nn-color-bg-hover);
    }

    .nn-table-filter-actions {
        display: flex;
        justify-content: space-between;
        padding: 7px 8px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .nn-table-filter-actions button {
        padding: 2px 6px;
        border: 0;
        background: transparent;
        color: var(--nn-color-link);
        cursor: pointer;
    }

    .nn-table-placeholder td {
        padding: 12px;
    }

    .nn-pagination {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 6px;
        margin: 12px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 13px;
    }

    .nn-pagination-center {
        justify-content: center;
    }

    .nn-pagination-total {
        margin-right: 4px;
    }

    .nn-pagination-button {
        min-width: 28px;
        height: 28px;
        padding: 0 7px;
        border: 1px solid var(--nn-color-border);
        border-radius: 5px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        cursor: pointer;
    }

    .nn-pagination-button:hover:not(:disabled),
    .nn-pagination-button.active {
        border-color: var(--nn-color-primary);
        color: var(--nn-color-primary);
    }

    .nn-pagination-button.active {
        background: var(--nn-color-bg-selected);
    }

    .nn-pagination-button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    .nn-pagination-size {
        height: 28px;
        padding: 0 7px;
        border: 1px solid var(--nn-color-border);
        border-radius: 5px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        outline: none;
    }

    .nn-pagination-jumper {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
    }

    .nn-pagination-jumper input {
        width: 52px;
        height: 28px;
        padding: 0 6px;
        border: 1px solid var(--nn-color-border);
        border-radius: 5px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        outline: none;
    }

    .nn-pagination-jumper input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    @keyframes nn-table-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
