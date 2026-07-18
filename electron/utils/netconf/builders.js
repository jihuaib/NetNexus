'use strict';

const { assertSafeXml } = require('./xml');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const BASE_CAPABILITY_PREFIX = 'urn:ietf:params:netconf:base:';
const NETCONF_NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const NETCONF_MONITORING_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const YANG_LIBRARY_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';
const WITH_DEFAULTS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults';

const DEFAULT_CLIENT_CAPABILITIES = Object.freeze([`${BASE_CAPABILITY_PREFIX}1.0`, `${BASE_CAPABILITY_PREFIX}1.1`]);

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
    return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function requireNonEmpty(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string`);
    }
    return value.trim();
}

function validateChoice(value, choices, name) {
    if (value !== undefined && value !== null && !choices.includes(value)) {
        throw new TypeError(`${name} must be one of: ${choices.join(', ')}`);
    }
}

function validateFragment(fragment, name = 'XML fragment') {
    const value = requireNonEmpty(fragment, name);
    assertSafeXml(value);
    return value;
}

function buildHello(capabilities = DEFAULT_CLIENT_CAPABILITIES) {
    if (!Array.isArray(capabilities)) {
        throw new TypeError('capabilities must be an array');
    }
    const normalized = [...new Set(capabilities.map(value => requireNonEmpty(value, 'capability')))];
    if (normalized.length === 0) {
        throw new TypeError('at least one NETCONF capability is required');
    }
    const capabilityXml = normalized.map(capability => `<capability>${escapeXml(capability)}</capability>`).join('');
    return `<hello xmlns="${BASE_NAMESPACE}"><capabilities>${capabilityXml}</capabilities></hello>`;
}

function buildRpc(operation, options = {}) {
    const normalizedOptions =
        typeof options === 'string' || typeof options === 'number' ? { messageId: String(options) } : options;
    if (!normalizedOptions || typeof normalizedOptions !== 'object') {
        throw new TypeError('RPC options must be an object or message-id');
    }
    if (normalizedOptions.messageId === undefined || normalizedOptions.messageId === null) {
        throw new TypeError('messageId is required');
    }
    const messageId = requireNonEmpty(String(normalizedOptions.messageId), 'messageId');
    const fragment = validateFragment(operation, 'operation');
    if (/^\s*<(?:[A-Za-z_][\w.-]*:)?rpc\b/i.test(fragment)) {
        throw new TypeError('operation must be an RPC operation fragment, not an <rpc> envelope');
    }
    return `<rpc xmlns="${BASE_NAMESPACE}" message-id="${escapeXmlAttribute(messageId)}">${fragment}</rpc>`;
}

function maybeWrap(fragment, options) {
    if (options && (options.wrap === true || options.messageId !== undefined)) {
        if (options.messageId === undefined || options.messageId === null) {
            throw new TypeError('messageId is required when wrap is enabled');
        }
        return buildRpc(fragment, { messageId: options.messageId });
    }
    return fragment;
}

function buildFilter(filter) {
    if (filter === undefined || filter === null || filter === '') {
        return '';
    }
    if (typeof filter === 'string') {
        const fragment = validateFragment(filter, 'filter');
        if (/^\s*<(?:[A-Za-z_][\w.-]*:)?filter\b/i.test(fragment)) {
            return fragment;
        }
        return `<filter type="subtree">${fragment}</filter>`;
    }
    if (typeof filter !== 'object' || Array.isArray(filter)) {
        throw new TypeError('filter must be an XML string or filter object');
    }

    const type = filter.type || 'subtree';
    validateChoice(type, ['subtree', 'xpath'], 'filter.type');
    if (type === 'xpath') {
        const select = requireNonEmpty(filter.select, 'filter.select');
        const namespaces = filter.namespaces || {};
        const namespaceAttributes = Object.entries(namespaces)
            .map(([prefix, namespace]) => {
                if (!/^[A-Za-z_][\w.-]*$/.test(prefix)) {
                    throw new TypeError(`invalid XPath namespace prefix: ${prefix}`);
                }
                return ` xmlns:${prefix}="${escapeXmlAttribute(requireNonEmpty(namespace, 'namespace'))}"`;
            })
            .join('');
        return `<filter type="xpath" select="${escapeXmlAttribute(select)}"${namespaceAttributes}/>`;
    }

    const content = filter.xml !== undefined ? filter.xml : filter.content;
    return `<filter type="subtree">${validateFragment(content, 'filter content')}</filter>`;
}

function buildWithDefaults(mode) {
    if (mode === undefined || mode === null || mode === '') {
        return '';
    }
    validateChoice(mode, ['report-all', 'report-all-tagged', 'trim', 'explicit'], 'withDefaults');
    return `<with-defaults xmlns="${WITH_DEFAULTS_NAMESPACE}">${mode}</with-defaults>`;
}

function buildDatastore(containerName, value, options = {}) {
    if (typeof value === 'string') {
        const datastore = requireNonEmpty(value, containerName);
        if (options.allowUrl && /^(?:https?|ftp|sftp|file):/i.test(datastore)) {
            return `<${containerName}><url>${escapeXml(datastore)}</url></${containerName}>`;
        }
        if (!/^[A-Za-z_][\w.-]*$/.test(datastore)) {
            throw new TypeError(`${containerName} datastore has an invalid name`);
        }
        return `<${containerName}><${datastore}/></${containerName}>`;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${containerName} must be a datastore name or object`);
    }
    if (value.url !== undefined) {
        if (!options.allowUrl) {
            throw new TypeError(`${containerName} does not support a URL here`);
        }
        return `<${containerName}><url>${escapeXml(requireNonEmpty(value.url, `${containerName}.url`))}</url></${containerName}>`;
    }
    if (value.config !== undefined) {
        if (!options.allowConfig) {
            throw new TypeError(`${containerName} does not support inline config here`);
        }
        const config = validateFragment(value.config, `${containerName}.config`);
        const wrapped = /^\s*<(?:[A-Za-z_][\w.-]*:)?config\b/i.test(config) ? config : `<config>${config}</config>`;
        return `<${containerName}>${wrapped}</${containerName}>`;
    }
    throw new TypeError(`${containerName} object must contain url or config`);
}

