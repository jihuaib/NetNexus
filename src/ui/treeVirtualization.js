const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const positiveNumber = (value, fallback) => {
    const number = finiteNumber(value, fallback);
    return number > 0 ? number : fallback;
};

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

export function resolveTreeVirtualWindow({ itemCount, itemHeight, viewportHeight, scrollTop = 0, overscan = 0 }) {
    const count = Math.max(0, Math.floor(finiteNumber(itemCount)));
    const rowHeight = positiveNumber(itemHeight, 1);
    const viewport = Math.max(0, finiteNumber(viewportHeight));
    const extraRows = Math.max(0, Math.floor(finiteNumber(overscan)));
    const totalHeight = count * rowHeight;
    const maximumScrollTop = Math.max(0, totalHeight - viewport);
    const resolvedScrollTop = clamp(finiteNumber(scrollTop), 0, maximumScrollTop);

    if (count === 0 || viewport <= 0) {
        return {
            start: 0,
            end: 0,
            beforeHeight: 0,
            afterHeight: totalHeight,
            totalHeight,
            scrollTop: resolvedScrollTop,
            maximumScrollTop
        };
    }

    const firstVisible = Math.min(count - 1, Math.floor(resolvedScrollTop / rowHeight));
    const visibleEnd = Math.min(count, Math.ceil((resolvedScrollTop + viewport) / rowHeight));
    const start = Math.max(0, firstVisible - extraRows);
    const end = Math.min(count, Math.max(firstVisible + 1, visibleEnd) + extraRows);

    return {
        start,
        end,
        beforeHeight: start * rowHeight,
        afterHeight: Math.max(0, (count - end) * rowHeight),
        totalHeight,
        scrollTop: resolvedScrollTop,
        maximumScrollTop
    };
}

export function resolveTreeVirtualScrollTop({
    index,
    itemCount,
    itemHeight,
    viewportHeight,
    currentScrollTop = 0,
    align = 'auto',
    offset = 0
}) {
    const count = Math.max(0, Math.floor(finiteNumber(itemCount)));
    const rowHeight = positiveNumber(itemHeight, 1);
    const viewport = Math.max(0, finiteNumber(viewportHeight));
    const totalHeight = count * rowHeight;
    const maximumScrollTop = Math.max(0, totalHeight - viewport);
    const current = clamp(finiteNumber(currentScrollTop), 0, maximumScrollTop);

    if (count === 0 || viewport <= 0) return current;

    const resolvedIndex = clamp(Math.floor(finiteNumber(index)), 0, count - 1);
    const resolvedOffset = finiteNumber(offset);
    const itemTop = resolvedIndex * rowHeight;
    const itemBottom = itemTop + rowHeight;
    let next = current;

    if (align === 'top') {
        next = itemTop - resolvedOffset;
    } else if (align === 'bottom') {
        next = itemBottom - viewport + resolvedOffset;
    } else if (itemTop < current + resolvedOffset) {
        next = itemTop - resolvedOffset;
    } else if (itemBottom > current + viewport) {
        next = itemBottom - viewport;
    }

    return clamp(next, 0, maximumScrollTop);
}
