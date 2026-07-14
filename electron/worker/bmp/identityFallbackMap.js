class IdentityFallbackMap extends Map {
    constructor(makeLegacyKey, entries) {
        super(entries);
        this.makeLegacyKey = makeLegacyKey;
    }

    resolveFallbackKey(key) {
        if (typeof this.makeLegacyKey !== 'function') {
            return undefined;
        }

        let matchedKey;
        for (const [candidateKey, value] of super.entries()) {
            if (this.makeLegacyKey(value) !== key) {
                continue;
            }
            if (matchedKey !== undefined) {
                return undefined;
            }
            matchedKey = candidateKey;
        }
        return matchedKey;
    }

    get(key) {
        if (super.has(key)) {
            return super.get(key);
        }
        const fallbackKey = this.resolveFallbackKey(key);
        return fallbackKey === undefined ? undefined : super.get(fallbackKey);
    }

    has(key) {
        return super.has(key) || this.resolveFallbackKey(key) !== undefined;
    }

    delete(key) {
        if (super.has(key)) {
            return super.delete(key);
        }
        const fallbackKey = this.resolveFallbackKey(key);
        return fallbackKey === undefined ? false : super.delete(fallbackKey);
    }
}

module.exports = IdentityFallbackMap;
