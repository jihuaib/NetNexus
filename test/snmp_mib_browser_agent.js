#!/usr/bin/env node

const path = require('path');
const snmp = require('net-snmp');

const listenPort = Number(process.argv[2]) || Number(process.env.SNMP_DEMO_PORT) || 10161;
const community = process.argv[3] || process.env.SNMP_DEMO_COMMUNITY || 'public';
const host = process.env.SNMP_DEMO_HOST || '127.0.0.1';
const startTime = Date.now();

const OIDS = {
    demoAgentName: '1.3.6.1.4.1.55555.1.1.1',
    demoAgentCounter: '1.3.6.1.4.1.55555.1.1.2',
    demoWritableName: '1.3.6.1.4.1.55555.1.1.3',
    demoIfEntry: '1.3.6.1.4.1.55555.1.2.1.1'
};

const tableRows = [
    [1, 'loopback0', 1, 10000000, 'Local loopback'],
    [2, 'eth0', 1, 1000000000, 'Server uplink'],
    [3, 'eth1', 2, 100000000, 'Backup link'],
    [10, 'wan0', 1, 100000000, 'WAN circuit'],
    [20, 'mgmt0', 1, 100000000, 'Management network']
];

function createAgent() {
    const agent = snmp.createAgent(
        {
            port: listenPort,
            address: host,
            disableAuthorization: true
        },
        (error, data) => {
            if (error) {
                console.error('[snmp-demo-agent] request error:', error.message || error);
                return;
            }

            if (process.env.SNMP_DEMO_VERBOSE === '1') {
                console.log('[snmp-demo-agent] request:', JSON.stringify(data));
            }
        }
    );

    const mib = agent.getMib();

    mib.registerProviders([
        {
            name: 'demoAgentName',
            type: snmp.MibProviderType.Scalar,
            oid: OIDS.demoAgentName,
            scalarType: snmp.ObjectType.OctetString,
            maxAccess: snmp.MaxAccess['read-only']
        },
        {
            name: 'demoAgentCounter',
            type: snmp.MibProviderType.Scalar,
            oid: OIDS.demoAgentCounter,
            scalarType: snmp.ObjectType.Integer,
            maxAccess: snmp.MaxAccess['read-only'],
            handler: mibRequest => {
                mibRequest.instanceNode.value = Math.floor((Date.now() - startTime) / 1000);
                mibRequest.done();
            }
        },
        {
            name: 'demoWritableName',
            type: snmp.MibProviderType.Scalar,
            oid: OIDS.demoWritableName,
            scalarType: snmp.ObjectType.OctetString,
            maxAccess: snmp.MaxAccess['read-write']
        },
        {
            name: 'demoIfTable',
            type: snmp.MibProviderType.Table,
            oid: OIDS.demoIfEntry,
            maxAccess: snmp.MaxAccess['not-accessible'],
            tableColumns: [
                {
                    number: 1,
                    name: 'demoIfIndex',
                    type: snmp.ObjectType.Integer,
                    maxAccess: snmp.MaxAccess['read-only']
                },
                {
                    number: 2,
                    name: 'demoIfName',
                    type: snmp.ObjectType.OctetString,
                    maxAccess: snmp.MaxAccess['read-only']
                },
                {
                    number: 3,
                    name: 'demoIfStatus',
                    type: snmp.ObjectType.Integer,
                    maxAccess: snmp.MaxAccess['read-write'],
                    constraints: {
                        enumeration: {
                            1: 'up',
                            2: 'down',
                            3: 'testing'
                        }
                    }
                },
                {
                    number: 4,
                    name: 'demoIfSpeed',
                    type: snmp.ObjectType.Gauge,
                    maxAccess: snmp.MaxAccess['read-only']
                },
                {
                    number: 5,
                    name: 'demoIfAlias',
                    type: snmp.ObjectType.OctetString,
                    maxAccess: snmp.MaxAccess['read-write']
                }
            ],
            tableIndex: [
                {
                    columnName: 'demoIfIndex'
                }
            ]
        }
    ]);

    mib.setScalarValue('demoAgentName', 'NetNexus Demo Agent');
    mib.setScalarValue('demoAgentCounter', 0);
    mib.setScalarValue('demoWritableName', 'initial-name');
    tableRows.forEach(row => mib.addTableRow('demoIfTable', row));

    return agent;
}

const agent = createAgent();
const mibPath = path.join(__dirname, 'mibs', 'NETNEXUS-DEMO-MIB.mib');

console.log('[snmp-demo-agent] listening');
console.log(`  host: ${host}`);
console.log(`  port: ${listenPort}`);
console.log(`  community: ${community}`);
console.log(`  MIB: ${mibPath}`);
console.log('');
console.log('Useful OIDs:');
console.log(`  demoAgentName.0     ${OIDS.demoAgentName}.0`);
console.log(`  demoWritableName.0  ${OIDS.demoWritableName}.0`);
console.log(`  demoIfName column   ${OIDS.demoIfEntry}.2`);
console.log(`  demoIfAlias column  ${OIDS.demoIfEntry}.5`);
console.log('');
console.log('Press Ctrl+C to stop.');

function shutdown() {
    agent.close(() => {
        console.log('\n[snmp-demo-agent] stopped');
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
