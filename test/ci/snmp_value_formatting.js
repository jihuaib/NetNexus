const assert = require('assert');
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

console.log('SNMP value formatting tests passed');
