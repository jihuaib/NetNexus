const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const BgpConst = require('../const/bgpConst');
const BgpRouteSqliteStore = require('../worker/bgp/bgpRouteSqliteStore');
const { getAfiAndSafi } = require('./bgpUtils');
const { createMrtEncoder } = require('./bgpMrtEncoder');

const MRT_FAMILIES = new Set([
    BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
    BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
    BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST
]);
const EXPORT_BATCH_ROUTES = 1000;
const EXPORT_BATCH_BYTES = 1024 * 1024;

function openSnapshot(options) {
    const addressFamily = Number(options.addressFamily);
    if (!MRT_FAMILIES.has(addressFamily)) throw new Error('MRT 导出支持 IPv4、IPv6 和 IPv4 Label 路由');
    if (!fs.existsSync(options.dbPath)) throw new Error('没有可导出的 BGP 路由库');
    const store = new BgpRouteSqliteStore({ dbPath: options.dbPath, readOnly: true });
    try {
        store.open();
        store.db.exec('BEGIN');
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instanceKey = `0|${afi}|${safi}`;
        let routeCount;
        let groupName;
        const groupId = options.groupId;
        if (groupId !== undefined) {
            if (typeof groupId !== 'string' || !groupId.trim()) throw new Error('路由组 ID 无效');
            const group = store.listRouteGroups().find(item => item.groupId === groupId);
            if (!group) throw new Error('本组尚未生成路由');
            if (group.addressFamily !== addressFamily) throw new Error('路由组地址族与导出请求不一致');
            routeCount = group.routeCount;
            groupName = group.groupName;
        } else routeCount = store.getRouteCount(instanceKey);
        if (!routeCount) throw new Error('没有可导出的已生成路由');
        if (!Number.isSafeInteger(routeCount) || routeCount > 0x100000000)
            throw new Error('导出路由数超出 MRT 序列号范围');
        return {
            store,
            addressFamily,
            routeCount,
            groupName,
            routes: () =>
                groupId === undefined
                    ? store.iterateRoutes(instanceKey)
                    : store.iterateRouteGroupRoutes(groupId, { batchSize: EXPORT_BATCH_ROUTES })
        };
    } catch (error) {
        store.close();
        throw error;
    }
}

function closeSnapshot(snapshot) {
    try {
        if (snapshot.store.db?.inTransaction) snapshot.store.db.exec('ROLLBACK');
    } finally {
        snapshot.store.close();
    }
}

function getMrtExportInfo(options) {
    const snapshot = openSnapshot(options);
    try {
        return {
            addressFamily: snapshot.addressFamily,
            routeCount: snapshot.routeCount,
            groupName: snapshot.groupName
        };
    } finally {
        closeSnapshot(snapshot);
    }
}

/** Stream a consistent, read-only route snapshot to an atomically published file. */
async function exportRouteDatabaseMrt(options) {
    const requestedPath = path.resolve(options.filePath);
    // Resolve the parent once, so directory aliases cannot bypass the database
    // guard or redirect the temporary file between creation and publication.
    const filePath = path.join(fs.realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));
    const dbPath = path.resolve(options.dbPath);
    const sourcePaths = new Set([dbPath]);
    if (fs.existsSync(dbPath)) sourcePaths.add(fs.realpathSync(dbPath));
    const targetStat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    for (const sourcePath of sourcePaths) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            const artifact = `${sourcePath}${suffix}`;
            const canonicalArtifact = path.join(fs.realpathSync(path.dirname(artifact)), path.basename(artifact));
            const sameEntry = filePath === canonicalArtifact;
            const artifactStat = targetStat && fs.existsSync(artifact) ? fs.statSync(artifact) : null;
            const sameFile = artifactStat && targetStat.dev === artifactStat.dev && targetStat.ino === artifactStat.ino;
            if (sameEntry || sameFile) throw new Error('导出文件不能覆盖 BGP 路由数据库');
        }
    }
    const snapshot = openSnapshot(options);
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let file = null;
    let published = false;
    try {
        const encoder = createMrtEncoder({
            addressFamily: snapshot.addressFamily,
            routerId: options.routerId,
            localAs: options.localAs,
            localIp: options.localIp,
            timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
            viewName: snapshot.groupName || 'NetNexus',
            addPath: true
        });
        file = await fs.promises.open(temporaryPath, 'wx');
        let chunks = [encoder.peerIndexTable()];
        let chunkBytes = chunks[0].length;
        let batchRoutes = 0;
        let routeCount = 0;
        const flush = async () => {
            if (!chunks.length) return;
            await file.writeFile(Buffer.concat(chunks, chunkBytes));
            chunks = [];
            chunkBytes = 0;
            batchRoutes = 0;
            if (options.onProgress) await options.onProgress(routeCount);
        };
        for (const row of snapshot.routes()) {
            const record = encoder.encodeRoute(row, { sequence: routeCount });
            chunks.push(record);
            chunkBytes += record.length;
            routeCount += 1;
            batchRoutes += 1;
            if (chunkBytes >= EXPORT_BATCH_BYTES || batchRoutes >= EXPORT_BATCH_ROUTES) await flush();
        }
        await flush();
        if (routeCount !== snapshot.routeCount) throw new Error('路由库快照数量不一致，导出未完成');
        await file.sync();
        await file.close();
        file = null;
        closeSnapshot(snapshot);
        await fs.promises.rename(temporaryPath, filePath);
        published = true;
        return { filePath: requestedPath, routeCount, addressFamily: snapshot.addressFamily };
    } finally {
        try {
            if (file) await file.close();
        } finally {
            try {
                if (snapshot.store.db) closeSnapshot(snapshot);
            } finally {
                if (!published) await fs.promises.rm(temporaryPath, { force: true });
            }
        }
    }
}

module.exports = { getMrtExportInfo, exportRouteDatabaseMrt };
