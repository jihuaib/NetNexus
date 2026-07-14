const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snmp = require('net-snmp');
const MibRegistry = require('../../electron/utils/mibRegistry');

const LARGE_MIB_COUNT = 180;
const MAX_FILES_PER_BATCH = 128;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mib-large-directory-'));
const originalCreateModuleStore = snmp.createModuleStore;
let serializeBatchSizes = [];

snmp.createModuleStore = function createInstrumentedModuleStore(...args) {
    const store = originalCreateModuleStore.apply(this, args);
    const originalSerialize = store.parser.Serialize;
    store.parser.Serialize = function serializeWithBatchSize(...serializeArgs) {
        serializeBatchSizes.push(Object.keys(this.CharBuffer?.Table || {}).length);
        return originalSerialize.apply(this, serializeArgs);
    };
    return store;
};

function writeMib(filePath, moduleName, objectName, enterpriseId) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
        filePath,
        `${moduleName} DEFINITIONS ::= BEGIN

IMPORTS
    enterprises
        FROM SNMPv2-SMI;

${objectName} OBJECT IDENTIFIER ::= { enterprises ${enterpriseId} }

END
`,
        'utf8'
    );
}

function resetSerializeMeasurements() {
    serializeBatchSizes = [];
}

try {
    const largeDirectory = path.join(tempDir, 'large');
    for (let index = 0; index < LARGE_MIB_COUNT; index += 1) {
        const suffix = String(index).padStart(3, '0');
        writeMib(
            path.join(largeDirectory, `NETNEXUS-LARGE-${suffix}-MIB.mib`),
            `NETNEXUS-LARGE-${suffix}-MIB`,
            `netNexusLarge${suffix}`,
            91000 + index
        );
    }

    resetSerializeMeasurements();
    const largeRegistry = new MibRegistry();
    const largeProgress = [];
    const largeSummary = largeRegistry.compileMibFiles([largeDirectory], {
        onProgress: progress => largeProgress.push(JSON.parse(JSON.stringify(progress)))
    });
    assert.equal(largeSummary.loadedFiles.length, LARGE_MIB_COUNT);
    assert.equal(largeSummary.failedFiles.length, 0);
    assert.equal(largeSummary.skippedFiles.length, 0);
    assert(serializeBatchSizes.length >= 2, '180个MIB必须拆成多个批次编译');
    assert(
        serializeBatchSizes.every(size => size > 0 && size <= MAX_FILES_PER_BATCH),
        `每次Serialize最多处理${MAX_FILES_PER_BATCH}个MIB，实际批次: ${serializeBatchSizes.join(', ')}`
    );
    assert.equal(
        serializeBatchSizes.reduce((total, size) => total + size, 0),
        LARGE_MIB_COUNT,
        '正常分块编译不应重复Serialize已成功的MIB'
    );
    const largeTerminalEvents = largeProgress.filter(progress =>
        ['compiled', 'skipped', 'failed'].includes(progress.fileStatus)
    );
    assert.equal(largeTerminalEvents.length, LARGE_MIB_COUNT, '每个MIB必须且只能产生一个文件终态事件');
    assert.equal(
        new Set(largeTerminalEvents.map(progress => progress.filePath)).size,
        LARGE_MIB_COUNT,
        '文件终态事件不能因批次重试而重复'
    );
    let lastCompleted = 0;
    largeProgress.forEach(progress => {
        assert(progress.completed >= lastCompleted, '进度completed必须单调递增');
        assert(progress.completed <= progress.total, '进度completed不能超过total');
        lastCompleted = progress.completed;
    });
    const largeFinalProgress = largeProgress.at(-1);
    assert.equal(largeFinalProgress.phase, 'completed');
    assert.equal(largeFinalProgress.completed, LARGE_MIB_COUNT);
    assert.deepEqual(largeFinalProgress.counts, {
        compiled: LARGE_MIB_COUNT,
        skipped: 0,
        failed: 0
    });

    const sameBasenameLeft = path.join(tempDir, 'same-basename', 'left', 'SHARED.mib');
    const sameBasenameRight = path.join(tempDir, 'same-basename', 'right', 'SHARED.mib');
    writeMib(sameBasenameLeft, 'NETNEXUS-SHARED-LEFT-MIB', 'netNexusSharedLeft', 91201);
    writeMib(sameBasenameRight, 'NETNEXUS-SHARED-RIGHT-MIB', 'netNexusSharedRight', 91202);

    const sameBasenameRegistry = new MibRegistry();
    const sameBasenameSummary = sameBasenameRegistry.compileMibFiles([sameBasenameLeft, sameBasenameRight]);
    assert.equal(sameBasenameSummary.loadedFiles.length, 2);
    assert.equal(sameBasenameSummary.failedFiles.length, 0);
    assert(sameBasenameSummary.modules.includes('NETNEXUS-SHARED-LEFT-MIB'));
    assert(sameBasenameSummary.modules.includes('NETNEXUS-SHARED-RIGHT-MIB'));

    const duplicateWinner = path.join(tempDir, 'duplicates', 'winner', 'DUPLICATE.mib');
    const duplicateSkipped = path.join(tempDir, 'duplicates', 'skipped', 'DUPLICATE.mib');
    writeMib(duplicateWinner, 'NETNEXUS-DUPLICATE-MIB', 'netNexusDuplicateWinner', 91301);
    writeMib(duplicateSkipped, 'NETNEXUS-DUPLICATE-MIB', 'netNexusDuplicateSkipped', 91302);

    const duplicateRegistry = new MibRegistry();
    const duplicateProgress = [];
    const duplicateSummary = duplicateRegistry.compileMibFiles([duplicateWinner, duplicateSkipped], {
        onProgress: progress => duplicateProgress.push(progress)
    });
    assert.equal(duplicateSummary.loadedFiles.length, 1);
    assert.equal(duplicateSummary.loadedFiles[0].filePath, duplicateWinner);
    assert.equal(duplicateSummary.failedFiles.length, 0);
    assert.equal(duplicateSummary.skippedFiles.length, 1);
    assert.equal(duplicateSummary.skippedFiles[0].filePath, duplicateSkipped);
    assert.equal(duplicateSummary.skippedFiles[0].status, 'skipped');
    assert.match(duplicateSummary.skippedFiles[0].msg, /重复模块/);
    assert.equal(
        duplicateProgress.filter(progress => progress.fileStatus === 'skipped').length,
        1,
        '重复模块必须在进度中显示为跳过'
    );

    const isolatedFailureDirectory = path.join(tempDir, 'isolated-failure');
    const goodMibCount = 40;
    for (let index = 0; index < goodMibCount; index += 1) {
        const suffix = String(index).padStart(2, '0');
        writeMib(
            path.join(isolatedFailureDirectory, `GOOD-${suffix}-MIB.mib`),
            `NETNEXUS-GOOD-${suffix}-MIB`,
            `netNexusGood${suffix}`,
            91400 + index
        );
    }
    const badMibPath = path.join(isolatedFailureDirectory, 'ZZ-BROKEN-MIB.mib');
    fs.writeFileSync(
        badMibPath,
        `NETNEXUS-BROKEN-MIB DEFINITIONS ::= BEGIN

IMPORTS
    OBJECT-TYPE, enterprises
        FROM SNMPv2-SMI;

netNexusBroken OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "Definition intentionally overwritten below"
    ::= { enterprises 91499 }

netNexusBroken ::= SEQUENCE { value INTEGER }

netNexusBrokenChild OBJECT IDENTIFIER ::= { netNexusBroken 1 }

END
`,
        'utf8'
    );

    resetSerializeMeasurements();
    const isolatedFailureRegistry = new MibRegistry();
    const isolatedFailureProgress = [];
    const isolatedFailureSummary = isolatedFailureRegistry.compileMibFiles([isolatedFailureDirectory], {
        onProgress: progress => isolatedFailureProgress.push(progress)
    });
    assert.equal(isolatedFailureSummary.loadedFiles.length, goodMibCount);
    assert.equal(isolatedFailureSummary.failedFiles.length, 1);
    assert.equal(isolatedFailureSummary.failedFiles[0].filePath, badMibPath);
    assert(isolatedFailureSummary.modules.includes('NETNEXUS-GOOD-00-MIB'));
    assert(isolatedFailureSummary.modules.includes('NETNEXUS-GOOD-39-MIB'));
    assert(!isolatedFailureSummary.modules.includes('NETNEXUS-BROKEN-MIB'));
    const serializedFileWork = serializeBatchSizes.reduce((total, size) => total + size, 0);
    assert(
        serializedFileWork <= (goodMibCount + 1) * 2,
        `坏文件隔离不应触发已成功文件的累计全量重建，实际Serialize工作量: ${serializedFileWork}`
    );
    const isolatedTerminalEvents = isolatedFailureProgress.filter(progress =>
        ['compiled', 'skipped', 'failed'].includes(progress.fileStatus)
    );
    assert.equal(isolatedTerminalEvents.length, goodMibCount + 1);
    assert.equal(new Set(isolatedTerminalEvents.map(progress => progress.filePath)).size, goodMibCount + 1);
    assert.equal(isolatedTerminalEvents.filter(progress => progress.fileStatus === 'compiled').length, goodMibCount);
    assert.equal(isolatedTerminalEvents.filter(progress => progress.fileStatus === 'failed').length, 1);
    assert.deepEqual(isolatedFailureProgress.at(-1).counts, {
        compiled: goodMibCount,
        skipped: 0,
        failed: 1
    });

    console.log('MIB registry large-directory and failure-isolation tests passed');
} finally {
    snmp.createModuleStore = originalCreateModuleStore;
    fs.rmSync(tempDir, { recursive: true, force: true });
}
