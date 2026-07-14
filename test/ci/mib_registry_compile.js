const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snmp = require('net-snmp');
const MibRegistry = require('../../electron/utils/mibRegistry');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mib-registry-'));
const cacheFilePath = path.join(tempDir, 'mib-cache.json');
const rootMibPath = path.join(tempDir, 'TEST-ROOT-MIB.mib');
const childMibPath = path.join(tempDir, 'TEST-CHILD-MIB.mib');
const objectsMibPath = path.join(tempDir, 'TEST-OBJECTS-MIB.mib');
const requestedFiles = [objectsMibPath, childMibPath, rootMibPath];
const testOid = '1.3.6.1.4.1.99990.1.1.0';

const originalCreateModuleStore = snmp.createModuleStore;
let serializeCalls = 0;

snmp.createModuleStore = function createInstrumentedModuleStore(...args) {
    const store = originalCreateModuleStore.apply(this, args);
    const originalSerialize = store.parser.Serialize;
    store.parser.Serialize = function serializeWithCounter(...serializeArgs) {
        serializeCalls += 1;
        return originalSerialize.apply(this, serializeArgs);
    };
    return store;
};

try {
    fs.writeFileSync(
        rootMibPath,
        `TEST-ROOT-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises
        FROM SNMPv2-SMI;

testRoot OBJECT IDENTIFIER ::= { enterprises 99990 }

END
`,
        'utf8'
    );
    fs.writeFileSync(
        childMibPath,
        `TEST-CHILD-MIB DEFINITIONS ::= BEGIN

IMPORTS
    testRoot
        FROM TEST-ROOT-MIB;

testChild OBJECT IDENTIFIER ::= { testRoot 1 }

END
`,
        'utf8'
    );
    fs.writeFileSync(
        objectsMibPath,
        `TEST-OBJECTS-MIB DEFINITIONS ::= BEGIN

IMPORTS
    testChild
        FROM TEST-CHILD-MIB
    OBJECT-TYPE, Integer32
        FROM SNMPv2-SMI;

testValue OBJECT-TYPE
    SYNTAX Integer32
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "A test scalar"
    ::= { testChild 1 }

END
`,
        'utf8'
    );

    const registry = new MibRegistry();
    const summary = registry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
    assert.equal(summary.loadedFiles.length, 3);
    assert.equal(summary.failedFiles.length, 0);
    assert.deepEqual(
        summary.loadedFiles.map(file => file.fileName),
        ['TEST-ROOT-MIB.mib', 'TEST-CHILD-MIB.mib', 'TEST-OBJECTS-MIB.mib']
    );
    assert.equal(serializeCalls, 1, 'batch compilation must serialize all input MIBs once');
    assert(summary.modules.includes('TEST-ROOT-MIB'));
    assert(summary.modules.includes('TEST-CHILD-MIB'));
    assert(summary.modules.includes('TEST-OBJECTS-MIB'));
    assert.equal(registry.translateOid(testOid).moduleQualifiedName, 'TEST-OBJECTS-MIB::testValue');

    const serializeCallsAfterCompile = serializeCalls;
    let snapshotLoads = 0;
    const originalLoadSnapshot = registry.loadSnapshot.bind(registry);
    registry.loadSnapshot = (...args) => {
        snapshotLoads += 1;
        return originalLoadSnapshot(...args);
    };
    registry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
    assert.equal(snapshotLoads, 0, 'the active registry must be reused for repeated requests');
    assert.equal(serializeCalls, serializeCallsAfterCompile);

    const restoredRegistry = new MibRegistry();
    const restoredSummary = restoredRegistry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
    assert.equal(restoredSummary.cacheHit, true);
    const serializeCallsAfterCacheRestore = serializeCalls;
    restoredRegistry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
    assert.equal(serializeCalls, serializeCallsAfterCacheRestore, 'a cache hit must remain active in memory');

    registry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath, force: true });
    assert.equal(serializeCalls, serializeCallsAfterCompile + 1, 'force must bypass the active registry');

    fs.appendFileSync(objectsMibPath, '\n-- invalidate the source signature\n', 'utf8');
    registry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
    assert.equal(serializeCalls, serializeCallsAfterCompile + 2, 'a changed source file must recompile');

    console.log('MIB registry batch compilation tests passed');
} finally {
    snmp.createModuleStore = originalCreateModuleStore;
    fs.rmSync(tempDir, { recursive: true, force: true });
}
