#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Server, utils: sshUtils } = require('ssh2');
const { XMLParser } = require('fast-xml-parser');
const {
    BASE_NAMESPACE,
    DelimiterFramer,
    createFramer,
    encodeMessage,
    escapeXml,
    escapeXmlAttribute,
    parseNetconfMessage,
    parseXml,
    findRoot,
    findFirst,
    childValues,
    childText,
    getAttribute,
    localName,
    extractElementContent,
    filterSubtreeXml,
    hasSubtreeFilter
} = require('../electron/utils/netconf');

const MOCK_NAMESPACE = 'urn:netnexus:params:xml:ns:yang:mock-device';
const MOCK_TYPES_NAMESPACE = 'urn:netnexus:params:xml:ns:yang:mock-types';
const MOCK_INVALID_NAMESPACE = 'urn:netnexus:params:xml:ns:yang:mock-invalid';
const YANG_LIBRARY_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const IETF_DATASTORES_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const NETCONF_MONITORING_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const SUBSCRIBED_NOTIFICATIONS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
const YANG_PUSH_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';
const YANG_PATCH_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-patch';
const SUBSCRIBED_NOTIFICATIONS_REVISION = '2019-09-09';
const YANG_PUSH_REVISION = '2019-09-09';
const REVISION = '2026-07-18';
const DEFAULT_HOST_KEY_PATH = path.join(__dirname, 'fixtures', 'netconfMockHostKey.pem');
const DEFAULT_OPTIONS = Object.freeze({
    host: '127.0.0.1',
    port: 8830,
    username: 'netconf',
    password: 'netconf',
    hostKeyPath: DEFAULT_HOST_KEY_PATH,
    allowRemote: false,
    quiet: false,
    maxMessageSize: 8 * 1024 * 1024
});
const NAMESPACE_AWARE_XML_OPTIONS = Object.freeze({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: false,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true
});
const namespaceAwareParser = new XMLParser(NAMESPACE_AWARE_XML_OPTIONS);
const DYNAMIC_RPC_CHILD_NAMESPACES = Object.freeze({
    'establish-subscription': Object.freeze({
        'stream-filter-name': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stream-subtree-filter': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stream-xpath-filter': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        stream: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'replay-start-time': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stop-time': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        dscp: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        weighting: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        dependency: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        encoding: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        datastore: YANG_PUSH_NAMESPACE,
        'selection-filter-ref': YANG_PUSH_NAMESPACE,
        'datastore-subtree-filter': YANG_PUSH_NAMESPACE,
        'datastore-xpath-filter': YANG_PUSH_NAMESPACE,
        periodic: YANG_PUSH_NAMESPACE,
        'on-change': YANG_PUSH_NAMESPACE
    }),
    'modify-subscription': Object.freeze({
        id: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stream-filter-name': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stream-subtree-filter': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stream-xpath-filter': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        'stop-time': SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        datastore: YANG_PUSH_NAMESPACE,
        'selection-filter-ref': YANG_PUSH_NAMESPACE,
        'datastore-subtree-filter': YANG_PUSH_NAMESPACE,
        'datastore-xpath-filter': YANG_PUSH_NAMESPACE,
        periodic: YANG_PUSH_NAMESPACE,
        'on-change': YANG_PUSH_NAMESPACE
    }),
    'delete-subscription': Object.freeze({ id: SUBSCRIBED_NOTIFICATIONS_NAMESPACE }),
    'kill-subscription': Object.freeze({ id: SUBSCRIBED_NOTIFICATIONS_NAMESPACE }),
    'resync-subscription': Object.freeze({ id: YANG_PUSH_NAMESPACE })
});

const MOCK_TYPES_YANG = [
    'module netnexus-mock-types {',
    '  yang-version 1.1;',
    '  namespace "' + MOCK_TYPES_NAMESPACE + '";',
    '  prefix nnmt;',
    '',
    '  revision ' + REVISION + ' {',
    '    description "Initial revision for the NetNexus NETCONF mock.";',
    '  }',
    '',
    '  typedef interface-name {',
    '    type string {',
    '      length "1..64";',
    '      pattern "[A-Za-z][A-Za-z0-9_.-]*";',
    '    }',
    '    description "A simple interface name used by the mock device.";',
    '  }',
    '',
    '  typedef mtu {',
    '    type uint16 {',
    '      range "576..9216";',
    '    }',
    '    units "octets";',
    '  }',
    '}',
    ''
].join('\n');

const MOCK_DEVICE_YANG = [
    'module netnexus-mock-device {',
    '  yang-version 1.1;',
    '  namespace "' + MOCK_NAMESPACE + '";',
    '  prefix nnmd;',
    '',
    '  import netnexus-mock-types {',
    '    prefix nnmt;',
    '    revision-date ' + REVISION + ';',
    '  }',
    '',
    '  revision ' + REVISION + ' {',
    '    description "Stateful device model served by npm run mock:netconf.";',
    '  }',
    '',
    '  feature interface-counters {',
    '    description "Expose deterministic mock interface counters.";',
    '  }',
    '',
    '  container system {',
    '    leaf hostname { type string; }',
    '    leaf location { type string; }',
    '    leaf contact { type string; }',
    '  }',
    '',
    '  container interfaces {',
    '    list interface {',
    '      key "name";',
    '      leaf name { type nnmt:interface-name; }',
    '      leaf description { type string; }',
    '      leaf enabled { type boolean; default "true"; }',
    '      leaf mtu { type nnmt:mtu; default "1500"; }',
    '      leaf oper-status {',
    '        config false;',
    '        type enumeration {',
    '          enum up;',
    '          enum down;',
    '        }',
    '      }',
    '      leaf packets {',
    '        if-feature interface-counters;',
    '        config false;',
    '        type uint64;',
    '      }',
    '    }',
    '  }',
    '',
    '  container state {',
    '    config false;',
    '    leaf uptime { type uint64; units "seconds"; }',
    '    leaf session-count { type uint32; }',
    '    leaf datastore-revision { type uint64; }',
    '    leaf last-operation { type string; }',
    '  }',
    '',
    '  rpc reboot {',
    '    input {',
    '      leaf delay { type uint16; units "seconds"; default "0"; }',
    '    }',
    '    output {',
    '      leaf accepted { type boolean; }',
    '      leaf reboot-count { type uint32; }',
    '    }',
    '  }',
    '',
    '  notification mock-event {',
    '    leaf message { type string; }',
    '    leaf datastore-revision { type uint64; }',
    '  }',
    '}',
    ''
].join('\n');

const MOCK_INVALID_YANG = [
    'module netnexus-mock-invalid {',
    '  yang-version 1.1;',
    '  namespace "' + MOCK_INVALID_NAMESPACE + '";',
    '  prefix nnmi;',
    '',
    '  revision ' + REVISION + ' {',
    '    description "Intentionally invalid model for testing compilation diagnostics.";',
    '  }',
    '',
    '  container broken {',
    '    leaf invalid-value {',
    '      type intentionally-undefined-type;',
    '    }',
    '  }',
    '}',
    ''
].join('\n');

const CUSTOM_MOCK_MODULES = Object.freeze({
    'netnexus-mock-device': Object.freeze({
        name: 'netnexus-mock-device',
        revision: REVISION,
        namespace: MOCK_NAMESPACE,
        source: MOCK_DEVICE_YANG,
        features: ['interface-counters'],
        conformanceType: 'implement'
    }),
    'netnexus-mock-types': Object.freeze({
        name: 'netnexus-mock-types',
        revision: REVISION,
        namespace: MOCK_TYPES_NAMESPACE,
        source: MOCK_TYPES_YANG,
        features: [],
        conformanceType: 'import'
    }),
    'netnexus-mock-invalid': Object.freeze({
        name: 'netnexus-mock-invalid',
        revision: REVISION,
        namespace: MOCK_INVALID_NAMESPACE,
        source: MOCK_INVALID_YANG,
        features: [],
        conformanceType: 'implement'
    })
});

const STANDARD_IANA_MODULE_FILES = Object.freeze([
    'ietf-interfaces@2018-02-20.yang',
    'ietf-ip@2018-02-22.yang',
    'ietf-netconf-acm@2018-02-14.yang',
    'ietf-network-instance@2019-01-21.yang',
    'ietf-restconf@2017-01-26.yang',
    'ietf-subscribed-notifications@2019-09-09.yang',
    'ietf-yang-patch@2017-02-22.yang',
    'ietf-yang-push@2019-09-09.yang'
]);
const STANDARD_RUNTIME_MODULE_NAMES = Object.freeze([
    'ietf-datastores',
    'ietf-inet-types',
    'ietf-yang-schema-mount',
    'ietf-yang-types'
]);

function latestYangModulePath(directory, moduleName) {
    let candidates;
    try {
        candidates = fs
            .readdirSync(directory)
            .filter(file => file === moduleName + '.yang' || file.startsWith(moduleName + '@'))
            .filter(file => file.endsWith('.yang'))
            .sort();
    } catch (_error) {
        return null;
    }
    return candidates.length > 0 ? path.join(directory, candidates[candidates.length - 1]) : null;
}

