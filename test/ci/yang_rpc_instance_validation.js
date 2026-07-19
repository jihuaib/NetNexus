const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { YangRegistry } = require('../../electron/utils/yang');
const { normalizeLibyangRpcDiagnostic } = require('../../electron/utils/yang/yangRpcInstanceValidation');
const { MOCK_DEVICE_YANG, MOCK_TYPES_YANG } = require('../../scripts/mockNetconfServer');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-rpc-validation-'));

const TYPEDEF_BOOLEAN_MODULE = `module netnexus-validation-demo {
  yang-version 1.1;
  namespace "urn:netnexus:validation:demo";
  prefix nvd;
  revision 2026-07-19;
  typedef switch-value { type boolean; }
  container flags { leaf active { type switch-value; } }
}`;

function editConfigRpc(body) {
    return [
        '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="validation-1">',
        '  <edit-config>',
        '    <target><running/></target>',
        '    <config>',
        body,
        '    </config>',
        '  </edit-config>',
        '</rpc>'
    ].join('\n');
}

function interfaceBody(fields, attributes = '') {
    return [
        `      <interfaces xmlns="urn:netnexus:params:xml:ns:yang:mock-device"${attributes}>`,
        '        <interface>',
        ...fields.map(field => `          ${field}`),
        '        </interface>',
        '      </interfaces>'
    ].join('\n');
}

async function run() {
    try {
        const registry = new YangRegistry({
            rootDir: path.join(temporaryRoot, 'repository'),
            resourcesPath: path.join(projectRoot, 'resources'),
            isPackaged: false
        });
        registry.importContents([
            {
                content: MOCK_TYPES_YANG,
                expectedName: 'netnexus-mock-types',
                revision: '2026-07-18',
                source: 'test'
            },
            {
                content: MOCK_DEVICE_YANG,
                expectedName: 'netnexus-mock-device',
                revision: '2026-07-18',
                source: 'test'
            },
            {
                content: TYPEDEF_BOOLEAN_MODULE,
                expectedName: 'netnexus-validation-demo',
                revision: '2026-07-19',
                source: 'test'
            }
        ]);
        const compiled = await registry.compile({ force: true });
        assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));

        const invalidBooleanRpc = editConfigRpc(interfaceBody(['<name>eth0</name>', '<enabled>wrong</enabled>']));
        const invalidBoolean = await registry.validateRpc({ compileId: compiled.compileId, rpc: invalidBooleanRpc });
        assert.equal(invalidBoolean.valid, false);
        assert.equal(invalidBoolean.engine, 'libyang');
        assert.equal(invalidBoolean.authoritative, true);
        assert.equal(invalidBoolean.performed, true);
        assert.equal(invalidBoolean.validationType, 'edit');
        assert.equal(invalidBoolean.diagnostics.length, 1);
        assert.match(invalidBoolean.diagnostics[0].message, /boolean.*true.*false/u);
        assert.equal(invalidBoolean.diagnostics[0].line, 8);
        assert.equal(
            invalidBooleanRpc.slice(
                invalidBoolean.diagnostics[0].index,
                invalidBoolean.diagnostics[0].index + invalidBoolean.diagnostics[0].length
            ),
            'wrong'
        );

        for (const value of ['true', 'false']) {
            const result = await registry.validateRpc({
                compileId: compiled.compileId,
                rpc: editConfigRpc(interfaceBody(['<name>eth0</name>', `<enabled>${value}</enabled>`]))
            });
            assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
        }
        const uppercaseBoolean = await registry.validateRpc({
            compileId: compiled.compileId,
            rpc: editConfigRpc(interfaceBody(['<name>eth0</name>', '<enabled>TRUE</enabled>']))
        });
        assert.equal(uppercaseBoolean.valid, false);
        assert.match(uppercaseBoolean.diagnostics[0].message, /boolean/u);

        const typedefBoolean = await registry.validateRpc({
            compileId: compiled.compileId,
            rpc: editConfigRpc('      <flags xmlns="urn:netnexus:validation:demo"><active>invalid</active></flags>')
        });
        assert.equal(typedefBoolean.valid, false);
        assert.match(typedefBoolean.diagnostics[0].message, /boolean/u);

        const invalidRange = await registry.validateRpc({
            compileId: compiled.compileId,
            rpc: editConfigRpc(interfaceBody(['<name>eth0</name>', '<mtu>100</mtu>']))
        });
        assert.equal(invalidRange.valid, false);
        assert.match(invalidRange.diagnostics[0].rawMessage, /mtu|range|uint16|Invalid value/iu);

        const invalidPattern = await registry.validateRpc({
            compileId: compiled.compileId,
            rpc: editConfigRpc(interfaceBody(['<name>1-invalid</name>']))
        });
        assert.equal(invalidPattern.valid, false);
        assert.match(invalidPattern.diagnostics[0].rawMessage, /pattern|Invalid value/iu);

        const inheritedNamespaceRpc = [
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"',
            '     xmlns:mock="urn:netnexus:params:xml:ns:yang:mock-device" message-id="validation-2">',
            '  <mock:reboot>',
            '    <mock:delay>invalid</mock:delay>',
            '  </mock:reboot>',
            '</rpc>'
        ].join('\n');
        const customRpc = await registry.validateRpc({ compileId: compiled.compileId, rpc: inheritedNamespaceRpc });
        assert.equal(customRpc.valid, false);
        assert.equal(customRpc.validationType, 'rpc');
        assert.equal(customRpc.diagnostics[0].line, 4);
        assert.match(customRpc.diagnostics[0].rawMessage, /uint16/u);

        const netconfAttributeRpc = editConfigRpc(
            interfaceBody(['<name>eth0</name>', '<enabled>invalid</enabled>'], ' nc:operation="merge"')
        ).replace('<rpc ', '<rpc xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" ');
        const netconfAttribute = await registry.validateRpc({
            compileId: compiled.compileId,
            rpc: netconfAttributeRpc
        });
        assert.equal(netconfAttribute.valid, false);
        assert.match(netconfAttribute.diagnostics[0].message, /boolean/u);

        const getRpc = '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="validation-3"><get/></rpc>';
        const skipped = await registry.validateRpc({ compileId: compiled.compileId, rpc: getRpc });
        assert.equal(skipped.valid, true);
        assert.equal(skipped.performed, false);
        assert.equal(skipped.skippedReason, 'no-yang-instance-data');

        const colonLineDiagnostic = normalizeLibyangRpcDiagnostic(invalidBooleanRpc, {
            message: 'Invalid boolean value "wrong". (/mock:interfaces/interface/enabled) (line: 8)'
        });
        assert.equal(colonLineDiagnostic.line, 8);
        assert.equal(
            invalidBooleanRpc.slice(colonLineDiagnostic.index, colonLineDiagnostic.index + colonLineDiagnostic.length),
            'wrong'
        );

        console.log('YANG RPC libyang instance validation tests passed');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
