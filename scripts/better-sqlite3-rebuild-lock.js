const fs = require('fs');
const path = require('path');

const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 100;

function lockFilePath(projectRoot) {
    return path.join(projectRoot, 'node_modules', '.cache', 'netnexus', 'better-sqlite3-rebuild.lock');
}

function sleepSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function readLock(lockPath, fsApi = fs) {
    try {
        return JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    } catch (_error) {
        return null;
    }
}

function removeStaleLock(lockPath, dependencies = {}) {
    const fsApi = dependencies.fs || fs;
    let stats;
    try {
        stats = fsApi.statSync(lockPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }

    const now = (dependencies.now || Date.now)();
    const lock = readLock(lockPath, fsApi);
    const age = Math.max(0, now - Number(lock?.startedAt || stats.mtimeMs));
    const isRunning = dependencies.processIsRunning || processIsRunning;
    if (age <= LOCK_MAX_AGE_MS && (!lock?.pid || isRunning(lock.pid))) return false;

    try {
        fsApi.unlinkSync(lockPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return true;
}

function waitForRebuild(projectRoot, dependencies = {}) {
    const lockPath = lockFilePath(projectRoot);
    const fsApi = dependencies.fs || fs;
    const now = dependencies.now || Date.now;
    const sleep = dependencies.sleep || sleepSync;
    const startedAt = now();

    while (fsApi.existsSync(lockPath)) {
        if (removeStaleLock(lockPath, dependencies)) continue;
        if (now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
            throw new Error(`Timed out waiting for better-sqlite3 source rebuild lock: ${lockPath}`);
        }
        sleep(LOCK_POLL_MS);
    }
}

function acquireRebuildLock(projectRoot, dependencies = {}) {
    const fsApi = dependencies.fs || fs;
    const lockPath = lockFilePath(projectRoot);
    fsApi.mkdirSync(path.dirname(lockPath), { recursive: true });

    let shouldRetry = true;
    while (shouldRetry) {
        waitForRebuild(projectRoot, dependencies);
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
            const descriptor = fsApi.openSync(lockPath, 'wx');
            try {
                fsApi.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }));
            } finally {
                fsApi.closeSync(descriptor);
            }
            return () => {
                const current = readLock(lockPath, fsApi);
                if (current?.token !== token) return;
                try {
                    fsApi.unlinkSync(lockPath);
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            shouldRetry = true;
        }
    }
    throw new Error(`Unable to acquire better-sqlite3 source rebuild lock: ${lockPath}`);
}

module.exports = {
    LOCK_MAX_AGE_MS,
    LOCK_POLL_MS,
    LOCK_WAIT_TIMEOUT_MS,
    acquireRebuildLock,
    lockFilePath,
    processIsRunning,
    readLock,
    removeStaleLock,
    sleepSync,
    waitForRebuild
};