function loadStandardYangModule(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    const name = /^\s*(?:submodule|module)\s+([A-Za-z_][\w.-]*)\s*\{/mu.exec(source)?.[1];
    const namespace = /^\s*namespace\s+["']([^"']+)["']\s*;/mu.exec(source)?.[1];
    const fileRevision = /@(\d{4}-\d{2}-\d{2})\.yang$/u.exec(filePath)?.[1];
    const revision = fileRevision || /^\s*revision\s+["']?(\d{4}-\d{2}-\d{2})["']?\s*\{/mu.exec(source)?.[1];
    if (!name || !namespace || !revision) throw new Error('unable to parse YANG module metadata: ' + filePath);
    const features =
        name === 'ietf-subscribed-notifications'
            ? ['encode-xml', 'xpath', 'subtree']
            : name === 'ietf-yang-push'
              ? ['on-change']
              : [];
    return Object.freeze({
        name,
        revision,
        namespace,
        source,
        features,
        conformanceType: name === 'ietf-subscribed-notifications' || name === 'ietf-yang-push' ? 'implement' : 'import'
    });
}

function loadStandardMockModules() {
    const projectRoot = path.resolve(__dirname, '..');
    const ianaDirectory = path.join(projectRoot, 'resources', 'libyang', 'iana');
    const runtimeDirectory = path.join(
        projectRoot,
        'resources',
        'libyang',
        process.platform + '-' + process.arch,
        'share',
        'yang',
        'modules',
        'libyang'
    );
    const paths = STANDARD_IANA_MODULE_FILES.map(file => path.join(ianaDirectory, file));
    for (const moduleName of STANDARD_RUNTIME_MODULE_NAMES) {
        const filePath = latestYangModulePath(runtimeDirectory, moduleName);
        if (!filePath) return Object.freeze({});
        paths.push(filePath);
    }
    if (paths.some(filePath => !fs.existsSync(filePath))) return Object.freeze({});
    try {
        return Object.freeze(
            Object.fromEntries(
                paths.map(filePath => {
                    const module = loadStandardYangModule(filePath);
                    return [module.name, module];
                })
            )
        );
    } catch (_error) {
        return Object.freeze({});
    }
}

const STANDARD_MOCK_MODULES = loadStandardMockModules();
const STANDARD_SUBSCRIPTION_MODELS_AVAILABLE = Boolean(
    STANDARD_MOCK_MODULES['ietf-subscribed-notifications'] && STANDARD_MOCK_MODULES['ietf-yang-push']
);
const MOCK_MODULES = Object.freeze({ ...CUSTOM_MOCK_MODULES, ...STANDARD_MOCK_MODULES });

const MOCK_KEY_DEFINITIONS = Object.freeze([
    Object.freeze({
        namespace: MOCK_NAMESPACE,
        element: 'interface',
        keys: Object.freeze([Object.freeze({ namespace: MOCK_NAMESPACE, name: 'name' })])
    }),
    Object.freeze({
        namespace: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        element: 'stream',
        keys: Object.freeze([Object.freeze({ namespace: SUBSCRIBED_NOTIFICATIONS_NAMESPACE, name: 'name' })])
    }),
    Object.freeze({
        namespace: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        element: 'subscription',
        keys: Object.freeze([Object.freeze({ namespace: SUBSCRIBED_NOTIFICATIONS_NAMESPACE, name: 'id' })])
    })
]);

const SERVER_CAPABILITIES = Object.freeze([
    'urn:ietf:params:netconf:base:1.0',
    'urn:ietf:params:netconf:base:1.1',
    'urn:ietf:params:netconf:capability:xpath:1.0',
    'urn:ietf:params:netconf:capability:writable-running:1.0',
    'urn:ietf:params:netconf:capability:candidate:1.0',
    'urn:ietf:params:netconf:capability:startup:1.0',
    'urn:ietf:params:netconf:capability:validate:1.1',
    'urn:ietf:params:netconf:capability:notification:1.0',
    'urn:ietf:params:netconf:capability:interleave:1.0',
    'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=netnexus-mock-1',
    ...(STANDARD_SUBSCRIPTION_MODELS_AVAILABLE
        ? [
              SUBSCRIBED_NOTIFICATIONS_NAMESPACE +
                  '?module=ietf-subscribed-notifications&revision=' +
                  SUBSCRIBED_NOTIFICATIONS_REVISION +
                  '&features=encode-xml,xpath,subtree',
              YANG_PUSH_NAMESPACE + '?module=ietf-yang-push&revision=' + YANG_PUSH_REVISION + '&features=on-change'
          ]
        : []),
    NETCONF_MONITORING_NAMESPACE + '?module=ietf-netconf-monitoring&revision=2010-10-04',
    MOCK_NAMESPACE + '?module=netnexus-mock-device&revision=' + REVISION + '&features=interface-counters',
    MOCK_TYPES_NAMESPACE + '?module=netnexus-mock-types&revision=' + REVISION,
    MOCK_INVALID_NAMESPACE + '?module=netnexus-mock-invalid&revision=' + REVISION
]);

class MockRpcError extends Error {
    constructor(message, tag = 'operation-failed', options = {}) {
        super(message);
        this.name = 'MockRpcError';
        this.tag = tag;
        this.type = options.type || 'application';
        this.appTag = options.appTag || '';
        this.info = options.info || '';
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createInitialConfig() {
    return {
        system: {
            hostname: 'netnexus-mock',
            location: 'local-lab',
            contact: 'netnexus@example.test'
        },
        interfaces: [
            {
                name: 'eth0',
                description: 'Management interface',
                enabled: true,
                mtu: 1500
            },
            {
                name: 'loopback0',
                description: 'Mock loopback interface',
                enabled: true,
                mtu: 1500
            }
        ]
    };
}

function normalizeOptions(options = {}) {
    const normalized = {
        ...DEFAULT_OPTIONS,
        ...options
    };
    normalized.host = String(normalized.host || DEFAULT_OPTIONS.host).trim();
    normalized.username = String(normalized.username || '').trim();
    normalized.password = String(normalized.password || '');
    normalized.hostKeyPath = path.resolve(String(normalized.hostKeyPath || DEFAULT_HOST_KEY_PATH));
    normalized.port = Number(normalized.port);
    normalized.maxMessageSize = Number(normalized.maxMessageSize || DEFAULT_OPTIONS.maxMessageSize);
    normalized.allowRemote = Boolean(normalized.allowRemote);
    normalized.quiet = Boolean(normalized.quiet);

    if (!normalized.host) throw new TypeError('NETCONF mock host is required');
    if (!Number.isSafeInteger(normalized.port) || normalized.port < 0 || normalized.port > 65535) {
        throw new TypeError('NETCONF mock port must be an integer between 0 and 65535');
    }
    if (!normalized.username) throw new TypeError('NETCONF mock username is required');
    if (!normalized.password) throw new TypeError('NETCONF mock password is required');
    if (!Number.isSafeInteger(normalized.maxMessageSize) || normalized.maxMessageSize < 1024) {
        throw new TypeError('NETCONF mock maxMessageSize must be an integer of at least 1024');
    }
    if (!isLoopbackHost(normalized.host) && !normalized.allowRemote) {
        throw new Error('Refusing a non-loopback listen address without --allow-remote');
    }
    return normalized;
}

function isLoopbackHost(host) {
    const normalized = String(host || '')
        .trim()
        .toLowerCase();
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function hostKeyFingerprint(privateKey) {
    const parsed = sshUtils.parseKey(privateKey);
    if (parsed instanceof Error) throw parsed;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    const publicSsh = key.getPublicSSH();
    const digest = crypto.createHash('sha256').update(publicSsh).digest('base64').replace(/=+$/u, '');
    return 'SHA256:' + digest;
}

function firstOperation(root) {
    if (!root || !root.value || typeof root.value !== 'object') return null;
    for (const [key, value] of Object.entries(root.value)) {
        if (!key.startsWith('@_') && key !== '#text') {
            return { name: localName(key), value };
        }
    }
    return null;
}

function datastoreFrom(xml, containerName, fallback = '') {
    const escaped = String(containerName).replace(/[.*+?^$()|[\]{}\\]/gu, '\\$&');
    const expression = new RegExp(
        '<(?:[A-Za-z_][\\w.-]*:)?' + escaped + '\\b[^>]*>\\s*<(?:[A-Za-z_][\\w.-]*:)?([A-Za-z_][\\w.-]*)\\b',
        'iu'
    );
    const match = expression.exec(xml);
    return match ? match[1] : fallback;
}

function rpcReply(messageId, body) {
    return (
        '<rpc-reply xmlns="' +
        BASE_NAMESPACE +
        '" message-id="' +
        escapeXmlAttribute(messageId) +
        '">' +
        body +
        '</rpc-reply>'
    );
}

function rpcErrorReply(messageId, error) {
    const normalized = error instanceof MockRpcError ? error : new MockRpcError(error.message || String(error));
    const appTag = normalized.appTag ? '<error-app-tag>' + escapeXml(normalized.appTag) + '</error-app-tag>' : '';
    const info = normalized.info ? '<error-info>' + normalized.info + '</error-info>' : '';
    return rpcReply(
        messageId,
        '<rpc-error>' +
            '<error-type>' +
            escapeXml(normalized.type) +
            '</error-type>' +
            '<error-tag>' +
            escapeXml(normalized.tag) +
            '</error-tag>' +
            '<error-severity>error</error-severity>' +
            appTag +
            '<error-message xml:lang="en">' +
            escapeXml(normalized.message) +
            '</error-message>' +
            info +
            '</rpc-error>'
    );
}

function serverHello(sessionId) {
    const capabilities = SERVER_CAPABILITIES.map(function (capability) {
        return '<capability>' + escapeXml(capability) + '</capability>';
    }).join('');
    return (
        '<hello xmlns="' +
        BASE_NAMESPACE +
        '"><capabilities>' +
        capabilities +
        '</capabilities><session-id>' +
        sessionId +
        '</session-id></hello>'
    );
}

function renderSystem(system) {
    return (
        '<system xmlns="' +
        MOCK_NAMESPACE +
        '"><hostname>' +
        escapeXml(system.hostname || '') +
        '</hostname><location>' +
        escapeXml(system.location || '') +
        '</location><contact>' +
        escapeXml(system.contact || '') +
        '</contact></system>'
    );
}

function renderInterfaces(interfaces, includeOperational) {
    const body = interfaces
        .map(function (item, index) {
            const operational = includeOperational
                ? '<oper-status>' +
                  (item.enabled ? 'up' : 'down') +
                  '</oper-status><packets>' +
                  String(1000 + index * 100 + item.mtu) +
                  '</packets>'
                : '';
            return (
                '<interface><name>' +
                escapeXml(item.name) +
                '</name><description>' +
                escapeXml(item.description || '') +
                '</description><enabled>' +
                String(Boolean(item.enabled)) +
                '</enabled><mtu>' +
                String(item.mtu) +
                '</mtu>' +
                operational +
                '</interface>'
            );
        })
        .join('');
    return '<interfaces xmlns="' + MOCK_NAMESPACE + '">' + body + '</interfaces>';
}

function parseBoolean(value, fieldName) {
    const normalized = String(value || '').trim();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw new MockRpcError(fieldName + ' must be true or false', 'invalid-value');
}

function applyConfigFragment(current, fragment, replace) {
    if (!fragment || !String(fragment).trim()) {
        throw new MockRpcError('edit-config requires a non-empty config element', 'missing-element');
    }
    const document = parseXml('<config>' + fragment + '</config>');
    const next = replace ? { system: { hostname: '', location: '', contact: '' }, interfaces: [] } : clone(current);
    let recognized = false;

    const systemNode = findFirst(document, 'system');
    if (systemNode) {
        recognized = true;
        for (const field of ['hostname', 'location', 'contact']) {
            const value = childText(systemNode, field);
            if (value !== null) next.system[field] = value;
        }
    }

    const interfacesNode = findFirst(document, 'interfaces');
    if (interfacesNode) {
        recognized = true;
        for (const interfaceNode of childValues(interfacesNode, 'interface')) {
            const name = childText(interfaceNode, 'name');
            if (!name) throw new MockRpcError('interface name is required', 'missing-element');
            const operation = String(getAttribute(interfaceNode, 'operation') || '').toLowerCase();
            const existingIndex = next.interfaces.findIndex(function (item) {
                return item.name === name;
            });
            if (operation === 'delete' || operation === 'remove') {
                if (existingIndex >= 0) next.interfaces.splice(existingIndex, 1);
                continue;
            }
            const item =
                existingIndex >= 0
                    ? { ...next.interfaces[existingIndex] }
                    : { name, description: '', enabled: true, mtu: 1500 };
            const description = childText(interfaceNode, 'description');
            const enabled = childText(interfaceNode, 'enabled');
            const mtu = childText(interfaceNode, 'mtu');
            if (description !== null) item.description = description;
            if (enabled !== null) item.enabled = parseBoolean(enabled, 'enabled');
            if (mtu !== null) {
                const number = Number(mtu);
                if (!Number.isInteger(number) || number < 576 || number > 9216) {
                    throw new MockRpcError('mtu must be an integer between 576 and 9216', 'invalid-value');
                }
                item.mtu = number;
            }
            if (existingIndex >= 0) next.interfaces.splice(existingIndex, 1, item);
            else next.interfaces.push(item);
        }
    }

    if (!recognized) {
        throw new MockRpcError('config contains no nodes from netnexus-mock-device', 'unknown-element');
    }
    return next;
}

function cdata(value) {
    return '<![CDATA[' + String(value).replace(/\]\]>/gu, ']]]]><![CDATA[>') + ']]>';
}

function openingElement(xml, elementName) {
    const escapedName = String(elementName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const expression = new RegExp('<((?:[A-Za-z_][\\w.-]*:)?' + escapedName + ')\\b([^>]*)>', 'iu');
    const match = expression.exec(String(xml || ''));
    if (!match) return null;
    return {
        qualifiedName: match[1],
        attributes: match[2],
        source: match[0],
        index: match.index,
        endIndex: match.index + match[0].length,
        selfClosing: /\/\s*>$/u.test(match[0])
    };
}

function namespaceDeclarations(attributes, target = new Map()) {
    const expression = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
    let match;
    while ((match = expression.exec(String(attributes || ''))) !== null) {
        target.set(match[1] || '', match[2] === undefined ? match[3] : match[2]);
    }
    return target;
}

function parsedNamespaceDeclarations(node, target = new Map()) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return target;
    for (const [name, value] of Object.entries(node)) {
        if (name === '@_xmlns') target.set('', String(value));
        else if (name.startsWith('@_xmlns:')) target.set(name.slice('@_xmlns:'.length), String(value));
    }
    return target;
}

function parsedElementEntry(node, wantedName) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    for (const [name, value] of Object.entries(node)) {
        if (!name.startsWith('@_') && name !== '#text' && localName(name) === wantedName) return { name, value };
    }
    return null;
}

function qualifiedNameNamespace(name, namespaces) {
    const separator = String(name).indexOf(':');
    const prefix = separator < 0 ? '' : String(name).slice(0, separator);
    return namespaces.get(prefix) || '';
}

function directOperationChildren(xml, operationName) {
    const document = namespaceAwareParser.parse(String(xml || ''));
    const rpc = parsedElementEntry(document, 'rpc');
    const operation = parsedElementEntry(rpc?.value, operationName);
    if (!rpc || !operation) return [];
    const inherited = parsedNamespaceDeclarations(rpc.value);
    parsedNamespaceDeclarations(operation.value, inherited);
    const children = [];
    for (const [name, rawValue] of Object.entries(operation.value || {})) {
        if (name.startsWith('@_') || name === '#text') continue;
        for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
            const namespaces = parsedNamespaceDeclarations(value, new Map(inherited));
            children.push({
                localName: localName(name),
                namespace: qualifiedNameNamespace(name, namespaces)
            });
        }
    }
    return children;
}

function assertDynamicRpcChildNamespaces(xml, operationName) {
    const expected = DYNAMIC_RPC_CHILD_NAMESPACES[operationName];
    if (!expected) return;
    for (const child of directOperationChildren(xml, operationName)) {
        const namespace = expected[child.localName];
        if (!namespace) {
            throw new MockRpcError('unexpected ' + operationName + ' input: ' + child.localName, 'unknown-element', {
                type: 'protocol',
                info: '<bad-element>' + escapeXml(child.localName) + '</bad-element>'
            });
        }
        if (child.namespace !== namespace) {
            throw new MockRpcError(child.localName + ' uses an unexpected namespace', 'unknown-namespace', {
                type: 'protocol',
                info:
                    '<bad-element>' +
                    escapeXml(child.localName) +
                    '</bad-element><bad-namespace>' +
                    escapeXml(child.namespace) +
                    '</bad-namespace>'
            });
        }
    }
}

function namespaceContext(xml, elementNames, initialNamespaces = null) {
    const namespaces = new Map(initialNamespaces || []);
    for (const name of elementNames) {
        const element = openingElement(xml, name);
        if (element) namespaceDeclarations(element.attributes, namespaces);
    }
    return namespaces;
}

function implementedModuleNamespaceContext() {
    return new Map(
        Object.values(MOCK_MODULES)
            .filter(module => module.conformanceType !== 'import')
            .map(module => [module.name, module.namespace])
    );
}

function subscriptionXPathContext(xml, elementNames) {
    return namespaceContext(xml, elementNames, implementedModuleNamespaceContext());
}

function resolvedElementNamespace(xml, elementName) {
    const element = openingElement(xml, elementName);
    if (!element) return '';
    const namespaces = namespaceContext(xml, ['rpc', elementName]);
    const separator = element.qualifiedName.indexOf(':');
    const prefix = separator < 0 ? '' : element.qualifiedName.slice(0, separator);
    return namespaces.get(prefix) || '';
}

function extractElementXml(xml, elementName) {
    const source = String(xml || '');
    const opening = openingElement(source, elementName);
    if (!opening) return null;
    if (opening.selfClosing) return opening.source;
    const escapedName = String(elementName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const closingExpression = new RegExp('<\\/(?:[A-Za-z_][\\w.-]*:)?' + escapedName + '\\s*>', 'giu');
    closingExpression.lastIndex = opening.endIndex;
    const closing = closingExpression.exec(source);
    return closing ? source.slice(opening.index, closing.index + closing[0].length) : null;
}

function standaloneFilterXml(requestXml) {
    const filterXml = extractElementXml(requestXml, 'filter');
    if (!filterXml) return null;
    const inherited = namespaceContext(requestXml, ['rpc', 'create-subscription']);
    const filterOpening = openingElement(filterXml, 'filter');
    namespaceDeclarations(filterOpening?.attributes, inherited);
    const existing = namespaceDeclarations(filterOpening?.attributes);
    const missing = [...inherited.entries()].filter(([prefix]) => !existing.has(prefix));
    if (missing.length === 0) return filterXml;
    const declarations = missing
        .map(([prefix, namespace]) => {
            return ' xmlns' + (prefix ? ':' + prefix : '') + '="' + escapeXmlAttribute(namespace) + '"';
        })
        .join('');
    return filterXml.replace(/^(<(?:(?:[A-Za-z_][\w.-]*):)?filter\b)/iu, '$1' + declarations);
}

function standaloneAnydataFilterXml(requestXml, elementName, operationName) {
    const elementXml = extractElementXml(requestXml, elementName);
    if (!elementXml) return null;
    const inherited = namespaceContext(requestXml, ['rpc', operationName, elementName]);
    const elementOpening = openingElement(elementXml, elementName);
    namespaceDeclarations(elementOpening?.attributes, inherited);
    const declarations = [...inherited.entries()]
        .map(([prefix, namespace]) => {
            return ' xmlns' + (prefix ? ':' + prefix : '') + '="' + escapeXmlAttribute(namespace) + '"';
        })
        .join('');
    const content = extractElementContent(elementXml, elementName);
    return '<filter type="subtree"' + declarations + '>' + content + '</filter>';
}

function standaloneElementXml(requestXml, elementName, operationName) {
    const elementXml = extractElementXml(requestXml, elementName);
    if (!elementXml) return null;
    const inherited = namespaceContext(requestXml, ['rpc', operationName, elementName]);
    const elementOpening = openingElement(elementXml, elementName);
    const existing = namespaceDeclarations(elementOpening?.attributes);
    const missing = [...inherited.entries()].filter(([prefix]) => !existing.has(prefix));
    if (missing.length === 0) return elementXml;
    const declarations = missing
        .map(([prefix, namespace]) => {
            return ' xmlns' + (prefix ? ':' + prefix : '') + '="' + escapeXmlAttribute(namespace) + '"';
        })
        .join('');
    return elementXml.replace(/^(<(?:(?:[A-Za-z_][\w.-]*):)?[A-Za-z_][\w.-]*\b)/u, '$1' + declarations);
}

function parseUint32(value, fieldName, options = {}) {
    const normalized = String(value ?? '').trim();
    if (!/^\d+$/u.test(normalized)) {
        throw new MockRpcError(fieldName + ' must be an unsigned integer', 'invalid-value');
    }
    const number = Number(normalized);
    const minimum = options.allowZero ? 0 : 1;
    if (!Number.isSafeInteger(number) || number < minimum || number > 4_294_967_295) {
        throw new MockRpcError(fieldName + ' must be between ' + minimum + ' and 4294967295', 'invalid-value');
    }
    return number;
}

function parseEventTime(value, fieldName) {
    const normalized = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)) {
        throw new MockRpcError(fieldName + ' must be an RFC 3339 date-time', 'invalid-value');
    }
    const timestamp = Date.parse(normalized);
    if (!Number.isFinite(timestamp)) {
        throw new MockRpcError(fieldName + ' must be a valid RFC 3339 date-time', 'invalid-value');
    }
    return { value: normalized, timestamp };
}

