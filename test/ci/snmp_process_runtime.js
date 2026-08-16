const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const snmp = require('net-snmp');

const SnmpApp = require('../../electron/app/snmpApp');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');

const DEMO_MIB_PATH = path.join(__dirname, '../../scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib');
const DEMO_AGENT_NAME_OID = '1.3.6.1.4.1.55555.1.1.1';
const DEMO_WRITABLE_NAME_OID = '1.3.6.1.4.1.55555.1.1.3';
const DEMO_IF_ENTRY_OID = '1.3.6.1.4.1.55555.1.2.1.1';
const DEMO_IF_NAME_OID = `${DEMO_IF_ENTRY_OID}.2`;
const TEST_TRAP_OID = '1.3.6.1.4.1.55555.0.1';

class MemoryStore {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = await predicate();
        if (result) return result;
        await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
}

function getFreeUdpPort() {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', () => {
            const port = socket.address().port;
            socket.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

async function getDistinctUdpPorts() {
    const first = await getFreeUdpPort();
    let second = await getFreeUdpPort();
    while (second === first) second = await getFreeUdpPort();
    return [first, second];
}

function createRendererTarget(events) {
    return {
        id: 73,
        send(channel, payload) {
            if (channel === 'unified-event') events.push(payload);
        },
        isDestroyed() {
            return false;
        }
    };
}

function createLocalAgent(port, errors) {
    const agent = snmp.createAgent(
        {
            port,
            address: '127.0.0.1',
            transport: 'udp4',
            disableAuthorization: true
        },
        error => {
            if (error) errors.push(error);
        }
    );
    const mib = agent.getMib();
    mib.registerProviders([
        {
            name: 'demoAgentName',
            type: snmp.MibProviderType.Scalar,
            oid: DEMO_AGENT_NAME_OID,
            scalarType: snmp.ObjectType.OctetString,
            maxAccess: snmp.MaxAccess['read-only']
        },
        {
            name: 'demoWritableName',
            type: snmp.MibProviderType.Scalar,
            oid: DEMO_WRITABLE_NAME_OID,
            scalarType: snmp.ObjectType.OctetString,
            maxAccess: snmp.MaxAccess['read-write']
        },
        {
            name: 'demoIfTable',
            type: snmp.MibProviderType.Table,
            oid: DEMO_IF_ENTRY_OID,
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
                }
            ],
            tableIndex: [{ columnName: 'demoIfIndex' }]
        }
    ]);
    mib.setScalarValue('demoAgentName', 'NetNexus Utility Agent');
    mib.setScalarValue('demoWritableName', 'before-set');
    mib.addTableRow('demoIfTable', [1, 'loopback0']);
    mib.addTableRow('demoIfTable', [2, 'ethernet0']);
    return agent;
}

async function waitForAgent(agent, port) {
    await waitFor(() => {
        const sockets = Object.values(agent.listener?.sockets || {});
        return (
            sockets.length > 0 &&
            sockets.every(socket => {
                try {
                    return socket.address().port === port;
                } catch (_error) {
                    return false;
                }
            })
        );
    }, `local SNMP agent to listen on UDP ${port}`);
}

function closeAgent(agent) {
    if (!agent) return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const timer = setTimeout(finish, 1000);
        timer.unref?.();
        try {
            agent.close(() => {
                clearTimeout(timer);
                finish();
            });
        } catch (_error) {
            clearTimeout(timer);
            finish();
        }
    });
}

function sendV2Trap(createSession, trapPort) {
    return new Promise((resolve, reject) => {
        const session = Reflect.apply(createSession, snmp, [
            '127.0.0.1',
            'public',
            {
                version: snmp.Version2c,
                transport: 'udp4',
                trapPort,
                retries: 0,
                timeout: 1000
            }
        ]);
        session.trap(
            TEST_TRAP_OID,
            [
                {
                    oid: `${DEMO_AGENT_NAME_OID}.0`,
                    type: snmp.ObjectType.OctetString,
                    value: 'utility-trap'
                }
            ],
            { upTime: 12345 },
            error => {
                try {
                    session.close();
                } catch (_error) {
                    // net-snmp may already have closed the datagram socket.
                }
                if (error) reject(error);
                else resolve();
            }
        );
    });
}

function findNamedValues(value, propertyName, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    const matches = [];
    for (const [key, child] of Object.entries(value)) {
        if (key === propertyName) matches.push(child);
        matches.push(...findNamedValues(child, propertyName, seen));
    }
    return matches;
}

