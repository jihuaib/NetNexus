class RouteUpdateAggregator {
    constructor() {
        this.pendingRouteUpdates = new Map();
        this.pendingInstanceRouteUpdates = new Map();
    }

    makeRouteUpdateKey(update) {
        return [
            update.client?.localIp,
            update.client?.localPort,
            update.client?.remoteIp,
            update.client?.remotePort,
            update.session?.sessionType,
            update.session?.sessionRd,
            update.session?.sessionIp,
            update.session?.sessionAs,
            update.af,
            update.ribType
        ].join('|');
    }

    makeInstanceRouteUpdateKey(update) {
        return [
            update.client?.localIp,
            update.client?.localPort,
            update.client?.remoteIp,
            update.client?.remotePort,
            update.instance?.instanceType,
            update.instance?.instanceRd,
            update.instance?.addrFamilyType,
            update.af
        ].join('|');
    }

    mergePendingRouteUpdate(map, key, update, updatedAt) {
        const existing = map.get(key);
        if (!existing) {
            map.set(key, { ...update, batch: true, changedCount: update.changedCount || 1, updatedAt });
            return;
        }

        existing.type = update.type;
        existing.changedCount += update.changedCount || 1;
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

    clear() {
        this.pendingRouteUpdates.clear();
        this.pendingInstanceRouteUpdates.clear();
    }
}

module.exports = RouteUpdateAggregator;