function resolveXPathName(value, namespaces) {
    const match = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*|\*)$/u.exec(String(value || ''));
    if (!match) throw new MockRpcError('unsupported XPath name: ' + value, 'invalid-value');
    if (!match[1]) {
        return { namespace: '', localName: match[2], anyNamespace: match[2] === '*' };
    }
    if (!namespaces.has(match[1])) {
        throw new MockRpcError('XPath prefix is not declared: ' + match[1], 'invalid-value');
    }
    return { namespace: namespaces.get(match[1]), localName: match[2], anyNamespace: false };
}

function xpathNameMatches(actual, expected) {
    return (
        (expected.localName === '*' || actual.localName === expected.localName) &&
        (expected.anyNamespace || actual.namespace === expected.namespace)
    );
}

function compileMockXPath(select, namespaces) {
    const normalized = String(select || '').trim();
    if (!normalized) throw new MockRpcError('XPath filter select is required', 'missing-attribute');
    if (normalized === '.' || normalized === '/*' || normalized === '//*')
        return function () {
            return true;
        };
    if (!normalized.startsWith('/')) {
        throw new MockRpcError('the mock supports absolute XPath notification filters', 'invalid-value');
    }

    const descendant = normalized.startsWith('//');
    let pathAndPredicate = normalized.slice(descendant ? 2 : 1);
    let predicate = null;
    const predicateMatch = /\[([^\]]+)\]\s*$/u.exec(pathAndPredicate);
    if (predicateMatch) {
        predicate = predicateMatch[1].trim();
        pathAndPredicate = pathAndPredicate.slice(0, predicateMatch.index);
    }
    if (!pathAndPredicate || /[()[\]|]/u.test(pathAndPredicate)) {
        throw new MockRpcError('unsupported XPath expression for the mock notification stream', 'invalid-value');
    }
    const expectedPath = pathAndPredicate.split('/').map(value => resolveXPathName(value, namespaces));
    let predicateMatcher = function () {
        return true;
    };
    if (predicate) {
        const selfMatch = /^(?:\.|text\(\))\s*=\s*(["'])(.*?)\1$/u.exec(predicate);
        const childMatch = /^((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2$/u.exec(predicate);
        if (selfMatch) {
            predicateMatcher = node => String(node.value ?? '') === selfMatch[2];
        } else if (childMatch) {
            const childName = resolveXPathName(childMatch[1], namespaces);
            predicateMatcher = node =>
                node.children.some(
                    child => xpathNameMatches(child, childName) && String(child.value ?? '') === childMatch[3]
                );
        } else {
            throw new MockRpcError('unsupported XPath predicate for the mock notification stream', 'invalid-value');
        }
    }

    return function matchesMockEvent(message, revision) {
        const mockEvent = {
            namespace: MOCK_NAMESPACE,
            localName: 'mock-event',
            value: '',
            children: [
                { namespace: MOCK_NAMESPACE, localName: 'message', value: String(message), children: [] },
                {
                    namespace: MOCK_NAMESPACE,
                    localName: 'datastore-revision',
                    value: String(revision),
                    children: []
                }
            ]
        };
        const paths = [[mockEvent], ...mockEvent.children.map(child => [mockEvent, child])];
        for (const path of paths) {
            if (expectedPath.length > path.length) continue;
            const offset = descendant ? path.length - expectedPath.length : 0;
            if (!descendant && expectedPath.length !== path.length) continue;
            if (!expectedPath.every((expected, index) => xpathNameMatches(path[offset + index], expected))) continue;
            if (predicateMatcher(path[path.length - 1])) return true;
        }
        return false;
    };
}

function compileDatastoreXPath(select, namespaces) {
    const normalized = String(select || '').trim();
    if (!normalized) throw new MockRpcError('datastore-xpath-filter is required', 'invalid-value');
    if (normalized === '.' || normalized === '/*') {
        return function (xml) {
            return xml;
        };
    }
    if (!normalized.startsWith('/') || normalized.startsWith('//') || /[()[\]|@]/u.test(normalized)) {
        throw new MockRpcError('the mock supports simple absolute datastore XPath filters', 'invalid-value');
    }
    const names = normalized
        .slice(1)
        .split('/')
        .filter(Boolean)
        .map(value => resolveXPathName(value, namespaces));
    const implementedNamespaces = new Set(implementedModuleNamespaceContext().values());
    if (
        names.length === 0 ||
        names.some(name => name.localName === '*' || !implementedNamespaces.has(name.namespace))
    ) {
        throw new MockRpcError(
            'the mock datastore XPath must select nodes from an implemented module',
            'invalid-value'
        );
    }
    let filterContent = '';
    for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        filterContent =
            '<' +
            name.localName +
            ' xmlns="' +
            escapeXmlAttribute(name.namespace) +
            '"' +
            '>' +
            filterContent +
            '</' +
            name.localName +
            '>';
    }
    const filterXml = '<filter type="subtree">' + filterContent + '</filter>';
    return function (xml) {
        return filterSubtreeXml(xml, filterXml, { keyDefinitions: MOCK_KEY_DEFINITIONS });
    };
}

function selectionObjectChildren(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const children = [];
    for (const [name, childValue] of Object.entries(value)) {
        if (name.startsWith('@_') || name === '#text') continue;
        const values = Array.isArray(childValue) ? childValue : [childValue];
        for (const item of values) children.push(normalizeSelectionNode(localName(name), item));
    }
    return children;
}

function normalizeSelectionNode(name, value) {
    const objectValue = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const text = objectValue ? String(objectValue['#text'] ?? '') : String(value ?? '');
    return {
        name,
        text,
        children: selectionObjectChildren(objectValue)
    };
}

function parseSelectionNodes(xml) {
    const root = findRoot(
        parseXml('<netnexus-yang-push-selection>' + String(xml || '') + '</netnexus-yang-push-selection>')
    );
    return selectionObjectChildren(root?.value);
}

function selectionKeyDefinition(node) {
    return MOCK_KEY_DEFINITIONS.find(
        definition => definition.namespace === MOCK_NAMESPACE && definition.element === node.name
    );
}

function selectionNodeIdentity(node) {
    const definition = selectionKeyDefinition(node);
    if (!definition) return node.name;
    const keys = definition.keys.map(key => {
        const child = node.children.find(item => item.name === key.name);
        return child?.text ?? '';
    });
    return node.name + '\u0000' + keys.join('\u0000');
}

function selectionNodeTarget(node, parentTarget = '') {
    let segment = (parentTarget ? '' : 'netnexus-mock-device:') + node.name;
    const definition = selectionKeyDefinition(node);
    if (definition) {
        const keys = definition.keys.map(key => {
            const child = node.children.find(item => item.name === key.name);
            return encodeURIComponent(child?.text ?? '');
        });
        segment += '=' + keys.join(',');
    }
    return parentTarget + '/' + segment;
}

function serializeSelectionNode(node, includeNamespace = true) {
    const namespace = includeNamespace ? ' xmlns="' + MOCK_NAMESPACE + '"' : '';
    const content =
        node.children.length > 0
            ? node.children.map(child => serializeSelectionNode(child, false)).join('')
            : escapeXml(node.text);
    return '<' + node.name + namespace + '>' + content + '</' + node.name + '>';
}

function selectionSiblingMap(nodes) {
    return new Map(nodes.map(node => [selectionNodeIdentity(node), node]));
}

function diffSelectionNodes(previousNodes, currentNodes, parentTarget = '') {
    const previous = selectionSiblingMap(previousNodes);
    const current = selectionSiblingMap(currentNodes);
    const identities = new Set([...previous.keys(), ...current.keys()]);
    const changes = [];
    for (const identity of identities) {
        const before = previous.get(identity);
        const after = current.get(identity);
        const node = after || before;
        const target = selectionNodeTarget(node, parentTarget);
        if (!before) {
            changes.push({ target, operation: 'create', node: after });
            continue;
        }
        if (!after) {
            changes.push({ target, operation: 'delete', node: null });
            continue;
        }
        if (before.children.length > 0 || after.children.length > 0) {
            if (before.children.length === 0 || after.children.length === 0) {
                changes.push({ target, operation: 'replace', node: after });
            } else {
                changes.push(...diffSelectionNodes(before.children, after.children, target));
            }
        } else if (before.text !== after.text) {
            changes.push({ target, operation: 'replace', node: after });
        }
    }
    return changes;
}

function diffSelectionXml(previousXml, currentXml) {
    return diffSelectionNodes(parseSelectionNodes(previousXml), parseSelectionNodes(currentXml));
}

function recordPendingSelectionChanges(subscription, changes) {
    if (!Array.isArray(subscription.pendingChanges)) subscription.pendingChanges = [];
    subscription.pendingChanges.push(...changes);
}

function pendingYangPatchChanges(subscription, currentSelection) {
    if (Array.isArray(subscription.pendingChanges) && subscription.pendingChanges.length > 0) {
        return [...subscription.pendingChanges];
    }
    return diffSelectionXml(subscription.lastSelection || '', currentSelection);
}

function serializeYangPatchEdits(changes) {
    return changes
        .map(function (change, index) {
            const value = change.node ? '<value>' + serializeSelectionNode(change.node) + '</value>' : '';
            return (
                '<edit><edit-id>edit-' +
                String(index + 1) +
                '</edit-id><operation>' +
                change.operation +
                '</operation><target>' +
                escapeXml(change.target) +
                '</target>' +
                value +
                '</edit>'
            );
        })
        .join('');
}

function notificationEnvelope(body, eventTime = new Date().toISOString()) {
    return (
        '<notification xmlns="' +
        NOTIFICATION_NAMESPACE +
        '"><eventTime>' +
        escapeXml(eventTime) +
        '</eventTime>' +
        body +
        '</notification>'
    );
}

function subscriptionTerminationReasonXml(reason) {
    const normalized = String(reason || 'no-such-subscription').trim();
    const identity = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)$/u.exec(normalized);
    if (!identity) throw new TypeError('invalid subscription termination reason identity: ' + normalized);
    if (!identity[1] || identity[1] === 'sn' || identity[1] === 'ietf-subscribed-notifications') {
        return '<reason>' + escapeXml(identity[2]) + '</reason>';
    }
    const moduleName = identity[1] === 'yp' ? 'ietf-yang-push' : identity[1];
    const module = MOCK_MODULES[moduleName];
    if (!module) throw new TypeError('unknown subscription termination reason module: ' + moduleName);
    const prefix = moduleName === 'ietf-yang-push' ? 'yp' : 'reason-module';
    return (
        '<reason xmlns:' +
        prefix +
        '="' +
        escapeXmlAttribute(module.namespace) +
        '">' +
        prefix +
        ':' +
        escapeXml(identity[2]) +
        '</reason>'
    );
}

function asSubscriptionFilterError(error) {
    if (error instanceof MockRpcError) {
        error.tag = 'invalid-value';
        error.appTag = 'ietf-subscribed-notifications:filter-unsupported';
        return error;
    }
    return new MockRpcError(error.message || String(error), 'invalid-value', {
        appTag: 'ietf-subscribed-notifications:filter-unsupported'
    });
}

class MockNetconfSession {
    constructor(server, sshClient, stream, sessionId) {
        this.server = server;
        this.sshClient = sshClient;
        this.stream = stream;
        this.sessionId = String(sessionId);
        this.helloFramer = new DelimiterFramer({ maxMessageSize: server.options.maxMessageSize });
        this.framer = null;
        this.baseVersion = null;
        this.established = false;
        this.subscription = null;
        this.subscribed = false;
        this.subscriptionStopTimer = null;
        this.dynamicSubscriptions = new Map();
        this.closed = false;
        this.boundData = this.handleData.bind(this);

        stream.on('data', this.boundData);
        stream.on('error', this.handleError.bind(this));
        stream.on('close', this.close.bind(this));
    }

    handleError(error) {
        this.server.log('session-error', { sessionId: this.sessionId, message: error.message });
    }

    handleData(chunk) {
        try {
            if (!this.established) {
                const messages = this.helloFramer.push(chunk, 1);
                if (messages.length === 0) return;
                const remainder = this.helloFramer.takeBuffered();
                this.acceptClientHello(messages[0]);
                if (remainder.length > 0) this.handleEstablishedData(remainder);
                return;
            }
            this.handleEstablishedData(chunk);
        } catch (error) {
            this.server.log('protocol-error', { sessionId: this.sessionId, message: error.message });
            this.close();
        }
    }

    acceptClientHello(xml) {
        const hello = parseNetconfMessage(xml, { maxXmlSize: this.server.options.maxMessageSize });
        if (hello.type !== 'hello') throw new Error('expected NETCONF client hello');
        const clientSupports11 = hello.capabilities.some(function (capability) {
            return capability.startsWith('urn:ietf:params:netconf:base:1.1');
        });
        const clientSupports10 = hello.capabilities.some(function (capability) {
            return capability.startsWith('urn:ietf:params:netconf:base:1.0');
        });
        if (!clientSupports11 && !clientSupports10) throw new Error('client advertises no supported NETCONF base');

        this.baseVersion = clientSupports11 ? '1.1' : '1.0';
        this.framer = createFramer(this.baseVersion, { maxMessageSize: this.server.options.maxMessageSize });
        this.established = true;
        this.stream.write(encodeMessage(serverHello(this.sessionId), '1.0'));
        this.server.log('session-ready', {
            sessionId: this.sessionId,
            baseVersion: this.baseVersion
        });
        this.server.emit('session-ready', this.publicState());
    }

    handleEstablishedData(chunk) {
        const messages = this.framer.push(chunk);
        for (const xml of messages) this.handleRpc(xml);
    }

    publicState() {
        return {
            sessionId: this.sessionId,
            baseVersion: this.baseVersion,
            subscribed: this.subscribed || this.dynamicSubscriptions.size > 0,
            subscription: this.subscription
                ? {
                      stream: this.subscription.stream,
                      filterType: this.subscription.filter?.type || null,
                      startTime: this.subscription.startTime?.value || null,
                      stopTime: this.subscription.stopTime?.value || null
                  }
                : null,
            dynamicSubscriptions: [...this.dynamicSubscriptions.values()].map(function (subscription) {
                return {
                    id: subscription.id,
                    target: subscription.target,
                    stream: subscription.stream || null,
                    datastore: subscription.datastore || null,
                    filterType: subscription.filter?.type || null,
                    trigger: subscription.trigger?.type || null,
                    period: subscription.trigger?.period ?? null,
                    dampeningPeriod: subscription.trigger?.dampeningPeriod ?? null,
                    stopTime: subscription.stopTime?.value || null
                };
            })
        };
    }

    handleRpc(xml) {
        const startedAt = Date.now();
        let messageId = '0';
        let operationName = 'unknown';
        try {
            const document = parseXml(xml, { maxXmlSize: this.server.options.maxMessageSize });
            const root = findRoot(document);
            if (!root || root.name !== 'rpc') throw new MockRpcError('expected an rpc envelope', 'malformed-message');
            messageId = getAttribute(root.value, 'message-id');
            if (messageId === null || messageId === '') {
                throw new MockRpcError('rpc message-id is required', 'missing-attribute', {
                    type: 'protocol'
                });
            }
            const operation = firstOperation(root);
            if (!operation) throw new MockRpcError('rpc contains no operation', 'missing-element');
            operationName = operation.name;
            const action = this.executeOperation(operationName, operation.value, xml, messageId);
            if (action && action.reply) {
                this.send(action.reply, action.afterWrite);
            }
            this.server.log('rpc', {
                sessionId: this.sessionId,
                messageId,
                operation: operationName,
                durationMs: Date.now() - startedAt,
                revision: this.server.state.revision
            });
            this.server.emit('rpc', { sessionId: this.sessionId, messageId, operation: operationName, xml });
        } catch (error) {
            this.send(rpcErrorReply(messageId, error));
            this.server.log('rpc-error', {
                sessionId: this.sessionId,
                messageId,
                operation: operationName,
                tag: error.tag || 'operation-failed',
                message: error.message
            });
        }
    }

    executeOperation(name, node, xml, messageId) {
        switch (name) {
            case 'get':
                return { reply: this.handleGet(xml, messageId) };
            case 'get-config':
                return { reply: this.handleGetConfig(xml, messageId) };
            case 'edit-config':
                return { reply: this.handleEditConfig(node, xml, messageId) };
            case 'copy-config':
                return { reply: this.handleCopyConfig(xml, messageId) };
            case 'delete-config':
                return { reply: this.handleDeleteConfig(xml, messageId) };
            case 'lock':
                return { reply: this.handleLock(xml, messageId) };
            case 'unlock':
                return { reply: this.handleUnlock(xml, messageId) };
            case 'validate':
                return { reply: this.handleValidate(xml, messageId) };
            case 'commit':
                return { reply: this.handleCommit(messageId) };
            case 'discard-changes':
                return { reply: this.handleDiscardChanges(messageId) };
            case 'get-schema':
                return { reply: this.handleGetSchema(node, messageId) };
            case 'create-subscription':
                return {
                    reply: this.handleCreateSubscription(node, xml, messageId),
                    afterWrite: this.activateSubscription.bind(this)
                };
            case 'establish-subscription': {
                const established = this.handleEstablishSubscription(node, xml, messageId);
                return {
                    reply: established.reply,
                    afterWrite: this.activateDynamicSubscription.bind(this, established.subscriptionId)
                };
            }
            case 'modify-subscription': {
                const modified = this.handleModifySubscription(node, xml, messageId);
                return {
                    reply: modified.reply,
                    afterWrite: this.activateModifiedSubscription.bind(this, modified.subscriptionId)
                };
            }
            case 'delete-subscription':
                return { reply: this.handleDeleteSubscription(node, xml, messageId) };
            case 'kill-subscription': {
                const killed = this.handleKillSubscription(node, xml, messageId);
                return {
                    reply: killed.reply,
                    afterWrite: killed.terminate
                };
            }
            case 'resync-subscription': {
                const resynced = this.handleResyncSubscription(node, xml, messageId);
                return {
                    reply: resynced.reply,
                    afterWrite: this.sendYangPushUpdate.bind(this, resynced.subscriptionId)
                };
            }
            case 'kill-session':
                return { reply: this.handleKillSession(node, messageId) };
            case 'close-session':
                return {
                    reply: rpcReply(messageId, '<ok/>'),
                    afterWrite: this.close.bind(this)
                };
            case 'reboot':
                return { reply: this.handleReboot(node, messageId) };
            default:
                throw new MockRpcError(
                    'operation is not supported by the mock device: ' + name,
                    'operation-not-supported',
                    {
                        type: 'protocol'
                    }
                );
        }
    }

    handleGet(xml, messageId) {
        const candidates = this.server.renderOperationalData(hasSubtreeFilter(xml));
        const data = filterSubtreeXml(candidates, xml, { keyDefinitions: MOCK_KEY_DEFINITIONS });
        return rpcReply(messageId, '<data>' + data + '</data>');
    }

    handleGetConfig(xml, messageId) {
        const source = datastoreFrom(xml, 'source', 'running');
        this.server.requireDatastore(source);
        return rpcReply(messageId, '<data>' + this.server.renderDatastore(source, xml, false) + '</data>');
    }

    handleEditConfig(node, xml, messageId) {
        const target = datastoreFrom(xml, 'target', 'running');
        this.server.requireDatastore(target);
        this.server.assertWritable(target, this.sessionId);
        const fragment = extractElementContent(xml, 'config');
        const defaultOperation = childText(node, 'default-operation') || 'merge';
        const testOption = childText(node, 'test-option') || 'test-then-set';
        const next = applyConfigFragment(
            this.server.state.datastores[target],
            fragment,
            defaultOperation === 'replace'
        );
        if (testOption !== 'test-only') {
            this.server.state.datastores[target] = next;
            this.server.changed('edit-config ' + target);
        }
        return rpcReply(messageId, '<ok/>');
    }

    handleCopyConfig(xml, messageId) {
        const target = datastoreFrom(xml, 'target', 'running');
        const source = datastoreFrom(xml, 'source', 'running');
        this.server.requireDatastore(target);
        this.server.requireDatastore(source);
        this.server.assertWritable(target, this.sessionId);
        this.server.state.datastores[target] = clone(this.server.state.datastores[source]);
        this.server.changed('copy-config ' + source + ' to ' + target);
        return rpcReply(messageId, '<ok/>');
    }

    handleDeleteConfig(xml, messageId) {
        const target = datastoreFrom(xml, 'target', 'startup');
        this.server.requireDatastore(target);
        if (target === 'running') {
            throw new MockRpcError('the running datastore cannot be deleted', 'operation-not-supported');
        }
        this.server.assertWritable(target, this.sessionId);
        this.server.state.datastores[target] = { system: { hostname: '', location: '', contact: '' }, interfaces: [] };
        this.server.changed('delete-config ' + target);
        return rpcReply(messageId, '<ok/>');
    }

    handleLock(xml, messageId) {
        const target = datastoreFrom(xml, 'target', 'running');
        this.server.requireDatastore(target);
        const holder = this.server.state.locks[target];
        if (holder && holder !== this.sessionId) {
            throw new MockRpcError('datastore is locked by session ' + holder, 'lock-denied', {
                info: '<session-id>' + escapeXml(holder) + '</session-id>'
            });
        }
        this.server.state.locks[target] = this.sessionId;
        return rpcReply(messageId, '<ok/>');
    }

    handleUnlock(xml, messageId) {
        const target = datastoreFrom(xml, 'target', 'running');
        this.server.requireDatastore(target);
        const holder = this.server.state.locks[target];
        if (holder && holder !== this.sessionId) {
            throw new MockRpcError('datastore lock is owned by session ' + holder, 'lock-denied');
        }
        this.server.state.locks[target] = null;
        return rpcReply(messageId, '<ok/>');
    }

    handleValidate(xml, messageId) {
        const source = datastoreFrom(xml, 'source', 'candidate');
        this.server.requireDatastore(source);
        const config = this.server.state.datastores[source];
        if (!config.system.hostname) {
            throw new MockRpcError('system hostname must not be empty', 'invalid-value');
        }
        return rpcReply(messageId, '<ok/>');
    }

    handleCommit(messageId) {
        this.server.assertWritable('candidate', this.sessionId);
        this.server.assertWritable('running', this.sessionId);
        this.server.state.datastores.running = clone(this.server.state.datastores.candidate);
        this.server.changed('commit candidate to running');
        return rpcReply(messageId, '<ok/>');
    }

    handleDiscardChanges(messageId) {
        this.server.assertWritable('candidate', this.sessionId);
        this.server.state.datastores.candidate = clone(this.server.state.datastores.running);
        this.server.changed('discard candidate changes');
        return rpcReply(messageId, '<ok/>');
    }

    handleGetSchema(node, messageId) {
        const identifier = childText(node, 'identifier');
        const version = childText(node, 'version');
        const format = childText(node, 'format') || 'yang';
        const module = MOCK_MODULES[identifier];
        if (!module) throw new MockRpcError('unknown YANG module: ' + identifier, 'invalid-value');
        if (version && version !== module.revision) {
            throw new MockRpcError('unknown revision for ' + identifier + ': ' + version, 'invalid-value');
        }
        if (format.toLowerCase() !== 'yang') {
            throw new MockRpcError('only YANG format is available', 'invalid-value');
        }
        return rpcReply(
            messageId,
            '<data xmlns="' + NETCONF_MONITORING_NAMESPACE + '">' + cdata(module.source) + '</data>'
        );
    }

    handleCreateSubscription(node, xml, messageId) {
        const operationNamespace = resolvedElementNamespace(xml, 'create-subscription');
        if (operationNamespace !== NOTIFICATION_NAMESPACE) {
            throw new MockRpcError(
                'create-subscription must use the NETCONF notification namespace',
                'unknown-namespace',
                {
                    type: 'protocol',
                    info:
                        '<bad-element>create-subscription</bad-element><bad-namespace>' +
                        escapeXml(operationNamespace) +
                        '</bad-namespace>'
                }
            );
        }
        if (this.dynamicSubscriptions.size > 0) {
            throw new MockRpcError(
                'RFC 5277 and RFC 8639 subscriptions cannot share one NETCONF session',
                'operation-not-supported',
                { type: 'protocol' }
            );
        }
        if (this.subscription) {
            throw new MockRpcError('this NETCONF session already has an active RFC 5277 subscription');
        }

        const streamNodes = childValues(node, 'stream');
        if (streamNodes.length > 1) {
            throw new MockRpcError('create-subscription accepts at most one stream', 'invalid-value');
        }
        const stream = streamNodes.length === 0 ? 'NETCONF' : childText(node, 'stream');
        if (stream !== 'NETCONF') {
            throw new MockRpcError('the mock supports only the NETCONF notification stream', 'invalid-value');
        }

        const filterNodes = childValues(node, 'filter');
        if (filterNodes.length > 1) {
            throw new MockRpcError('create-subscription accepts at most one filter', 'invalid-value');
        }
        let filter = null;
        if (filterNodes.length === 1) {
            const filterNode = filterNodes[0];
            const type = String(getAttribute(filterNode, 'type') || 'subtree').toLowerCase();
            if (type === 'subtree') {
                const filterXml = standaloneFilterXml(xml);
                if (!filterXml) throw new MockRpcError('unable to parse the subtree filter', 'invalid-value');
                // Parse and exercise the existing namespace-aware matcher now so malformed
                // filters fail with the subscription RPC rather than during /notify.
                filterSubtreeXml('<mock-event xmlns="' + MOCK_NAMESPACE + '"/>', filterXml, {
                    keyDefinitions: MOCK_KEY_DEFINITIONS
                });
                filter = { type, xml: filterXml };
            } else if (type === 'xpath') {
                const select = getAttribute(filterNode, 'select');
                const namespaces = namespaceContext(xml, ['rpc', 'create-subscription', 'filter']);
                filter = {
                    type,
                    select,
                    matches: compileMockXPath(select, namespaces)
                };
            } else {
                throw new MockRpcError('unsupported notification filter type: ' + type, 'invalid-value');
            }
        }

        const startNodes = childValues(node, 'startTime');
        const stopNodes = childValues(node, 'stopTime');
        if (startNodes.length > 1 || stopNodes.length > 1) {
            throw new MockRpcError('startTime and stopTime may appear at most once', 'invalid-value');
        }
        const startTime = startNodes.length > 0 ? parseEventTime(childText(node, 'startTime'), 'startTime') : null;
        const stopTime = stopNodes.length > 0 ? parseEventTime(childText(node, 'stopTime'), 'stopTime') : null;
        if (startTime && startTime.timestamp > Date.now()) {
            throw new MockRpcError('startTime must not be later than the current time', 'invalid-value');
        }
        if (stopTime && !startTime) {
            throw new MockRpcError('stopTime requires startTime', 'invalid-value');
        }
        if (stopTime && stopTime.timestamp <= startTime.timestamp) {
            throw new MockRpcError('stopTime must be later than startTime', 'invalid-value');
        }

        this.subscription = { stream, filter, startTime, stopTime };
        this.subscribed = true;
        this.server.log('subscription-created', {
            sessionId: this.sessionId,
            stream,
            filterType: filter?.type || null,
            startTime: startTime?.value || null,
            stopTime: stopTime?.value || null
        });
        return rpcReply(messageId, '<ok/>');
    }

    assertSubscribedNotificationsNamespace(xml, operationName) {
        const operationNamespace = resolvedElementNamespace(xml, operationName);
        if (operationNamespace !== SUBSCRIBED_NOTIFICATIONS_NAMESPACE) {
            throw new MockRpcError(
                operationName + ' must use the ietf-subscribed-notifications namespace',
                'unknown-namespace',
                {
                    type: 'protocol',
                    info:
                        '<bad-element>' +
                        escapeXml(operationName) +
                        '</bad-element><bad-namespace>' +
                        escapeXml(operationNamespace) +
                        '</bad-namespace>'
                }
            );
        }
        if (!STANDARD_SUBSCRIPTION_MODELS_AVAILABLE) {
            throw new MockRpcError('modern subscription YANG modules are unavailable', 'operation-not-supported');
        }
    }

    parseDynamicSubscriptionId(node) {
        const idNodes = childValues(node, 'id');
        if (idNodes.length !== 1) {
            throw new MockRpcError('subscription id is required exactly once', 'missing-element');
        }
        return String(parseUint32(childText(node, 'id'), 'id', { allowZero: true }));
    }

    dynamicSubscriptionOrThrow(id) {
        const subscription = this.dynamicSubscriptions.get(String(id));
        if (subscription) return subscription;
        throw new MockRpcError('subscription does not exist on this NETCONF session: ' + id, 'invalid-value', {
            appTag: 'ietf-subscribed-notifications:no-such-subscription'
        });
    }

    parseStreamSubscriptionFilter(node, xml, operationName) {
        if (childValues(node, 'stream-filter-name').length > 0) {
            throw new MockRpcError('the mock does not provide configured stream filters', 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:filter-unsupported'
            });
        }
        const subtreeNodes = childValues(node, 'stream-subtree-filter');
        const xpathNodes = childValues(node, 'stream-xpath-filter');
        if (subtreeNodes.length + xpathNodes.length > 1) {
            throw new MockRpcError('only one stream filter may be supplied', 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:filter-unsupported'
            });
        }
        if (subtreeNodes.length === 1) {
            const filterXml = standaloneAnydataFilterXml(xml, 'stream-subtree-filter', operationName);
            if (!filterXml) throw new MockRpcError('unable to parse stream-subtree-filter', 'invalid-value');
            try {
                filterSubtreeXml('<mock-event xmlns="' + MOCK_NAMESPACE + '"/>', filterXml, {
                    keyDefinitions: MOCK_KEY_DEFINITIONS
                });
            } catch (error) {
                throw asSubscriptionFilterError(error);
            }
            return {
                type: 'subtree',
                xml: filterXml,
                stateXml: standaloneElementXml(xml, 'stream-subtree-filter', operationName)
            };
        }
        if (xpathNodes.length === 1) {
            const select = childText(node, 'stream-xpath-filter');
            const namespaces = subscriptionXPathContext(xml, ['rpc', operationName, 'stream-xpath-filter']);
            let matches;
            try {
                matches = compileMockXPath(select, namespaces);
            } catch (error) {
                throw asSubscriptionFilterError(error);
            }
            return {
                type: 'xpath',
                select,
                matches,
                stateXml: standaloneElementXml(xml, 'stream-xpath-filter', operationName)
            };
        }
        return null;
    }

    parseDatastoreSubscriptionFilter(node, xml, operationName) {
        if (childValues(node, 'selection-filter-ref').length > 0) {
            throw new MockRpcError('the mock does not provide configured selection filters', 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:filter-unsupported'
            });
        }
        const subtreeNodes = childValues(node, 'datastore-subtree-filter');
        const xpathNodes = childValues(node, 'datastore-xpath-filter');
        if (subtreeNodes.length + xpathNodes.length > 1) {
            throw new MockRpcError('only one datastore selection filter may be supplied', 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:filter-unsupported'
            });
        }
        if (subtreeNodes.length === 1) {
            const filterXml = standaloneAnydataFilterXml(xml, 'datastore-subtree-filter', operationName);
            if (!filterXml) throw new MockRpcError('unable to parse datastore-subtree-filter', 'invalid-value');
            const source = this.server.renderDatastore('running', '', true);
            try {
                filterSubtreeXml(source, filterXml, { keyDefinitions: MOCK_KEY_DEFINITIONS });
            } catch (error) {
                throw asSubscriptionFilterError(error);
            }
            return {
                type: 'subtree',
                xml: filterXml,
                stateXml: standaloneElementXml(xml, 'datastore-subtree-filter', operationName)
            };
        }
        if (xpathNodes.length === 1) {
            const select = childText(node, 'datastore-xpath-filter');
            const namespaces = subscriptionXPathContext(xml, ['rpc', operationName, 'datastore-xpath-filter']);
            let selectXml;
            try {
                selectXml = compileDatastoreXPath(select, namespaces);
            } catch (error) {
                throw asSubscriptionFilterError(error);
            }
            return {
                type: 'xpath',
                select,
                selectXml,
                stateXml: standaloneElementXml(xml, 'datastore-xpath-filter', operationName)
            };
        }
        return null;
    }

    parseYangPushTrigger(node, existing = null, establishing = false) {
        const periodicNodes = childValues(node, 'periodic');
        const onChangeNodes = childValues(node, 'on-change');
        if (periodicNodes.length + onChangeNodes.length > 1) {
            throw new MockRpcError('only one YANG-Push update trigger may be supplied', 'invalid-value');
        }
        if (periodicNodes.length === 1) {
            const periodNodes = childValues(periodicNodes[0], 'period');
            if (periodNodes.length !== 1) {
                throw new MockRpcError('periodic subscriptions require period', 'missing-element');
            }
            const period = parseUint32(childText(periodicNodes[0], 'period'), 'period', { allowZero: true });
            if (period === 0) {
                const errorContainer = establishing
                    ? 'establish-subscription-datastore-error-info'
                    : 'modify-subscription-datastore-error-info';
                throw new MockRpcError('the mock cannot schedule a zero-length period', 'invalid-value', {
                    appTag: 'ietf-yang-push:period-unsupported',
                    info:
                        '<' +
                        errorContainer +
                        ' xmlns="' +
                        YANG_PUSH_NAMESPACE +
                        '"><reason>period-unsupported</reason><period-hint>1</period-hint></' +
                        errorContainer +
                        '>'
                });
            }
            const anchorText = childText(periodicNodes[0], 'anchor-time');
            const anchorTime = anchorText === null ? null : parseEventTime(anchorText, 'anchor-time');
            return { type: 'periodic', period, periodMs: period * 10, anchorTime };
        }
        if (onChangeNodes.length === 1) {
            const dampeningText = childText(onChangeNodes[0], 'dampening-period');
            const dampeningPeriod =
                dampeningText === null ? 0 : parseUint32(dampeningText, 'dampening-period', { allowZero: true });
            const syncText = childText(onChangeNodes[0], 'sync-on-start');
            if (!establishing && syncText !== null) {
                throw new MockRpcError('sync-on-start cannot be modified after establishment', 'invalid-value');
            }
            const syncOnStart =
                syncText === null
                    ? establishing
                        ? true
                        : (existing?.syncOnStart ?? true)
                    : parseBoolean(syncText, 'sync-on-start');
            const excludedChanges = childValues(onChangeNodes[0], 'excluded-change');
            if (excludedChanges.length > 0) {
                throw new MockRpcError('the mock does not support excluded-change', 'operation-not-supported', {
                    appTag: 'ietf-yang-push:cant-exclude'
                });
            }
            return {
                type: 'on-change',
                dampeningPeriod,
                dampeningMs: dampeningPeriod * 10,
                syncOnStart
            };
        }
        if (existing) return existing;
        if (establishing)
            throw new MockRpcError('YANG-Push subscriptions require an update trigger', 'missing-element');
        return null;
    }

    parseDynamicStopTime(node, existing = null, allowPast = false) {
        const stopNodes = childValues(node, 'stop-time');
        if (stopNodes.length > 1) throw new MockRpcError('stop-time may appear at most once', 'invalid-value');
        if (stopNodes.length === 0) return existing;
        const stopTime = parseEventTime(childText(node, 'stop-time'), 'stop-time');
        if (!allowPast && stopTime.timestamp <= Date.now()) {
            throw new MockRpcError('stop-time must be later than the current time', 'invalid-value');
        }
        return stopTime;
    }

    parseDynamicEncoding(node) {
        const encoding = childText(node, 'encoding');
        if (encoding === null || String(encoding).split(':').pop() === 'encode-xml') return 'encode-xml';
        throw new MockRpcError('the NETCONF mock supports only XML subscription encoding', 'invalid-value', {
            appTag: 'ietf-subscribed-notifications:encoding-unsupported'
        });
    }

    rejectUnsupportedDynamicQos(node) {
        if (childValues(node, 'dscp').length > 0) {
            throw new MockRpcError('the mock cannot apply DSCP marking to subscription traffic', 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:dscp-unavailable'
            });
        }
        if (childValues(node, 'weighting').length > 0 || childValues(node, 'dependency').length > 0) {
            throw new MockRpcError(
                'the mock does not advertise the subscribed-notifications qos feature',
                'operation-not-supported'
            );
        }
    }

    parseDatastoreIdentity(node, xml, operationName) {
        const datastoreNodes = childValues(node, 'datastore');
        if (datastoreNodes.length > 1) {
            throw new MockRpcError('datastore may appear at most once', 'invalid-value');
        }
        if (datastoreNodes.length === 0) return null;
        const lexical = String(childText(node, 'datastore') || '').trim();
        const identity = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)$/u.exec(lexical);
        if (!identity || !identity[1]) {
            throw new MockRpcError('datastore must be a prefixed ietf-datastores identity', 'invalid-value');
        }
        const namespaces = namespaceContext(xml, ['rpc', operationName, 'datastore']);
        if (namespaces.get(identity[1]) !== IETF_DATASTORES_NAMESPACE) {
            throw new MockRpcError('datastore identity must use the ietf-datastores namespace', 'invalid-value');
        }
        const datastore = identity[2];
        if (datastore === 'operational') return datastore;
        this.server.requireDatastore(datastore);
        return datastore;
    }

    handleEstablishSubscription(node, xml, messageId) {
        this.assertSubscribedNotificationsNamespace(xml, 'establish-subscription');
        assertDynamicRpcChildNamespaces(xml, 'establish-subscription');
        if (this.subscription) {
            throw new MockRpcError(
                'RFC 5277 and RFC 8639 subscriptions cannot share one NETCONF session',
                'operation-not-supported',
                { type: 'protocol' }
            );
        }
        this.rejectUnsupportedDynamicQos(node);

        const streamNodes = childValues(node, 'stream');
        const datastore = this.parseDatastoreIdentity(node, xml, 'establish-subscription');
        const hasStreamFilter =
            childValues(node, 'stream-filter-name').length +
                childValues(node, 'stream-subtree-filter').length +
                childValues(node, 'stream-xpath-filter').length >
            0;
        const hasDatastorePolicy =
            childValues(node, 'selection-filter-ref').length +
                childValues(node, 'datastore-subtree-filter').length +
                childValues(node, 'datastore-xpath-filter').length +
                childValues(node, 'periodic').length +
                childValues(node, 'on-change').length >
            0;
        if (streamNodes.length > 1 || (streamNodes.length === 1 && datastore)) {
            throw new MockRpcError('establish-subscription requires exactly one target', 'invalid-value');
        }
        const encoding = this.parseDynamicEncoding(node);
        let subscription;
        if (datastore) {
            if (hasStreamFilter) {
                throw new MockRpcError('a datastore subscription cannot use a stream filter', 'invalid-value');
            }
            const stopTime = this.parseDynamicStopTime(node);
            const filter = this.parseDatastoreSubscriptionFilter(node, xml, 'establish-subscription');
            const trigger = this.parseYangPushTrigger(node, null, true);
            subscription = { target: 'datastore', datastore, filter, trigger, stopTime, encoding };
        } else {
            if (streamNodes.length !== 1) {
                throw new MockRpcError('event stream subscriptions require stream', 'missing-element');
            }
            const stream = childText(node, 'stream');
            if (stream !== 'NETCONF') {
                throw new MockRpcError('the mock supports only the NETCONF event stream', 'invalid-value');
            }
            if (hasDatastorePolicy) {
                throw new MockRpcError('an event stream subscription cannot use YANG-Push policy', 'invalid-value');
            }
            const replayText = childText(node, 'replay-start-time');
            if (replayText !== null) {
                throw new MockRpcError('the mock does not retain an event replay log', 'operation-not-supported', {
                    appTag: 'ietf-subscribed-notifications:replay-unsupported'
                });
            }
            const replayStartTime = null;
            const stopTime = this.parseDynamicStopTime(node);
            const filter = this.parseStreamSubscriptionFilter(node, xml, 'establish-subscription');
            subscription = {
                target: 'stream',
                stream,
                filter,
                replayStartTime,
                stopTime,
                encoding
            };
        }

        const subscriptionId = String(this.server.nextSubscriptionId++);
        Object.assign(subscription, {
            id: subscriptionId,
            createdAt: new Date().toISOString(),
            sentEventRecords: 0,
            excludedEventRecords: 0,
            stopTimer: null,
            updateTimer: null,
            changeTimer: null,
            pendingOperation: '',
            pendingChanges: [],
            observedSelection: undefined,
            lastSelection: undefined,
            lastUpdateAt: null,
            patchId: 0
        });
        this.dynamicSubscriptions.set(subscriptionId, subscription);
        this.server.log('dynamic-subscription-created', {
            sessionId: this.sessionId,
            subscriptionId,
            target: subscription.target,
            stream: subscription.stream || null,
            datastore: subscription.datastore || null,
            trigger: subscription.trigger?.type || null
        });
        return {
            subscriptionId,
            reply: rpcReply(
                messageId,
                '<id xmlns="' + SUBSCRIBED_NOTIFICATIONS_NAMESPACE + '">' + subscriptionId + '</id>'
            )
        };
    }

    handleModifySubscription(node, xml, messageId) {
        this.assertSubscribedNotificationsNamespace(xml, 'modify-subscription');
        assertDynamicRpcChildNamespaces(xml, 'modify-subscription');
        const subscriptionId = this.parseDynamicSubscriptionId(node);
        const subscription = this.dynamicSubscriptionOrThrow(subscriptionId);
        const stopTime = this.parseDynamicStopTime(node, subscription.stopTime);
        const datastore = this.parseDatastoreIdentity(node, xml, 'modify-subscription');
        const hasStreamTarget =
            childValues(node, 'stream-filter-name').length +
                childValues(node, 'stream-subtree-filter').length +
                childValues(node, 'stream-xpath-filter').length >
            0;
        const hasDatastorePolicy =
            childValues(node, 'selection-filter-ref').length +
                childValues(node, 'datastore-subtree-filter').length +
                childValues(node, 'datastore-xpath-filter').length +
                childValues(node, 'periodic').length +
                childValues(node, 'on-change').length >
            0;
        let filter = subscription.filter;
        let trigger = subscription.trigger;
        if (subscription.target === 'stream') {
            if (datastore) throw new MockRpcError('a stream subscription cannot become YANG-Push', 'invalid-value');
            if (hasDatastorePolicy) {
                throw new MockRpcError('a stream subscription cannot use YANG-Push policy', 'invalid-value');
            }
            if (!hasStreamTarget) {
                throw new MockRpcError('modify-subscription requires its mandatory stream target', 'missing-element');
            }
            filter = this.parseStreamSubscriptionFilter(node, xml, 'modify-subscription') || filter;
        } else {
            if (!datastore) {
                throw new MockRpcError(
                    'modify-subscription requires its mandatory datastore target',
                    'missing-element'
                );
            }
            if (hasStreamTarget) {
                throw new MockRpcError('a datastore subscription cannot use a stream filter', 'invalid-value');
            }
            if (datastore !== subscription.datastore) {
                throw new MockRpcError('a dynamic subscription cannot change its datastore', 'invalid-value');
            }
            filter = this.parseDatastoreSubscriptionFilter(node, xml, 'modify-subscription') || filter;
            trigger = this.parseYangPushTrigger(node, subscription.trigger, false);
        }
        this.clearDynamicSubscriptionTimers(subscription, { preservePending: true });
        Object.assign(subscription, { filter, trigger, stopTime });
        this.server.log('dynamic-subscription-modified', {
            sessionId: this.sessionId,
            subscriptionId,
            filterType: subscription.filter?.type || null,
            trigger: subscription.trigger?.type || null
        });
        return { subscriptionId, reply: rpcReply(messageId, '<ok/>') };
    }

    handleDeleteSubscription(node, xml, messageId) {
        this.assertSubscribedNotificationsNamespace(xml, 'delete-subscription');
        assertDynamicRpcChildNamespaces(xml, 'delete-subscription');
        const subscriptionId = this.parseDynamicSubscriptionId(node);
        this.dynamicSubscriptionOrThrow(subscriptionId);
        this.clearDynamicSubscription(subscriptionId, 'delete-subscription');
        return rpcReply(messageId, '<ok/>');
    }

    handleKillSubscription(node, xml, messageId) {
        this.assertSubscribedNotificationsNamespace(xml, 'kill-subscription');
        assertDynamicRpcChildNamespaces(xml, 'kill-subscription');
        const subscriptionId = this.parseDynamicSubscriptionId(node);
        const found = this.server.findDynamicSubscription(subscriptionId);
        if (!found) {
            throw new MockRpcError('subscription does not exist: ' + subscriptionId, 'invalid-value', {
                appTag: 'ietf-subscribed-notifications:no-such-subscription'
            });
        }
        return {
            reply: rpcReply(messageId, '<ok/>'),
            terminate: found.session.terminateDynamicSubscription.bind(
                found.session,
                subscriptionId,
                'no-such-subscription'
            )
        };
    }

    handleResyncSubscription(node, xml, messageId) {
        const operationNamespace = resolvedElementNamespace(xml, 'resync-subscription');
        if (operationNamespace !== YANG_PUSH_NAMESPACE) {
            throw new MockRpcError('resync-subscription must use the ietf-yang-push namespace', 'unknown-namespace', {
                type: 'protocol'
            });
        }
        if (!STANDARD_SUBSCRIPTION_MODELS_AVAILABLE) {
            throw new MockRpcError('ietf-yang-push is unavailable', 'operation-not-supported');
        }
        assertDynamicRpcChildNamespaces(xml, 'resync-subscription');
        const subscriptionId = this.parseDynamicSubscriptionId(node);
        const subscription = this.dynamicSubscriptions.get(subscriptionId);
        if (!subscription) {
            throw new MockRpcError('subscription cannot be resynchronized on this NETCONF session', 'invalid-value', {
                appTag: 'ietf-yang-push:no-such-subscription-resync'
            });
        }
        if (subscription.target !== 'datastore' || subscription.trigger?.type !== 'on-change') {
            throw new MockRpcError(
                'the existing subscription does not support on-change synchronization',
                'operation-not-supported',
                { appTag: 'ietf-yang-push:on-change-sync-unsupported' }
            );
        }
        return { subscriptionId, reply: rpcReply(messageId, '<ok/>') };
    }

    handleKillSession(node, messageId) {
        const targetId = childText(node, 'session-id');
        const target = this.server.sessions.get(String(targetId || ''));
        if (!target) throw new MockRpcError('session does not exist: ' + targetId, 'invalid-value');
        if (target === this) throw new MockRpcError('a session cannot kill itself', 'invalid-value');
        setImmediate(target.close.bind(target));
        return rpcReply(messageId, '<ok/>');
    }

    handleReboot(node, messageId) {
        const delay = Number(childText(node, 'delay') || 0);
        this.server.state.rebootCount += 1;
        this.server.changed('reboot requested');
        return rpcReply(
            messageId,
            '<accepted xmlns="' +
                MOCK_NAMESPACE +
                '">true</accepted><reboot-count xmlns="' +
                MOCK_NAMESPACE +
                '">' +
                this.server.state.rebootCount +
                '</reboot-count><delay xmlns="' +
                MOCK_NAMESPACE +
                '">' +
                (Number.isFinite(delay) ? delay : 0) +
                '</delay>'
        );
    }

    activateSubscription() {
        if (!this.subscription || this.closed) return;
        this.scheduleSubscriptionStop();
        setTimeout(
            function () {
                if (!this.closed && this.subscription) this.server.notify('subscription-ready');
            }.bind(this),
            25
        );
    }

    scheduleSubscriptionStop() {
        if (this.subscriptionStopTimer) clearTimeout(this.subscriptionStopTimer);
        this.subscriptionStopTimer = null;
        const stopTimestamp = this.subscription?.stopTime?.timestamp;
        if (!Number.isFinite(stopTimestamp)) return;
        const remaining = stopTimestamp - Date.now();
        if (remaining <= 0) {
            setImmediate(this.completeSubscription.bind(this));
            return;
        }
        this.subscriptionStopTimer = setTimeout(
            this.scheduleSubscriptionStop.bind(this),
            Math.min(remaining, 2_147_483_647)
        );
    }

    completeSubscription() {
        if (!this.subscription || this.closed) return;
        const xml =
            '<notification xmlns="' +
            NOTIFICATION_NAMESPACE +
            '"><eventTime>' +
            new Date().toISOString() +
            '</eventTime><notificationComplete/></notification>';
        this.send(xml);
        this.clearSubscription('stop-time');
    }

    clearSubscription(reason = 'cleared') {
        if (this.subscriptionStopTimer) clearTimeout(this.subscriptionStopTimer);
        this.subscriptionStopTimer = null;
        if (this.subscription) {
            this.server.log('subscription-ended', { sessionId: this.sessionId, reason });
        }
        this.subscription = null;
        this.subscribed = false;
    }

    clearDynamicSubscriptionTimers(subscription, options = {}) {
        for (const field of ['stopTimer', 'updateTimer', 'changeTimer']) {
            if (subscription[field]) clearTimeout(subscription[field]);
            subscription[field] = null;
        }
        if (!options.preservePending) {
            subscription.pendingOperation = '';
            if (Array.isArray(subscription.pendingChanges)) subscription.pendingChanges.length = 0;
        }
    }

    clearDynamicSubscription(subscriptionId, reason = 'cleared') {
        const id = String(subscriptionId);
        const subscription = this.dynamicSubscriptions.get(id);
        if (!subscription) return false;
        this.clearDynamicSubscriptionTimers(subscription);
        this.dynamicSubscriptions.delete(id);
        this.server.log('dynamic-subscription-ended', {
            sessionId: this.sessionId,
            subscriptionId: id,
            reason
        });
        return true;
    }

    dynamicSubscriptionExpired(subscription, now = Date.now()) {
        if (!Number.isFinite(subscription.stopTime?.timestamp) || now < subscription.stopTime.timestamp) {
            return false;
        }
        this.clearDynamicSubscription(subscription.id, 'stop-time');
        return true;
    }

    scheduleDynamicStop(subscription) {
        if (!Number.isFinite(subscription.stopTime?.timestamp)) return;
        const remaining = subscription.stopTime.timestamp - Date.now();
        if (remaining <= 0) {
            this.clearDynamicSubscription(subscription.id, 'stop-time');
            return;
        }
        subscription.stopTimer = setTimeout(
            this.scheduleDynamicStop.bind(this, subscription),
            Math.min(remaining, 2_147_483_647)
        );
    }

    scheduleOnChangeUpdate(subscription) {
        if (
            this.closed ||
            subscription.changeTimer ||
            !Array.isArray(subscription.pendingChanges) ||
            subscription.pendingChanges.length === 0 ||
            this.dynamicSubscriptionExpired(subscription)
        ) {
            return;
        }
        const nextAllowedAt = Number.isFinite(subscription.lastUpdateAt)
            ? subscription.lastUpdateAt + subscription.trigger.dampeningMs
            : Date.now();
        const remaining = Math.max(0, nextAllowedAt - Date.now());
        subscription.changeTimer = setTimeout(
            () => {
                const current = this.dynamicSubscriptions.get(String(subscription.id));
                if (current !== subscription) return;
                subscription.changeTimer = null;
                if (this.dynamicSubscriptionExpired(subscription)) return;
                if (
                    Number.isFinite(subscription.lastUpdateAt) &&
                    Date.now() < subscription.lastUpdateAt + subscription.trigger.dampeningMs
                ) {
                    this.scheduleOnChangeUpdate(subscription);
                    return;
                }
                this.sendYangPushChangeUpdate(subscription.id);
            },
            Math.min(remaining, 2_147_483_647)
        );
    }

    scheduleDynamicDelivery(subscription, sendInitial) {
        if (this.dynamicSubscriptionExpired(subscription)) return;
        this.scheduleDynamicStop(subscription);
        if (subscription.target !== 'datastore') return;
        if (subscription.trigger.type === 'periodic') {
            subscription.pendingOperation = '';
            if (Array.isArray(subscription.pendingChanges)) subscription.pendingChanges.length = 0;
            if (sendInitial && !subscription.trigger.anchorTime) this.sendYangPushUpdate(subscription.id);
            const now = Date.now();
            const anchor = subscription.trigger.anchorTime?.timestamp;
            if (Number.isFinite(anchor)) {
                if (anchor > now) subscription.nextUpdateAt = anchor;
                else {
                    const intervals = Math.floor((now - anchor) / subscription.trigger.periodMs) + 1;
                    subscription.nextUpdateAt = anchor + intervals * subscription.trigger.periodMs;
                }
            } else {
                subscription.nextUpdateAt =
                    (sendInitial && Number.isFinite(subscription.lastUpdateAt) ? subscription.lastUpdateAt : now) +
                    subscription.trigger.periodMs;
            }
            this.schedulePeriodicUpdate(subscription.id);
            return;
        }
        if (sendInitial && subscription.trigger.syncOnStart) {
            this.sendYangPushUpdate(subscription.id);
            return;
        }
        const selection = this.renderYangPushSelection(subscription);
        const observed = subscription.observedSelection ?? subscription.lastSelection ?? selection;
        recordPendingSelectionChanges(subscription, diffSelectionXml(observed, selection));
        subscription.observedSelection = selection;
        if (subscription.lastSelection === undefined) subscription.lastSelection = selection;
        this.scheduleOnChangeUpdate(subscription);
    }

    schedulePeriodicUpdate(subscriptionId) {
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (!subscription || subscription.trigger?.type !== 'periodic' || this.closed) return;
        if (this.dynamicSubscriptionExpired(subscription)) return;
        const now = Date.now();
        const remaining = subscription.nextUpdateAt - now;
        if (remaining <= 0) {
            this.sendYangPushUpdate(subscription.id);
            if (!this.dynamicSubscriptions.has(String(subscription.id))) return;
            const elapsedPeriods = Math.floor(
                Math.max(0, now - subscription.nextUpdateAt) / subscription.trigger.periodMs
            );
            subscription.nextUpdateAt += (elapsedPeriods + 1) * subscription.trigger.periodMs;
        }
        subscription.updateTimer = setTimeout(
            this.schedulePeriodicUpdate.bind(this, subscription.id),
            Math.min(Math.max(1, subscription.nextUpdateAt - Date.now()), 2_147_483_647)
        );
    }

    activateDynamicSubscription(subscriptionId) {
        if (this.closed) return;
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (!subscription) return;
        this.scheduleDynamicDelivery(subscription, true);
        if (subscription.target === 'stream' && subscription.replayStartTime) {
            this.sendSubscriptionState(subscription.id, 'replay-completed');
        }
    }

    activateModifiedSubscription(subscriptionId) {
        if (this.closed) return;
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (!subscription) return;
        this.clearDynamicSubscriptionTimers(subscription, { preservePending: true });
        this.scheduleDynamicDelivery(subscription, false);
    }

    renderDynamicSubscriptionPolicy(subscription) {
        const stopTime = subscription.stopTime
            ? '<stop-time>' + escapeXml(subscription.stopTime.value) + '</stop-time>'
            : '';
        if (subscription.target === 'stream') {
            return (
                (subscription.filter?.stateXml || '') +
                '<stream>' +
                escapeXml(subscription.stream) +
                '</stream>' +
                (subscription.replayStartTime
                    ? '<replay-start-time>' + escapeXml(subscription.replayStartTime.value) + '</replay-start-time>'
                    : '') +
                stopTime
            );
        }
        const filter = subscription.filter?.stateXml || '';
        let trigger;
        if (subscription.trigger.type === 'periodic') {
            trigger =
                '<periodic xmlns="' +
                YANG_PUSH_NAMESPACE +
                '"><period>' +
                subscription.trigger.period +
                '</period>' +
                (subscription.trigger.anchorTime
                    ? '<anchor-time>' + escapeXml(subscription.trigger.anchorTime.value) + '</anchor-time>'
                    : '') +
                '</periodic>';
        } else {
            trigger =
                '<on-change xmlns="' +
                YANG_PUSH_NAMESPACE +
                '"><dampening-period>' +
                subscription.trigger.dampeningPeriod +
                '</dampening-period><sync-on-start>' +
                String(subscription.trigger.syncOnStart) +
                '</sync-on-start></on-change>';
        }
        return (
            '<datastore xmlns="' +
            YANG_PUSH_NAMESPACE +
            '" xmlns:ds="' +
            IETF_DATASTORES_NAMESPACE +
            '">ds:' +
            escapeXml(subscription.datastore) +
            '</datastore>' +
            filter +
            trigger +
            stopTime
        );
    }

    recordDynamicSubscriptionEvent(subscription, excluded = false) {
        const field = excluded ? 'excludedEventRecords' : 'sentEventRecords';
        const current = Number(subscription?.[field] || 0);
        subscription[field] = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
    }

    renderDynamicSubscriptionReceiver(subscription) {
        const receiverName =
            'NETCONF session ' + this.sessionId + ' (' + String(this.server.options.username || 'unknown') + ')';
        return (
            '<receivers><receiver><name>' +
            escapeXml(receiverName) +
            '</name><sent-event-records>' +
            String(subscription.sentEventRecords || 0) +
            '</sent-event-records><excluded-event-records>' +
            String(subscription.excludedEventRecords || 0) +
            '</excluded-event-records><state>active</state></receiver></receivers>'
        );
    }

    sendSubscriptionState(subscriptionId, eventName, reason = 'no-such-subscription') {
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (!subscription || this.closed) return false;
        const supported = new Set([
            'subscription-started',
            'subscription-modified',
            'subscription-terminated',
            'replay-completed'
        ]);
        if (!supported.has(eventName)) throw new TypeError('unsupported subscription state event: ' + eventName);
        const policy =
            eventName === 'subscription-started' || eventName === 'subscription-modified'
                ? this.renderDynamicSubscriptionPolicy(subscription)
                : '';
        const terminationReason =
            eventName === 'subscription-terminated' ? subscriptionTerminationReasonXml(reason) : '';
        const body =
            '<' +
            eventName +
            ' xmlns="' +
            SUBSCRIBED_NOTIFICATIONS_NAMESPACE +
            '"><id>' +
            escapeXml(subscription.id) +
            '</id>' +
            policy +
            terminationReason +
            '</' +
            eventName +
            '>';
        this.recordDynamicSubscriptionEvent(subscription);
        this.send(notificationEnvelope(body));
        this.server.log('subscription-state-notification', {
            sessionId: this.sessionId,
            subscriptionId: subscription.id,
            notification: eventName,
            reason: eventName === 'subscription-terminated' ? reason : null
        });
        return true;
    }

    terminateDynamicSubscription(subscriptionId, reason = 'no-such-subscription') {
        const id = String(subscriptionId);
        if (!this.sendSubscriptionState(id, 'subscription-terminated', reason)) return false;
        this.clearDynamicSubscription(id, reason);
        return true;
    }

    renderYangPushSelection(subscription) {
        const source =
            subscription.datastore === 'operational'
                ? this.server.renderOperationalData(subscription.filter?.type === 'subtree')
                : this.server.renderDatastore(subscription.datastore);
        if (!subscription.filter) return source;
        if (subscription.filter.type === 'xpath') return subscription.filter.selectXml(source);
        return filterSubtreeXml(source, subscription.filter.xml, { keyDefinitions: MOCK_KEY_DEFINITIONS });
    }

    sendYangPushUpdate(subscriptionId) {
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (!subscription || subscription.target !== 'datastore' || this.closed) return false;
        if (this.dynamicSubscriptionExpired(subscription)) return false;
        const selection = this.renderYangPushSelection(subscription);
        if (subscription.changeTimer) clearTimeout(subscription.changeTimer);
        subscription.changeTimer = null;
        subscription.pendingOperation = '';
        if (Array.isArray(subscription.pendingChanges)) subscription.pendingChanges.length = 0;
        subscription.observedSelection = selection;
        subscription.lastSelection = selection;
        subscription.lastUpdateAt = Date.now();
        if (subscription.trigger?.type === 'on-change') subscription.patchId = 0;
        const body =
            '<push-update xmlns="' +
            YANG_PUSH_NAMESPACE +
            '"><id>' +
            escapeXml(subscription.id) +
            '</id><datastore-contents>' +
            selection +
            '</datastore-contents></push-update>';
        this.recordDynamicSubscriptionEvent(subscription);
        this.send(notificationEnvelope(body));
        this.server.log('yang-push-update', {
            sessionId: this.sessionId,
            subscriptionId: subscription.id,
            revision: this.server.state.revision
        });
        return true;
    }

    sendYangPushChangeUpdate(subscriptionId) {
        const subscription = this.dynamicSubscriptions.get(String(subscriptionId));
        if (
            !subscription ||
            subscription.target !== 'datastore' ||
            subscription.trigger.type !== 'on-change' ||
            this.closed
        ) {
            return false;
        }
        subscription.changeTimer = null;
        if (this.dynamicSubscriptionExpired(subscription)) return false;
        const operation = subscription.pendingOperation || 'datastore changed';
        const selection = this.renderYangPushSelection(subscription);
        const observed = subscription.observedSelection ?? subscription.lastSelection ?? selection;
        recordPendingSelectionChanges(subscription, diffSelectionXml(observed, selection));
        subscription.observedSelection = selection;
        const changes = pendingYangPatchChanges(subscription, selection);
        if (changes.length === 0) {
            subscription.pendingOperation = '';
            return false;
        }
        const patchId = subscription.patchId;
        subscription.patchId = (subscription.patchId + 1) % 4_294_967_296;
        subscription.pendingOperation = '';
        subscription.pendingChanges.length = 0;
        subscription.lastSelection = selection;
        subscription.lastUpdateAt = Date.now();
        const body =
            '<push-change-update xmlns="' +
            YANG_PUSH_NAMESPACE +
            '"><id>' +
            escapeXml(subscription.id) +
            '</id><datastore-changes><yang-patch><patch-id>' +
            patchId +
            '</patch-id><comment>' +
            escapeXml(operation) +
            '</comment>' +
            serializeYangPatchEdits(changes) +
            '</yang-patch></datastore-changes></push-change-update>';
        this.recordDynamicSubscriptionEvent(subscription);
        this.send(notificationEnvelope(body));
        this.server.log('yang-push-change-update', {
            sessionId: this.sessionId,
            subscriptionId: subscription.id,
            revision: this.server.state.revision
        });
        return true;
    }

    notifyYangPushChange(operation) {
        for (const subscription of this.dynamicSubscriptions.values()) {
            if (subscription.target !== 'datastore' || subscription.trigger.type !== 'on-change') continue;
            if (this.dynamicSubscriptionExpired(subscription)) continue;
            const selection = this.renderYangPushSelection(subscription);
            const observed = subscription.observedSelection ?? subscription.lastSelection ?? selection;
            const changes = diffSelectionXml(observed, selection);
            subscription.observedSelection = selection;
            if (changes.length === 0) continue;
            recordPendingSelectionChanges(subscription, changes);
            subscription.pendingOperation = String(operation || 'datastore changed');
            this.scheduleOnChangeUpdate(subscription);
        }
    }

    subscriptionMatches(message, payloadXml) {
        const filter = this.subscription?.filter;
        if (!filter) return true;
        if (filter.type === 'xpath') return filter.matches(message, this.server.state.revision);
        try {
            return Boolean(filterSubtreeXml(payloadXml, filter.xml, { keyDefinitions: MOCK_KEY_DEFINITIONS }).trim());
        } catch (error) {
            this.server.log('notification-filter-error', {
                sessionId: this.sessionId,
                message: error.message
            });
            return false;
        }
    }

    sendNotification(message) {
        if (!this.established || this.closed) return false;
        const payload =
            '<mock-event xmlns="' +
            MOCK_NAMESPACE +
            '"><message>' +
            escapeXml(message) +
            '</message><datastore-revision>' +
            this.server.state.revision +
            '</datastore-revision></mock-event>';
        const body =
            '<mock-event xmlns="' +
            MOCK_NAMESPACE +
            '">' +
            extractElementContent(payload, 'mock-event') +
            '</mock-event>';
        let delivered = false;
        if (this.subscription && this.subscriptionMatches(message, payload)) {
            this.send(notificationEnvelope(body));
            delivered = true;
        }
        for (const subscription of this.dynamicSubscriptions.values()) {
            if (subscription.target !== 'stream') continue;
            if (this.dynamicSubscriptionExpired(subscription)) continue;
            const filter = subscription.filter;
            let matches = true;
            if (filter?.type === 'xpath') matches = filter.matches(message, this.server.state.revision);
            else if (filter?.type === 'subtree') {
                try {
                    matches = Boolean(
                        filterSubtreeXml(payload, filter.xml, { keyDefinitions: MOCK_KEY_DEFINITIONS }).trim()
                    );
                } catch (error) {
                    matches = false;
                    this.server.log('notification-filter-error', {
                        sessionId: this.sessionId,
                        subscriptionId: subscription.id,
                        message: error.message
                    });
                }
            }
            if (!matches) {
                this.recordDynamicSubscriptionEvent(subscription, true);
                continue;
            }
            this.recordDynamicSubscriptionEvent(subscription);
            this.send(notificationEnvelope(body));
            delivered = true;
        }
        return delivered;
    }

    send(xml, callback) {
        if (this.closed) return;
        this.stream.write(encodeMessage(xml, this.baseVersion || '1.0'), callback);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.clearSubscription('session-close');
        for (const subscriptionId of [...this.dynamicSubscriptions.keys()]) {
            this.clearDynamicSubscription(subscriptionId, 'session-close');
        }
        this.stream.removeListener('data', this.boundData);
        for (const datastore of Object.keys(this.server.state.locks)) {
            if (this.server.state.locks[datastore] === this.sessionId) {
                this.server.state.locks[datastore] = null;
            }
        }
        this.server.sessions.delete(this.sessionId);
        try {
            this.stream.end();
        } catch (_error) {
            // The SSH channel may already be closed by the peer.
        }
        this.server.log('session-close', { sessionId: this.sessionId });
        this.server.emit('session-close', { sessionId: this.sessionId });
    }
}

class MockNetconfServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = normalizeOptions(options);
        this.server = null;
        this.connections = new Set();
        this.sessions = new Map();
        this.logs = [];
        this.nextSessionId = 1001;
        this.nextSubscriptionId = 2_147_483_648;
        this.startedAt = null;
        this.running = false;
        this.hostKey = null;
        this.fingerprint = '';
        this.state = this.createState();
    }

    createState() {
        const initial = createInitialConfig();
        return {
            datastores: {
                running: clone(initial),
                candidate: clone(initial),
                startup: clone(initial)
            },
            locks: {
                running: null,
                candidate: null,
                startup: null
            },
            revision: 1,
            rebootCount: 0,
            lastOperation: 'server initialized'
        };
    }

    reset() {
        this.state = this.createState();
        this.log('state-reset', { revision: this.state.revision });
        this.notify('mock device state reset');
        for (const session of this.sessions.values()) session.notifyYangPushChange('mock device state reset');
        return this.getStatus();
    }

    log(event, data = {}) {
        const record = { time: new Date().toISOString(), event, ...data };
        this.logs.push(record);
        if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
        this.emit('log', record);
        if (!this.options.quiet) {
            const details = Object.entries(data)
                .map(function (entry) {
                    return entry[0] + '=' + JSON.stringify(entry[1]);
                })
                .join(' ');
            process.stdout.write('[NETCONF Mock] ' + event + (details ? ' ' + details : '') + '\n');
        }
    }

    async start() {
        if (this.server) return this.getStatus();
        this.hostKey = fs.readFileSync(this.options.hostKeyPath);
        this.fingerprint = hostKeyFingerprint(this.hostKey);
        const server = new Server({ hostKeys: [this.hostKey] }, this.handleConnection.bind(this));
        this.server = server;
        server.on('error', this.handleServerError.bind(this));

        try {
            await new Promise(
                function (resolve, reject) {
                    const onError = function (error) {
                        server.removeListener('listening', onListening);
                        reject(error);
                    };
                    const onListening = function () {
                        server.removeListener('error', onError);
                        resolve();
                    };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    server.listen(this.options.port, this.options.host);
                }.bind(this)
            );
        } catch (error) {
            if (this.server === server) this.server = null;
            this.running = false;
            throw error;
        }
        const address = server.address();
        this.options.port = address.port;
        this.startedAt = new Date().toISOString();
        this.running = true;
        this.log('ready', {
            host: this.options.host,
            port: this.options.port,
            username: this.options.username,
            fingerprint: this.fingerprint
        });
        this.emit('ready', this.getStatus());
        return this.getStatus();
    }

    handleServerError(error) {
        this.log('server-error', { message: error.message, code: error.code || null });
        this.emit('server-error', error);
    }

    handleConnection(client, info) {
        this.connections.add(client);
        this.log('ssh-connection', {
            remoteAddress: info.ip,
            remotePort: info.port
        });
        client
            .on(
                'authentication',
                function (context) {
                    const accepted =
                        context.method === 'password' &&
                        context.username === this.options.username &&
                        context.password === this.options.password;
                    if (accepted) {
                        this.log('auth-success', { username: context.username, method: context.method });
                        context.accept();
                    } else {
                        this.log('auth-reject', { username: context.username || '', method: context.method });
                        context.reject(['password']);
                    }
                }.bind(this)
            )
            .on(
                'ready',
                function () {
                    client.on(
                        'session',
                        function (accept) {
                            const sshSession = accept();
                            sshSession.on(
                                'subsystem',
                                function (acceptSubsystem, rejectSubsystem, info) {
                                    if (info.name !== 'netconf') {
                                        rejectSubsystem();
                                        return;
                                    }
                                    const stream = acceptSubsystem();
                                    const sessionId = String(this.nextSessionId++);
                                    const session = new MockNetconfSession(this, client, stream, sessionId);
                                    this.sessions.set(sessionId, session);
                                    this.log('subsystem-open', { sessionId, name: info.name });
                                }.bind(this)
                            );
                            sshSession.on('shell', function (_acceptShell, rejectShell) {
                                rejectShell();
                            });
                            sshSession.on('exec', function (_acceptExec, rejectExec) {
                                rejectExec();
                            });
                        }.bind(this)
                    );
                }.bind(this)
            )
            .on(
                'error',
                function (error) {
                    this.log('ssh-error', { message: error.message });
                }.bind(this)
            )
            .on(
                'close',
                function () {
                    this.connections.delete(client);
                    for (const session of [...this.sessions.values()]) {
                        if (session.sshClient === client) session.close();
                    }
                    this.log('ssh-close', { connections: this.connections.size });
                }.bind(this)
            );
    }

    requireDatastore(name) {
        if (!Object.prototype.hasOwnProperty.call(this.state.datastores, name)) {
            throw new MockRpcError('unknown datastore: ' + name, 'invalid-value');
        }
        return this.state.datastores[name];
    }

    assertWritable(name, sessionId) {
        const holder = this.state.locks[name];
        if (holder && holder !== sessionId) {
            throw new MockRpcError('datastore is locked by session ' + holder, 'lock-denied', {
                info: '<session-id>' + escapeXml(holder) + '</session-id>'
            });
        }
    }

    changed(operation) {
        this.state.revision += 1;
        this.state.lastOperation = operation;
        this.log('state-change', { operation, revision: this.state.revision });
        this.notify(operation);
        for (const session of this.sessions.values()) session.notifyYangPushChange(operation);
    }

    notify(message) {
        for (const session of this.sessions.values()) session.sendNotification(message);
    }

    findDynamicSubscription(subscriptionId) {
        const id = String(subscriptionId);
        for (const session of this.sessions.values()) {
            if (session.dynamicSubscriptions.has(id))
                return { session, subscription: session.dynamicSubscriptions.get(id) };
        }
        return null;
    }

    notifySubscriptionState(subscriptionId, eventName, reason) {
        const found = this.findDynamicSubscription(subscriptionId);
        return found ? found.session.sendSubscriptionState(subscriptionId, eventName, reason) : false;
    }

    terminateSubscription(subscriptionId, reason = 'no-such-subscription') {
        const found = this.findDynamicSubscription(subscriptionId);
        return found ? found.session.terminateDynamicSubscription(subscriptionId, reason) : false;
    }

    subscriptionStateXml() {
        if (!STANDARD_SUBSCRIPTION_MODELS_AVAILABLE) return '';
        const subscriptions = [];
        for (const session of this.sessions.values()) {
            for (const subscription of session.dynamicSubscriptions.values()) {
                subscriptions.push(
                    '<subscription><id>' +
                        escapeXml(subscription.id) +
                        '</id>' +
                        session.renderDynamicSubscriptionPolicy(subscription) +
                        '<encoding>' +
                        escapeXml(subscription.encoding || 'encode-xml') +
                        '</encoding>' +
                        session.renderDynamicSubscriptionReceiver(subscription) +
                        '</subscription>'
                );
            }
        }
        return (
            '<streams xmlns="' +
            SUBSCRIBED_NOTIFICATIONS_NAMESPACE +
            '"><stream><name>NETCONF</name><description>NetNexus mock event stream</description>' +
            '</stream></streams>' +
            '<subscriptions xmlns="' +
            SUBSCRIBED_NOTIFICATIONS_NAMESPACE +
            '">' +
            subscriptions.join('') +
            '</subscriptions>'
        );
    }

    renderOperationalData(includeDiscovery = false) {
        let xml = this.renderDatastore('running', '', true) + this.subscriptionStateXml();
        if (includeDiscovery) {
            xml += this.yangLibraryXml();
            xml += this.modulesStateXml();
            xml += this.monitoringSchemasXml();
        }
        return xml;
    }

    renderDatastore(name, filterXml = '', includeOperational = false) {
        const config = this.requireDatastore(name);
        let xml = renderSystem(config.system) + renderInterfaces(config.interfaces, includeOperational);
        if (includeOperational) {
            const uptime = this.startedAt
                ? Math.max(0, Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000))
                : 0;
            xml +=
                '<state xmlns="' +
                MOCK_NAMESPACE +
                '"><uptime>' +
                uptime +
                '</uptime><session-count>' +
                this.sessions.size +
                '</session-count><datastore-revision>' +
                this.state.revision +
                '</datastore-revision><last-operation>' +
                escapeXml(this.state.lastOperation) +
                '</last-operation></state>';
        }
        return filterSubtreeXml(xml, filterXml, { keyDefinitions: MOCK_KEY_DEFINITIONS });
    }

    yangLibraryXml() {
        const moduleEntries = Object.values(MOCK_MODULES)
            .sort(
                (left, right) => Number(left.conformanceType === 'import') - Number(right.conformanceType === 'import')
            )
            .map(function (module) {
                const elementName = module.conformanceType === 'import' ? 'import-only-module' : 'module';
                const features = module.features
                    .map(feature => '<feature>' + escapeXml(feature) + '</feature>')
                    .join('');
                return (
                    '<' +
                    elementName +
                    '><name>' +
                    escapeXml(module.name) +
                    '</name><revision>' +
                    escapeXml(module.revision) +
                    '</revision><namespace>' +
                    escapeXml(module.namespace) +
                    '</namespace><location>NETCONF</location>' +
                    features +
                    '</' +
                    elementName +
                    '>'
                );
            })
            .join('');
        return (
            '<yang-library xmlns="' +
            YANG_LIBRARY_NAMESPACE +
            '" xmlns:ds="' +
            IETF_DATASTORES_NAMESPACE +
            '"><content-id>netnexus-mock-' +
            this.state.revision +
            '</content-id><module-set><name>netnexus-mock</name>' +
            moduleEntries +
            '</module-set><schema><name>netnexus-mock-schema</name><module-set>netnexus-mock</module-set></schema>' +
            '<datastore><name>ds:running</name><schema>netnexus-mock-schema</schema></datastore>' +
            '<datastore><name>ds:candidate</name><schema>netnexus-mock-schema</schema></datastore>' +
            '<datastore><name>ds:startup</name><schema>netnexus-mock-schema</schema></datastore>' +
            '</yang-library>'
        );
    }

    modulesStateXml() {
        return (
            '<modules-state xmlns="' +
            YANG_LIBRARY_NAMESPACE +
            '"><module-set-id>netnexus-mock-' +
            this.state.revision +
            '</module-set-id>' +
            Object.values(MOCK_MODULES)
                .map(function (module) {
                    const features = module.features
                        .map(feature => '<feature>' + escapeXml(feature) + '</feature>')
                        .join('');
                    return (
                        '<module><name>' +
                        module.name +
                        '</name><revision>' +
                        module.revision +
                        '</revision><schema>NETCONF</schema><namespace>' +
                        module.namespace +
                        '</namespace><conformance-type>' +
                        module.conformanceType +
                        '</conformance-type>' +
                        features +
                        '</module>'
                    );
                })
                .join('') +
            '</modules-state>'
        );
    }

    monitoringSchemasXml() {
        return (
            '<netconf-state xmlns="' +
            NETCONF_MONITORING_NAMESPACE +
            '"><schemas>' +
            Object.values(MOCK_MODULES)
                .map(function (module) {
                    return (
                        '<schema><identifier>' +
                        module.name +
                        '</identifier><version>' +
                        module.revision +
                        '</version><format>yang</format><namespace>' +
                        module.namespace +
                        '</namespace><location>NETCONF</location></schema>'
                    );
                })
                .join('') +
            '</schemas></netconf-state>'
        );
    }

    getStatus() {
        return {
            running: this.running,
            host: this.options.host,
            port: this.options.port,
            username: this.options.username,
            fingerprint: this.fingerprint,
            startedAt: this.startedAt,
            sessions: [...this.sessions.values()].map(function (session) {
                return session.publicState();
            }),
            revision: this.state.revision,
            locks: { ...this.state.locks },
            lastOperation: this.state.lastOperation
        };
    }

    async stop() {
        const server = this.server;
        if (!server) return;
        this.server = null;
        this.running = false;
        for (const session of [...this.sessions.values()]) session.close();
        for (const client of [...this.connections]) {
            try {
                client.end();
            } catch (_error) {
                // Connection may already be closed.
            }
        }
        this.connections.clear();
        await new Promise(function (resolve) {
            server.close(resolve);
        });
        this.startedAt = null;
        this.log('stopped');
        this.emit('stopped');
    }
}

