'use strict';

const { assertSafeXml } = require('./xml');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const BASE_CAPABILITY_PREFIX = 'urn:ietf:params:netconf:base:';
const NETCONF_NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const SUBSCRIBED_NOTIFICATIONS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
const YANG_PUSH_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';
const DATASTORES_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
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

function optionalTextElement(name, value, options = {}) {
    if (value === undefined || value === null || value === '') return '';
    const tag = options.prefix ? `${options.prefix}:${name}` : name;
    return `<${tag}>${escapeXml(value)}</${tag}>`;
}

function uintValue(value, name, maximum = 0xffffffff) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
        throw new TypeError(`${name} must be an integer between 0 and ${maximum}`);
    }
    return normalized;
}

function buildNamespaceAttributes(namespaces = {}) {
    if (!namespaces || typeof namespaces !== 'object' || Array.isArray(namespaces)) {
        throw new TypeError('namespaces must be an object');
    }
    return Object.entries(namespaces)
        .map(([prefix, namespace]) => {
            if (prefix === '') {
                return ` xmlns="${escapeXmlAttribute(requireNonEmpty(namespace, 'namespace'))}"`;
            }
            if (!/^[A-Za-z_][\w.-]*$/.test(prefix) || ['xml', 'xmlns'].includes(prefix)) {
                throw new TypeError(`invalid namespace prefix: ${prefix}`);
            }
            return ` xmlns:${prefix}="${escapeXmlAttribute(requireNonEmpty(namespace, 'namespace'))}"`;
        })
        .join('');
}

function mergeNamespaceMaps(...sources) {
    const merged = {};
    for (const source of sources) {
        if (source === undefined || source === null) continue;
        if (typeof source !== 'object' || Array.isArray(source)) {
            throw new TypeError('namespaces must be an object');
        }
        for (const [prefix, namespace] of Object.entries(source)) {
            const normalizedNamespace = requireNonEmpty(namespace, 'namespace');
            if (Object.prototype.hasOwnProperty.call(merged, prefix) && merged[prefix] !== normalizedNamespace) {
                throw new TypeError(`namespace prefix ${prefix} has conflicting mappings`);
            }
            merged[prefix] = normalizedNamespace;
        }
    }
    return merged;
}

