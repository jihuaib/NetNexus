const assert = require('node:assert/strict');

const TcpMd5SettingsStore = require('../../electron/utils/tcpMd5SettingsStore');
const tcpAoConfig = require('../../electron/utils/tcpAoConfig');
const {
    MAX_TCP_MD5_KEY_BYTES,
    MAX_TCP_MD5_PROFILES,
    normalizeTcpMd5Key,
    normalizeTcpMd5Profile,
    sanitizeTcpMd5Profile,
    assertNonOverlappingTcpMd5Profiles
} = require('../../electron/utils/tcpMd5Config');
const {
    RPKI_AUTH_TYPES,
    BMP_AUTH_TYPES,
    normalizeRpkiAuthenticationSelection,
    normalizeBmpAuthenticationSelection,
    redactAuthenticationConfig
} = require('../../electron/utils/tcpAuthConfig');

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, JSON.parse(JSON.stringify(value)));
    }
}

class FakeCredentialStore {
    constructor(options = {}) {
        this.available = options.available !== false;
        this.encryptCalls = [];
        this.decryptCalls = [];
    }

    isAvailable() {
        return this.available;
    }

    encrypt(value) {
        this.encryptCalls.push(value);
        return `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`;
    }

    decrypt(value) {
        this.decryptCalls.push(value);
        if (typeof value !== 'string' || !value.startsWith('encrypted:')) {
            throw new Error('damaged ciphertext');
        }
        return Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8');
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function profile(overrides = {}) {
    return {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.1/32',
        key: 'correct horse battery staple',
        ...overrides
    };
}

function testConfigNormalization() {
    assert.deepEqual(RPKI_AUTH_TYPES, { NONE: 'none', TCP_AO: 'tcp-ao', TCP_MD5: 'tcp-md5' });
    assert.deepEqual(BMP_AUTH_TYPES, { NONE: 'none', TCP_AO: 'tcp-ao', TCP_MD5: 'tcp-md5' });
    assert.equal(Object.prototype.hasOwnProperty.call(RPKI_AUTH_TYPES, 'MD5'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(BMP_AUTH_TYPES, 'MD5'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(tcpAoConfig, 'normalizeRpkiAuthSelection'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(tcpAoConfig, 'normalizeBmpAuthSelection'), false);

    assert.deepEqual(normalizeBmpAuthenticationSelection({ authType: 'md5', tcpMd5ProfileId: 'router-a' }), {
        authType: 'tcp-md5',
        tcpAoProfileIds: [],
        tcpMd5ProfileIds: ['router-a']
    });
    assert.deepEqual(
        normalizeBmpAuthenticationSelection({
            authType: ' TCP-MD5 ',
            tcpMd5ProfileIds: ['router-a', 'router-b']
        }),
        { authType: 'tcp-md5', tcpAoProfileIds: [], tcpMd5ProfileIds: ['router-a', 'router-b'] }
    );
    assert.deepEqual(
        normalizeBmpAuthenticationSelection({
            authType: 'none',
            tcpMd5ProfileIds: ['stale-profile'],
            tcpMd5ProfileId: 'also-stale'
        }),
        { authType: 'none', tcpAoProfileIds: [], tcpMd5ProfileIds: [] }
    );
    assert.throws(() => normalizeBmpAuthenticationSelection({ authType: 'tcp-md5' }), /必须选择/);
    assert.throws(
        () =>
            normalizeBmpAuthenticationSelection({
                authType: 'tcp-md5',
                tcpMd5ProfileIds: ['router-a', 'router-a']
            }),
        /不能重复/
    );
    assert.throws(
        () =>
            normalizeBmpAuthenticationSelection({
                authType: 'tcp-md5',
                tcpMd5ProfileIds: Array.from({ length: MAX_TCP_MD5_PROFILES + 1 }, (_item, index) => `p-${index}`)
            }),
        /1-32/
    );

    assert.deepEqual(normalizeRpkiAuthenticationSelection({ authType: 'md5', tcpMd5ProfileId: 'router-a' }), {
        authType: 'tcp-md5',
        tcpAoProfileId: '',
        tcpMd5ProfileId: 'router-a'
    });
    assert.deepEqual(normalizeRpkiAuthenticationSelection({ authType: 'none', tcpMd5ProfileId: 'stale-profile' }), {
        authType: 'none',
        tcpAoProfileId: '',
        tcpMd5ProfileId: ''
    });
    assert.throws(() => normalizeRpkiAuthenticationSelection({ authType: 'tcp-md5' }), /ID格式无效/);
    assert.throws(() => normalizeRpkiAuthenticationSelection({ authType: 'tls' }), /不支持/);
    assert.deepEqual(
        redactAuthenticationConfig({ tcpMd5: { key: 'secret' }, profiles: [{ keyEncrypted: 'ciphertext' }] }),
        { tcpMd5: { key: '<redacted>' }, profiles: [{ keyEncrypted: '<redacted>' }] }
    );

    assert.deepEqual(
        normalizeTcpMd5Profile({
            id: ' router-a ',
            name: ' Router A ',
            peer: '192.0.2.1',
            key: ' key with spaces ',
            keyEncrypted: 'attacker-controlled-ciphertext',
            unexpected: true
        }),
        {
            id: 'router-a',
            name: 'Router A',
            peer: '192.0.2.1/32',
            key: ' key with spaces '
        }
    );
    assert.throws(() => normalizeTcpMd5Profile(profile({ id: '-bad' })), /ID格式无效/);
    assert.throws(() => normalizeTcpMd5Profile(profile({ name: '' })), /名称长度/);
    assert.throws(() => normalizeTcpMd5Profile(profile({ name: 'n'.repeat(65) })), /名称长度/);
    assert.throws(() => normalizeTcpMd5Profile(profile({ peer: '192.0.2.1/24' })), /主机位/);
    assert.throws(() => normalizeTcpMd5Profile(profile({ peer: 'not-an-address' })), /IPv4、IPv6/);
    assert.throws(() => normalizeTcpMd5Profile(profile({ peer: '::ffff:192.0.2.1' })), /IPv4映射/);

    assert.equal(normalizeTcpMd5Key('x'), 'x');
    assert.equal(normalizeTcpMd5Key('x'.repeat(MAX_TCP_MD5_KEY_BYTES)), 'x'.repeat(MAX_TCP_MD5_KEY_BYTES));
    assert.equal(normalizeTcpMd5Key('界'.repeat(26)), '界'.repeat(26));
    assert.equal(normalizeTcpMd5Key('', { required: false }), '');
    assert.throws(() => normalizeTcpMd5Key(''), /请输入/);
    assert.throws(() => normalizeTcpMd5Key('x'.repeat(MAX_TCP_MD5_KEY_BYTES + 1)), /80字节/);
    assert.throws(() => normalizeTcpMd5Key('界'.repeat(27)), /80字节/);
    assert.throws(() => normalizeTcpMd5Key('before\0after'), /NUL/);

    assert.deepEqual(
        sanitizeTcpMd5Profile({
            id: 'router-a',
            name: 'Router A',
            peer: '192.0.2.1/32',
            key: 'plaintext-must-not-leak',
            keyEncrypted: 'ciphertext-must-not-leak',
            savedKeyStatus: 'unavailable',
            hasSavedKey: true,
            usedBy: ['BMP'],
            unexpected: true
        }),
        {
            id: 'router-a',
            name: 'Router A',
            peer: '192.0.2.1/32',
            hasSavedKey: false,
            savedKeyStatus: 'unavailable',
            usedBy: ['BMP']
        }
    );

    assert.equal(
        assertNonOverlappingTcpMd5Profiles([
            profile({ peer: '192.0.2.0/25' }),
            profile({ id: 'router-b', name: 'Router B', peer: '192.0.2.128/25' })
        ]).length,
        2
    );
    assert.throws(
        () =>
            assertNonOverlappingTcpMd5Profiles([
                profile({ peer: '192.0.2.0/24' }),
                profile({ id: 'router-b', name: 'Router B', peer: '192.0.2.128/25' })
            ]),
        /不能重叠/
    );
    assert.throws(() => assertNonOverlappingTcpMd5Profiles([]), /至少需要一个/);
}

function testEncryptedPersistenceAndRuntimeProfile() {
    const rawStore = new MemoryStore();
    const credentialStore = new FakeCredentialStore();
    const settings = new TcpMd5SettingsStore(rawStore, credentialStore);
    const plaintext = 'correct horse battery staple';

    const saved = settings.saveSettings({
        version: 99,
        profiles: [
            profile({
                key: plaintext,
                keyEncrypted: 'attacker-controlled-ciphertext',
                hasSavedKey: true,
                savedKeyStatus: 'available',
                usedBy: ['attacker'],
                unexpected: true
            })
        ],
        unexpected: true
    });
    assert.deepEqual(saved, {
        version: 1,
        profiles: [
            {
                id: 'router-a',
                name: 'Router A',
                peer: '192.0.2.1/32',
                hasSavedKey: true,
                savedKeyStatus: 'available',
                usedBy: []
            }
        ]
    });
    assert.deepEqual(credentialStore.encryptCalls, [plaintext]);

    const raw = rawStore.get('tcp-md5-settings');
    assert.deepEqual(Object.keys(raw).sort(), ['profiles', 'version']);
    assert.deepEqual(Object.keys(raw.profiles[0]).sort(), ['id', 'keyEncrypted', 'name', 'peer']);
    assert.equal(Object.prototype.hasOwnProperty.call(raw.profiles[0], 'key'), false);
    assert.equal(JSON.stringify(raw).includes(plaintext), false, 'plaintext TCP MD5 key reached storage');
    assert.notEqual(raw.profiles[0].keyEncrypted, 'attacker-controlled-ciphertext');
    assert.match(raw.profiles[0].keyEncrypted, /^encrypted:/);

    const runtime = settings.getRuntimeProfile(' router-a ');
    assert.deepEqual(runtime, {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.1/32',
        key: plaintext
    });
    assert.equal(Object.prototype.hasOwnProperty.call(runtime, 'keyEncrypted'), false);

    const encryptedBeforeUpdate = raw.profiles[0].keyEncrypted;
    const renamed = settings.saveSettings({
        profiles: [
            {
                ...saved.profiles[0],
                name: 'Router A renamed',
                key: '',
                keyEncrypted: 'replacement-must-be-ignored'
            }
        ]
    });
    assert.equal(renamed.profiles[0].name, 'Router A renamed');
    assert.equal(rawStore.get('tcp-md5-settings').profiles[0].keyEncrypted, encryptedBeforeUpdate);
    assert.equal(settings.getRuntimeProfile('router-a').key, plaintext);
    assert.deepEqual(credentialStore.encryptCalls, [plaintext], 'an empty edit should reuse the existing ciphertext');

    const beforeRejectedSave = clone(rawStore.get('tcp-md5-settings'));
    assert.throws(
        () =>
            settings.saveSettings({
                profiles: [
                    { ...renamed.profiles[0], key: '' },
                    profile({ id: 'router-b', name: 'Router B', peer: '198.51.100.2/32', key: '' })
                ]
            }),
        /缺少密钥/
    );
    assert.deepEqual(rawStore.get('tcp-md5-settings'), beforeRejectedSave, 'a rejected save must be atomic');

    assert.throws(
        () =>
            settings.saveSettings({
                profiles: [
                    { ...renamed.profiles[0], key: '' },
                    profile({ id: 'router-a', name: 'Router B', peer: '198.51.100.2/32', key: 'second' })
                ]
            }),
        /ID重复/
    );
    assert.throws(
        () =>
            settings.saveSettings({
                profiles: [
                    { ...renamed.profiles[0], key: '' },
                    profile({ id: 'router-b', name: 'router a RENAMED', peer: '198.51.100.2/32', key: 'second' })
                ]
            }),
        /名称重复/
    );
    assert.throws(() => settings.getRuntimeProfile('missing-profile'), /不存在/);
}

function testKeyAvailabilityStates() {
    const rawStore = new MemoryStore();
    const credentialStore = new FakeCredentialStore();
    const settings = new TcpMd5SettingsStore(rawStore, credentialStore);
    settings.saveSettings({ profiles: [profile()] });

    credentialStore.available = false;
    assert.deepEqual(settings.listProfiles().profiles[0], {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.1/32',
        hasSavedKey: false,
        savedKeyStatus: 'unavailable',
        usedBy: []
    });

    const raw = rawStore.get('tcp-md5-settings');
    rawStore.set('tcp-md5-settings', {
        version: 1,
        profiles: [
            { ...raw.profiles[0], keyEncrypted: 'damaged-ciphertext' },
            { id: 'router-b', name: 'Router B', peer: '198.51.100.2/32', keyEncrypted: '' }
        ]
    });
    credentialStore.available = true;
    const listed = settings.listProfiles().profiles;
    assert.equal(listed[0].savedKeyStatus, 'unavailable');
    assert.equal(listed[0].hasSavedKey, false);
    assert.equal(listed[1].savedKeyStatus, 'missing');
    assert.equal(listed[1].hasSavedKey, false);
    assert.throws(
        () => settings.saveSettings({ profiles: listed.map(item => ({ ...item, key: '' })) }),
        /无法读取.*重新输入密钥/
    );
    assert.throws(() => settings.getRuntimeProfile('router-a'), /damaged ciphertext/);
    assert.throws(() => settings.getRuntimeProfile('router-b'), /没有保存密钥/);
}

function createDependencyFixture() {
    const rawStore = new MemoryStore();
    const settings = new TcpMd5SettingsStore(rawStore, new FakeCredentialStore());
    const saved = settings.saveSettings({
        profiles: [
            profile(),
            profile({ id: 'router-b', name: 'Router B', peer: '198.51.100.2/32', key: 'router-b-secret' })
        ]
    });
    return { rawStore, settings, profiles: clone(saved.profiles) };
}

function testReferencesAndDeletionProtection() {
    {
        const { rawStore, settings, profiles } = createDependencyFixture();
        assert.deepEqual(settings.assertProfilesExist(['router-a', 'router-b']), ['router-a', 'router-b']);
        assert.throws(() => settings.assertProfilesExist('missing-router'), /不存在.*missing-router/);
        rawStore.set('bmp-config', { authType: 'tcp-md5', tcpMd5ProfileIds: ['router-a'] });
        rawStore.set('rpki-config', { authType: 'md5', tcpMd5ProfileId: 'router-b' });
        const listed = settings.listProfiles().profiles;
        assert.deepEqual(listed.find(item => item.id === 'router-a').usedBy, ['BMP']);
        assert.deepEqual(listed.find(item => item.id === 'router-b').usedBy, ['RPKI']);

        const before = clone(rawStore.get('tcp-md5-settings'));
        const candidateProfiles = profiles
            .filter(item => item.id !== 'router-a')
            .map(item => ({ ...item, name: 'Must not be partially written', key: '' }));
        assert.throws(() => settings.saveSettings({ profiles: candidateProfiles }), /BMP/);
        assert.deepEqual(rawStore.get('tcp-md5-settings'), before);
    }

    {
        const { rawStore, settings, profiles } = createDependencyFixture();
        rawStore.set('bmp-config', { authType: 'md5', tcpMd5ProfileId: 'router-a' });
        rawStore.set('rpki-config', { authType: 'tcp-md5', tcpMd5ProfileId: 'router-a' });
        assert.deepEqual(settings.listProfiles().profiles[0].usedBy, ['BMP', 'RPKI']);
        assert.throws(
            () => settings.saveSettings({ profiles: profiles.filter(item => item.id !== 'router-a') }),
            /BMP.*RPKI/
        );

        const edited = profiles
            .filter(item => item.id !== 'router-b')
            .map(item => ({ ...item, name: 'Referenced profile edited safely', key: '' }));
        const result = settings.saveSettings({ profiles: edited });
        assert.deepEqual(
            result.profiles.map(item => item.id),
            ['router-a']
        );
        assert.equal(result.profiles[0].name, 'Referenced profile edited safely');
    }

    {
        const { rawStore, settings, profiles } = createDependencyFixture();
        rawStore.set('bmp-config', {
            authType: 'none',
            tcpMd5ProfileIds: ['router-a'],
            tcpMd5ProfileId: 'router-a'
        });
        rawStore.set('rpki-config', { authType: 'tcp-ao', tcpMd5ProfileId: 'router-a' });
        const result = settings.saveSettings({
            profiles: profiles.filter(item => item.id !== 'router-a').map(item => ({ ...item, key: '' }))
        });
        assert.deepEqual(
            result.profiles.map(item => item.id),
            ['router-b']
        );
        assert.deepEqual(result.profiles[0].usedBy, []);
    }
}

function testProfileLimit() {
    const settings = new TcpMd5SettingsStore(new MemoryStore(), new FakeCredentialStore());
    const profiles = Array.from({ length: MAX_TCP_MD5_PROFILES + 1 }, (_item, index) =>
        profile({
            id: `router-${index}`,
            name: `Router ${index}`,
            peer: `192.0.2.${index}/32`,
            key: `secret-${index}`
        })
    );
    assert.throws(() => settings.saveSettings({ profiles }), /最多保存32条/);
}

function main() {
    testConfigNormalization();
    testEncryptedPersistenceAndRuntimeProfile();
    testKeyAvailabilityStates();
    testReferencesAndDeletionProtection();
    testProfileLimit();
    console.log('TCP MD5 settings tests passed');
}

main();
