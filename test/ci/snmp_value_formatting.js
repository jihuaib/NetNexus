const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snmp = require('net-snmp');
const MibRegistry = require('../../electron/utils/mibRegistry');
const { formatSnmpValue } = require('../../electron/utils/snmpValueFormatter');

// Session varbind formatting now belongs to the SNMP Utility Process. This unit
// test covers the shared value formatter without recreating a main-process SNMP app.
const printable = formatSnmpValue(Buffer.from('router-1', 'utf8'));
assert.equal(printable.value, 'router-1');
assert.equal(printable.valueEncoding, 'utf8');
assert.equal(printable.valueHex, '726f757465722d31');
assert.equal(printable.rawValueLength, 8);

const unicode = formatSnmpValue(Buffer.from('接口一', 'utf8'));
assert.equal(unicode.value, '接口一');
assert.equal(unicode.valueEncoding, 'utf8');

const binary = formatSnmpValue(Buffer.from([0x00, 0x01, 0xff, 0x41]));
assert.equal(binary.value, '0001ff41');
assert.equal(binary.valueEncoding, 'hex');
assert.equal(binary.valueHex, '0001ff41');
assert.equal(binary.rawValueLength, 4);

const integer = formatSnmpValue(72);
assert.equal(integer.value, '72');

const registry = new MibRegistry();
const trapVarbind = registry.enrichVarbind({
    oid: '1.3.6.1.2.1.1.5.0',
    type: snmp.ObjectType.OctetString,
    value: Buffer.from([0x00, 0x01, 0xff, 0x41])
});
assert.equal(trapVarbind.value, '0001ff41');
assert.equal(trapVarbind.valueEncoding, 'hex');

const demoMibPath = path.join(__dirname, '../../scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib');
const demoIfStatusObjectOid = '1.3.6.1.4.1.55555.1.2.1.1.3';
const demoIfStatusOid = '1.3.6.1.4.1.55555.1.2.1.1.3.1';
const demoAgentCounterOid = '1.3.6.1.4.1.55555.1.1.2.0';
const demoIfStatusEnumValues = {
    1: 'up',
    2: 'down',
    3: 'testing'
};
const demoIfStatusDescription = 'Writable demo interface status.';
registry.compileMibFiles([demoMibPath]);

const enumOidInfo = registry.translateOid(demoIfStatusOid);
assert.deepEqual(enumOidInfo.enumValues, demoIfStatusEnumValues);

function findOidTreeNode(nodes, oid) {
    for (const node of nodes) {
        if (node.oid === oid) return node;
        const child = findOidTreeNode(node.children, oid);
        if (child) return child;
    }
    return null;
}

function assertTreeNodeDetails(node, enumValues, description) {
    assert.ok(node, 'Expected MIB object in OID tree');
    assert.deepEqual(node.enumValues, enumValues);
    assert.equal(node.description, description);
}

const demoIfEntryOid = '1.3.6.1.4.1.55555.1.2.1.1';
assertTreeNodeDetails(
    registry.getOidTreeChildren(demoIfEntryOid).find(node => node.oid === demoIfStatusObjectOid),
    demoIfStatusEnumValues,
    demoIfStatusDescription
);
assertTreeNodeDetails(
    findOidTreeNode(registry.buildOidTree(), demoIfStatusObjectOid),
    demoIfStatusEnumValues,
    demoIfStatusDescription
);
assertTreeNodeDetails(registry.toOidTreeNode('1.3.6.1.4.1.55555.999'), {}, '');

const enumTrapVarbind = registry.enrichVarbind({
    oid: demoIfStatusOid,
    type: snmp.ObjectType.Integer,
    value: 2
});
assert.equal(enumTrapVarbind.value, '2');
assert.equal(enumTrapVarbind.enumName, 'down');
assert.equal(enumTrapVarbind.displayValue, 'down (2)');
assert.equal(
    enumTrapVarbind.oidPath,
    'iso.org.dod.internet.private.enterprises.netNexusDemoMIB.netNexusDemoObjects.demoTables.demoIfTable.demoIfEntry.demoIfStatus'
);
assert.equal(enumTrapVarbind.oidInstance, '1');
assert.equal(enumTrapVarbind.oidMacro, 'OBJECT-TYPE');