function valueAfter(argv, index, name) {
    if (index + 1 >= argv.length) throw new Error(name + ' requires a value');
    return argv[index + 1];
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
    const options = {
        host: env.NETCONF_MOCK_HOST || DEFAULT_OPTIONS.host,
        port: env.NETCONF_MOCK_PORT || DEFAULT_OPTIONS.port,
        username: env.NETCONF_MOCK_USERNAME || DEFAULT_OPTIONS.username,
        password: env.NETCONF_MOCK_PASSWORD || DEFAULT_OPTIONS.password,
        hostKeyPath: env.NETCONF_MOCK_HOST_KEY || DEFAULT_OPTIONS.hostKeyPath,
        allowRemote: false,
        quiet: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--allow-remote') options.allowRemote = true;
        else if (argument === '--quiet') options.quiet = true;
        else if (argument === '--host') {
            options.host = valueAfter(argv, index, '--host');
            index += 1;
        } else if (argument.startsWith('--host=')) options.host = argument.slice(7);
        else if (argument === '--port') {
            options.port = valueAfter(argv, index, '--port');
            index += 1;
        } else if (argument.startsWith('--port=')) options.port = argument.slice(7);
        else if (argument === '--username') {
            options.username = valueAfter(argv, index, '--username');
            index += 1;
        } else if (argument.startsWith('--username=')) options.username = argument.slice(11);
        else if (argument === '--password') {
            options.password = valueAfter(argv, index, '--password');
            index += 1;
        } else if (argument.startsWith('--password=')) options.password = argument.slice(11);
        else if (argument === '--host-key') {
            options.hostKeyPath = valueAfter(argv, index, '--host-key');
            index += 1;
        } else if (argument.startsWith('--host-key=')) options.hostKeyPath = argument.slice(11);
        else throw new Error('Unknown argument: ' + argument);
    }
    if (options.help) return options;
    return normalizeOptions(options);
}

