const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));

function bundleRenderer(relativePath, contents) {
    const sourcePath = path.join(projectRoot, relativePath);
    const result = esbuild.buildSync({
        absWorkingDir: projectRoot,
        ...(contents
            ? { stdin: { contents, resolveDir: projectRoot, sourcefile: relativePath } }
            : { entryPoints: [sourcePath] }),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        metafile: true
    });
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    loaded._compile(result.outputFiles[0].text, sourcePath);
    return {
        exports: loaded.exports,
        inputs: Object.keys(result.metafile.inputs).map(input => input.replace(/\\/g, '/'))
    };
}

const common = bundleRenderer('src/utils/validationCommon.js');
const bgp = bundleRenderer('src/utils/bgp/validationRules.js');
const bmp = bundleRenderer('src/utils/bmp/validationRules.js');
const rpki = bundleRenderer('src/const/rpkiConst.js');
const protocolDependency = /(?:^|\/)src\/(?:utils\/(?:bgp|bmp)\/|const\/(?:bgpConst|bmpConst)\.js$)/;
assert.ok(!common.inputs.some(input => protocolDependency.test(input)), 'common validation must not load BGP/BMP');
assert.ok(!rpki.inputs.some(input => protocolDependency.test(input)), 'RPKI IP defaults must not load BGP/BMP');
assert.ok(!bgp.inputs.some(input => /(?:^|\/)src\/(?:utils\/bmp\/|const\/bmpConst\.js$)/.test(input)));
assert.ok(!bmp.inputs.some(input => /(?:^|\/)src\/(?:utils\/bgp\/|const\/bgpConst\.js$)/.test(input)));
assert.ok(!Object.keys(common.exports).some(name => /^create(?:Bgp|Bmp)/.test(name)), 'factories have one owner');

const identity = bundleRenderer(
    'renderer-ip-type-identity.js',
    "export { IP_TYPE as commonIpType } from './src/const/ipConst.js';\n" +
        "export { IP_TYPE as bgpIpType } from './src/const/bgpConst.js';\n" +
        "export { DEFAULT_VALUES as rpkiDefaults } from './src/const/rpkiConst.js';"
).exports;
assert.deepEqual(identity.commonIpType, { IPV4: 1, IPV6: 2 });
assert.strictEqual(identity.bgpIpType, identity.commonIpType, 'the existing BGP API re-exports the same enum object');
assert.equal(identity.rpkiDefaults.DEFAULT_RPKI_IP_TYPE, identity.commonIpType.IPV4);

const constants = bundleRenderer('src/const/bgpConst.js').exports;
const { FormValidator } = common.exports;
function expectField(factory, key, value, formData = {}, error = null) {
    const errors = { value: {} };
    const validator = new FormValidator(errors, 0);
    validator.addRules(factory());
    assert.equal(validator.validateField(key, value, { ...formData, [key]: value }), error !== null, key);
    assert.equal(errors.value[key], error || '', key);
}

const {
    createBgpConfigValidationRules,
    createBgpIpv4RouteConfigValidationRules,
    createBgpIpv4QpRouteConfigValidationRules
} = bgp.exports;
const { createBmpConfigValidationRules } = bmp.exports;
for (const value of ['1', '179', '65535']) expectField(createBgpConfigValidationRules, 'port', value);
expectField(createBgpConfigValidationRules, 'port', '65536', {}, '端口范围 1-65535');
expectField(createBgpConfigValidationRules, 'localAs', '4294967295');
expectField(createBgpConfigValidationRules, 'localAs', '4294967296', {}, '请输入有效的ASN');
expectField(createBmpConfigValidationRules, 'port', '1024');
expectField(createBmpConfigValidationRules, 'port', '179', {}, '请输入1024-65535之间的数字');
for (const value of [1, 16, ' 16 ']) expectField(createBmpConfigValidationRules, 'threadCount', value);
for (const value of [0, 17, 1.5, true, '4.0']) {
    expectField(createBmpConfigValidationRules, 'threadCount', value, {}, '请输入1-16之间的整数');
}
expectField(createBmpConfigValidationRules, 'pathMarkingTlvType', 0x3fff);
expectField(createBmpConfigValidationRules, 'pathMarkingTlvType', 0x4000, {}, '请输入1-16383之间的整数');

const labeled = { addressFamily: constants.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST, labelMode: 'increment', count: '2' };
expectField(createBgpIpv4RouteConfigValidationRules, 'labelStart', 0xfffff, labeled);
expectField(createBgpIpv4RouteConfigValidationRules, 'labelStart', 0x100000, labeled, '标签范围为 0 ~ 1048575');
expectField(
    createBgpIpv4RouteConfigValidationRules,
    'labelStep',
    '1',
    { ...labeled, labelStart: '1048575' },
    '标签递增超出20bit范围'
);
expectField(createBgpIpv4RouteConfigValidationRules, 'rt', '65000:4294967295 192.0.2.1:65535');
expectField(createBgpIpv4RouteConfigValidationRules, 'rt', '65536:65536', {}, 'RT格式错误(支持空格分隔多个值)');
const unicast = { addressFamily: constants.BGP_ADDR_FAMILY.IPV4_UNC, addPathEnabled: true };
expectField(createBgpIpv4RouteConfigValidationRules, 'addPathCount', '255', unicast);
expectField(createBgpIpv4RouteConfigValidationRules, 'addPathCount', '256', unicast, 'ADD-PATH数量范围为 1 ~ 255');
const srv6 = {
    ...unicast,
    srv6Enabled: true,
    srv6SidMode: 'increment',
    srv6Sid: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    count: '1',
    addPathCount: '2'
};
expectField(createBgpIpv4RouteConfigValidationRules, 'srv6Sid', '2001:db8::1', srv6);
expectField(createBgpIpv4RouteConfigValidationRules, 'srv6Sid', '192.0.2.1', srv6, '请输入有效的SRv6 SID IPv6地址');
expectField(createBgpIpv4RouteConfigValidationRules, 'srv6SidStep', '1', srv6, 'SRv6 SID递增超出IPv6地址范围');
expectField(
    createBgpIpv4QpRouteConfigValidationRules,
    'dqpnStep',
    '1',
    { startDqpn: '16777215', count: '2', routeGrowthMode: 'dqpn' },
    'DQPN连续生成超出 24bit 范围'
);

const { createRpkiRoaConfigValidationRules } = common.exports;
expectField(createRpkiRoaConfigValidationRules, 'ip', '192.0.2.1', { ipType: identity.commonIpType.IPV4 });
expectField(createRpkiRoaConfigValidationRules, 'ip', '2001:db8::1', { ipType: identity.commonIpType.IPV6 });
expectField(
    createRpkiRoaConfigValidationRules,
    'mask',
    '33',
    { ipType: identity.commonIpType.IPV4, maxLength: '32' },
    '请输入有效的掩码值'
);

console.log('Protocol renderer validation ownership, shared IP enum and field boundary regressions passed.');
