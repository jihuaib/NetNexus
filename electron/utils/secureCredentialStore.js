const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const LocalFileKeyProvider = require('./localFileKeyProvider');

const SECRET_FIELDS = Object.freeze(['password', 'passphrase', 'privateKey']);
const LINUX_CIPHERTEXT_PREFIX = 'netnexus-local-file:v1:';
const LINUX_CIPHER_ALGORITHM = 'aes-256-gcm';
const LINUX_IV_BYTES = 12;
const LINUX_AUTH_TAG_BYTES = 16;
const MAX_LINUX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_LINUX_CIPHERTEXT_CHARS = 2 * 1024 * 1024;
const LINUX_CIPHER_AAD = Buffer.from('NetNexus SecureCredentialStore local file v1', 'utf8');
const LINUX_LOCAL_FILE_BACKEND = 'local_file';
const UNKNOWN_STORAGE_BACKEND = 'unknown';

function defaultLocalKeyFilePath() {
    let userDataPath = '';
    try {
        userDataPath = app?.getPath?.('userData') || '';
    } catch (_error) {
        // Unit tests and command-line checks may run before Electron app readiness.
    }
    if (!userDataPath) {
        const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        userDataPath = path.join(configRoot, 'NetNexus');
    }
    return path.join(userDataPath, 'secure-credentials', 'master-key-v1');
}

function decodeCipherPart(value, label, expectedLength = null) {
    const encoded = String(value || '');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error(`Linux安全存储${label}格式无效`);
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded || (expectedLength !== null && decoded.length !== expectedLength)) {
        decoded.fill(0);
        throw new Error(`Linux安全存储${label}格式无效`);
    }
    return decoded;
}

class SecureCredentialStore {
    constructor(options = {}) {
        this.safeStorage = options.safeStorage || safeStorage;
        this.platform = options.platform || process.platform;
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.localKeyProvider =
            options.localKeyProvider ||
            (this.platform === 'linux'
                ? new LocalFileKeyProvider({
                      ...options.localFileKeyOptions,
                      filePath: options.localKeyFilePath || defaultLocalKeyFilePath()
                  })
                : null);
        this.lastLinuxStorageError = null;
    }

    getLinuxStorageBackend() {
        if (this.platform !== 'linux') return null;
        let key;
        try {
            key = this.localKeyProvider.getKey();
            if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Linux安全存储主密钥格式无效');
            this.lastLinuxStorageError = null;
            return LINUX_LOCAL_FILE_BACKEND;
        } catch (error) {
            this.lastLinuxStorageError = error;
            return UNKNOWN_STORAGE_BACKEND;
        } finally {
            key?.fill(0);
        }
    }

    async initialize() {
        if (this.platform !== 'linux') return this.getAvailabilityStatus();

        let key;
        try {
            key =
                typeof this.localKeyProvider.initialize === 'function'
                    ? await this.localKeyProvider.initialize()
                    : this.localKeyProvider.getKey();
            if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Linux安全存储主密钥格式无效');
            this.lastLinuxStorageError = null;
            return { available: true, backend: LINUX_LOCAL_FILE_BACKEND };
        } catch (error) {
            this.lastLinuxStorageError = error;
            return { available: false, backend: UNKNOWN_STORAGE_BACKEND };
        } finally {
            key?.fill(0);
        }
    }

    getAvailabilityStatus() {
        if (this.platform === 'linux') {
            const backend = this.getLinuxStorageBackend();
            return {
                available: backend === LINUX_LOCAL_FILE_BACKEND,
                backend
            };
        }

        let encryptionAvailable = false;
        try {
            encryptionAvailable = Boolean(this.safeStorage?.isEncryptionAvailable?.());
        } catch (_error) {
            encryptionAvailable = false;
        }

        return {
            available: encryptionAvailable,
            backend: null
        };
    }

    isAvailable() {
        return this.getAvailabilityStatus().available;
    }

    assertAvailable() {
        const status = this.getAvailabilityStatus();
        if (status.available) return;
        if (this.platform === 'linux') {
            throw new Error(
                this.lastLinuxStorageError?.message || 'Linux本地密钥文件不可用，请检查应用数据目录权限'
            );
        }
        throw new Error('操作系统安全存储当前不可用');
    }

