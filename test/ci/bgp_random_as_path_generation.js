const assert = require('assert');
const {
    buildRandomAsPathGenerationContext,
    getGeneratedRandomAsPath
} = require('../../electron/utils/bgpRouteGenerator');

const samples = [0.999999, 0, 0.5, 0.999999];
let index = 0;
const context = buildRandomAsPathGenerationContext(
    {
        randomAsPathEnabled: true,
        asMin: 64512,
        asMax: 64514,
        asPathMinLength: 1,
        asPathMaxLength: 3
    },
    () => samples[index++]
);

assert.strictEqual(getGeneratedRandomAsPath(context), '64512 64513 64514');
assert.strictEqual(getGeneratedRandomAsPath(buildRandomAsPathGenerationContext({})), '');
assert.throws(
    () => buildRandomAsPathGenerationContext({ randomAsPathEnabled: true, asMin: 10, asMax: 9, asPathLength: 1 }),
    /结束AS范围/
);
assert.throws(
    () =>
        buildRandomAsPathGenerationContext({
            randomAsPathEnabled: true,
            asMin: 1,
            asMax: 10,
            asPathMinLength: 2,
            asPathMaxLength: 1
        }),
    /最多AS个数范围/
);

console.log('BGP random AS Path generation tests passed');
