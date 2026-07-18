'use strict';

const assert = require('assert');
const {
    normalizeYangLibrary8525,
    normalizeModulesState7895,
    normalizeNetconfSchemas6022,
    normalizeCapabilityInventory,
    discoverSchemaInventory,
    getSchema,
    buildHello,
    buildGet,
    buildGetConfig,
    buildEditConfig,
    buildGetSchema,
    buildCommit,
    parseNetconfMessage,
    NetconfXmlError
} = require('../../electron/utils/netconf');

const rfc8525Reply = `
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1">
  <data>
    <yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library">
      <module-set>
        <name>complete</name>
        <module>
          <name>ietf-interfaces</name>
          <revision>2018-02-20</revision>
          <namespace>urn:ietf:params:xml:ns:yang:ietf-interfaces</namespace>
          <location>NETCONF</location>
          <feature>arbitrary-names</feature>
          <deviation>vendor-interface-deviations</deviation>
          <submodule><name>ietf-if-extensions</name><revision>2018-02-20</revision></submodule>
        </module>
        <import-only-module>
          <name>ietf-yang-types</name>
          <revision>2013-07-15</revision>
          <namespace>urn:ietf:params:xml:ns:yang:ietf-yang-types</namespace>
        </import-only-module>
      </module-set>
      <schema><name>complete-schema</name><module-set>complete</module-set></schema>
      <datastore><name>ietf-datastores:running</name><schema>complete-schema</schema></datastore>
      <content-id>content-42</content-id>
    </yang-library>
  </data>
</rpc-reply>`;

const rfc7895Reply = `
<rpc-reply message-id="2"><data>
  <modules-state xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library">
    <module-set-id>set-7</module-set-id>
    <module>
      <name>vendor-system</name><revision>2026-01-10</revision>
      <namespace>urn:vendor:system</namespace><schema>https://device/schema/vendor-system.yang</schema>
      <feature>audit</feature><conformance-type>implement</conformance-type>
      <deviation><name>vendor-deviations</name><revision>2025-01-01</revision></deviation>
    </module>
  </modules-state>
</data></rpc-reply>`;

const rfc6022Reply = `
<rpc-reply message-id="3"><data>
  <netconf-state xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><schemas>
    <schema><identifier>legacy-system</identifier><version>2012-01-01</version><format>yang</format>
      <namespace>urn:legacy:system</namespace><location>NETCONF</location></schema>
  </schemas></netconf-state>
</data></rpc-reply>`;

const library = normalizeYangLibrary8525(rfc8525Reply);
assert.equal(library.source, 'rfc8525');
assert.equal(library.contentId, 'content-42');
assert.equal(library.modules.length, 2);
assert.equal(library.modules[0].name, 'ietf-interfaces');
assert.deepEqual(library.modules[0].features, ['arbitrary-names']);
assert.deepEqual(library.modules[0].deviations, [{ name: 'vendor-interface-deviations', revision: null }]);
assert.equal(library.modules[0].submodules[0].name, 'ietf-if-extensions');
assert.equal(library.modules[1].conformanceType, 'import');
assert.equal(library.datastores[0].schema, 'complete-schema');

const modulesState = normalizeModulesState7895(rfc7895Reply);
assert.equal(modulesState.moduleSetId, 'set-7');
assert.equal(modulesState.modules[0].locations[0], 'https://device/schema/vendor-system.yang');
assert.deepEqual(modulesState.modules[0].deviations, [{ name: 'vendor-deviations', revision: '2025-01-01' }]);

const monitoring = normalizeNetconfSchemas6022(rfc6022Reply);
assert.equal(monitoring.modules[0].name, 'legacy-system');
assert.equal(monitoring.modules[0].revision, '2012-01-01');
assert.equal(monitoring.modules[0].locations[0], 'NETCONF');

const helloInventory = normalizeCapabilityInventory([
    'urn:vendor:router?module=vendor-router&revision=2026-02-03&features=a,b&deviations=vendor-dev'
]);
assert.equal(helloInventory.modules[0].name, 'vendor-router');
assert.deepEqual(helloInventory.modules[0].features, ['a', 'b']);

const helloXml = buildHello();
assert(helloXml.includes('urn:ietf:params:netconf:base:1.0'));
assert(helloXml.includes('urn:ietf:params:netconf:base:1.1'));
assert(!helloXml.includes('xml:ns:netconf:base:1.0?'));
assert(
    buildGet({ filter: '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>' }).includes('type="subtree"')
);
assert(buildGetConfig({ source: 'candidate', withDefaults: 'trim' }).includes('<candidate/>'));
assert(
    buildEditConfig({
        target: 'candidate',
        config: '<system xmlns="urn:vendor:system"/>',
        testOption: 'test-only'
    }).includes('<test-option>test-only</test-option>')
);
assert(buildGetSchema({ identifier: 'ietf-interfaces', version: '2018-02-20' }).includes('<get-schema'));
assert(buildCommit({ confirmed: true, confirmTimeout: 60 }).includes('<confirm-timeout>60</confirm-timeout>'));

assert.throws(
    () =>
        parseNetconfMessage('<!DOCTYPE rpc-reply [<!ENTITY x SYSTEM "file:///etc/passwd">]><rpc-reply>&x;</rpc-reply>'),
    error => error instanceof NetconfXmlError && error.code === 'NETCONF_UNSAFE_XML'
);

async function run() {
    const calls = [];
    const fallbackClient = {
        capabilities: [],
        async rpc(operation) {
            calls.push(operation);
            if (calls.length === 1) {
                throw new Error('RFC 8525 is unavailable');
            }
            if (calls.length === 2) {
                return '<rpc-reply message-id="2"><data/></rpc-reply>';
            }
            return { xml: rfc6022Reply };
        }
    };
    const discovered = await discoverSchemaInventory(fallbackClient);
    assert.equal(discovered.source, 'rfc6022');
    assert.equal(discovered.modules[0].name, 'legacy-system');
    assert.equal(discovered.attempts.length, 3);
    assert(calls[0].includes('<yang-library'));
    assert(calls[1].includes('<modules-state'));
    assert(calls[2].includes('<schemas/>'));

    const capabilityFallback = await discoverSchemaInventory({
        capabilities: ['urn:vendor:x?module=x&revision=2020-01-01'],
        async rpc() {
            throw new Error('not supported');
        }
    });
    assert.equal(capabilityFallback.source, 'hello');
    assert.equal(capabilityFallback.modules[0].name, 'x');

    let getSchemaOperation = null;
    const downloaded = await getSchema(
        {
            async rpc(operation) {
                getSchemaOperation = operation;
                return {
                    xml: '<rpc-reply message-id="9"><data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><![CDATA[module demo { namespace "urn:demo"; prefix d; }]]></data></rpc-reply>'
                };
            }
        },
        'demo',
        { version: '2026-01-01' }
    );
    assert(getSchemaOperation.includes('<identifier>demo</identifier>'));
    assert(getSchemaOperation.includes('<version>2026-01-01</version>'));
    assert.equal(downloaded.content, 'module demo { namespace "urn:demo"; prefix d; }');

    console.log('YANG NETCONF inventory and XML builder tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
