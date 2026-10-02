// Find an exact shared NLRI in bounded sequences without enumerating prefixes or paths.
const floorDiv = (a, b) => {
    if (b < 0n) {
        a = -a;
        b = -b;
    }
    const q = a / b;
    return a < 0n && a % b ? q - 1n : q;
};
const ceilDiv = (a, b) => -floorDiv(-a, b);
function bezout(a, b) {
    let x = 1n,
        y = 0n,
        u = 0n,
        v = 1n;
    const sa = a < 0n ? -1n : 1n,
        sb = b < 0n ? -1n : 1n;
    a *= sa;
    b *= sb;
    while (b) {
        const q = a / b;
        [a, b] = [b, a - q * b];
        [x, u] = [u, x - q * u];
        [y, v] = [v, y - q * v];
    }
    return [a, x * sa, y * sb];
}
export function intersectRouteSequences(left, right) {
    if (left.signature !== right.signature || left.count < 1n || right.count < 1n) return null;
    const equations = left.start.map((value, index) => [
        left.step[index],
        -right.step[index],
        right.start[index] - value
    ]);
    const first = equations.find(([a, b]) => a !== 0n || b !== 0n);
    if (!first) return equations.every(([, , d]) => d === 0n) ? left.start : null;
    const [a, b, d] = first;
    const [g, x, y] = bezout(a, b);
    if (d % g) return null;
    const i = x * (d / g),
        j = y * (d / g),
        di = b / g,
        dj = -a / g;
    let low = null,
        high = null;
    for (const [base, stride, maximum] of [
        [i, di, left.count - 1n],
        [j, dj, right.count - 1n]
    ]) {
        if (!stride) {
            if (base < 0n || base > maximum) return null;
            continue;
        }
        const min = stride > 0n ? ceilDiv(-base, stride) : ceilDiv(maximum - base, stride);
        const max = stride > 0n ? floorDiv(maximum - base, stride) : floorDiv(-base, stride);
        low = low === null || min > low ? min : low;
        high = high === null || max < high ? max : high;
    }
    if (low > high) return null;
    for (const [p, q, difference] of equations) {
        const coefficient = p * di + q * dj,
            constant = difference - p * i - q * j;
        if (!coefficient) {
            if (constant) return null;
        } else {
            if (constant % coefficient) return null;
            const t = constant / coefficient;
            if (t < low || t > high) return null;
            low = t;
            high = t;
        }
    }
    const index = i + di * low;
    return left.start.map((value, offset) => value + left.step[offset] * index);
}
