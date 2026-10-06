class DynamicParameterRegistry {
    constructor({ timeoutMs = 3000 } = {}) {
        this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
        this.providers = new Map();
    }

    register(name, provider) {
        const providerName = String(name || '').trim();
        if (!providerName || typeof provider !== 'function') {
            throw new TypeError('Dynamic parameter registration requires a name and provider function');
        }

        const registration = { provider };
        this.providers.set(providerName, registration);
        return () => {
            if (this.providers.get(providerName) !== registration) {
                return false;
            }
            return this.providers.delete(providerName);
        };
    }

    async resolve(name, context = {}) {
        const providerName = String(name || '').trim();
        const registration = this.providers.get(providerName);
        if (!registration) {
            return failedResolution(providerName, 'unknown-provider', 'Dynamic parameter provider is not registered');
        }

        let timer;
        try {
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`Dynamic parameter provider timed out after ${this.timeoutMs} ms`);
                    error.code = 'provider-timeout';
                    reject(error);
                }, this.timeoutMs);
            });
            const values = await Promise.race([Promise.resolve().then(() => registration.provider(context)), timeout]);
            if (!Array.isArray(values)) {
                return failedResolution(
                    providerName,
                    'invalid-result',
                    'Dynamic parameter provider must return an array'
                );
            }
            return { candidates: normalizeCandidates(values, context), diagnostic: null };
        } catch (error) {
            return failedResolution(
                providerName,
                error && error.code === 'provider-timeout' ? 'provider-timeout' : 'provider-error',
                error && error.message ? error.message : String(error)
            );
        } finally {
            clearTimeout(timer);
        }
    }
}

function normalizeCandidates(values, context) {
    const prefix = String(context.prefix || '').toLowerCase();
    const seen = new Set();
    const candidates = [];
    values.forEach(item => {
        const rawValue = typeof item === 'string' ? item : item && item.value;
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
            return;
        }
        const value = String(rawValue);
        if (
            !value ||
            Array.from(value).some(isControlCharacter) ||
            seen.has(value) ||
            !value.toLowerCase().startsWith(prefix)
        ) {
            return;
        }
        if (context.node && context.node.paramType && !context.node.paramType.validate(value)) {
            return;
        }
        seen.add(value);
        candidates.push({
            value,
            description:
                typeof item === 'string'
                    ? ''
                    : Array.from(String(item.description || ''), character =>
                          isControlCharacter(character) ? ' ' : character
                      ).join('')
        });
    });
    return candidates;
}

function isControlCharacter(character) {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
}

function failedResolution(provider, code, message) {
    return { candidates: [], diagnostic: { provider, code, message } };
}

module.exports = DynamicParameterRegistry;