function buildGet(options = {}) {
    const fragment = `<get>${buildFilter(options.filter)}${buildWithDefaults(options.withDefaults)}</get>`;
    return maybeWrap(fragment, options);
}

function buildGetConfig(options = {}) {
    const source = options.source || 'running';
    const fragment = `<get-config>${buildDatastore('source', source, { allowUrl: true })}${buildFilter(
        options.filter
    )}${buildWithDefaults(options.withDefaults)}</get-config>`;
    return maybeWrap(fragment, options);
}

function normalizeConfig(config) {
    const value = validateFragment(config, 'config');
    return /^\s*<(?:[A-Za-z_][\w.-]*:)?config\b/i.test(value) ? value : `<config>${value}</config>`;
}

function buildEditConfig(options = {}) {
    validateChoice(options.defaultOperation, ['merge', 'replace', 'none'], 'defaultOperation');
    validateChoice(options.testOption, ['test-then-set', 'set', 'test-only'], 'testOption');
    validateChoice(options.errorOption, ['stop-on-error', 'continue-on-error', 'rollback-on-error'], 'errorOption');
    const controls = [
        options.defaultOperation ? `<default-operation>${options.defaultOperation}</default-operation>` : '',
        options.testOption ? `<test-option>${options.testOption}</test-option>` : '',
        options.errorOption ? `<error-option>${options.errorOption}</error-option>` : ''
    ].join('');
    const fragment = `<edit-config>${buildDatastore('target', options.target || 'running')}${controls}${normalizeConfig(
        options.config
    )}</edit-config>`;
    return maybeWrap(fragment, options);
}

function buildCopyConfig(options = {}) {
    const fragment = `<copy-config>${buildDatastore('target', options.target || 'running', {
        allowUrl: true
    })}${buildDatastore('source', options.source || 'running', {
        allowUrl: true,
        allowConfig: true
    })}</copy-config>`;
    return maybeWrap(fragment, options);
}

function buildDeleteConfig(options = {}) {
    const fragment = `<delete-config>${buildDatastore('target', options.target || 'startup', {
        allowUrl: true
    })}</delete-config>`;
    return maybeWrap(fragment, options);
}

function buildLock(options = {}) {
    return maybeWrap(`<lock>${buildDatastore('target', options.target || 'running')}</lock>`, options);
}

function buildUnlock(options = {}) {
    return maybeWrap(`<unlock>${buildDatastore('target', options.target || 'running')}</unlock>`, options);
}

function buildValidate(options = {}) {
    const source = options.source === undefined ? 'candidate' : options.source;
    return maybeWrap(
        `<validate>${buildDatastore('source', source, { allowUrl: true, allowConfig: true })}</validate>`,
        options
    );
}

