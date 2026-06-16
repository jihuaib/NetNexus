const assert = require('assert');
const path = require('path');

const { parseSyslogMessage, parseSyslogBuffer } = require(
    path.join(__dirname, '..', '..', 'electron', 'utils', 'syslogParser.js')
);

const rfc3164 = parseSyslogMessage('<34>Oct 11 22:14:15 mymachine su[123]: failed password for root');
assert.equal(rfc3164.format, 'RFC3164');
assert.equal(rfc3164.priority, 34);
assert.equal(rfc3164.facilityName, 'auth');
assert.equal(rfc3164.severityName, 'critical');
assert.equal(rfc3164.timestamp, 'Oct 11 22:14:15');
assert.equal(rfc3164.hostname, 'mymachine');
assert.equal(rfc3164.appName, 'su');
assert.equal(rfc3164.procId, '123');
assert.equal(rfc3164.message, 'failed password for root');

const rfc5424 = parseSyslogMessage(
    '<165>1 2003-10-11T22:14:15.003Z mymachine evntslog 8710 ID47 [exampleSDID@32473 iut="3"] application event'
);
assert.equal(rfc5424.format, 'RFC5424');
assert.equal(rfc5424.priority, 165);
assert.equal(rfc5424.facilityName, 'local4');
assert.equal(rfc5424.severityName, 'notice');
assert.equal(rfc5424.version, 1);
assert.equal(rfc5424.timestamp, '2003-10-11T22:14:15.003Z');
assert.equal(rfc5424.hostname, 'mymachine');
assert.equal(rfc5424.appName, 'evntslog');
assert.equal(rfc5424.procId, '8710');
assert.equal(rfc5424.msgId, 'ID47');
assert.equal(rfc5424.structuredData, '[exampleSDID@32473 iut="3"]');
assert.equal(rfc5424.message, 'application event');

const rfc5424NoStructuredData = parseSyslogMessage('<14>1 2026-06-13T10:00:00Z host app - - - service started');
assert.equal(rfc5424NoStructuredData.format, 'RFC5424');
assert.equal(rfc5424NoStructuredData.facilityName, 'user');
assert.equal(rfc5424NoStructuredData.severityName, 'info');
assert.equal(rfc5424NoStructuredData.structuredData, '-');
assert.equal(rfc5424NoStructuredData.message, 'service started');

const raw = parseSyslogMessage('message without priority');
assert.equal(raw.format, 'RAW');
assert.equal(raw.priority, null);
assert.equal(raw.parseError, '缺少PRI字段');
assert.equal(raw.message, 'message without priority');

const fromBuffer = parseSyslogBuffer(Buffer.from('<13>Jun 13 08:00:01 host app: hello\n'));
assert.equal(fromBuffer.format, 'RFC3164');
assert.equal(fromBuffer.facilityName, 'user');
assert.equal(fromBuffer.severityName, 'notice');
assert.equal(fromBuffer.message, 'hello');

console.log('syslog_parser tests passed');
