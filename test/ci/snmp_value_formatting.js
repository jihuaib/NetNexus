const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snmp = require('net-snmp');
const SnmpApp = require('../../electron/app/snmpApp');
const MibRegistry = require('../../electron/utils/mibRegistry');
const { formatSnmpValue } = require('../../electron/utils/snmpValueFormatter');

const app = new SnmpApp(
    {
        handle() {}
    },
    {
        get() {
            return null;
        },
        set() {}
    }
);

const printable = app.formatSessionVarbind({
    oid: '1.3.6.1.2.1.1.5.0',
    type: snmp.ObjectType.OctetString,
    value: Buffer.from('router-1', 'utf8')
});
assert.equal(printable.type, 'OctetString');
assert.equal(printable.value, 'router-1');
assert.equal(printable.valueEncoding, 'utf8');
assert.equal(printable.valueHex, '726f757465722d31');
assert.equal(printable.rawValueLength, 8);

const unicode = formatSnmpValue(Buffer.from('接口一', 'utf8'));
assert.equal(unicode.value, '接口一');
assert.equal(unicode.valueEncoding, 'utf8');

const binary = app.formatSessionVarbind({
    oid: '1.3.6.1.2.1.999.1.0',
    type: snmp.ObjectType.OctetString,
    value: Buffer.from([0x00, 0x01, 0xff, 0x41])
});
assert.equal(binary.value, '0001ff41');
assert.equal(binary.valueEncoding, 'hex');
assert.equal(binary.valueHex, '0001ff41');
assert.equal(binary.rawValueLength, 4);

const integer = app.formatSessionVarbind({
    oid: '1.3.6.1.2.1.1.7.0',
    type: snmp.ObjectType.Integer,
    value: 72
});
assert.equal(integer.type, 'Integer');
assert.equal(integer.value, 72);

const registry = new MibRegistry();
const trapVarbind = registry.enrichVarbind({
    oid: '1.3.6.1.2.1.1.5.0',
    type: snmp.ObjectType.OctetString,
    value: Buffer.from([0x00, 0x01, 0xff, 0x41])
});
assert.equal(trapVarbind.value, '0001ff41');
assert.equal(trapVarbind.valueEncoding, 'hex');

const demoMibPath = path.join(__dirname, '../../scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib');
const demoIfStatusOid = '1.3.6.1.4.1.55555.1.2.1.1.3.1';
const demoAgentCounterOid = '1.3.6.1.4.1.55555.1.1.2.0';
registry.compileMibFiles([demoMibPath]);

const enumOidInfo = registry.translateOid(demoIfStatusOid);
assert.deepEqual(enumOidInfo.enumValues, {
    1: 'up',
    2: 'down',
    3: 'testing'
});

const enumTrapVarbind = registry.enrichVarbind({
    oid: demoIfStatusOid,
    type: snmp.ObjectType.Integer,
    value: 2
});
assert.equal(enumTrapVarbind.value, '2');
assert.equal(enumTrapVarbind.enumName, 'down');
assert.equal(enumTrapVarbind.displayValue, 'down (2)');

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

const mibDir = path.join(__dirname, '../../node_modules/net-snmp/lib/mibs');
const textualConventionRegistry = new MibRegistry();
textualConventionRegistry.compileMibFiles([path.join(mibDir, 'IF-MIB.mib'), path.join(mibDir, 'IANAifType-MIB.mib')]);
const truthValueVarbind = textualConventionRegistry.enrichVarbind({
    oid: '1.3.6.1.2.1.31.1.1.1.16.1',
    type: snmp.ObjectType.Integer,
    value: 2
});
assert.equal(truthValueVarbind.enumName, 'false');
assert.equal(truthValueVarbind.displayValue, 'false (2)');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-snmp-enum-'));
try {
    const cacheFilePath = path.join(cacheDir, 'mib-cache.json');
    const cacheWriter = new MibRegistry();
    cacheWriter.loadOrCompileMibFiles([demoMibPath], { cacheFilePath });

    const cacheReader = new MibRegistry();
    const cachedSummary = cacheReader.loadOrCompileMibFiles([demoMibPath], { cacheFilePath });
    assert.equal(cachedSummary.cacheHit, true);
    assert.equal(
        cacheReader.enrichVarbind({
            oid: demoIfStatusOid,
            type: snmp.ObjectType.Integer,
            value: 3
        }).displayValue,
        'testing (3)'
    );
} finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
}

console.log('SNMP value formatting tests passed');
