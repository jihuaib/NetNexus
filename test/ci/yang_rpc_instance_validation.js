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

const CROSS_MODULE_IFM = `module netnexus-validation-ifm {
  yang-version 1.1;
  namespace "urn:netnexus:validation:ifm";
  prefix ifm;
  revision 2026-07-19;

  container ifm {
    container interfaces {
      list interface {
        key "name";
        leaf name { type string; }
      }
    }
  }
}`;

const CROSS_MODULE_ETHERNET = `module netnexus-validation-ethernet {
  yang-version 1.1;
  namespace "urn:netnexus:validation:ethernet";
  prefix ethernet;
  import netnexus-validation-ifm { prefix ifm; }
  import netnexus-validation-ifm-trunk { prefix ifm-trunk; }
  revision 2026-07-19;

  augment "/ifm:ifm/ifm:interfaces/ifm:interface" {
    container ethernet {
      container main-interface {
        leaf l2-attribute {
          when "not(/ifm:ifm/ifm:interfaces/ifm:interface/ifm-trunk:trunk/ifm-trunk:members/ifm-trunk:member[ifm-trunk:name=current()/../../../ifm:name])";
          type boolean;
        }
      }
    }
  }
}`;

const CROSS_MODULE_IFM_TRUNK = `module netnexus-validation-ifm-trunk {
  yang-version 1.1;
  namespace "urn:netnexus:validation:ifm-trunk";
  prefix ifm-trunk;
  import netnexus-validation-ifm { prefix ifm; }
  revision 2026-07-19;

  augment "/ifm:ifm/ifm:interfaces/ifm:interface" {
    container trunk {
      container members {
        list member {
          key "name";
          leaf name { type string; }
        }
      }
    }
  }
}`;

const SCOPE_TYPES = `module netnexus-validation-scope-types {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:types";
  prefix st;
  revision 2026-07-19;
  typedef small-number { type uint8 { range "1..9"; } }
}`;

const SCOPE_SHARED = `module netnexus-validation-scope-shared {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:shared";
  prefix ss;
  import netnexus-validation-scope-types { prefix st; }
  revision 2026-07-19;
  grouping payload { leaf count { type st:small-number; } }
}`;

const SCOPE_TARGET = `module netnexus-validation-scope-target {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:target";
  prefix target;
  import netnexus-validation-scope-shared { prefix ss; }
  revision 2026-07-19;
  feature writable;
  container scoped-root {
    uses ss:payload;
    leaf featured { if-feature writable; type boolean; }
    leaf removed-by-device { type string; }
  }
}`;

const SCOPE_TARGET_DEVIATION = `module netnexus-validation-scope-target-deviation {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:target-deviation";
  prefix td;
  import netnexus-validation-scope-target { prefix target; }
  revision 2026-07-19;
  deviation "/target:scoped-root/target:removed-by-device" { deviate not-supported; }
}`;

/* The noise deviation shares the target module's datastore root but changes a node
 * owned by an unrelated augmenting module. It mirrors vendor deviation bundles. */
const SCOPE_NOISE = `module netnexus-validation-scope-noise {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:noise";
  prefix noise;
  import netnexus-validation-scope-target { prefix target; }
  revision 2026-07-19;
  feature noisy;
  augment "/target:scoped-root" {
    leaf featured { if-feature noisy; type boolean; }
    leaf removed { type string; }
  }
}`;