function printHelp() {
    process.stdout.write(
        [
            'NetNexus NETCONF-over-SSH mock server',
            '',
            'Usage:',
            '  npm run mock:netconf',
            '  npm run mock:netconf -- --port 18830 --username demo --password secret',
            '',
            'Options:',
            '  --host <address>     Listen address (default: 127.0.0.1)',
            '  --port <port>        Listen port (default: 8830; 0 selects a free port)',
            '  --username <name>    SSH username (default: netconf)',
            '  --password <value>   SSH password (default: netconf)',
            '  --host-key <path>    Stable SSH host private key',
            '  --allow-remote       Permit a non-loopback listen address',
            '  --quiet              Suppress protocol event logs',
            '  --help               Show this help',
            '',
            'Interactive commands:',
            '  /status',
            '  /show running|candidate|startup',
            '  /reset',
            '  /notify <message>',
            '  /subscriptions',
            '  /lifecycle started|modified|terminated <subscription-id> [reason]',
            '  /terminate <subscription-id> [reason]',
            '  /quit',
            ''
        ].join('\n')
    );
}

function printProfile(status, password) {
    process.stdout.write(
        [
            '',
            'Create a normal NETCONF Profile in NetNexus with:',
            '  Name:     Local NETCONF Mock',
            '  Host:     ' + status.host,
            '  Port:     ' + status.port,
            '  Username: ' + status.username,
            '  Password: ' + password,
            '  Host Key: ' + status.fingerprint + ' (or leave empty on first connection)',
            '',
            'Then use: Test connection -> Save -> Connect -> Read device list.',
            ''
        ].join('\n')
    );
}