function normalizedIdentityref(value, namespaceMap, options = {}) {
    const normalized = requireNonEmpty(value, options.name || 'identityref');
    if (!/^(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$/.test(normalized)) {
        throw new TypeError(`${options.name || 'identityref'} must be an identityref QName`);
    }
    const separator = normalized.indexOf(':');
    if (separator < 0) {
        return {
            value: options.unprefixedPrefix ? `${options.unprefixedPrefix}:${normalized}` : normalized,
            namespaces: {}
        };
    }
    const sourcePrefix = normalized.slice(0, separator);
    const identity = normalized.slice(separator + 1);
    const namespaces = mergeNamespaceMaps(namespaceMap);
    const hasBinding = Object.prototype.hasOwnProperty.call(namespaces, sourcePrefix);
    const namespace = hasBinding ? namespaces[sourcePrefix] : null;
    if ((options.knownPrefixes || []).includes(sourcePrefix) && (!hasBinding || namespace === options.knownNamespace)) {
        return {
            value: options.knownOutputPrefix ? `${options.knownOutputPrefix}:${identity}` : identity,
            namespaces: {}
        };
    }
    if (!hasBinding) {
        throw new TypeError(`${options.name || 'identityref'} prefix ${sourcePrefix} has no namespace mapping`);
    }
    if (namespace === options.knownNamespace) {
        return {
            value: options.knownOutputPrefix ? `${options.knownOutputPrefix}:${identity}` : identity,
            namespaces: {}
        };
    }
    let outputPrefix = sourcePrefix;
    if ((options.reservedPrefixes || []).includes(outputPrefix)) {
        const fallbackStem = options.fallbackPrefix || 'identity';
        outputPrefix = fallbackStem;
        let sequence = 2;
        while (
            Object.prototype.hasOwnProperty.call(namespaces, outputPrefix) &&
            namespaces[outputPrefix] !== namespace
        ) {
            outputPrefix = `${fallbackStem}${sequence++}`;
        }
    }
    return { value: `${outputPrefix}:${identity}`, namespaces: { [outputPrefix]: namespace } };
}

function normalizedDatastoreIdentity(value, options = {}) {
    const normalizedValue = String(value || 'operational');
    const datastorePrefix = String(options.datastorePrefix || 'ds');
    const qualifiedValue =
        !normalizedValue.includes(':') && datastorePrefix !== 'ds'
            ? `${datastorePrefix}:${normalizedValue}`
            : normalizedValue;
    return normalizedIdentityref(qualifiedValue, options.datastoreNamespaces, {
        name: 'datastore',
        knownNamespace: DATASTORES_NAMESPACE,
        knownPrefixes: ['ds', 'ietf-datastores'],
        knownOutputPrefix: 'ds',
        unprefixedPrefix: 'ds',
        reservedPrefixes: ['xml', 'xmlns', 'yp', 'ds'],
        fallbackPrefix: 'datastore'
    });
}

function normalizedEncodingIdentity(value, options = {}) {
    const normalized = normalizedIdentityref(value, options.encodingNamespaces, {
        name: 'encoding',
        knownNamespace: SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        knownPrefixes: ['sn', 'ietf-subscribed-notifications'],
        knownOutputPrefix: '',
        reservedPrefixes: ['xml', 'xmlns', 'yp', 'ds'],
        fallbackPrefix: 'encoding'
    });
    if (!normalized.value.includes(':') && !['encode-xml', 'encode-json'].includes(normalized.value)) {
        throw new TypeError(`ietf-subscribed-notifications does not define encoding identity ${normalized.value}`);
    }
    return normalized;
}

function customEnvelopeNamespaces(options = {}, yangPush = false) {
    const datastoreIdentity = yangPush
        ? normalizedDatastoreIdentity(options.datastore || 'operational', options)
        : { namespaces: {} };
    const encodingIdentity =
        options.encoding === undefined || options.encoding === null || options.encoding === ''
            ? { namespaces: {} }
            : normalizedEncodingIdentity(options.encoding, options);
    return mergeNamespaceMaps(datastoreIdentity.namespaces, encodingIdentity.namespaces);
}

function normalizeSubscriptionFilter(filter, fallbackType = 'subtree') {
    if (filter === undefined || filter === null || filter === '') return null;
    if (typeof filter === 'string') return { type: fallbackType, content: filter };
    if (typeof filter !== 'object' || Array.isArray(filter)) {
        throw new TypeError('subscription filter must be an XML string or filter object');
    }
    return filter;
}

function buildModernFilter(filter, options = {}) {
    const normalized = normalizeSubscriptionFilter(filter, options.fallbackType || 'subtree');
    if (!normalized) return '';
    const namespaces = { ...(normalized.namespaces || {}) };
    let elementPrefix = options.prefix || '';
    const elementNamespace =
        options.namespace || (elementPrefix ? YANG_PUSH_NAMESPACE : SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    if (!elementPrefix && namespaces[''] && namespaces[''] !== elementNamespace) {
        let fallbackPrefix = 'nsn';
        let sequence = 2;
        while (namespaces[fallbackPrefix]) fallbackPrefix = `nsn${sequence++}`;
        namespaces[fallbackPrefix] = elementNamespace;
        elementPrefix = fallbackPrefix;
    }
    if (elementPrefix && namespaces[elementPrefix] && namespaces[elementPrefix] !== elementNamespace) {
        const fallbackStem = options.prefix ? 'nyp' : 'nsn';
        let fallbackPrefix = fallbackStem;
        let sequence = 2;
        while (namespaces[fallbackPrefix]) fallbackPrefix = `${fallbackStem}${sequence++}`;
        namespaces[fallbackPrefix] = elementNamespace;
        elementPrefix = fallbackPrefix;
    }
    const prefix = elementPrefix ? `${elementPrefix}:` : '';
    const namespaceAttributes = buildNamespaceAttributes(namespaces);
    const type = normalized.type || options.fallbackType || 'subtree';
    validateChoice(type, ['subtree', 'xpath', 'reference'], 'filter.type');
    if (type === 'reference') {
        return `<${prefix}${options.referenceName}>${escapeXml(
            requireNonEmpty(normalized.name || normalized.value, 'filter reference')
        )}</${prefix}${options.referenceName}>`;
    }
    if (type === 'xpath') {
        const select = requireNonEmpty(normalized.select || normalized.expression || normalized.value, 'filter.select');
        return `<${prefix}${options.xpathName}${namespaceAttributes}>${escapeXml(select)}</${prefix}${
            options.xpathName
        }>`;
    }
    const content = normalized.xml !== undefined ? normalized.xml : normalized.content;
    if (normalized.empty === true && (content === undefined || content === null || content === '')) {
        return `<${prefix}${options.subtreeName}${namespaceAttributes}/>`;
    }
    return `<${prefix}${options.subtreeName}${namespaceAttributes}>${validateFragment(
        content,
        'filter content'
    )}</${prefix}${options.subtreeName}>`;
}

function buildStreamTarget(options = {}, requireStream = true) {
    const reference = options.streamFilterName || options.filterName;
    const filter = reference
        ? buildModernFilter(
              { type: 'reference', name: reference },
              {
                  referenceName: 'stream-filter-name',
                  xpathName: 'stream-xpath-filter',
                  subtreeName: 'stream-subtree-filter'
              }
          )
        : buildModernFilter(options.streamFilter ?? options.filter, {
              referenceName: 'stream-filter-name',
              xpathName: 'stream-xpath-filter',
              subtreeName: 'stream-subtree-filter'
          });
    const streamValue = options.stream;
    const stream =
        streamValue === undefined || streamValue === null || streamValue === ''
            ? requireStream
                ? '<stream>NETCONF</stream>'
                : ''
            : `<stream>${escapeXml(streamValue)}</stream>`;
    return `${filter}${stream}${optionalTextElement('replay-start-time', options.replayStartTime)}`;
}

function datastoreIdentity(value, options = {}) {
    return normalizedDatastoreIdentity(value, options).value;
}

function encodingIdentity(value, options = {}) {
    return normalizedEncodingIdentity(value, options).value;
}

function buildDatastoreTarget(options = {}, requireDatastore = true) {
    const reference = options.selectionFilterRef || options.datastoreFilterName || options.filterName;
    const filter = reference
        ? buildModernFilter(
              { type: 'reference', name: reference },
              {
                  prefix: 'yp',
                  referenceName: 'selection-filter-ref',
                  xpathName: 'datastore-xpath-filter',
                  subtreeName: 'datastore-subtree-filter'
              }
          )
        : buildModernFilter(options.datastoreFilter ?? options.filter, {
              prefix: 'yp',
              referenceName: 'selection-filter-ref',
              xpathName: 'datastore-xpath-filter',
              subtreeName: 'datastore-subtree-filter'
          });
    const datastore =
        options.datastore === undefined || options.datastore === null || options.datastore === ''
            ? requireDatastore
                ? `<yp:datastore>${datastoreIdentity('operational', options)}</yp:datastore>`
                : ''
            : `<yp:datastore>${escapeXml(datastoreIdentity(options.datastore, options))}</yp:datastore>`;
    return `${datastore}${filter}`;
}

function normalizedUpdateTrigger(options = {}) {
    const value = String(options.updateTrigger || options.trigger || options.mode || '').trim();
    if (!value) return '';
    if (['periodic'].includes(value)) return 'periodic';
    if (['on-change', 'onChange', 'on_change'].includes(value)) return 'on-change';
    throw new TypeError('updateTrigger must be periodic or on-change');
}

function buildUpdatePolicy(options = {}, required = false, modifiable = false) {
    if (modifiable && options.syncOnStart !== undefined && options.syncOnStart !== null) {
        throw new TypeError('syncOnStart cannot be modified after a subscription is established');
    }
    if (modifiable && options.excludedChanges !== undefined && options.excludedChanges !== null) {
        throw new TypeError('excludedChanges cannot be modified after a subscription is established');
    }
    if (modifiable && options.excludedChange !== undefined && options.excludedChange !== null) {
        throw new TypeError('excludedChange cannot be modified after a subscription is established');
    }
    const trigger = normalizedUpdateTrigger(options);
    if (!trigger) {
        for (const field of [
            'period',
            'anchorTime',
            'dampeningPeriod',
            'syncOnStart',
            'excludedChanges',
            'excludedChange'
        ]) {
            if (options[field] !== undefined && options[field] !== null && options[field] !== '') {
                throw new TypeError(`updateTrigger is required when ${field} is provided`);
            }
        }
        if (required) throw new TypeError('updateTrigger is required for a datastore subscription');
        return '';
    }
    if (trigger === 'periodic') {
        if (
            options.dampeningPeriod !== undefined &&
            options.dampeningPeriod !== null &&
            options.dampeningPeriod !== ''
        ) {
            throw new TypeError('dampeningPeriod is only valid for an on-change subscription');
        }
        if (
            !modifiable &&
            (options.syncOnStart !== undefined ||
                options.excludedChanges !== undefined ||
                options.excludedChange !== undefined)
        ) {
            throw new TypeError('syncOnStart and excludedChanges are only valid for an on-change subscription');
        }
        if (options.period === undefined || options.period === null || options.period === '') {
            throw new TypeError('period is required for a periodic subscription');
        }
        const period = uintValue(options.period, 'period');
        const anchor = optionalTextElement('anchor-time', options.anchorTime, { prefix: 'yp' });
        return `<yp:periodic><yp:period>${period}</yp:period>${anchor}</yp:periodic>`;
    }
    if (options.period !== undefined && options.period !== null && options.period !== '') {
        throw new TypeError('period is only valid for a periodic subscription');
    }
    if (options.anchorTime !== undefined && options.anchorTime !== null && options.anchorTime !== '') {
        throw new TypeError('anchorTime is only valid for a periodic subscription');
    }
    const dampening =
        options.dampeningPeriod === undefined || options.dampeningPeriod === null || options.dampeningPeriod === ''
            ? ''
            : `<yp:dampening-period>${uintValue(options.dampeningPeriod, 'dampeningPeriod')}</yp:dampening-period>`;
    let syncOnStart = '';
    if (!modifiable && options.syncOnStart !== undefined && options.syncOnStart !== null) {
        if (typeof options.syncOnStart !== 'boolean') throw new TypeError('syncOnStart must be a boolean');
        syncOnStart = `<yp:sync-on-start>${options.syncOnStart}</yp:sync-on-start>`;
    }
    const excludedChanges = options.excludedChanges || options.excludedChange || [];
    const normalizedExcluded = Array.isArray(excludedChanges) ? excludedChanges : [excludedChanges];
    const excluded = normalizedExcluded
        .filter(value => value !== undefined && value !== null && value !== '')
        .map(value => {
            validateChoice(value, ['create', 'delete', 'insert', 'move', 'replace'], 'excludedChange');
            return `<yp:excluded-change>${value}</yp:excluded-change>`;
        })
        .join('');
    return `<yp:on-change>${dampening}${syncOnStart}${excluded}</yp:on-change>`;
}

function buildSubscriptionQos(options = {}) {
    const parts = [];
    if (options.stopTime !== undefined && options.stopTime !== null && options.stopTime !== '') {
        parts.push(optionalTextElement('stop-time', options.stopTime));
    }
    if (options.dscp !== undefined && options.dscp !== null && options.dscp !== '') {
        parts.push(`<dscp>${uintValue(options.dscp, 'dscp', 63)}</dscp>`);
    }
    if (options.weighting !== undefined && options.weighting !== null && options.weighting !== '') {
        parts.push(`<weighting>${uintValue(options.weighting, 'weighting', 255)}</weighting>`);
    }
    if (options.dependency !== undefined && options.dependency !== null && options.dependency !== '') {
        parts.push(`<dependency>${uintValue(options.dependency, 'dependency')}</dependency>`);
    }
    if (options.encoding !== undefined && options.encoding !== null && options.encoding !== '') {
        parts.push(optionalTextElement('encoding', encodingIdentity(options.encoding, options)));
    }
    return parts.join('');
}

function isDatastoreSubscription(options = {}) {
    return Boolean(
        options.targetType === 'datastore' ||
        ['yang-push', 'rfc8641'].includes(options.subscriptionType) ||
        options.datastore ||
        options.datastoreFilter ||
        options.datastoreFilterName ||
        options.selectionFilterRef ||
        options.updateTrigger ||
        options.trigger ||
        options.mode ||
        options.period !== undefined ||
        options.dampeningPeriod !== undefined
    );
}

function modernSubscriptionEnvelope(operationName, content, options = {}) {
    const yangPush = options.yangPush || isDatastoreSubscription(options);
    const customNamespaces = customEnvelopeNamespaces(options, yangPush);
    const namespaces = yangPush
        ? ` xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${DATASTORES_NAMESPACE}"${buildNamespaceAttributes(
              customNamespaces
          )}`
        : buildNamespaceAttributes(customNamespaces);
    return maybeWrap(
        `<${operationName} xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"${namespaces}>${content}</${operationName}>`,
        options
    );
}

function buildEstablishSubscription(options = {}) {
    const yangPush = isDatastoreSubscription(options);
    const target = yangPush ? buildDatastoreTarget(options, true) : buildStreamTarget(options, true);
    const updatePolicy = yangPush ? buildUpdatePolicy(options, false) : '';
    return modernSubscriptionEnvelope(
        'establish-subscription',
        `${target}${buildSubscriptionQos(options)}${updatePolicy}`,
        {
            ...options,
            yangPush
        }
    );
}

function buildModifySubscription(options = {}) {
    const subscriptionId = uintValue(options.id ?? options.publisherSubscriptionId ?? options.subscriptionId, 'id');
    const yangPush = isDatastoreSubscription(options);
    for (const field of ['replayStartTime', 'dscp', 'weighting', 'dependency', 'encoding']) {
        if (options[field] !== undefined && options[field] !== null && options[field] !== '') {
            throw new TypeError(`${field} cannot be modified after a subscription is established`);
        }
    }
    if (!yangPush && options.stream !== undefined && options.stream !== null && options.stream !== '') {
        throw new TypeError('stream cannot be modified after a subscription is established');
    }
    let target;
    if (yangPush) {
        if (!options.datastore) throw new TypeError('datastore is required when modifying a YANG-Push subscription');
        target = buildDatastoreTarget(options, true);
    } else {
        const reference = options.streamFilterName || options.filterName;
        const filter = reference ? { type: 'reference', name: reference } : (options.streamFilter ?? options.filter);
        if (!filter) {
            throw new TypeError('streamFilter or streamFilterName is required when modifying an event subscription');
        }
        target = buildModernFilter(filter, {
            referenceName: 'stream-filter-name',
            xpathName: 'stream-xpath-filter',
            subtreeName: 'stream-subtree-filter'
        });
    }
    const updatePolicy = yangPush ? buildUpdatePolicy(options, false, true) : '';
    const stopTime = optionalTextElement('stop-time', options.stopTime);
    return modernSubscriptionEnvelope(
        'modify-subscription',
        `<id>${subscriptionId}</id>${target}${stopTime}${updatePolicy}`,
        { ...options, yangPush }
    );
}

function buildSubscriptionIdRpc(operationName, id, namespace, options = {}) {
    const subscriptionId = uintValue(id, 'id');
    return maybeWrap(`<${operationName} xmlns="${namespace}"><id>${subscriptionId}</id></${operationName}>`, options);
}

function buildDeleteSubscription(idOrOptions, maybeOptions = {}) {
    const options = idOrOptions && typeof idOrOptions === 'object' ? idOrOptions : { ...maybeOptions, id: idOrOptions };
    return buildSubscriptionIdRpc(
        'delete-subscription',
        options.id ?? options.publisherSubscriptionId ?? options.subscriptionId,
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        options
    );
}

function buildKillSubscription(idOrOptions, maybeOptions = {}) {
    const options = idOrOptions && typeof idOrOptions === 'object' ? idOrOptions : { ...maybeOptions, id: idOrOptions };
    return buildSubscriptionIdRpc(
        'kill-subscription',
        options.id ?? options.publisherSubscriptionId ?? options.subscriptionId,
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        options
    );
}

function buildResyncSubscription(idOrOptions, maybeOptions = {}) {
    const options = idOrOptions && typeof idOrOptions === 'object' ? idOrOptions : { ...maybeOptions, id: idOrOptions };
    return buildSubscriptionIdRpc(
        'resync-subscription',
        options.id ?? options.publisherSubscriptionId ?? options.subscriptionId,
        YANG_PUSH_NAMESPACE,
        options
    );
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
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE,
    DATASTORES_NAMESPACE,
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
    buildEstablishSubscription,
    buildModifySubscription,
    buildDeleteSubscription,
    buildKillSubscription,
    buildResyncSubscription,
    buildYangLibraryFilter,
    buildModulesStateFilter,
    buildNetconfSchemasFilter
};
