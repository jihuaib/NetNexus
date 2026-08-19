const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MASTER_KEY_BYTES = 32;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SUPPORTS_POSIX_PERMISSIONS = process.platform !== 'win32';

function codedError(message, code, cause = null) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

function validateOwner(stat, label) {
    if (typeof process.getuid !== 'function') return;
    if (stat.uid !== process.getuid()) {
        throw codedError(`${label}不属于当前用户`, 'LOCAL_KEY_FILE_OWNER_INVALID');
    }
}

class LocalFileKeyProvider {
    constructor(options = {}) {
        if (!options.filePath) throw new Error('必须指定本地密钥文件路径');
        this.filePath = path.resolve(options.filePath);
        this.directoryPath = path.dirname(this.filePath);
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.cachedKey = null;
    }

    syncDirectory(directoryPath) {
        // Win32 does not allow opening directories through fs.openSync. The
        // Windows application uses safeStorage/DPAPI instead of this local-key
        // backend, while test instances retain their inherited NTFS ACLs.
        if (!SUPPORTS_POSIX_PERMISSIONS) return;
        const directoryFlag = fs.constants.O_DIRECTORY || 0;
        const fileDescriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY | directoryFlag);
        try {
            fs.fsyncSync(fileDescriptor);
        } finally {
            fs.closeSync(fileDescriptor);
        }
    }

    ensureDirectory() {
        let created = false;
        try {
            fs.lstatSync(this.directoryPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            created = true;
        }
        fs.mkdirSync(this.directoryPath, { recursive: true, mode: DIRECTORY_MODE });
        const stat = fs.lstatSync(this.directoryPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw codedError('本地密钥目录不是普通目录', 'LOCAL_KEY_DIRECTORY_INVALID');
        }
        validateOwner(stat, '本地密钥目录');
        if (SUPPORTS_POSIX_PERMISSIONS) {
            if ((stat.mode & 0o777) !== DIRECTORY_MODE) fs.chmodSync(this.directoryPath, DIRECTORY_MODE);
            const securedStat = fs.lstatSync(this.directoryPath);
            if ((securedStat.mode & 0o777) !== DIRECTORY_MODE) {
                throw codedError('本地密钥目录权限必须为0700', 'LOCAL_KEY_DIRECTORY_PERMISSIONS_INVALID');
            }
        }
        this.syncDirectory(this.directoryPath);
        if (created) this.syncDirectory(path.dirname(this.directoryPath));
    }

    readKeyFromDisk() {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        let fileDescriptor;
        let key;
        try {
            const pathStat = fs.lstatSync(this.filePath);
            if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
                throw codedError('本地密钥路径不是普通文件', 'LOCAL_KEY_FILE_INVALID');
            }
            fileDescriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | noFollow);
            const stat = fs.fstatSync(fileDescriptor);
            if (!stat.isFile()) throw codedError('本地密钥路径不是普通文件', 'LOCAL_KEY_FILE_INVALID');
            validateOwner(stat, '本地密钥文件');
            if (stat.size !== MASTER_KEY_BYTES) {
                throw codedError('本地密钥文件格式无效', 'LOCAL_KEY_FILE_INVALID');
            }
            if (SUPPORTS_POSIX_PERMISSIONS) {
                if ((stat.mode & 0o777) !== FILE_MODE) fs.fchmodSync(fileDescriptor, FILE_MODE);
                const securedStat = fs.fstatSync(fileDescriptor);
                if ((securedStat.mode & 0o777) !== FILE_MODE) {
                    throw codedError('本地密钥文件权限必须为0600', 'LOCAL_KEY_FILE_PERMISSIONS_INVALID');
                }
            }
            key = fs.readFileSync(fileDescriptor);
            if (key.length !== MASTER_KEY_BYTES) {
                throw codedError('本地密钥文件格式无效', 'LOCAL_KEY_FILE_INVALID');
            }
            return key;
        } catch (error) {
            key?.fill(0);
            throw error;
        } finally {
            if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
        }
    }

    createKeyFile() {
        const generated = this.randomBytes(MASTER_KEY_BYTES);
        if (!Buffer.isBuffer(generated) || generated.length !== MASTER_KEY_BYTES) {
            generated?.fill?.(0);
            throw codedError('无法生成本地安全存储主密钥', 'LOCAL_KEY_GENERATION_FAILED');
        }

        const nonce = crypto.randomBytes(8).toString('hex');
        const temporaryPath = `${this.filePath}.${process.pid}.${nonce}.tmp`;
        let fileDescriptor;
        try {
            const noFollow = fs.constants.O_NOFOLLOW || 0;
            fileDescriptor = fs.openSync(
                temporaryPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
                FILE_MODE
            );
            let offset = 0;
            while (offset < generated.length) {
                const written = fs.writeSync(fileDescriptor, generated, offset, generated.length - offset);
                if (written <= 0) throw codedError('无法写入本地密钥文件', 'LOCAL_KEY_FILE_UNAVAILABLE');
                offset += written;
            }
            if (SUPPORTS_POSIX_PERMISSIONS) fs.fchmodSync(fileDescriptor, FILE_MODE);
            fs.fsyncSync(fileDescriptor);
            fs.closeSync(fileDescriptor);
            fileDescriptor = undefined;

            let published = false;
            try {
                fs.linkSync(temporaryPath, this.filePath);
                published = true;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
            if (published) this.syncDirectory(this.directoryPath);

            const persisted = this.readKeyFromDisk();
            if (published && !crypto.timingSafeEqual(generated, persisted)) {
                persisted.fill(0);
                throw codedError('本地密钥文件校验失败', 'LOCAL_KEY_FILE_INVALID');
            }
            return persisted;
        } finally {
            generated.fill(0);
            if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
            try {
                fs.unlinkSync(temporaryPath);
            } catch (_error) {
                // The final key is already published or the original error is
                // more useful; a stale 0600 temporary file is harmless.
            }
        }
    }

    loadOrCreateKey() {
        this.ensureDirectory();
        let key;
        try {
            key = this.readKeyFromDisk();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            key = this.createKeyFile();
        }
        this.cachedKey = Buffer.from(key);
        key.fill(0);
        return Buffer.from(this.cachedKey);
    }

    getKey() {
        if (this.cachedKey) return Buffer.from(this.cachedKey);
        try {
            return this.loadOrCreateKey();
        } catch (error) {
            if (String(error.code || '').startsWith('LOCAL_KEY_')) throw error;
            throw codedError(`无法访问本地密钥文件: ${error.message}`, 'LOCAL_KEY_FILE_UNAVAILABLE', error);
        }
    }

    async initialize() {
        return this.getKey();
    }

    clearCache() {
        this.cachedKey?.fill(0);
        this.cachedKey = null;
    }
}

module.exports = LocalFileKeyProvider;
module.exports.MASTER_KEY_BYTES = MASTER_KEY_BYTES;
module.exports.DIRECTORY_MODE = DIRECTORY_MODE;
module.exports.FILE_MODE = FILE_MODE;