const unknownEnumTrapVarbind = registry.enrichVarbind({
    oid: demoIfStatusOid,
    type: snmp.ObjectType.Integer,
    value: 99
});
assert.equal(unknownEnumTrapVarbind.value, '99');
assert.equal(unknownEnumTrapVarbind.enumName, undefined);
assert.equal(unknownEnumTrapVarbind.displayValue, undefined);

const nonEnumIntegerVarbind = registry.enrichVarbind({
    oid: demoAgentCounterOid,
    type: snmp.ObjectType.Integer,
    value: 2
});
assert.equal(nonEnumIntegerVarbind.enumName, undefined);
assert.equal(nonEnumIntegerVarbind.displayValue, undefined);

for (const [value, valueName, valueInstance] of [
    [demoAgentCounterOid, 'NETNEXUS-DEMO-MIB::demoAgentCounter', '0'],
    [`${demoIfStatusObjectOid}.1.4.192.0.2.1`, 'NETNEXUS-DEMO-MIB::demoIfStatus', '1.4.192.0.2.1']
]) {
    const oidValueVarbind = registry.enrichVarbind({
        oid: '1.3.6.1.2.1.1.2.0',
        type: snmp.ObjectType.OID,
        value
    });
    assert.equal(oidValueVarbind.value, value);
    assert.equal(oidValueVarbind.valueName, valueName);
    assert.equal(oidValueVarbind.valueInstance, valueInstance);
}
assert.equal(nonEnumIntegerVarbind.valueName, '');
assert.equal(nonEnumIntegerVarbind.valueInstance, '');

const mibDir = path.join(__dirname, '../../node_modules/net-snmp/lib/mibs');
const textualConventionRegistry = new MibRegistry();
textualConventionRegistry.compileMibFiles([path.join(mibDir, 'IF-MIB.mib'), path.join(mibDir, 'IANAifType-MIB.mib')]);
const truthValueObjectOid = '1.3.6.1.2.1.31.1.1.1.16';
const truthValueVarbind = textualConventionRegistry.enrichVarbind({
    oid: '1.3.6.1.2.1.31.1.1.1.16.1',
    type: snmp.ObjectType.Integer,
    value: 2
});
assert.equal(truthValueVarbind.enumName, 'false');
assert.equal(truthValueVarbind.displayValue, 'false (2)');

const truthValueEnumValues = { 1: 'true', 2: 'false' };
const truthValueDescription = textualConventionRegistry.translateOid(truthValueObjectOid).description;
assert.ok(truthValueDescription, 'Expected IF-MIB object description');
assertTreeNodeDetails(
    textualConventionRegistry.getOidTreeChildren('1.3.6.1.2.1.31.1.1.1').find(node => node.oid === truthValueObjectOid),
    truthValueEnumValues,
    truthValueDescription
);
assertTreeNodeDetails(
    findOidTreeNode(textualConventionRegistry.buildOidTree(), truthValueObjectOid),
    truthValueEnumValues,
    truthValueDescription
);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-snmp-enum-'));
try {
    const cacheFilePath = path.join(cacheDir, 'mib-cache.json');
    const cacheWriter = new MibRegistry();
    cacheWriter.loadOrCompileMibFiles([demoMibPath], { cacheFilePath });

    const cacheReader = new MibRegistry();
    const cachedSummary = cacheReader.loadOrCompileMibFiles([demoMibPath], { cacheFilePath });
    assert.equal(cachedSummary.cacheHit, true);
    assertTreeNodeDetails(
        cacheReader.getOidTreeChildren(demoIfEntryOid).find(node => node.oid === demoIfStatusObjectOid),
        demoIfStatusEnumValues,
        demoIfStatusDescription
    );
    const cachedEnumVarbind = cacheReader.enrichVarbind({
        oid: demoIfStatusOid,
        type: snmp.ObjectType.Integer,
        value: 3
    });
    assert.equal(cachedEnumVarbind.displayValue, 'testing (3)');
    assert.equal(cachedEnumVarbind.oidPath, enumTrapVarbind.oidPath);
    assert.equal(cachedEnumVarbind.oidInstance, '1');
} finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
}

console.log('SNMP value formatting tests passed');