    encryptLinux(value) {
        let key;
        let iv;
        let plaintext;
        let ciphertext;
        try {
            plaintext = Buffer.from(String(value), 'utf8');
            if (plaintext.length > MAX_LINUX_PLAINTEXT_BYTES) {
                throw new Error(`Linux安全存储明文不能超过${MAX_LINUX_PLAINTEXT_BYTES}字节`);
            }
            key = this.localKeyProvider.getKey();
            iv = this.randomBytes(LINUX_IV_BYTES);
            if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(iv) || iv.length !== LINUX_IV_BYTES) {
                throw new Error('Linux安全存储加密材料格式无效');
            }
            const cipher = crypto.createCipheriv(LINUX_CIPHER_ALGORITHM, key, iv);
            cipher.setAAD(LINUX_CIPHER_AAD);
            ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            const authTag = cipher.getAuthTag();
            try {
                const serialized = `${LINUX_CIPHERTEXT_PREFIX}${iv.toString('base64')}:${authTag.toString(
                    'base64'
                )}:${ciphertext.toString('base64')}`;
                if (serialized.length > MAX_LINUX_CIPHERTEXT_CHARS) {
                    throw new Error('Linux安全存储密文过大');
                }
                return serialized;
            } finally {
                authTag.fill(0);
            }
        } finally {
            key?.fill(0);
            iv?.fill(0);
            plaintext?.fill(0);
            ciphertext?.fill(0);
        }
    }

    decryptLinux(value) {
        const serialized = String(value || '');
        if (!serialized.startsWith(LINUX_CIPHERTEXT_PREFIX)) {
            throw new Error('Linux本地密文格式不受支持，请重新输入密钥');
        }
        if (serialized.length > MAX_LINUX_CIPHERTEXT_CHARS) {
            throw new Error('Linux安全存储密文过大');
        }

        const parts = serialized.slice(LINUX_CIPHERTEXT_PREFIX.length).split(':');
        if (parts.length !== 3) throw new Error('Linux安全存储密文格式无效');
        let key;
        let iv;
        let authTag;
        let ciphertext;
        let plaintext;
        try {
            key = this.localKeyProvider.getKey();
            iv = decodeCipherPart(parts[0], 'IV', LINUX_IV_BYTES);
            authTag = decodeCipherPart(parts[1], '认证标签', LINUX_AUTH_TAG_BYTES);
            ciphertext = decodeCipherPart(parts[2], '密文');
            const decipher = crypto.createDecipheriv(LINUX_CIPHER_ALGORITHM, key, iv);
            decipher.setAAD(LINUX_CIPHER_AAD);
            decipher.setAuthTag(authTag);
            plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            if (plaintext.length > MAX_LINUX_PLAINTEXT_BYTES) {
                throw new Error('Linux安全存储解密内容过大');
            }
            return plaintext.toString('utf8');
        } catch (error) {
            if (/Linux安全存储|本地密钥文件/u.test(error.message)) throw error;
            throw new Error('Linux安全存储密文认证失败，密钥可能已更改或数据已损坏');
        } finally {
            key?.fill(0);
            iv?.fill(0);
            authTag?.fill(0);
            ciphertext?.fill(0);
            plaintext?.fill(0);
        }
    }

    encrypt(value) {
        if (!value) return '';
        this.assertAvailable();
        if (this.platform === 'linux') return this.encryptLinux(value);
        return this.safeStorage.encryptString(String(value)).toString('base64');
    }

    decrypt(value) {
        if (!value) return '';
        if (this.platform === 'linux' && !String(value).startsWith(LINUX_CIPHERTEXT_PREFIX)) {
            throw new Error('Linux本地密文格式不受支持，请重新输入密钥');
        }
        this.assertAvailable();
        if (this.platform === 'linux') return this.decryptLinux(value);
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
module.exports.LINUX_CIPHERTEXT_PREFIX = LINUX_CIPHERTEXT_PREFIX;
module.exports.MAX_LINUX_PLAINTEXT_BYTES = MAX_LINUX_PLAINTEXT_BYTES;