const SCOPE_NOISE_DEVIATION = `module netnexus-validation-scope-noise-deviation {
  yang-version 1.1;
  namespace "urn:netnexus:validation:scope:noise-deviation";
  prefix nd;
  import netnexus-validation-scope-noise { prefix noise; }
  import netnexus-validation-scope-target { prefix target; }
  revision 2026-07-19;
  deviation "/target:scoped-root/noise:removed" { deviate not-supported; }
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

async function assertReferencedImportValidation() {
    const registry = new YangRegistry({
        rootDir: path.join(temporaryRoot, 'referenced-import-repository'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false
    });
    registry.importContents([
        {
            content: CROSS_MODULE_IFM,
            expectedName: 'netnexus-validation-ifm',
            revision: '2026-07-19',
            source: 'test'
        },
        {
            content: CROSS_MODULE_ETHERNET,
            expectedName: 'netnexus-validation-ethernet',
            revision: '2026-07-19',
            source: 'test'
        },
        {
            content: CROSS_MODULE_IFM_TRUNK,
            expectedName: 'netnexus-validation-ifm-trunk',
            revision: '2026-07-19',
            source: 'test'
        }
    ]);

    const compiled = await registry.compile({ force: true });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    assert.equal(
        compiled.diagnostics.some(diagnostic =>
            /unknown\/non-implemented|referenced module .* is not implemented|check skipped/iu.test(
                String(diagnostic.message || '')
            )
        ),
        false,
        JSON.stringify(compiled.diagnostics, null, 2)
    );

    const rpc = editConfigRpc(
        [
            '      <ifm xmlns="urn:netnexus:validation:ifm">',
            '        <interfaces>',
            '          <interface>',
            '            <name>GE0/0/0</name>',
            '            <ethernet xmlns="urn:netnexus:validation:ethernet">',
            '              <main-interface><l2-attribute>true</l2-attribute></main-interface>',
            '            </ethernet>',
            '          </interface>',
            '        </interfaces>',
            '      </ifm>'
        ].join('\n')
    );
    const runtime = registry.compiler.createRuntime();
    let validationArgs = null;
    const capturingRuntime = {
        getStatus: options => runtime.getStatus(options),
        execute: (args, options) => {
            validationArgs = [...args];
            return runtime.execute(args, options);
        }
    };
    const validation = await registry.validateRpc({
        compileId: compiled.compileId,
        rpc,
        runtime: capturingRuntime
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert(validationArgs, 'RPC validation must invoke yanglint');
    assert.equal(
        validationArgs.filter(argument => argument === '-i').length,
        1,
        `referenced imports require exactly one yanglint -i option: ${JSON.stringify(validationArgs)}`
    );
    const ethernetIndex = validationArgs.findIndex(argument =>
        path.basename(argument).startsWith('netnexus-validation-ethernet@')
    );
    const ifmTrunkIndex = validationArgs.findIndex(argument =>
        path.basename(argument).startsWith('netnexus-validation-ifm-trunk@')
    );
    assert(
        ethernetIndex >= 0 && ifmTrunkIndex > ethernetIndex,
        `the regression requires the importing module to load before its referenced dependency: ${JSON.stringify(validationArgs)}`
    );
    assert(
        validationArgs.indexOf('-i') < validationArgs.indexOf('-I'),
        `yanglint -i must configure the Schema context before XML input parsing: ${JSON.stringify(validationArgs)}`
    );
}

function hasSchemaModule(args, moduleName) {
    return args.some(argument => {
        const fileName = path.basename(String(argument));
        return fileName.startsWith(`${moduleName}@`) && fileName.endsWith('.yang');
    });
}

function optionValues(args, option) {
    const values = [];
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] === option) values.push(args[index + 1]);
    }
    return values;
}

async function assertRpcSchemaScoping() {
    const registry = new YangRegistry({
        rootDir: path.join(temporaryRoot, 'rpc-scope-repository'),
        resourcesPath: path.join(projectRoot, 'resources'),
        isPackaged: false
    });
    registry.importContents([
        { content: SCOPE_TARGET, expectedName: 'netnexus-validation-scope-target', source: 'test' },
        { content: SCOPE_SHARED, expectedName: 'netnexus-validation-scope-shared', source: 'test' },
        { content: SCOPE_TYPES, expectedName: 'netnexus-validation-scope-types', source: 'test' },
        {
            content: SCOPE_TARGET_DEVIATION,
            expectedName: 'netnexus-validation-scope-target-deviation',
            source: 'test'
        },
        { content: SCOPE_NOISE, expectedName: 'netnexus-validation-scope-noise', source: 'test' },
        {
            content: SCOPE_NOISE_DEVIATION,
            expectedName: 'netnexus-validation-scope-noise-deviation',
            source: 'test'
        }
    ]);
    const compiled = await registry.compile({
        force: true,
        features: ['netnexus-validation-scope-target:writable', 'netnexus-validation-scope-noise:noisy']
    });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    assert.equal(compiled.schemaCompiler.schemaInputs.length, 6);
    assert(
        compiled.schemaCompiler.schemaInputs.every(input => input.hash && path.isAbsolute(input.path)),
        JSON.stringify(compiled.schemaCompiler.schemaInputs, null, 2)
    );

    const validRpc = editConfigRpc(
        [
            '      <scoped-root xmlns="urn:netnexus:validation:scope:target">',
            '        <count>7</count>',
            '        <featured>true</featured>',
            '      </scoped-root>'
        ].join('\n')
    );
    const runtime = registry.compiler.createRuntime();
    let validationArgs = null;
    const capturingRuntime = {
        getStatus: options => runtime.getStatus(options),
        execute: (args, options) => {
            validationArgs = [...args];
            return runtime.execute(args, options);
        }
    };
    const validation = await registry.validateRpc({
        compileId: compiled.compileId,
        rpc: validRpc,
        runtime: capturingRuntime
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert(validationArgs, 'scoped RPC validation must invoke yanglint');
    for (const moduleName of [
        'netnexus-validation-scope-target',
        'netnexus-validation-scope-shared',
        'netnexus-validation-scope-types',
        'netnexus-validation-scope-target-deviation'
    ]) {
        assert(hasSchemaModule(validationArgs, moduleName), `${moduleName} must be in the RPC validation scope`);
    }
    for (const moduleName of ['netnexus-validation-scope-noise', 'netnexus-validation-scope-noise-deviation']) {
        assert(!hasSchemaModule(validationArgs, moduleName), `${moduleName} must be outside the RPC validation scope`);
    }
    assert.equal(validationArgs.filter(argument => argument === '-i').length, 1);
    assert.deepEqual(optionValues(validationArgs, '-F'), ['netnexus-validation-scope-target:writable']);
    assert.deepEqual(
        validation.modules.map(module => module.name),
        [
            'netnexus-validation-scope-target',
            'netnexus-validation-scope-shared',
            'netnexus-validation-scope-types',
            'netnexus-validation-scope-target-deviation'
        ]
    );

    const deviatedNode = await registry.validateRpc({
        compileId: compiled.compileId,
        rpc: editConfigRpc(
            [
                '      <scoped-root xmlns="urn:netnexus:validation:scope:target">',
                '        <count>7</count>',
                '        <removed-by-device>must-fail</removed-by-device>',
                '      </scoped-root>'
            ].join('\n')
        )
    });
    assert.equal(deviatedNode.valid, false);
    assert.match(deviatedNode.diagnostics[0]?.rawMessage || '', /not found|unknown|schema node/iu);

    const unrelatedFeatureOnly = await registry.compile({
        force: true,
        features: ['netnexus-validation-scope-noise:noisy']
    });
    assert.equal(unrelatedFeatureOnly.success, true, JSON.stringify(unrelatedFeatureOnly.diagnostics, null, 2));
    validationArgs = null;
    const sentinelFeatureValidation = await registry.validateRpc({
        compileId: unrelatedFeatureOnly.compileId,
        rpc: editConfigRpc(
            [
                '      <scoped-root xmlns="urn:netnexus:validation:scope:target">',
                '        <count>7</count>',
                '      </scoped-root>'
            ].join('\n')
        ),
        runtime: capturingRuntime
    });
    assert.equal(sentinelFeatureValidation.valid, true, JSON.stringify(sentinelFeatureValidation.diagnostics, null, 2));
    assert.deepEqual(optionValues(validationArgs, '-F'), ['netnexus-validation-scope-target:']);
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

        await assertReferencedImportValidation();
        await assertRpcSchemaScoping();

        console.log('YANG RPC libyang instance validation tests passed');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
