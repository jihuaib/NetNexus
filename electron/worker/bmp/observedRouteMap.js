class ObservedRouteMap extends Map {
    constructor(entries, onMutation) {
        super();
        this.onMutation = typeof onMutation === 'function' ? onMutation : null;
        if (entries && typeof entries[Symbol.iterator] === 'function') {
            for (const [key, value] of entries) {
                super.set(key, value);
            }
        }
    }

    set(key, value) {
        const isNew = !this.has(key);
        const previous = this.get(key);
        super.set(key, value);
        this.onMutation?.({ action: 'upsert', routeKey: key, route: value, previous, isNew });
        return this;
    }

    delete(key) {
        if (!this.has(key)) {
            return false;
        }
        const route = this.get(key);
        const deleted = super.delete(key);
        if (deleted) {
            this.onMutation?.({ action: 'delete', routeKey: key, route, previous: route, isNew: false });
        }
        return deleted;
    }

    clear() {
        if (this.size === 0) {
            return;
        }
        for (const [routeKey, route] of this) {
            super.delete(routeKey);
            this.onMutation?.({ action: 'delete', routeKey, route, previous: route, isNew: false });
        }
    }

    clearSilently() {
        Map.prototype.clear.call(this);
    }
}

module.exports = ObservedRouteMap;
