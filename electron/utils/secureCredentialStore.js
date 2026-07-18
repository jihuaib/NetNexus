const { safeStorage } = require('electron');

const SECRET_FIELDS = Object.freeze(['password', 'passphrase', 'privateKey']);

class SecureCredentialStore {
    constructor(options = {}) {
        this.safeStorage = options.safeStorage || safeStorage;
    }

    isAvailable() {
        try {
            return Boolean(this.safeStorage?.isEncryptionAvailable?.());
        } catch (_error) {
            return false;
        }
    }

    encrypt(value) {
        if (!value) return '';
        if (!this.isAvailable()) {
            throw new Error('操作系统安全存储当前不可用');
        }
        return this.safeStorage.encryptString(String(value)).toString('base64');
    }

    decrypt(value) {
        if (!value) return '';
        if (!this.isAvailable()) {
            throw new Error('操作系统安全存储当前不可用');
        }
        return this.safeStorage.decryptString(Buffer.from(String(value), 'base64'));
    }

    protectProfile(profile = {}, previous = {}) {
        const output = { ...profile };
        SECRET_FIELDS.forEach(field => {
            const encryptedField = `${field}Encrypted`;
            const plainValue = profile[field];
            delete output[field];

            if (!profile.rememberCredentials) {
                delete output[encryptedField];
                return;
            }

            if (plainValue) {
                output[encryptedField] = this.encrypt(plainValue);
            } else if (previous[encryptedField]) {
                output[encryptedField] = previous[encryptedField];
            }
        });
        return output;
    }

    hydrateProfile(profile = {}, transientSecrets = {}) {
        const output = { ...profile };
        SECRET_FIELDS.forEach(field => {
            const encryptedField = `${field}Encrypted`;
            if (transientSecrets[field]) {
                output[field] = transientSecrets[field];
            } else if (profile[encryptedField]) {
                output[field] = this.decrypt(profile[encryptedField]);
            } else {
                output[field] = '';
            }
            delete output[encryptedField];
        });
        return output;
    }

    sanitizeProfile(profile = {}) {
        const output = { ...profile };
        SECRET_FIELDS.forEach(field => {
            delete output[field];
            delete output[`${field}Encrypted`];
        });
        output.hasSavedCredentials = SECRET_FIELDS.some(field => Boolean(profile[`${field}Encrypted`]));
        return output;
    }
}

module.exports = SecureCredentialStore;
