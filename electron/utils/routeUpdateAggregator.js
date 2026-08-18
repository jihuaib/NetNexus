class RouteUpdateAggregator {
    constructor() {
        this.pendingRouteUpdates = new Map();
        this.pendingInstanceRouteUpdates = new Map();
    }

    getSourceId(update) {
        return (
            update.sourceId || update.persistentSourceId || update.client?.sourceId || update.client?.persistentSourceId
        );
    }

    getConnectionId(update) {
        return update.client?.persistentConnectionId || update.client?.connectionId || null;
    }

    getScopeId(update, entity) {
        return update.scopeId || update.persistentScopeId || entity?.scopeId || entity?.persistentScopeId || null;
    }

    makeRouteUpdateKey(update) {
        const sourceId = this.getSourceId(update);
        const connectionId = this.getConnectionId(update);
        const scopeId = this.getScopeId(update, update.session);
        if (scopeId) {
            return ['scope', sourceId || '', connectionId || '', scopeId].join('|');
        }
        return [
            connectionId || '',
            update.client?.localIp,
            update.client?.localPort,
            update.client?.remoteIp,
            update.client?.remotePort,
            update.session?.sessionType,
            update.session?.sessionRdRaw || update.session?.sessionRd,
            update.session?.sessionIp,
            update.session?.sessionAs,
            update.af,
            update.ribType
        ].join('|');
    }

    makeInstanceRouteUpdateKey(update) {
        const sourceId = this.getSourceId(update);
        const connectionId = this.getConnectionId(update);
        const scopeId = this.getScopeId(update, update.instance);
        if (scopeId) {
            return ['scope', sourceId || '', connectionId || '', scopeId].join('|');
        }
        return [
            connectionId || '',
            update.client?.localIp,
            update.client?.localPort,
            update.client?.remoteIp,
            update.client?.remotePort,
            update.instance?.instanceType,
            update.instance?.instanceRdRaw || update.instance?.instanceRd,
            update.instance?.addrFamilyType,
            update.af
        ].join('|');
    }

    normalizeChangedCount(changedCount) {
        const value = Number(changedCount);
        return Number.isFinite(value) && value >= 0 ? value : 1;
    }

    mergePendingRouteUpdate(map, key, update, updatedAt) {
        const existing = map.get(key);
        if (!existing) {
            map.set(key, {
                ...update,
                batch: true,
                types: [update.type],
                changedCount: this.normalizeChangedCount(update.changedCount),
                updatedAt
            });
            return;
        }

        existing.type = update.type;
        if (!existing.types.includes(update.type)) {
            existing.types.push(update.type);
        }
        if (Object.prototype.hasOwnProperty.call(update, 'reason')) {
            existing.reason = update.reason;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'projectionReset')) {
            existing.projectionReset = update.projectionReset;
        }
        existing.changedCount += this.normalizeChangedCount(update.changedCount);
        existing.updatedAt = updatedAt;
    }

    enqueueRouteUpdate(update) {
        this.mergePendingRouteUpdate(this.pendingRouteUpdates, this.makeRouteUpdateKey(update), update, Date.now());
    }

    enqueueInstanceRouteUpdate(update) {
        this.mergePendingRouteUpdate(
            this.pendingInstanceRouteUpdates,
            this.makeInstanceRouteUpdateKey(update),
            update,
            Date.now()
        );
    }

    flushRouteUpdates() {
        const updates = Array.from(this.pendingRouteUpdates.values());
        this.pendingRouteUpdates.clear();
        return updates;
    }

    flushInstanceRouteUpdates() {
        const updates = Array.from(this.pendingInstanceRouteUpdates.values());
        this.pendingInstanceRouteUpdates.clear();
        return updates;
    }

    deleteSource(sourceId) {
        let deleted = 0;
        [this.pendingRouteUpdates, this.pendingInstanceRouteUpdates].forEach(updates => {
            for (const [key, update] of updates) {
                if (this.getSourceId(update) === sourceId) {
                    updates.delete(key);
                    deleted += 1;
                }
            }
        });
        return deleted;
    }

    clear() {
        this.pendingRouteUpdates.clear();
        this.pendingInstanceRouteUpdates.clear();
    }
}

module.exports = RouteUpdateAggregator;