function assertSuccess(response, description) {
    assert.equal(response.status, 'success', `${description}: ${response.msg || 'unknown error'}`);
    return response.data;
}

async function assertUtilityProcess(client) {
    assert(client, 'SnmpApp must retain its protocol process client');
    const host = client.process;
    assert(host, 'SNMP protocol client must expose its process host');
    assert.equal(host.runtimeKind, 'utility-process', 'SNMP runtime must use Electron utilityProcess');
    assert.equal(client.transport, 'utility-process');
    const pid = await waitFor(() => host.pid, 'SNMP Utility PID');
    assert.notEqual(pid, process.pid, 'SNMP runtime must not execute in the Electron main process');
    const metric = await waitFor(
        () => app.getAppMetrics().find(item => item.pid === pid),
        `SNMP Utility PID ${pid} to appear in app metrics`
    );
    assert.equal(metric.type, 'Utility');
    assert(
        metric.name === PROTOCOL_PROCESS_SERVICES.SNMP || metric.serviceName === PROTOCOL_PROCESS_SERVICES.SNMP,
        'SNMP Utility must retain its protocol service identity'
    );
    return { host, pid };
}

async function assertRuntimeStopped(snmpApp, sender, config) {
    assert.equal(snmpApp.worker, null, 'a stopped SNMP runtime must not retain a process client');
    assert.equal(Boolean(snmpApp.mibWorker), false, 'the Electron main process must not own a standalone MIB worker');

    const state = assertSuccess(await snmpApp.handleGetSnmpRuntimeState(), 'read stopped runtime state');
    assert.equal(state.running, false);
    assert.equal(state.trapRunning, false);
    assert.equal(snmpApp.worker, null, 'reading stopped state must not lazily create a runtime');

    const actions = [
        ['GET', () => snmpApp.handleSendGetRequest(null, { oid: `${DEMO_AGENT_NAME_OID}.0`, timeout: 1000 })],
        ['GET-NEXT', () => snmpApp.handleSendGetNextRequest(null, { oid: DEMO_AGENT_NAME_OID, timeout: 1000 })],
        [
            'WALK',
            () =>
                snmpApp.handleSendWalkRequest(null, {
                    oid: DEMO_IF_NAME_OID,
                    limit: 10,
                    maxRepetitions: 5,
                    timeout: 1000
                })
        ],
        [
            'SET',
            () =>
                snmpApp.handleSendSetRequest(null, {
                    oid: `${DEMO_WRITABLE_NAME_OID}.0`,
                    type: 'DisplayString',
                    value: 'must-not-run',
                    timeout: 1000
                })
        ],
        [
            'list instances',
            () =>
                snmpApp.handleListOidInstances(null, {
                    oid: DEMO_IF_NAME_OID,
                    limit: 10,
                    maxRepetitions: 5,
                    timeout: 1000
                })
        ],
        ['compile MIBs', () => snmpApp.handleCompileMibs({ sender }, { filePaths: [DEMO_MIB_PATH], force: true })],
        ['read MIB status', () => snmpApp.handleGetMibStatus({ sender })],
        ['read MIB tree', () => snmpApp.handleGetMibTreeChildren(null, '')],
        ['translate OID', () => snmpApp.handleTranslateOid(null, `${DEMO_AGENT_NAME_OID}.0`)],
        ['read MIB source', () => snmpApp.handleGetMibSource(null, { filePath: DEMO_MIB_PATH })],
        ['start Trap listener', () => snmpApp.handleStartSnmpTrap({ sender }, config)],
        ['stop Trap listener', () => snmpApp.handleStopSnmpTrap()],
        ['read Trap list', () => snmpApp.handleGetTrapList(null, { page: 1, pageSize: 20 })],
        ['clear Trap history', () => snmpApp.handleClearTrapHistory()]
    ];

    for (const [description, action] of actions) {
        const response = await action();
        assert.equal(response.status, 'error', `${description} must reject while the SNMP runtime is stopped`);
        assert.equal(response.data, null, `${description} stopped response must not expose stale data`);
        assert.match(response.msg, /未启动|没有运行/u, `${description} must explain that the runtime is stopped`);
        assert.equal(snmpApp.worker, null, `${description} must not lazily create an SNMP runtime`);
        assert.equal(Boolean(snmpApp.mibWorker), false, `${description} must not create a main-process MIB worker`);
    }
}