function buildCommit(options = {}) {
    let content = '';
    if (options.confirmed) {
        content += '<confirmed/>';
    }
    if (options.confirmTimeout !== undefined && options.confirmTimeout !== null) {
        const timeout = Number(options.confirmTimeout);
        if (!Number.isSafeInteger(timeout) || timeout <= 0) {
            throw new TypeError('confirmTimeout must be a positive integer');
        }
        content += `<confirm-timeout>${timeout}</confirm-timeout>`;
    }
    if (options.persist !== undefined && options.persist !== null) {
        content += `<persist>${escapeXml(options.persist)}</persist>`;
    }
    if (options.persistId !== undefined && options.persistId !== null) {
        content += `<persist-id>${escapeXml(options.persistId)}</persist-id>`;
    }
    return maybeWrap(`<commit>${content}</commit>`, options);
}

function buildCancelCommit(options = {}) {
    const persistId =
        options.persistId === undefined || options.persistId === null
            ? ''
            : `<persist-id>${escapeXml(options.persistId)}</persist-id>`;
    return maybeWrap(`<cancel-commit>${persistId}</cancel-commit>`, options);
}

function buildDiscardChanges(options = {}) {
    return maybeWrap('<discard-changes/>', options);
}

function buildCloseSession(options = {}) {
    return maybeWrap('<close-session/>', options);
}

function buildKillSession(sessionId, options = {}) {
    if (sessionId === undefined || sessionId === null) {
        throw new TypeError('sessionId is required');
    }
    const normalizedSessionId = requireNonEmpty(String(sessionId), 'sessionId');
    return maybeWrap(
        `<kill-session><session-id>${escapeXml(normalizedSessionId)}</session-id></kill-session>`,
        options
    );
}

function buildGetSchema(identifierOrOptions, maybeOptions = {}) {
    const options =
        identifierOrOptions && typeof identifierOrOptions === 'object'
            ? identifierOrOptions
            : { ...maybeOptions, identifier: identifierOrOptions };
    const identifier = requireNonEmpty(options.identifier, 'identifier');
    const version = options.version || options.revision;
    const format = options.format || 'yang';
    const content = [
        `<identifier>${escapeXml(identifier)}</identifier>`,
        version ? `<version>${escapeXml(version)}</version>` : '',
        format ? `<format>${escapeXml(format)}</format>` : ''
    ].join('');
    const fragment = `<get-schema xmlns="${NETCONF_MONITORING_NAMESPACE}">${content}</get-schema>`;
    return maybeWrap(fragment, options);
}

function buildCreateSubscription(options = {}) {
    const stream = options.stream ? `<stream>${escapeXml(options.stream)}</stream>` : '';
    const filter = buildFilter(options.filter);
    const startTime = options.startTime ? `<startTime>${escapeXml(options.startTime)}</startTime>` : '';
    const stopTime = options.stopTime ? `<stopTime>${escapeXml(options.stopTime)}</stopTime>` : '';
    const fragment = `<create-subscription xmlns="${NETCONF_NOTIFICATION_NAMESPACE}">${stream}${filter}${startTime}${stopTime}</create-subscription>`;
    return maybeWrap(fragment, options);
}

function buildYangLibraryFilter() {
    return `<yang-library xmlns="${YANG_LIBRARY_NAMESPACE}"/>`;
}

function buildModulesStateFilter() {
    return `<modules-state xmlns="${YANG_LIBRARY_NAMESPACE}"/>`;
}

function buildNetconfSchemasFilter() {
    return `<netconf-state xmlns="${NETCONF_MONITORING_NAMESPACE}"><schemas/></netconf-state>`;
}

module.exports = {
    BASE_NAMESPACE,
    BASE_CAPABILITY_PREFIX,
    NETCONF_NOTIFICATION_NAMESPACE,
    NETCONF_MONITORING_NAMESPACE,
    YANG_LIBRARY_NAMESPACE,
    WITH_DEFAULTS_NAMESPACE,
    DEFAULT_CLIENT_CAPABILITIES,
    escapeXml,
    escapeXmlAttribute,
    buildHello,
    buildRpc,
    buildFilter,
    buildGet,
    buildGetConfig,
    buildEditConfig,
    buildCopyConfig,
    buildDeleteConfig,
    buildLock,
    buildUnlock,
    buildValidate,
    buildCommit,
    buildCancelCommit,
    buildDiscardChanges,
    buildCloseSession,
    buildKillSession,
    buildGetSchema,
    buildCreateSubscription,
    buildYangLibraryFilter,
    buildModulesStateFilter,
    buildNetconfSchemasFilter
};
