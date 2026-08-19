const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SecureCredentialStore = require('../../electron/utils/secureCredentialStore');
const LocalFileKeyProvider = require('../../electron/utils/localFileKeyProvider');

const { LINUX_CIPHERTEXT_PREFIX, MAX_LINUX_PLAINTEXT_BYTES } = SecureCredentialStore;
const SUPPORTS_POSIX_PERMISSIONS = process.platform !== 'win32';

function createFakeKeyProvider(key = Buffer.alloc(32, 0x5a)) {
    return {
        initialize: async () => Buffer.from(key),
        getKey: () => Buffer.from(key)
    };
}

function createLinuxStore(options = {}) {
    return new SecureCredentialStore({
        platform: 'linux',
        localKeyProvider: options.localKeyProvider || createFakeKeyProvider(),
        randomBytes: options.randomBytes
    });
}

function permissions(filePath) {
    return fs.statSync(filePath).mode & 0o777;
}

function assertPermissions(filePath, expectedMode) {
    if (!SUPPORTS_POSIX_PERMISSIONS) return;
    assert.strictEqual(permissions(filePath), expectedMode);
}

function loadKeyDigestInChild(filePath) {
    const providerPath = require.resolve('../../electron/utils/localFileKeyProvider');
    const source = `
        const crypto = require('node:crypto');
        const Provider = require(${JSON.stringify(providerPath)});
        const key = new Provider({ filePath: ${JSON.stringify(filePath)} }).getKey();
        process.stdout.write(crypto.createHash('sha256').update(key).digest('hex'));
        key.fill(0);
    `;
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, ['-e', source], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`concurrent key provider exited ${code}: ${stderr}`));
        });
    });
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-local-key-'));
    try {
        const keyFilePath = path.join(tempRoot, 'credentials', 'master-key-v1');
        const generatedKey = Buffer.alloc(32, 0x6b);
        let generationCalls = 0;
        const firstProvider = new LocalFileKeyProvider({
            filePath: keyFilePath,
            randomBytes: size => {
                generationCalls += 1;
                assert.strictEqual(size, 32);
                return Buffer.from(generatedKey);
            }
        });

        const initializedKey = await firstProvider.initialize();
        assert.deepStrictEqual(initializedKey, generatedKey);
        initializedKey.fill(0);
        assert.strictEqual(generationCalls, 1);
        assertPermissions(path.dirname(keyFilePath), 0o700);
        assertPermissions(keyFilePath, 0o600);
        assert.deepStrictEqual(fs.readFileSync(keyFilePath), generatedKey);

        const cachedKey = firstProvider.getKey();
        cachedKey.fill(0);
        assert.deepStrictEqual(firstProvider.getKey(), generatedKey, 'callers must only receive a copy of the cache');
        firstProvider.clearCache();
        assert.deepStrictEqual(firstProvider.getKey(), generatedKey, 'clearing memory must not delete the key file');
        assert.strictEqual(generationCalls, 1);

        if (SUPPORTS_POSIX_PERMISSIONS) {
            fs.chmodSync(path.dirname(keyFilePath), 0o755);
            fs.chmodSync(keyFilePath, 0o644);
        }
        const restartedProvider = new LocalFileKeyProvider({
            filePath: keyFilePath,
            randomBytes: () => {
                throw new Error('an existing key must never be regenerated');
            }
        });
        const restartedKey = restartedProvider.getKey();
        assert.deepStrictEqual(restartedKey, generatedKey);
        restartedKey.fill(0);
        assertPermissions(path.dirname(keyFilePath), 0o700);
        assertPermissions(keyFilePath, 0o600);

        const secondProvider = new LocalFileKeyProvider({ filePath: keyFilePath });
        const sharedKey = secondProvider.getKey();
        assert.deepStrictEqual(sharedKey, generatedKey, 'all providers must load the same persisted key');
        sharedKey.fill(0);

        const concurrentPath = path.join(tempRoot, 'concurrent', 'master-key-v1');
        const concurrentDigests = await Promise.all(
            Array.from({ length: 12 }, () => loadKeyDigestInChild(concurrentPath))
        );
        assert.strictEqual(new Set(concurrentDigests).size, 1, 'concurrent processes must converge on one key');
        assert.strictEqual(fs.statSync(concurrentPath).size, 32);
        assertPermissions(path.dirname(concurrentPath), 0o700);
        assertPermissions(concurrentPath, 0o600);
        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(concurrentPath)),
            ['master-key-v1'],
            'atomic publication must not leave temporary files'
        );

        const malformedPath = path.join(tempRoot, 'malformed', 'master-key-v1');
        fs.mkdirSync(path.dirname(malformedPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(malformedPath, Buffer.alloc(31, 0x2a), { mode: 0o600 });
        const malformedProvider = new LocalFileKeyProvider({ filePath: malformedPath });
        assert.throws(
            () => malformedProvider.getKey(),
            error => error.code === 'LOCAL_KEY_FILE_INVALID' && /格式无效/u.test(error.message)
        );
        assert.strictEqual(fs.statSync(malformedPath).size, 31, 'a damaged key must never be overwritten');

        const symlinkDirectory = path.join(tempRoot, 'symlink');
        const symlinkTarget = path.join(tempRoot, 'symlink-target');
        fs.mkdirSync(symlinkDirectory, { mode: 0o700 });
        fs.writeFileSync(symlinkTarget, generatedKey, { mode: 0o600 });
        const symlinkPath = path.join(symlinkDirectory, 'master-key-v1');
        fs.symlinkSync(symlinkTarget, symlinkPath);
        const symlinkProvider = new LocalFileKeyProvider({ filePath: symlinkPath });
        assert.throws(() => symlinkProvider.getKey(), /本地密钥(文件|路径)/u);

        const realDirectory = path.join(tempRoot, 'real-directory');
        const directorySymlink = path.join(tempRoot, 'directory-symlink');
        fs.mkdirSync(realDirectory, { mode: 0o700 });
        fs.symlinkSync(realDirectory, directorySymlink);
        const symlinkDirectoryProvider = new LocalFileKeyProvider({
            filePath: path.join(directorySymlink, 'master-key-v1')
        });
        assert.throws(() => symlinkDirectoryProvider.getKey(), /本地密钥目录不是普通目录/u);

        const store = createLinuxStore();
        assert.deepStrictEqual(store.getAvailabilityStatus(), { available: true, backend: 'local_file' });
        assert.deepStrictEqual(await store.initialize(), { available: true, backend: 'local_file' });

        const firstCiphertext = store.encrypt('secret');
        const secondCiphertext = store.encrypt('secret');
        assert(firstCiphertext.startsWith(LINUX_CIPHERTEXT_PREFIX));
        assert(!firstCiphertext.slice(LINUX_CIPHERTEXT_PREFIX.length).includes('secret'));
        assert.notStrictEqual(firstCiphertext, secondCiphertext, 'AES-GCM must use a fresh IV for each encryption');
        assert.strictEqual(store.decrypt(firstCiphertext), 'secret');

        const wrongKeyStore = createLinuxStore({
            localKeyProvider: createFakeKeyProvider(Buffer.alloc(32, 0x6a))
        });
        assert.throws(() => wrongKeyStore.decrypt(firstCiphertext), /密文认证失败/u);

        const maximumPlaintext = 'x'.repeat(MAX_LINUX_PLAINTEXT_BYTES);
        assert.strictEqual(store.decrypt(store.encrypt(maximumPlaintext)), maximumPlaintext);
        assert.throws(() => store.encrypt(`${maximumPlaintext}x`), /明文不能超过/u);

        const protectedProfile = store.protectProfile({
            id: 'device-1',
            rememberCredentials: true,
            password: 'secret',
            passphrase: 'phrase'
        });
        assert(!Object.prototype.hasOwnProperty.call(protectedProfile, 'password'));
        assert(protectedProfile.passwordEncrypted);

        const hydrated = store.hydrateProfile(protectedProfile);
        assert.strictEqual(hydrated.password, 'secret');
        assert.strictEqual(hydrated.passphrase, 'phrase');
        assert(!Object.prototype.hasOwnProperty.call(hydrated, 'passwordEncrypted'));

        const sanitized = store.sanitizeProfile(protectedProfile);
        assert.strictEqual(sanitized.hasSavedCredentials, true);
        assert(!JSON.stringify(sanitized).includes('secret'));
        assert(!JSON.stringify(sanitized).includes(LINUX_CIPHERTEXT_PREFIX));

        const sessionOnly = store.protectProfile({
            id: 'device-2',
            rememberCredentials: false,
            password: 'temporary'
        });
        assert(!sessionOnly.passwordEncrypted);

        const preservedProfile = store.protectProfile(
            { id: 'device-1', rememberCredentials: true, password: '' },
            protectedProfile
        );
        assert.strictEqual(preservedProfile.passwordEncrypted, protectedProfile.passwordEncrypted);

        const tamperedParts = firstCiphertext.slice(LINUX_CIPHERTEXT_PREFIX.length).split(':');
        const tamperedTag = Buffer.from(tamperedParts[1], 'base64');
        tamperedTag[0] ^= 0xff;
        tamperedParts[1] = tamperedTag.toString('base64');
        tamperedTag.fill(0);
        assert.throws(
            () => store.decrypt(`${LINUX_CIPHERTEXT_PREFIX}${tamperedParts.join(':')}`),
            /密文认证失败/u
        );
        assert.throws(() => store.decrypt(`${LINUX_CIPHERTEXT_PREFIX}invalid`), /密文格式无效/u);
        assert.throws(() => store.decrypt('unsupported-ciphertext'), /重新输入密钥/u);

        const unavailableLinuxStore = createLinuxStore({
            localKeyProvider: {
                getKey: () => {
                    throw new Error('本地密钥文件不可写');
                }
            }
        });
        assert.deepStrictEqual(unavailableLinuxStore.getAvailabilityStatus(), {
            available: false,
            backend: 'unknown'
        });
        assert.throws(() => unavailableLinuxStore.encrypt('must-not-persist'), /本地密钥文件不可写/u);

        const nonLinuxStore = new SecureCredentialStore({
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: value => Buffer.from(value, 'utf8'),
                decryptString: buffer => buffer.toString('utf8')
            },
            platform: 'win32'
        });
        assert.deepStrictEqual(nonLinuxStore.getAvailabilityStatus(), { available: true, backend: null });
        assert.deepStrictEqual(await nonLinuxStore.initialize(), { available: true, backend: null });
        assert.strictEqual(nonLinuxStore.decrypt(nonLinuxStore.encrypt('windows-secret')), 'windows-secret');

        const unavailableNonLinuxStore = new SecureCredentialStore({
            safeStorage: { isEncryptionAvailable: () => false },
            platform: 'win32'
        });
        assert.strictEqual(unavailableNonLinuxStore.isAvailable(), false);
        assert.throws(() => unavailableNonLinuxStore.encrypt('must-not-persist'), /操作系统安全存储当前不可用/u);

        generatedKey.fill(0);
        firstProvider.clearCache();
        restartedProvider.clearCache();
        secondProvider.clearCache();
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    console.log('YANG secure credential tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