async function exerciseMibRuntime(snmpApp, sender, expectedPid) {
    const responses = [];
    const compiled = await snmpApp.handleCompileMibs({ sender }, { filePaths: [DEMO_MIB_PATH], force: true });
    const compileData = assertSuccess(compiled, 'compile demo MIB in nested worker');
    responses.push(compiled);
    assert(
        Number.isInteger(Number(compileData.mibWorkerThreadId)) && Number(compileData.mibWorkerThreadId) > 0,
        `compile response must expose a positive nested mibWorkerThreadId, got ${compileData.mibWorkerThreadId}`
    );
    assert(
        Array.isArray(compileData.loadedFiles) &&
            compileData.loadedFiles.some(file => path.basename(file.filePath || '') === path.basename(DEMO_MIB_PATH)),
        'the nested MIB worker must compile the requested demo MIB'
    );

    const status = await snmpApp.handleGetMibStatus({ sender });
    const statusData = assertSuccess(status, 'read MIB status from nested worker');
    responses.push(status);
    assert(statusData.modules.includes('NETNEXUS-DEMO-MIB'));

    const tree = await snmpApp.handleGetMibTreeChildren(null, '');
    const treeData = assertSuccess(tree, 'read MIB tree from nested worker');
    responses.push(tree);
    assert(Array.isArray(treeData));
    assert(treeData.length > 0, 'compiled MIB workspace must expose root tree nodes');

    const translated = await snmpApp.handleTranslateOid(null, `${DEMO_AGENT_NAME_OID}.0`);
    const translatedData = assertSuccess(translated, 'translate OID in nested worker');
    responses.push(translated);
    assert.equal(translatedData.moduleQualifiedName, 'NETNEXUS-DEMO-MIB::demoAgentName');

    const source = await snmpApp.handleGetMibSource(null, { filePath: DEMO_MIB_PATH });
    const sourceData = assertSuccess(source, 'read MIB source in nested worker');
    responses.push(source);
    assert.equal(sourceData.fileName, path.basename(DEMO_MIB_PATH));
    assert.match(sourceData.source, /NETNEXUS-DEMO-MIB DEFINITIONS ::= BEGIN/u);

    const threadIds = responses.flatMap(response => findNamedValues(response, 'mibWorkerThreadId'));
    assert(threadIds.length > 0, 'MIB responses must identify the nested worker thread');
    assert(
        threadIds.every(threadId => Number.isInteger(Number(threadId)) && Number(threadId) > 0),
        `nested mibWorkerThreadId values must be positive: ${threadIds.join(', ')}`
    );
    assert.equal(snmpApp.worker.pid, expectedPid, 'MIB actions must stay inside the existing SNMP Utility');
    assert.equal(
        Boolean(snmpApp.mibWorker),
        false,
        'MIB compilation must not create a worker in the Electron main process'
    );
}

