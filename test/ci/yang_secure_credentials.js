const assert = require('assert');
const SecureCredentialStore = require('../../electron/utils/secureCredentialStore');

const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: buffer => buffer.toString('utf8').replace(/^encrypted:/, '')
};

const store = new SecureCredentialStore({ safeStorage: fakeSafeStorage });
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
assert(!JSON.stringify(sanitized).includes('encrypted:'));

const sessionOnly = store.protectProfile({ id: 'device-2', rememberCredentials: false, password: 'temporary' });
assert(!sessionOnly.passwordEncrypted);

console.log('YANG secure credential tests passed');