function attachConsole(server) {
    if (!process.stdin || !process.stdin.isTTY) return;
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', function (chunk) {
        for (const line of String(chunk).split(/\r?\n/u)) {
            const command = line.trim();
            if (!command) continue;
            if (command === '/status') {
                process.stdout.write(JSON.stringify(server.getStatus(), null, 2) + '\n');
            } else if (/^\/show\s+/u.test(command)) {
                const datastore = command.slice('/show '.length).trim();
                try {
                    process.stdout.write(server.renderDatastore(datastore, '', true) + '\n');
                } catch (error) {
                    process.stderr.write(error.message + '\n');
                }
            } else if (command === '/reset') {
                process.stdout.write(JSON.stringify(server.reset(), null, 2) + '\n');
            } else if (/^\/notify(?:\s+|$)/u.test(command)) {
                server.notify(command.slice('/notify'.length).trim() || 'manual mock notification');
            } else if (command === '/subscriptions') {
                const subscriptions = server
                    .getStatus()
                    .sessions.flatMap(session => session.dynamicSubscriptions || []);
                process.stdout.write(JSON.stringify(subscriptions, null, 2) + '\n');
            } else if (/^\/lifecycle\s+/u.test(command)) {
                const [, state, subscriptionId, reason] = command.split(/\s+/u);
                const eventName = 'subscription-' + state;
                try {
                    if (!server.notifySubscriptionState(subscriptionId, eventName, reason)) {
                        process.stderr.write('Unknown subscription id: ' + subscriptionId + '\n');
                    }
                } catch (error) {
                    process.stderr.write(error.message + '\n');
                }
            } else if (/^\/terminate\s+/u.test(command)) {
                const [, subscriptionId, reason] = command.split(/\s+/u);
                if (!server.terminateSubscription(subscriptionId, reason || 'no-such-subscription')) {
                    process.stderr.write('Unknown subscription id: ' + subscriptionId + '\n');
                }
            } else if (command === '/quit' || command === '/exit') {
                server.stop().then(function () {
                    process.exit(0);
                });
            } else {
                process.stderr.write(
                    'Unknown command. Use /status, /show, /reset, /notify, /subscriptions, /lifecycle, /terminate or /quit.\n'
                );
            }
        }
    });
}

async function runCli() {
    const options = parseArgs();
    if (options.help) {
        printHelp();
        return;
    }
    const server = new MockNetconfServer(options);
    const status = await server.start();
    printProfile(status, options.password);
    attachConsole(server);
    let stopping = false;
    const stop = function () {
        if (stopping) return;
        stopping = true;
        server
            .stop()
            .catch(function (error) {
                process.stderr.write(error.stack || error.message || String(error));
                process.exitCode = 1;
            })
            .finally(function () {
                process.exit();
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

if (require.main === module) {
    runCli().catch(function (error) {
        process.stderr.write('Unable to start NETCONF mock: ' + (error.stack || error.message || String(error)) + '\n');
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_OPTIONS,
    MOCK_DEVICE_YANG,
    MOCK_INVALID_YANG,
    MOCK_TYPES_YANG,
    MOCK_MODULES,
    STANDARD_MOCK_MODULES,
    STANDARD_SUBSCRIPTION_MODELS_AVAILABLE,
    SERVER_CAPABILITIES,
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE,
    YANG_PATCH_NAMESPACE,
    MockRpcError,
    MockNetconfServer,
    createInitialConfig,
    applyConfigFragment,
    parseArgs,
    runCli
};