async function exerciseManagerRequests(snmpApp, expectedPid) {
    const getData = assertSuccess(
        await snmpApp.handleSendGetRequest(null, {
            oid: `${DEMO_AGENT_NAME_OID}.0`,
            timeout: 2000,
            retries: 0
        }),
        'send real GET through SNMP Utility'
    );
    assert.equal(getData.varbinds[0].oid, `${DEMO_AGENT_NAME_OID}.0`);
    assert.equal(getData.varbinds[0].value, 'NetNexus Utility Agent');

    const nextData = assertSuccess(
        await snmpApp.handleSendGetNextRequest(null, {
            oid: DEMO_AGENT_NAME_OID,
            timeout: 2000,
            retries: 0
        }),
        'send real GET-NEXT through SNMP Utility'
    );
    assert.equal(nextData.varbinds[0].oid, `${DEMO_AGENT_NAME_OID}.0`);

    const setData = assertSuccess(
        await snmpApp.handleSendSetRequest(null, {
            oid: `${DEMO_WRITABLE_NAME_OID}.0`,
            type: 'DisplayString',
            value: 'after-set',
            timeout: 2000,
            retries: 0
        }),
        'send real SET through SNMP Utility'
    );
    assert.equal(setData.varbinds[0].value, 'after-set');
    const readAfterSet = assertSuccess(
        await snmpApp.handleSendGetRequest(null, {
            oid: `${DEMO_WRITABLE_NAME_OID}.0`,
            timeout: 2000,
            retries: 0
        }),
        'read value written by Utility SET'
    );
    assert.equal(readAfterSet.varbinds[0].value, 'after-set');

    const walkData = assertSuccess(
        await snmpApp.handleSendWalkRequest(null, {
            oid: DEMO_IF_NAME_OID,
            limit: 10,
            maxRepetitions: 5,
            timeout: 2000,
            retries: 0
        }),
        'send real WALK through SNMP Utility'
    );
    assert.deepEqual(
        walkData.rows.map(row => row.value),
        ['loopback0', 'ethernet0']
    );

    const instanceData = assertSuccess(
        await snmpApp.handleListOidInstances(null, {
            oid: DEMO_IF_NAME_OID,
            limit: 10,
            maxRepetitions: 5,
            timeout: 2000,
            retries: 0
        }),
        'list real OID instances through SNMP Utility'
    );
    assert.deepEqual(
        instanceData.rows.map(row => row.instance),
        ['1', '2']
    );
    assert.equal(snmpApp.worker.pid, expectedPid, 'manager requests must reuse the same SNMP Utility PID');
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'SNMP runtime CI must run through the real Electron utility-process runner'
    );
    assert.equal(typeof app?.getAppMetrics, 'function', 'Electron app metrics must be available');

    const snmpAppSource = fs.readFileSync(path.join(__dirname, '../../electron/app/snmpApp.js'), 'utf8');
    for (const forbidden of [
        /net-snmp/u,
        /createSession/u,
        /createReceiver/u,
        /WorkerWithPromise/u,
        /worker_threads/u,
        /mibWorker/u,
        /formatSnmpValue/u
    ]) {
        assert.doesNotMatch(
            snmpAppSource,
            forbidden,
            `Electron main SNMP boundary must not contain ${forbidden.source}`
        );
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-snmp-process-runtime-'));
    const [agentPort, trapPort] = await getDistinctUdpPorts();
    const config = {
        targetHost: '127.0.0.1',
        queryPort: agentPort,
        port: trapPort,
        supportedVersions: ['v2c'],
        community: 'public',
        timeout: 2000,
        maxTrapHistory: 10
    };
    const rendererEvents = [];
    const sender = createRendererTarget(rendererEvents);
    const store = new MemoryStore({
        'snmp-config': config,
        'snmp-mib-files': [DEMO_MIB_PATH]
    });
    const snmpApp = new SnmpApp(new FakeIpcMain(), store);
    snmpApp.getMibCacheFilePath = () => path.join(tempDir, 'snmp-mib-cache.json');
    snmpApp.getMibProjectRootDir = () => path.join(tempDir, 'snmp-mib-projects');

    const agentErrors = [];
    let agent = null;
    const originalCreateSession = snmp.createSession;
    const originalCreateReceiver = snmp.createReceiver;
    let mainCreateSessionCalls = 0;
    let mainCreateReceiverCalls = 0;

    try {
        agent = createLocalAgent(agentPort, agentErrors);
        await waitForAgent(agent, agentPort);

        snmp.createSession = () => {
            mainCreateSessionCalls++;
            throw new Error('MAIN_PROCESS_SNMP_SESSION_FORBIDDEN');
        };
        snmp.createReceiver = () => {
            mainCreateReceiverCalls++;
            throw new Error('MAIN_PROCESS_SNMP_RECEIVER_FORBIDDEN');
        };

        await assertRuntimeStopped(snmpApp, sender, config);

        const firstStart = await snmpApp.handleStartSnmp({ sender }, config);
        const firstState = assertSuccess(firstStart, 'start first SNMP runtime');
        assert.equal(firstState.running, true);
        assert.equal(firstState.trapRunning, false, 'starting the runtime must not implicitly bind the Trap port');
        const firstProcess = await assertUtilityProcess(snmpApp.worker);

        const runningState = assertSuccess(
            await snmpApp.handleGetSnmpRuntimeState(),
            'read running SNMP runtime state'
        );
        assert.equal(runningState.running, true);
        assert.equal(runningState.trapRunning, false);

        await exerciseMibRuntime(snmpApp, sender, firstProcess.pid);
        await exerciseManagerRequests(snmpApp, firstProcess.pid);

        const emptyTrapPage = assertSuccess(
            await snmpApp.handleGetTrapList(null, { page: 1, pageSize: 20 }),
            'read empty Trap history before listener start'
        );
        assert.equal(emptyTrapPage.total, 0);
        assert.deepEqual(emptyTrapPage.list, []);

        const trapStarted = assertSuccess(
            await snmpApp.handleStartSnmpTrap({ sender }, config),
            'start Trap listener inside SNMP Utility'
        );
        assert.equal(trapStarted.running, true);
        assert.equal(trapStarted.trapRunning, true);
        assert.equal(snmpApp.worker.pid, firstProcess.pid, 'starting Trap must not replace the SNMP Utility');

        await sendV2Trap(originalCreateSession, trapPort);
        const trapPage = await waitFor(async () => {
            const response = await snmpApp.handleGetTrapList(null, { page: 1, pageSize: 20 });
            if (response.status !== 'success' || response.data.total < 1) return null;
            return response.data;
        }, 'real UDP Trap to appear in Utility-owned history');
        assert.equal(trapPage.total, 1);
        assert.equal(trapPage.totalTraps, 1);
        assert.equal(trapPage.historyCount, 1);
        assert.equal(trapPage.list[0].version, 'v2c');
        assert.equal(trapPage.list[0].community, 'public');
        assert.equal(trapPage.list[0].trapOid, TEST_TRAP_OID);
        assert(
            trapPage.list[0].varbinds.some(
                varbind => varbind.oid === `${DEMO_AGENT_NAME_OID}.0` && varbind.value === 'utility-trap'
            )
        );

        const trapStopped = assertSuccess(
            await snmpApp.handleStopSnmpTrap(),
            'stop Trap listener without stopping runtime'
        );
        assert.equal(trapStopped.running, true);
        assert.equal(trapStopped.trapRunning, false);
        assert.equal(snmpApp.worker.pid, firstProcess.pid, 'stopping Trap must keep the SNMP Utility alive');
        assert(app.getAppMetrics().some(item => item.pid === firstProcess.pid));

        const queryAfterTrapStop = assertSuccess(
            await snmpApp.handleSendGetRequest(null, {
                oid: `${DEMO_AGENT_NAME_OID}.0`,
                timeout: 2000,
                retries: 0
            }),
            'manager query after stopping only the Trap listener'
        );
        assert.equal(queryAfterTrapStop.varbinds[0].value, 'NetNexus Utility Agent');
        assert.equal(snmpApp.worker.pid, firstProcess.pid);

        const firstStopped = await snmpApp.handleStopSnmp();
        assertSuccess(firstStopped, 'stop first SNMP runtime');
        assert.equal(snmpApp.worker, null);
        await waitFor(() => firstProcess.host.runtime === null, 'first SNMP Utility to exit');
        await waitFor(
            () => !app.getAppMetrics().some(item => item.pid === firstProcess.pid),
            `first SNMP Utility PID ${firstProcess.pid} to leave app metrics`
        );
        await assertRuntimeStopped(snmpApp, sender, config);

        const secondStart = await snmpApp.handleStartSnmp({ sender }, config);
        const secondState = assertSuccess(secondStart, 'restart SNMP runtime');
        assert.equal(secondState.running, true);
        assert.equal(secondState.trapRunning, false);
        const secondProcess = await assertUtilityProcess(snmpApp.worker);
        assert.notEqual(secondProcess.pid, firstProcess.pid, 'restarting SNMP must create a new Utility PID');

        const restoredMibStatus = await snmpApp.handleGetMibStatus({ sender });
        const restoredMibData = assertSuccess(restoredMibStatus, 'restore MIB status in restarted Utility');
        assert(restoredMibData.modules.includes('NETNEXUS-DEMO-MIB'));
        const restartedThreadIds = findNamedValues(restoredMibStatus, 'mibWorkerThreadId');
        assert(restartedThreadIds.some(threadId => Number(threadId) > 0));

        const secondStopped = await snmpApp.handleStopSnmp();
        assertSuccess(secondStopped, 'stop restarted SNMP runtime');
        await waitFor(() => secondProcess.host.runtime === null, 'second SNMP Utility to exit');
        await waitFor(
            () => !app.getAppMetrics().some(item => item.pid === secondProcess.pid),
            `second SNMP Utility PID ${secondProcess.pid} to leave app metrics`
        );

        assert.equal(mainCreateSessionCalls, 0, 'SNMP manager sessions must never be created in Electron main');
        assert.equal(mainCreateReceiverCalls, 0, 'SNMP Trap receivers must never be created in Electron main');
        assert.equal(agentErrors.length, 0, agentErrors[0]?.stack || agentErrors[0]?.message);
        console.log(
            `SNMP process runtime passed: main=${process.pid}, first=${firstProcess.pid}, second=${secondProcess.pid}`
        );
    } finally {
        if (snmpApp.worker) {
            await snmpApp.handleStopSnmp().catch(() => {});
            await snmpApp.worker?.terminate().catch(() => {});
        }
        snmp.createSession = originalCreateSession;
        snmp.createReceiver = originalCreateReceiver;
        await closeAgent(agent);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
