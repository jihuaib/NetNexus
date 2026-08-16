'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { XMLBuilder, XMLParser } = require('fast-xml-parser');
const { getParentMessageEndpoint } = require('../core/parentMessageEndpoint');
const {
    NetconfClient,
    NetconfRpcCancelledError,
    calculateFingerprints,
    createHostVerifier,
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
    buildKillSession,
    buildCreateSubscription,
    buildEstablishSubscription,
    buildModifySubscription,
    buildDeleteSubscription,
    buildKillSubscription,
    buildResyncSubscription,
    BASE_NAMESPACE,
    NETCONF_NOTIFICATION_NAMESPACE,
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE,
    DATASTORES_NAMESPACE,
    assertSafeXml,
    parseXml,
    findRoot,
    childValues,
    childText,
    getAttribute,
    decodeXmlText,
    extractRpcMessageId,
    rpcReplyDataToConfig
} = require('../../utils/netconf');
const { parseYang } = require('../../utils/yang');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES, NETCONF_CAPABILITIES, NETCONF_LIMITS } = require('../../const/yangConst');

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const MAX_RECONNECT_DELAY = 30000;
const MAX_TIMER_DELAY = 0x7fffffff;
const MAX_SUBSCRIPTION_HISTORY_PER_PROFILE = 256;
const MAX_SUBSCRIPTION_HISTORY_BYTES_PER_PROFILE = 16 * 1024 * 1024;
const parentEndpoint = getParentMessageEndpoint();
const SUBSCRIBED_NOTIFICATION_STATE_EVENTS = new Set([
    'replay-completed',
    'subscription-completed',
    'subscription-modified',
    'subscription-resumed',
    'subscription-started',
    'subscription-suspended',
    'subscription-terminated'
]);
const YANG_PUSH_NOTIFICATION_EVENTS = new Set(['push-update', 'push-change-update']);
const OWNER_ONLY_SUBSCRIPTION_OPERATIONS = new Set([
    'modify-subscription',
    'delete-subscription',
    'resync-subscription'
]);
const orderedXmlParser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    commentPropName: '#comment',
    cdataPropName: '#cdata'
});
const orderedXmlBuilder = new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    commentPropName: '#comment',
    cdataPropName: '#cdata',
    format: false
});

function orderedElement(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const name = Object.keys(item).find(key => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'));
    if (!name) return null;
    return {
        name,
        children: Array.isArray(item[name]) ? item[name] : [],
        attributes: item[':@'] && typeof item[':@'] === 'object' ? item[':@'] : {}
    };
}

function extendNamespaces(parentNamespaces, attributes) {
    const namespaces = new Map(parentNamespaces || []);
    for (const [name, value] of Object.entries(attributes || {})) {
        if (name === '@_xmlns') namespaces.set('', String(value));
        else if (name.startsWith('@_xmlns:')) namespaces.set(name.slice('@_xmlns:'.length), String(value));
    }
    return namespaces;
}

function resolveOrderedElement(element, parentNamespaces = null) {
    if (!element) return null;
    const namespaces = extendNamespaces(parentNamespaces, element.attributes);
    const separator = element.name.indexOf(':');
    const prefix = separator < 0 ? '' : element.name.slice(0, separator);
    return {
        ...element,
        localName: separator < 0 ? element.name : element.name.slice(separator + 1),
        namespace: namespaces.get(prefix) || '',
        namespaces
    };
}

function orderedChildDescriptors(parent, localNameValue, namespace) {
    const matches = [];
    for (const item of parent?.children || []) {
        const descriptor = resolveOrderedElement(orderedElement(item), parent.namespaces);
        if (descriptor?.localName === localNameValue && descriptor.namespace === namespace) matches.push(descriptor);
    }
    return matches;
}

function orderedChildDescriptor(parent, localNameValue, namespace) {
    return orderedChildDescriptors(parent, localNameValue, namespace)[0] || null;
}

function orderedTextContent(items, cdata = false) {
    const parts = [];
    for (const item of items || []) {
        if (!item || typeof item !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(item, '#text')) {
            const value = String(item['#text'] ?? '');
            parts.push(cdata ? value : decodeXmlText(value));
        }
        if (Object.prototype.hasOwnProperty.call(item, '#cdata')) {
            parts.push(orderedTextContent(item['#cdata'], true));
        }
    }
    return parts.join('').trim();
}

function orderedDescriptorText(descriptor) {
    return descriptor ? orderedTextContent(descriptor.children) : null;
}

function orderedChildText(parent, localNameValue, namespace) {
    return orderedDescriptorText(orderedChildDescriptor(parent, localNameValue, namespace));
}

function orderedChildTexts(parent, localNameValue, namespace) {
    return orderedChildDescriptors(parent, localNameValue, namespace)
        .map(orderedDescriptorText)
        .filter(value => value !== null && value !== '');
}

function orderedNamespaceObject(descriptor) {
    return Object.fromEntries(
        [...(descriptor?.namespaces || new Map()).entries()].filter(
            ([prefix]) => prefix !== 'xml' && prefix !== 'xmlns'
        )
    );
}

function rawValueError(name, expected) {
    const error = new Error(`${name} must be ${expected}`);
    error.code = 'NETCONF_INVALID_SUBSCRIPTION_RPC';
    return error;
}

function normalizeRawUint(value, name, maximum = 0xffffffff) {
    if (value === null || value === undefined || value === '') return null;
    const normalized = String(value).trim();
    if (!/^\d+$/u.test(normalized)) throw rawValueError(name, `an integer between 0 and ${maximum}`);
    const numeric = Number(normalized);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) {
        throw rawValueError(name, `an integer between 0 and ${maximum}`);
    }
    return numeric;
}

function normalizeRawBoolean(value, name) {
    if (value === null || value === undefined || value === '') return null;
    const normalized = String(value).trim();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw rawValueError(name, 'a boolean');
}

function normalizeIdentityrefFromDescriptor(value, descriptor, knownNamespace, options = {}) {
    if (value === null || value === undefined || value === '') return { value: null, namespaces: {} };
    const normalized = String(value).trim();
    if (!/^(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$/u.test(normalized)) {
        throw rawValueError(options.name || 'identityref', 'a QName identityref');
    }
    const separator = normalized.indexOf(':');
    if (separator < 0) return { value: normalized, namespaces: {} };
    const sourcePrefix = normalized.slice(0, separator);
    const identity = normalized.slice(separator + 1);
    const namespace = descriptor?.namespaces?.get(sourcePrefix) || '';
    if (namespace === knownNamespace) return { value: identity, namespaces: {} };
    if (!namespace) throw rawValueError(options.name || 'identityref', `a QName with a bound ${sourcePrefix} prefix`);
    let prefix = sourcePrefix;
    const reserved = new Set(options.reservedPrefixes || []);
    if (reserved.has(prefix)) {
        const stem = options.fallbackPrefix || 'identity';
        prefix = stem;
        let sequence = 2;
        while (descriptor?.namespaces?.has(prefix) && descriptor.namespaces.get(prefix) !== namespace) {
            prefix = `${stem}${sequence++}`;
        }
    }
    return { value: `${prefix}:${identity}`, namespaces: { [prefix]: namespace } };
}

function orderedRoot(xml) {
    const document = orderedXmlParser.parse(xml);
    for (const item of document || []) {
        const root = resolveOrderedElement(orderedElement(item));
        if (root) return root;
    }
    return null;
}

function directOperationDescriptor(xml) {
    const root = orderedRoot(xml);
    if (!root) return null;
    if (root.localName !== 'rpc') return root;
    if (root.namespace !== BASE_NAMESPACE) return null;
    for (const item of root.children) {
        const operation = resolveOrderedElement(orderedElement(item), root.namespaces);
        if (operation) return operation;
    }
    return null;
}

function supportsCapability(capabilities, expected) {
    return (capabilities || []).some(capability => capability === expected || capability.startsWith(`${expected}?`));
}

function supportsYangModule(capabilities, moduleName, namespace) {
    return (capabilities || []).some(capability => {
        const value = String(capability || '');
        if (value === namespace || value.startsWith(`${namespace}?`)) return true;
        const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
        return new URLSearchParams(query).get('module') === moduleName;
    });
}

function yangModuleFeatures(capabilities, inventory, moduleName, namespace) {
    const features = new Set();
    for (const capability of capabilities || []) {
        const value = String(capability || '');
        const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
        const parameters = new URLSearchParams(query);
        const advertisedModule = parameters.get('module');
        if (!(value === namespace || value.startsWith(`${namespace}?`) || advertisedModule === moduleName)) continue;
        for (const feature of String(parameters.get('features') || '').split(',')) {
            if (feature.trim()) features.add(feature.trim());
        }
    }
    for (const module of inventory?.modules || []) {
        if (!isImplementedInventoryModule(module)) continue;
        if (String(module?.name || module?.identifier || '') !== moduleName) continue;
        const declared = module.features || module.feature || [];
        for (const feature of Array.isArray(declared) ? declared : [declared]) {
            const name = typeof feature === 'string' ? feature : feature?.name;
            if (name) features.add(String(name));
        }
    }
    return [...features].sort();
}

function isImplementedInventoryModule(module) {
    if (!module || typeof module !== 'object') return false;
    if (module.implemented === false || module.importOnly === true || module.isImportOnly === true) return false;
    const conformance = String(module.conformanceType || module.conformance || '')
        .trim()
        .toLowerCase();
    return !['import', 'import-only', 'import_only'].includes(conformance);
}

function capabilitySupportFrom(capabilities, inventory = null) {
    const moduleNames = new Set(
        (inventory?.modules || [])
            .filter(isImplementedInventoryModule)
            .map(module => String(module?.name || module?.identifier || ''))
            .filter(Boolean)
    );
    const subscribedNotificationsModule =
        moduleNames.has('ietf-subscribed-notifications') ||
        supportsYangModule(
            capabilities,
            'ietf-subscribed-notifications',
            NETCONF_CAPABILITIES.SUBSCRIBED_NOTIFICATIONS
        );
    const yangPushModule =
        moduleNames.has('ietf-yang-push') ||
        supportsYangModule(capabilities, 'ietf-yang-push', NETCONF_CAPABILITIES.YANG_PUSH);
    const subscribedNotificationFeatures = yangModuleFeatures(
        capabilities,
        inventory,
        'ietf-subscribed-notifications',
        NETCONF_CAPABILITIES.SUBSCRIBED_NOTIFICATIONS
    );
    const yangPushFeatures = yangModuleFeatures(
        capabilities,
        inventory,
        'ietf-yang-push',
        NETCONF_CAPABILITIES.YANG_PUSH
    );
    const encodeXml = subscribedNotificationFeatures.includes('encode-xml');
    const rfc8640 = subscribedNotificationsModule && encodeXml;
    const subscribedNotifications = rfc8640;
    const yangPush = rfc8640 && yangPushModule;
    return {
        notification: supportsCapability(capabilities, NETCONF_CAPABILITIES.NOTIFICATION),
        interleave: supportsCapability(capabilities, NETCONF_CAPABILITIES.INTERLEAVE),
        subscribedNotificationsModule,
        yangPushModule,
        encodeXml,
        rfc8640,
        subscribedNotifications,
        modernNotifications: subscribedNotifications,
        yangPush,
        subscribedNotificationFeatures,
        yangPushFeatures
    };
}

function profileSummary(entry) {
    return {
        profileName: entry?.profile?.name || entry?.profileId || '',
        host: entry?.profile?.host || '',
        port: Number(entry?.profile?.port) || 830
    };
}

function normalizeFilter(filter) {
    if (filter === undefined || filter === null || filter === '') return null;
    if (typeof filter === 'string') {
        const xml = filter.trim();
        if (!/^<(?:[A-Za-z_][\w.-]*:)?filter\b/i.test(xml)) {
            return { type: 'subtree', content: xml };
        }
        try {
            const root = findRoot(parseXml(xml));
            const node = root?.name === 'filter' ? root.value : null;
            if (!node) return { type: 'subtree', xml };
            const type = getAttribute(node, 'type') || 'subtree';
            return type === 'xpath' ? { type, select: getAttribute(node, 'select') || '', xml } : { type, xml };
        } catch (_error) {
            return { type: 'subtree', xml };
        }
    }
    if (typeof filter !== 'object' || Array.isArray(filter)) return null;
    const type = filter.type || 'subtree';
    if (type === 'reference') {
        const name = String(filter.name || filter.value || '').trim();
        return name ? { type, name } : null;
    }
    if (type === 'xpath') {
        return {
            type,
            select: filter.select || '',
            namespaces: filter.namespaces && typeof filter.namespaces === 'object' ? { ...filter.namespaces } : {}
        };
    }
    return {
        type,
        content: filter.xml !== undefined ? filter.xml : filter.content || '',
        empty: filter.empty === true,
        namespaces: filter.namespaces && typeof filter.namespaces === 'object' ? { ...filter.namespaces } : {}
    };
}

function directCreateSubscriptionNode(xml) {
    const document = parseXml(xml);
    const operation = directOperationDescriptor(xml);
    if (operation?.localName !== 'create-subscription' || operation.namespace !== NETCONF_NOTIFICATION_NAMESPACE) {
        return null;
    }
    const root = findRoot(document);
    if (!root) return null;
    if (root.name === 'create-subscription') {
        return root.value && typeof root.value === 'object' ? root.value : {};
    }
    if (root.name !== 'rpc') return null;
    const nodes = childValues(root.value, 'create-subscription');
    if (nodes.length === 0) return null;
    return nodes[0] && typeof nodes[0] === 'object' ? nodes[0] : {};
}

function rawSubscriptionParameters(xml) {
    const node = directCreateSubscriptionNode(xml);
    if (node === null) return null;
    const filterNodes = childValues(node, 'filter');
    const filterNode = filterNodes.length > 0 ? filterNodes[0] : null;
    let filter = null;
    if (filterNode) {
        const type = getAttribute(filterNode, 'type') || 'subtree';
        filter =
            type === 'xpath'
                ? { type, select: getAttribute(filterNode, 'select') || '' }
                : { type, document: filterNode };
    }
    return {
        stream: childText(node, 'stream') || 'NETCONF',
        filter,
        startTime: childText(node, 'startTime'),
        stopTime: childText(node, 'stopTime')
    };
}

function rawModernFilter(operationDescriptor, targetType) {
    const referenceName = targetType === 'datastore' ? 'selection-filter-ref' : 'stream-filter-name';
    const xpathName = targetType === 'datastore' ? 'datastore-xpath-filter' : 'stream-xpath-filter';
    const subtreeName = targetType === 'datastore' ? 'datastore-subtree-filter' : 'stream-subtree-filter';
    const expectedNamespace = targetType === 'datastore' ? YANG_PUSH_NAMESPACE : SUBSCRIBED_NOTIFICATIONS_NAMESPACE;
    const referenceDescriptor = orderedChildDescriptor(operationDescriptor, referenceName, expectedNamespace);
    const reference = orderedDescriptorText(referenceDescriptor);
    if (reference) return { type: 'reference', name: reference };
    const xpathDescriptor = orderedChildDescriptor(operationDescriptor, xpathName, expectedNamespace);
    if (xpathDescriptor) {
        return {
            type: 'xpath',
            select: orderedDescriptorText(xpathDescriptor) || '',
            namespaces: orderedNamespaceObject(xpathDescriptor)
        };
    }
    const subtreeDescriptor = orderedChildDescriptor(operationDescriptor, subtreeName, expectedNamespace);
    if (subtreeDescriptor) {
        const rebuiltContent = orderedXmlBuilder.build(subtreeDescriptor.children || []).trim();
        return {
            type: 'subtree',
            content: rebuiltContent,
            empty: rebuiltContent === '',
            namespaces: orderedNamespaceObject(subtreeDescriptor)
        };
    }
    return null;
}

function rawModernSubscriptionParameters(operationDescriptor, defaults = false) {
    const datastoreDescriptor = orderedChildDescriptor(operationDescriptor, 'datastore', YANG_PUSH_NAMESPACE);
    const periodicDescriptor = orderedChildDescriptor(operationDescriptor, 'periodic', YANG_PUSH_NAMESPACE);
    const onChangeDescriptor = orderedChildDescriptor(operationDescriptor, 'on-change', YANG_PUSH_NAMESPACE);
    const streamDescriptor = orderedChildDescriptor(operationDescriptor, 'stream', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    const streamFilterPresent = ['stream-filter-name', 'stream-xpath-filter', 'stream-subtree-filter'].some(name =>
        Boolean(orderedChildDescriptor(operationDescriptor, name, SUBSCRIBED_NOTIFICATIONS_NAMESPACE))
    );
    const datastoreFilterPresent = ['selection-filter-ref', 'datastore-xpath-filter', 'datastore-subtree-filter'].some(
        name => Boolean(orderedChildDescriptor(operationDescriptor, name, YANG_PUSH_NAMESPACE))
    );
    const streamTargetPresent = Boolean(streamDescriptor || streamFilterPresent);
    const datastoreTargetPresent = Boolean(
        datastoreDescriptor || datastoreFilterPresent || periodicDescriptor || onChangeDescriptor
    );
    if (streamTargetPresent === datastoreTargetPresent) {
        throw rawValueError('target', 'exactly one standard stream or datastore target');
    }
    const targetType = datastoreTargetPresent ? 'datastore' : 'stream';
    if (targetType === 'datastore' && !datastoreDescriptor) {
        throw rawValueError('datastore target', 'a standard ietf-yang-push datastore leaf');
    }
    if (defaults && targetType === 'stream' && !streamDescriptor) {
        throw rawValueError('stream target', 'a standard ietf-subscribed-notifications stream leaf');
    }
    const updateTrigger = periodicDescriptor ? 'periodic' : onChangeDescriptor ? 'on-change' : null;
    const filter = rawModernFilter(operationDescriptor, targetType);
    const parameters = { targetType };
    const assignOptional = (name, value, present) => {
        if (defaults || present) parameters[name] = value;
    };
    if (targetType === 'stream') {
        parameters.stream = orderedDescriptorText(streamDescriptor) || (defaults ? 'NETCONF' : null);
        parameters.datastore = null;
        parameters.datastoreNamespaces = {};
    } else {
        const datastoreIdentity = normalizeIdentityrefFromDescriptor(
            orderedDescriptorText(datastoreDescriptor),
            datastoreDescriptor,
            DATASTORES_NAMESPACE,
            {
                name: 'datastore',
                reservedPrefixes: ['xml', 'xmlns', 'yp', 'ds'],
                fallbackPrefix: 'datastore'
            }
        );
        parameters.stream = null;
        parameters.datastore = datastoreIdentity.value;
        parameters.datastoreNamespaces = datastoreIdentity.namespaces;
    }
    const replayStartDescriptor = orderedChildDescriptor(
        operationDescriptor,
        'replay-start-time',
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE
    );
    const stopDescriptor = orderedChildDescriptor(operationDescriptor, 'stop-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    const dscpDescriptor = orderedChildDescriptor(operationDescriptor, 'dscp', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    const weightingDescriptor = orderedChildDescriptor(
        operationDescriptor,
        'weighting',
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE
    );
    const dependencyDescriptor = orderedChildDescriptor(
        operationDescriptor,
        'dependency',
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE
    );
    const encodingDescriptor = orderedChildDescriptor(
        operationDescriptor,
        'encoding',
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE
    );
    const encodingIdentity = normalizeIdentityrefFromDescriptor(
        orderedDescriptorText(encodingDescriptor),
        encodingDescriptor,
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        {
            name: 'encoding',
            reservedPrefixes: ['xml', 'xmlns', 'yp', 'ds'],
            fallbackPrefix: 'encoding'
        }
    );
    assignOptional('replayStartTime', orderedDescriptorText(replayStartDescriptor), Boolean(replayStartDescriptor));
    assignOptional('stopTime', orderedDescriptorText(stopDescriptor), Boolean(stopDescriptor));
    assignOptional(
        'dscp',
        normalizeRawUint(orderedDescriptorText(dscpDescriptor), 'dscp', 63),
        Boolean(dscpDescriptor)
    );
    assignOptional(
        'weighting',
        normalizeRawUint(orderedDescriptorText(weightingDescriptor), 'weighting', 255),
        Boolean(weightingDescriptor)
    );
    assignOptional(
        'dependency',
        normalizeRawUint(orderedDescriptorText(dependencyDescriptor), 'dependency'),
        Boolean(dependencyDescriptor)
    );
    assignOptional('encoding', encodingIdentity.value, Boolean(encodingDescriptor));
    if (defaults || encodingDescriptor) parameters.encodingNamespaces = encodingIdentity.namespaces;
    assignOptional('updateTrigger', updateTrigger, Boolean(periodicDescriptor || onChangeDescriptor));
    const periodDescriptor = orderedChildDescriptor(periodicDescriptor, 'period', YANG_PUSH_NAMESPACE);
    const anchorDescriptor = orderedChildDescriptor(periodicDescriptor, 'anchor-time', YANG_PUSH_NAMESPACE);
    const dampeningDescriptor = orderedChildDescriptor(onChangeDescriptor, 'dampening-period', YANG_PUSH_NAMESPACE);
    const syncDescriptor = orderedChildDescriptor(onChangeDescriptor, 'sync-on-start', YANG_PUSH_NAMESPACE);
    assignOptional(
        'period',
        normalizeRawUint(orderedDescriptorText(periodDescriptor), 'period'),
        Boolean(periodDescriptor)
    );
    assignOptional('anchorTime', orderedDescriptorText(anchorDescriptor), Boolean(anchorDescriptor));
    assignOptional(
        'dampeningPeriod',
        normalizeRawUint(orderedDescriptorText(dampeningDescriptor), 'dampeningPeriod'),
        Boolean(dampeningDescriptor)
    );
    assignOptional(
        'syncOnStart',
        normalizeRawBoolean(orderedDescriptorText(syncDescriptor), 'syncOnStart'),
        Boolean(syncDescriptor)
    );
    const excludedChanges = orderedChildTexts(onChangeDescriptor, 'excluded-change', YANG_PUSH_NAMESPACE);
    if (defaults || excludedChanges.length > 0) parameters.excludedChanges = excludedChanges;
    if (defaults || filter) parameters.filter = filter;
    return parameters;
}

function rawSubscriptionOperation(xml) {
    const descriptor = directOperationDescriptor(xml);
    if (!descriptor) return null;
    const name = descriptor.localName;
    if (name === 'create-subscription' && descriptor.namespace === NETCONF_NOTIFICATION_NAMESPACE) {
        return { operation: name, type: 'rfc5277', parameters: rawSubscriptionParameters(xml) };
    }
    if (
        ['establish-subscription', 'modify-subscription', 'delete-subscription', 'kill-subscription'].includes(name) &&
        descriptor.namespace === SUBSCRIBED_NOTIFICATIONS_NAMESPACE
    ) {
        return {
            operation: name,
            type: name === 'establish-subscription' ? 'rfc8639' : 'subscription-management',
            publisherSubscriptionId: normalizeRawUint(
                orderedChildText(descriptor, 'id', SUBSCRIBED_NOTIFICATIONS_NAMESPACE),
                'id'
            ),
            parameters: ['establish-subscription', 'modify-subscription'].includes(name)
                ? rawModernSubscriptionParameters(descriptor, name === 'establish-subscription')
                : null
        };
    }
    if (name === 'resync-subscription' && descriptor.namespace === YANG_PUSH_NAMESPACE) {
        return {
            operation: name,
            type: 'subscription-management',
            publisherSubscriptionId: normalizeRawUint(orderedChildText(descriptor, 'id', YANG_PUSH_NAMESPACE), 'id'),
            parameters: null
        };
    }
    return null;
}

function modernReplyText(reply, name) {
    try {
        const root = orderedRoot(reply?.xml || '');
        if (root?.localName === 'rpc-reply' && root.namespace === BASE_NAMESPACE) {
            const value = orderedChildText(root, name, SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
            if (value !== null) return value;
        }
    } catch (_error) {
        // Test doubles and protocol-error replies may not contain a complete XML document.
    }
    return childText(reply?.root || {}, name);
}

function notificationEventDescriptor(notification) {
    let name = null;
    let namespace = '';
    let eventDescriptor = null;
    try {
        const root = orderedRoot(notification?.xml || '');
        if (root?.localName === 'notification' && root.namespace === NETCONF_NOTIFICATION_NAMESPACE) {
            for (const item of root.children) {
                const event = resolveOrderedElement(orderedElement(item), root.namespaces);
                if (event && event.localName !== 'eventTime') {
                    name = event.localName;
                    namespace = event.namespace;
                    eventDescriptor = event;
                    break;
                }
            }
        }
    } catch (_error) {
        // The NETCONF client has already parsed the message. Fall back to its document.
    }
    const subscribedNotificationEvent =
        namespace === SUBSCRIBED_NOTIFICATIONS_NAMESPACE && SUBSCRIBED_NOTIFICATION_STATE_EVENTS.has(name);
    const yangPushEvent = namespace === YANG_PUSH_NAMESPACE && YANG_PUSH_NOTIFICATION_EVENTS.has(name);
    const modernEvent = subscribedNotificationEvent || yangPushEvent;
    const idNamespace = subscribedNotificationEvent
        ? SUBSCRIBED_NOTIFICATIONS_NAMESPACE
        : yangPushEvent
          ? YANG_PUSH_NAMESPACE
          : null;
    const idDescriptor = idNamespace ? orderedChildDescriptor(eventDescriptor, 'id', idNamespace) : null;
    let publisherSubscriptionId = null;
    let parameterError = null;
    try {
        const normalizedId = normalizeRawUint(orderedDescriptorText(idDescriptor), 'id');
        publisherSubscriptionId = normalizedId === null ? null : String(normalizedId);
    } catch (error) {
        parameterError = errorData(error);
    }
    let parameters = null;
    if (subscribedNotificationEvent && ['subscription-modified', 'subscription-started'].includes(name)) {
        try {
            parameters = rawModernSubscriptionParameters(eventDescriptor, true);
        } catch (error) {
            parameterError = errorData(error);
        }
    }
    return {
        name,
        namespace,
        modernEvent,
        subscribedNotificationEvent,
        yangPushEvent,
        hasPublisherSubscriptionId: Boolean(idDescriptor),
        publisherSubscriptionId,
        reason: subscribedNotificationEvent
            ? orderedChildText(eventDescriptor, 'reason', SUBSCRIBED_NOTIFICATIONS_NAMESPACE)
            : null,
        parameters,
        parameterError
    };
}

function errorData(error) {
    return {
        name: error?.name || 'Error',
        code: error?.code || 'NETCONF_WORKER_ERROR',
        message: error?.message || String(error),
        errors: error?.errors || [],
        messageId: error?.messageId || null,
        requestXml: error?.requestXml || null,
        replyXml: error?.replyXml || null,
        subscription: error?.subscription || null
    };
}

function approximateJsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch (_error) {
        return 0;
    }
}

class NetconfWorkerService {
    constructor(port = parentEndpoint, options = {}) {
        this.port = port;
        this.clientFactory = options.clientFactory || (clientOptions => new NetconfClient(clientOptions));
        this.sessions = new Map();
        this.subscriptions = new Map();
        this.subscriptionStopTimers = new Map();
        this.connectQueue = Promise.resolve();
        this.cancelledRequests = new Set();
        this.activeConnectRequests = new Map();
        this.activeRpcRequests = new Map();
        this.closing = false;
        if (this.port && options.listen !== false) this.port.on('message', message => this.handleMessage(message));
    }

    sendResponse(messageId, status, data = null, msg = '', code = null) {
        if (!this.port) return;
        this.port.postMessage({ messageId, status, data, msg, code });
    }

    emit(eventName, data) {
        if (this.port) this.port.postMessage({ eventName, data });
    }

    async handleMessage(message = {}) {
        const { messageId, op, data } = message;
        if (op === '__cancel__') {
            this.cancelRequest(data?.messageId);
            return;
        }
        try {
            const result = await this.dispatch(op, data || {}, { messageId });
            if (!this.cancelledRequests.has(messageId)) this.sendResponse(messageId, 'success', result);
        } catch (error) {
            const detail = errorData(error);
            if (!this.cancelledRequests.has(messageId)) {
                this.sendResponse(messageId, 'error', detail, detail.message, detail.code);
            }
        } finally {
            this.cancelledRequests.delete(messageId);
        }
    }

    cancelRequest(messageId) {
        if (!messageId) return;
        this.cancelledRequests.add(messageId);
        const entry = this.activeConnectRequests.get(messageId);
        if (entry) {
            entry.manualClose = true;
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            entry.client?.disconnect?.('connection request cancelled');
        }
        const rpcRequest = this.activeRpcRequests.get(messageId);
        if (rpcRequest) rpcRequest.client?.cancelRpc?.(rpcRequest.messageId);
    }

    requestCancelledError() {
        const error = new Error('NETCONF连接请求已取消');
        error.code = 'NETCONF_CONNECT_CANCELLED';
        return error;
    }

    async dispatch(operation, data, context = {}) {
        switch (operation) {
            case NETCONF_REQ_TYPES.TEST_CONNECTION:
                return this.testConnection(data);
            case NETCONF_REQ_TYPES.CONNECT:
                return this.connect(data, context.messageId);
            case NETCONF_REQ_TYPES.DISCONNECT:
                return this.disconnect(data.profileId);
            case NETCONF_REQ_TYPES.DISCONNECT_ALL:
                return this.disconnectAll();
            case NETCONF_REQ_TYPES.PURGE_PROFILE:
                return this.purgeProfile(data.profileId);
            case NETCONF_REQ_TYPES.GET_SESSION_STATE:
                return this.getSessionState(data.profileId);
            case NETCONF_REQ_TYPES.GET_SUBSCRIPTIONS:
                return this.getSubscriptions(data.profileId);
            case NETCONF_REQ_TYPES.DISCOVER_MODULES:
                return this.discoverModules(data.profileId);
            case NETCONF_REQ_TYPES.GET_SCHEMA:
                return this.getSchema(data.profileId, data.module || data);
            case NETCONF_REQ_TYPES.EXECUTE_OPERATION:
                return this.executeOperation(data.profileId, data, context.messageId);
            case NETCONF_REQ_TYPES.SEND_RPC:
                return this.sendRpc(data.profileId, data, context.messageId);
            default: {
                const error = new Error(`不支持的NETCONF Worker操作: ${operation}`);
                error.code = 'NETCONF_UNKNOWN_OPERATION';
                throw error;
            }
        }
    }

    readPrivateKey(filePath) {
        const stats = fs.lstatSync(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error('SSH私钥必须是普通文件，不能使用符号链接');
        }
        if (stats.size <= 0 || stats.size > MAX_PRIVATE_KEY_BYTES) {
            throw new Error(`SSH私钥大小必须在1到${MAX_PRIVATE_KEY_BYTES}字节之间`);
        }
        return fs.readFileSync(filePath);
    }

    prepareProfile(profile, observed = {}) {
        const runtime = {
            ...profile,
            readyTimeout: Number(profile.connectTimeout || profile.readyTimeout) || 15000,
            keepaliveInterval: Number(profile.keepaliveInterval) || 0,
            keepaliveCountMax: Number(profile.keepaliveCountMax) || 3
        };
        if (runtime.authMethod === 'privateKey' && !runtime.privateKey && runtime.privateKeyPath) {
            runtime.privateKey = this.readPrivateKey(runtime.privateKeyPath);
        }
        if (runtime.authMethod === 'agent' && !runtime.agent) {
            runtime.agent = process.env.SSH_AUTH_SOCK;
        }

        const expected = String(runtime.hostKeyFingerprint || '').trim();
        if (runtime.hostKeyPolicy === 'strict' && !expected) {
            const error = new Error('严格主机密钥校验需要预先配置指纹');
            error.code = 'NETCONF_HOST_VERIFICATION_REQUIRED';
            throw error;
        }
        const verifier = expected ? createHostVerifier(expected) : null;
        runtime.hostVerifier = key => {
            const fingerprints = calculateFingerprints(key);
            observed.hostKeyFingerprint = fingerprints.sha256;
            return verifier ? verifier(key) : runtime.hostKeyPolicy !== 'strict';
        };
        return runtime;
    }

    createEntry(profile) {
        return {
            profileId: String(profile.id),
            profile,
            client: null,
            status: 'disconnected',
            connectedAt: null,
            disconnectedAt: null,
            lastError: null,
            observed: {},
            manualClose: false,
            reconnectAttempt: 0,
            reconnectTimer: null,
            activeSubscriptionId: null,
            subscriptionPending: false,
            pendingSubscriptions: { legacy: 0, modern: 0 },
            schemaInventory: null,
            schemaDiscoveryPromise: null,
            schemaDiscoveryError: null
        };
    }

    publicState(entry) {
        if (!entry) {
            return {
                profileId: null,
                status: 'disconnected',
                connected: false,
                capabilities: [],
                supportsNotification: false,
                supportsInterleave: false,
                supportsSubscribedNotifications: false,
                supportsYangPush: false,
                notificationFeatures: {
                    rfc5277: false,
                    rfc8639: false,
                    rfc8640: false,
                    rfc8641: false,
                    yangPush: false
                },
                capabilitySupport: {
                    notification: false,
                    interleave: false,
                    subscribedNotificationsModule: false,
                    yangPushModule: false,
                    encodeXml: false,
                    rfc8640: false,
                    subscribedNotifications: false,
                    modernNotifications: false,
                    yangPush: false,
                    subscribedNotificationFeatures: [],
                    yangPushFeatures: []
                },
                subscription: null,
                activeSubscription: null,
                activeSubscriptions: [],
                subscriptionActive: false,
                activeSubscriptionCount: 0
            };
        }
        const info = entry.client?.connected ? entry.client.sessionInfo() : {};
        const capabilitySupport = capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        const activeSubscriptions = this.sessionSubscriptions(entry, info.sessionId || null, true).map(subscription =>
            this.publicSubscription(subscription)
        );
        const activeSubscription =
            this.publicSubscription(this.activeSubscription(entry)) || activeSubscriptions[0] || null;
        return {
            profileId: entry.profileId,
            ...profileSummary(entry),
            status: entry.status,
            state: entry.status,
            connected: entry.status === 'connected' && Boolean(entry.client?.connected),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            capabilities: info.capabilities || [],
            serverCapabilities: info.capabilities || [],
            supportsNotification: capabilitySupport.notification,
            supportsInterleave: capabilitySupport.interleave,
            supportsSubscribedNotifications: capabilitySupport.subscribedNotifications,
            supportsYangPush: capabilitySupport.yangPush,
            notificationFeatures: {
                rfc5277: capabilitySupport.notification,
                rfc8639: capabilitySupport.subscribedNotifications,
                rfc8640: capabilitySupport.rfc8640,
                rfc8641: capabilitySupport.yangPush,
                yangPush: capabilitySupport.yangPush,
                subscribedNotificationFeatures: capabilitySupport.subscribedNotificationFeatures,
                yangPushFeatures: capabilitySupport.yangPushFeatures
            },
            capabilitySupport,
            subscription: activeSubscription,
            activeSubscription,
            activeSubscriptions,
            subscriptionActive: activeSubscriptions.length > 0,
            activeSubscriptionCount: activeSubscriptions.length,
            connectedAt: entry.connectedAt,
            disconnectedAt: entry.disconnectedAt,
            reconnectAttempt: entry.reconnectAttempt,
            capabilityDiscoveryPending: Boolean(entry.schemaDiscoveryPromise),
            capabilityDiscoveryError: entry.schemaDiscoveryError,
            hostKeyFingerprint: entry.observed.hostKeyFingerprint || entry.profile.hostKeyFingerprint || '',
            lastError: entry.lastError
        };
    }

    scrubEntrySecrets(entry) {
        if (!entry?.profile) return;
        const profile = { ...entry.profile };
        delete profile.password;
        delete profile.passphrase;
        delete profile.privateKey;
        entry.profile = profile;
    }

    emitState(entry, extra = {}) {
        this.emit(YANG_EVT_TYPES.SESSION_EVENT, { ...this.publicState(entry), ...extra });
    }

    publicSubscription(subscription) {
        if (!subscription) return null;
        const {
            _lifecycleRevision,
            _lastLifecycleTransportSequence,
            _lastPolicySnapshotRevision,
            _lastPolicySnapshotTransportSequence,
            ...publicFields
        } = subscription;
        return {
            ...publicFields,
            filter: subscription.filter
                ? {
                      ...subscription.filter,
                      namespaces: { ...(subscription.filter.namespaces || {}) }
                  }
                : null,
            datastoreNamespaces: { ...(subscription.datastoreNamespaces || {}) },
            encodingNamespaces: { ...(subscription.encodingNamespaces || {}) },
            excludedChanges: Array.isArray(subscription.excludedChanges) ? [...subscription.excludedChanges] : [],
            capabilitySupport: { ...(subscription.capabilitySupport || {}) }
        };
    }

    isLiveSubscription(subscription) {
        return ['ACTIVE', 'SUSPENDED'].includes(String(subscription?.state || '').toUpperCase());
    }

    isUnresolvedSubscription(subscription) {
        return this.isLiveSubscription(subscription) || String(subscription?.state || '').toUpperCase() === 'UNKNOWN';
    }

    recordLifecycleTransition(subscription, transportSequence = null) {
        if (!subscription) return;
        subscription._lifecycleRevision = Number(subscription._lifecycleRevision || 0) + 1;
        const sequence = Number(transportSequence);
        if (Number.isSafeInteger(sequence) && sequence > 0) {
            subscription._lastLifecycleTransportSequence = Math.max(
                Number(subscription._lastLifecycleTransportSequence || 0),
                sequence
            );
        }
    }

    clearSubscriptionStopTimer(subscriptionId) {
        const normalizedId = String(subscriptionId || '');
        const timer = this.subscriptionStopTimers.get(normalizedId);
        if (timer) clearTimeout(timer);
        this.subscriptionStopTimers.delete(normalizedId);
    }

    reconcileSubscriptionStop(entry, subscription, now = Date.now()) {
        if (!subscription || !this.isLiveSubscription(subscription) || !subscription.stopTime) return false;
        const stopTimestamp = Date.parse(subscription.stopTime);
        if (!Number.isFinite(stopTimestamp) || stopTimestamp > now) return false;
        this.terminateSubscription(entry, subscription, 'stop-time');
        return true;
    }

    scheduleSubscriptionStop(subscription) {
        if (!subscription) return;
        this.clearSubscriptionStopTimer(subscription.id);
        if (!this.isLiveSubscription(subscription) || !subscription.stopTime) return;
        const stopTimestamp = Date.parse(subscription.stopTime);
        if (!Number.isFinite(stopTimestamp)) return;
        const entry = this.sessions.get(String(subscription.profileId || '')) || null;
        if (this.reconcileSubscriptionStop(entry, subscription)) return;
        const scheduleNext = () => {
            if (!this.isLiveSubscription(subscription) || !subscription.stopTime) return;
            const currentStopTimestamp = Date.parse(subscription.stopTime);
            if (!Number.isFinite(currentStopTimestamp)) return;
            const remaining = currentStopTimestamp - Date.now();
            if (remaining <= 0) {
                this.reconcileSubscriptionStop(
                    this.sessions.get(String(subscription.profileId || '')) || null,
                    subscription
                );
                return;
            }
            const timer = setTimeout(scheduleNext, Math.min(remaining, MAX_TIMER_DELAY));
            timer.unref?.();
            this.subscriptionStopTimers.set(subscription.id, timer);
        };
        scheduleNext();
    }

    reconcileProfileSubscriptionStops(entry) {
        if (!entry) return;
        const now = Date.now();
        for (const subscription of this.sessionSubscriptions(entry, null, false)) {
            this.reconcileSubscriptionStop(entry, subscription, now);
        }
    }

    pruneSubscriptionHistory(profileId) {
        const normalizedProfileId = String(profileId || '');
        if (!normalizedProfileId) return;
        const records = [...this.subscriptions.values()].filter(
            subscription => String(subscription.profileId || '') === normalizedProfileId
        );
        let totalBytes = records.reduce((total, subscription) => total + approximateJsonBytes(subscription), 0);
        let totalCount = records.length;
        const removable = records
            .filter(subscription => !this.isUnresolvedSubscription(subscription))
            .sort((left, right) =>
                String(left.terminatedAt || left.updatedAt || left.createdAt || '').localeCompare(
                    String(right.terminatedAt || right.updatedAt || right.createdAt || '')
                )
            );
        for (const subscription of removable) {
            if (
                totalCount <= MAX_SUBSCRIPTION_HISTORY_PER_PROFILE &&
                totalBytes <= MAX_SUBSCRIPTION_HISTORY_BYTES_PER_PROFILE
            ) {
                break;
            }
            if (!this.subscriptions.delete(subscription.id)) continue;
            totalCount -= 1;
            totalBytes = Math.max(0, totalBytes - approximateJsonBytes(subscription));
        }
    }

    markSubscriptionUnknown(entry, subscription, operation, error) {
        if (!subscription || !this.isUnresolvedSubscription(subscription)) return null;
        this.clearSubscriptionStopTimer(subscription.id);
        const now = new Date().toISOString();
        subscription.state = 'UNKNOWN';
        subscription.updatedAt = now;
        subscription.desynchronized = true;
        subscription.desynchronizedAt = now;
        subscription.desynchronizationReason = `rpc-timeout:${operation}`;
        subscription.error = errorData(error);
        this.recordLifecycleTransition(subscription);
        this.emitSubscription(subscription);
        if (entry) this.emitState(entry, { subscriptionChanged: true, subscriptionDesynchronized: true });
        return this.publicSubscription(subscription);
    }

    activeSubscription(entry) {
        if (!entry?.activeSubscriptionId) return null;
        const subscription = this.subscriptions.get(entry.activeSubscriptionId) || null;
        return subscription?.subscriptionType === 'rfc5277' && this.isLiveSubscription(subscription)
            ? subscription
            : null;
    }

    sessionSubscriptions(entry, sessionId = null, liveOnly = false) {
        const normalizedSessionId = sessionId === undefined || sessionId === null ? null : String(sessionId);
        return [...this.subscriptions.values()].filter(subscription => {
            if (subscription.profileId !== entry?.profileId) return false;
            if (normalizedSessionId !== null && String(subscription.sessionId || '') !== normalizedSessionId)
                return false;
            return !liveOnly || this.isLiveSubscription(subscription);
        });
    }

    modernSubscriptions(entry, sessionId = null, liveOnly = false) {
        return this.sessionSubscriptions(entry, sessionId, liveOnly).filter(
            subscription => subscription.subscriptionType !== 'rfc5277'
        );
    }

    subscriptionForSession(entry, sessionId) {
        const live = this.sessionSubscriptions(entry, sessionId, true);
        if (live.length === 1) return live[0];
        const history = this.sessionSubscriptions(entry, sessionId, false);
        for (let index = history.length - 1; index >= 0; index -= 1) {
            if (!this.isLiveSubscription(history[index])) return history[index];
        }
        return null;
    }

    subscriptionByPublisherId(entry, publisherSubscriptionId, sessionId = null, liveOnly = true) {
        const expected = String(publisherSubscriptionId ?? '').trim();
        if (!expected) return null;
        const matches = this.modernSubscriptions(entry, sessionId, liveOnly).filter(
            subscription => String(subscription.publisherSubscriptionId || '') === expected
        );
        return matches[matches.length - 1] || null;
    }

    emitSubscription(subscription) {
        this.emit(YANG_EVT_TYPES.SUBSCRIPTION_EVENT, this.publicSubscription(subscription));
    }

    assertCanCreateSubscription(entry) {
        const info = entry.client?.sessionInfo?.() || {};
        const capabilities = info.capabilities || [];
        if (!supportsCapability(capabilities, NETCONF_CAPABILITIES.NOTIFICATION)) {
            const error = new Error('设备未声明 NETCONF :notification 能力，不能建立 RFC 5277 订阅');
            error.code = 'NETCONF_NOTIFICATION_NOT_SUPPORTED';
            throw error;
        }
        const active = this.activeSubscription(entry);
        const modern = this.modernSubscriptions(entry, info.sessionId || null, true);
        const uncertain = this.modernSubscriptions(entry, info.sessionId || null, false).find(
            subscription => String(subscription.state || '').toUpperCase() === 'UNKNOWN'
        );
        const pending = entry.pendingSubscriptions || { legacy: entry.subscriptionPending ? 1 : 0, modern: 0 };
        if (active || modern.length > 0 || uncertain || pending.legacy > 0 || pending.modern > 0) {
            const error = new Error(
                pending.legacy > 0
                    ? '当前 NETCONF Session 正在建立 RFC 5277 订阅'
                    : uncertain
                      ? '当前 NETCONF Session 存在状态未知的 RFC 8639 订阅，请先重连再建立 RFC 5277 订阅'
                      : modern.length > 0 || pending.modern > 0
                        ? '当前 NETCONF Session 已使用 RFC 8639 动态订阅，不能同时建立 RFC 5277 订阅'
                        : '当前 NETCONF Session 已有活动的 RFC 5277 订阅'
            );
            error.code = 'NETCONF_SUBSCRIPTION_ALREADY_ACTIVE';
            error.subscription = this.publicSubscription(active || uncertain || modern[0]);
            throw error;
        }
    }

    assertCanEstablishSubscription(entry) {
        const info = entry.client?.sessionInfo?.() || {};
        const capabilitySupport = capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        if (!capabilitySupport.subscribedNotifications) {
            const error = new Error(
                capabilitySupport.subscribedNotificationsModule && !capabilitySupport.encodeXml
                    ? '设备的 ietf-subscribed-notifications 未启用 RFC 8640 强制的 encode-xml feature'
                    : '设备未声明可用于 NETCONF 的 ietf-subscribed-notifications / RFC 8640 能力'
            );
            error.code = 'NETCONF_MODERN_SUBSCRIPTION_NOT_SUPPORTED';
            throw error;
        }
        const legacy = this.activeSubscription(entry);
        const pending = entry.pendingSubscriptions || { legacy: entry.subscriptionPending ? 1 : 0, modern: 0 };
        if (legacy || pending.legacy > 0) {
            const error = new Error('当前 NETCONF Session 已使用 RFC 5277 订阅，不能同时建立 RFC 8639 动态订阅');
            error.code = 'NETCONF_SUBSCRIPTION_PROTOCOL_CONFLICT';
            error.subscription = this.publicSubscription(legacy);
            throw error;
        }
        return capabilitySupport;
    }

    assertModernRequestSupported(entry, operation, parameters = {}, subscription = null, knownSupport = null) {
        const info = entry.client?.sessionInfo?.() || {};
        const support = knownSupport || capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        const subscribedFeatures = new Set(support.subscribedNotificationFeatures || []);
        const yangPushFeatures = new Set(support.yangPushFeatures || []);
        const fail = (feature, message, code = 'NETCONF_SUBSCRIPTION_FEATURE_NOT_SUPPORTED') => {
            const error = new Error(message);
            error.code = code;
            error.feature = feature;
            throw error;
        };
        const targetType = parameters?.targetType || subscription?.targetType || 'stream';
        if (operation === 'modify-subscription') {
            const immutableFields = [
                'replayStartTime',
                'dscp',
                'weighting',
                'dependency',
                'encoding',
                'syncOnStart',
                'excludedChanges'
            ].filter(field => Object.prototype.hasOwnProperty.call(parameters || {}, field));
            if (immutableFields.length > 0) {
                const error = new Error(
                    `modify-subscription 不能修改建立后不可变的参数: ${immutableFields.join(', ')}`
                );
                error.code = 'NETCONF_SUBSCRIPTION_PARAMETER_IMMUTABLE';
                error.parameters = immutableFields;
                throw error;
            }
        }
        if (
            parameters?.updateTrigger === 'periodic' &&
            !Object.prototype.hasOwnProperty.call(parameters || {}, 'period')
        ) {
            const error = new Error('periodic update-trigger 必须包含 period');
            error.code = 'NETCONF_INVALID_SUBSCRIPTION_RPC';
            throw error;
        }
        if (targetType === 'datastore' && !support.yangPush) {
            fail(
                'ietf-yang-push',
                '设备未声明可用于 NETCONF 的 ietf-yang-push 能力',
                'NETCONF_YANG_PUSH_NOT_SUPPORTED'
            );
        }
        const filter = normalizeFilter(parameters?.filter);
        if (filter?.type === 'xpath' && !subscribedFeatures.has('xpath')) {
            fail('xpath', '设备的 ietf-subscribed-notifications 未启用 xpath feature');
        }
        if (filter?.type === 'subtree' && !subscribedFeatures.has('subtree')) {
            fail('subtree', '设备的 ietf-subscribed-notifications 未启用 subtree feature');
        }
        if (parameters?.replayStartTime && !subscribedFeatures.has('replay')) {
            fail('replay', '设备的 ietf-subscribed-notifications 未启用 replay feature');
        }
        if (parameters?.dscp !== undefined && parameters?.dscp !== null && !subscribedFeatures.has('dscp')) {
            fail('dscp', '设备的 ietf-subscribed-notifications 未启用 dscp feature');
        }
        if (
            (parameters?.weighting !== undefined && parameters?.weighting !== null) ||
            (parameters?.dependency !== undefined && parameters?.dependency !== null)
        ) {
            if (!subscribedFeatures.has('qos')) {
                fail('qos', '设备的 ietf-subscribed-notifications 未启用 qos feature');
            }
        }
        const encoding = String(parameters?.encoding || '').trim();
        const encodingSeparator = encoding.indexOf(':');
        const encodingPrefix = encodingSeparator < 0 ? '' : encoding.slice(0, encodingSeparator);
        const encodingLocalName = encodingSeparator < 0 ? encoding : encoding.slice(encodingSeparator + 1);
        const encodingNamespace = encodingPrefix ? parameters?.encodingNamespaces?.[encodingPrefix] : null;
        const standardEncoding =
            !encodingPrefix ||
            encodingNamespace === SUBSCRIBED_NOTIFICATIONS_NAMESPACE ||
            (['sn', 'ietf-subscribed-notifications'].includes(encodingPrefix) && !encodingNamespace);
        if (standardEncoding && encodingLocalName && !['encode-xml', 'encode-json'].includes(encodingLocalName)) {
            const error = new Error(`ietf-subscribed-notifications 未定义 encoding identity: ${encodingLocalName}`);
            error.code = 'NETCONF_SUBSCRIPTION_ENCODING_UNSUPPORTED';
            error.encoding = encoding;
            throw error;
        }
        if (standardEncoding && encodingLocalName === 'encode-json' && !subscribedFeatures.has('encode-json')) {
            fail('encode-json', '设备的 ietf-subscribed-notifications 未启用 encode-json feature');
        }
        if (standardEncoding && encodingLocalName === 'encode-xml' && !subscribedFeatures.has('encode-xml')) {
            fail('encode-xml', '设备的 ietf-subscribed-notifications 未启用 encode-xml feature');
        }
        if (parameters?.updateTrigger === 'on-change' && !yangPushFeatures.has('on-change')) {
            fail('on-change', '设备的 ietf-yang-push 未启用 on-change feature');
        }
        if (operation === 'resync-subscription') {
            if (
                String(subscription?.state || '').toUpperCase() !== 'ACTIVE' ||
                subscription?.targetType !== 'datastore' ||
                subscription?.updateTrigger !== 'on-change'
            ) {
                const error = new Error('resync-subscription 仅适用于活动的 on-change YANG-Push 订阅');
                error.code = 'NETCONF_RESYNC_NOT_ALLOWED';
                error.subscription = this.publicSubscription(subscription);
                throw error;
            }
            if (!yangPushFeatures.has('on-change')) {
                fail('on-change', '设备的 ietf-yang-push 未启用 resync 所需的 on-change feature');
            }
        }
        return support;
    }

    beginSubscription(entry, type) {
        if (!entry.pendingSubscriptions) entry.pendingSubscriptions = { legacy: 0, modern: 0 };
        entry.pendingSubscriptions[type] += 1;
        entry.subscriptionPending = entry.pendingSubscriptions.legacy + entry.pendingSubscriptions.modern > 0;
    }

    endSubscription(entry, type) {
        if (!entry.pendingSubscriptions) entry.pendingSubscriptions = { legacy: 0, modern: 0 };
        entry.pendingSubscriptions[type] = Math.max(0, entry.pendingSubscriptions[type] - 1);
        entry.subscriptionPending = entry.pendingSubscriptions.legacy + entry.pendingSubscriptions.modern > 0;
    }

    activateSubscription(entry, parameters, requestXml, messageId, sessionInfo = null) {
        const info = sessionInfo || entry.client?.sessionInfo?.() || {};
        const capabilitySupport = capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        // History is kept by the renderer across worker restarts, so a process-local
        // counter would eventually overwrite an older subscription record.
        const id = `rfc5277-${randomUUID()}`;
        const subscription = {
            id,
            subscriptionId: id,
            profileId: entry.profileId,
            ...profileSummary(entry),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            type: 'rfc5277',
            subscriptionType: 'rfc5277',
            state: 'ACTIVE',
            stream: parameters.stream || 'NETCONF',
            filter: normalizeFilter(parameters.filter),
            startTime: parameters.startTime || null,
            stopTime: parameters.stopTime || null,
            messageId: messageId || null,
            requestXml: requestXml || null,
            capabilitySupport,
            createdAt: new Date().toISOString(),
            terminatedAt: null,
            terminationReason: null,
            error: null
        };
        this.subscriptions.set(id, subscription);
        this.pruneSubscriptionHistory(entry.profileId);
        entry.activeSubscriptionId = id;
        this.emitSubscription(subscription);
        this.emitState(entry, { subscriptionChanged: true });
        this.scheduleSubscriptionStop(subscription);
        return this.publicSubscription(subscription);
    }

    activateModernSubscription(entry, parameters, requestXml, messageId, reply, sessionInfo = null) {
        const info = sessionInfo || entry.client?.sessionInfo?.() || {};
        let normalizedPublisherSubscriptionId = null;
        try {
            normalizedPublisherSubscriptionId = normalizeRawUint(modernReplyText(reply, 'id'), 'id');
        } catch (_error) {
            // Map every missing or malformed successful reply identifier to the
            // protocol-facing error below.  The Session can no longer be tracked safely.
        }
        const publisherSubscriptionId =
            normalizedPublisherSubscriptionId === null ? '' : String(normalizedPublisherSubscriptionId);
        if (!publisherSubscriptionId) {
            const error = new Error('RFC 8639 establish-subscription 成功响应缺少有效的 uint32 订阅 id');
            error.code = 'NETCONF_SUBSCRIPTION_ID_MISSING';
            error.replyXml = reply?.xml || null;
            error.requestXml = requestXml || null;
            error.messageId = messageId || null;
            throw error;
        }
        if (this.subscriptionByPublisherId(entry, publisherSubscriptionId, info.sessionId || null, true)) {
            const error = new Error(`设备返回了重复的活动订阅 id: ${publisherSubscriptionId}`);
            error.code = 'NETCONF_DUPLICATE_SUBSCRIPTION_ID';
            throw error;
        }
        const targetType = parameters.targetType === 'datastore' ? 'datastore' : 'stream';
        const id = `rfc8639-${randomUUID()}`;
        const subscription = {
            id,
            subscriptionId: id,
            publisherSubscriptionId,
            deviceSubscriptionId: publisherSubscriptionId,
            profileId: entry.profileId,
            ...profileSummary(entry),
            sessionId: info.sessionId || null,
            baseVersion: info.baseVersion || null,
            type: targetType === 'datastore' ? 'rfc8641' : 'rfc8639',
            subscriptionType: targetType === 'datastore' ? 'yang-push' : 'rfc8639',
            transportBinding: 'rfc8640',
            targetType,
            state: 'ACTIVE',
            stream: targetType === 'stream' ? parameters.stream || 'NETCONF' : null,
            datastore: targetType === 'datastore' ? parameters.datastore || null : null,
            datastoreNamespaces:
                targetType === 'datastore' && parameters.datastoreNamespaces
                    ? { ...parameters.datastoreNamespaces }
                    : {},
            filter: normalizeFilter(parameters.filter),
            replayStartTime: parameters.replayStartTime || null,
            replayStartTimeRevision: modernReplyText(reply, 'replay-start-time-revision'),
            stopTime: parameters.stopTime || null,
            dscp: parameters.dscp ?? null,
            weighting: parameters.weighting ?? null,
            dependency: parameters.dependency ?? null,
            encoding: parameters.encoding || null,
            encodingNamespaces: parameters.encodingNamespaces ? { ...parameters.encodingNamespaces } : {},
            updateTrigger: parameters.updateTrigger || null,
            period: parameters.period ?? null,
            anchorTime: parameters.anchorTime || null,
            dampeningPeriod: parameters.dampeningPeriod ?? null,
            syncOnStart: parameters.syncOnStart ?? null,
            excludedChanges: Array.isArray(parameters.excludedChanges) ? [...parameters.excludedChanges] : [],
            messageId: messageId || null,
            requestXml: requestXml || null,
            capabilitySupport: capabilitySupportFrom(info.capabilities || [], entry.schemaInventory),
            createdAt: new Date().toISOString(),
            updatedAt: null,
            terminatedAt: null,
            terminationReason: null,
            error: null,
            desynchronized: false,
            desynchronizedAt: null,
            desynchronizationReason: null,
            _lifecycleRevision: 0,
            _lastLifecycleTransportSequence: 0,
            _lastPolicySnapshotRevision: 0,
            _lastPolicySnapshotTransportSequence: 0
        };
        this.subscriptions.set(id, subscription);
        this.pruneSubscriptionHistory(entry.profileId);
        this.emitSubscription(subscription);
        this.emitState(entry, { subscriptionChanged: true });
        this.scheduleSubscriptionStop(subscription);
        return this.publicSubscription(subscription);
    }

    updateModernSubscription(subscription, parameters, requestXml, messageId, options = {}) {
        if (!subscription) return null;
        const targetType = parameters?.targetType || subscription.targetType;
        const targetChanged = targetType !== subscription.targetType;
        const hasParameter = name => parameters && Object.prototype.hasOwnProperty.call(parameters, name);
        const previousUpdateTrigger = subscription.updateTrigger || null;
        const updatingPolicy = hasParameter('updateTrigger');
        const updateTrigger =
            targetType === 'datastore'
                ? updatingPolicy
                    ? parameters.updateTrigger
                    : targetChanged
                      ? null
                      : previousUpdateTrigger
                : null;
        const switchingPolicy = updatingPolicy && updateTrigger !== previousUpdateTrigger;
        const expectedLifecycleRevision = Number(options.expectedLifecycleRevision || 0);
        const replyTransportSequence = Number(options.replyTransportSequence || 0);
        const lastLifecycleTransportSequence = Number(subscription._lastLifecycleTransportSequence || 0);
        const hasOrderedTransportSequence =
            Number.isSafeInteger(replyTransportSequence) &&
            replyTransportSequence > 0 &&
            Number.isSafeInteger(lastLifecycleTransportSequence) &&
            lastLifecycleTransportSequence > 0;
        const lifecycleChangedAfterRequest = Number(subscription._lifecycleRevision || 0) !== expectedLifecycleRevision;
        const lifecycleEventAfterReply = hasOrderedTransportSequence
            ? lastLifecycleTransportSequence > replyTransportSequence
            : lifecycleChangedAfterRequest;
        const lastPolicySnapshotTransportSequence = Number(subscription._lastPolicySnapshotTransportSequence || 0);
        const hasOrderedPolicySnapshot =
            Number.isSafeInteger(replyTransportSequence) &&
            replyTransportSequence > 0 &&
            Number.isSafeInteger(lastPolicySnapshotTransportSequence) &&
            lastPolicySnapshotTransportSequence > 0;
        const policySnapshotAfterReply = hasOrderedPolicySnapshot
            ? lastPolicySnapshotTransportSequence > replyTransportSequence
            : Number(subscription._lastPolicySnapshotRevision || 0) > expectedLifecycleRevision;
        if (policySnapshotAfterReply) {
            subscription.requestXml = requestXml || subscription.requestXml;
            subscription.messageId = messageId || subscription.messageId;
            this.emitSubscription(subscription);
            return this.publicSubscription(subscription);
        }
        const shouldActivate = this.isLiveSubscription(subscription) && !lifecycleEventAfterReply;
        Object.assign(subscription, {
            targetType,
            type: targetType === 'datastore' ? 'rfc8641' : 'rfc8639',
            subscriptionType: targetType === 'datastore' ? 'yang-push' : 'rfc8639',
            state: shouldActivate ? 'ACTIVE' : subscription.state,
            stream: targetType === 'stream' ? parameters?.stream || subscription.stream || 'NETCONF' : null,
            datastore: targetType === 'datastore' ? parameters?.datastore || subscription.datastore || null : null,
            datastoreNamespaces:
                targetType === 'datastore'
                    ? hasParameter('datastoreNamespaces')
                        ? { ...(parameters.datastoreNamespaces || {}) }
                        : { ...(subscription.datastoreNamespaces || {}) }
                    : {},
            filter: hasParameter('filter')
                ? normalizeFilter(parameters.filter)
                : targetChanged
                  ? null
                  : subscription.filter,
            replayStartTime: hasParameter('replayStartTime')
                ? parameters.replayStartTime
                : targetType === 'stream'
                  ? subscription.replayStartTime || null
                  : null,
            stopTime: hasParameter('stopTime') ? parameters.stopTime : subscription.stopTime || null,
            dscp: hasParameter('dscp') ? parameters.dscp : (subscription.dscp ?? null),
            weighting: hasParameter('weighting') ? parameters.weighting : (subscription.weighting ?? null),
            dependency: hasParameter('dependency') ? parameters.dependency : (subscription.dependency ?? null),
            encoding: hasParameter('encoding') ? parameters.encoding : subscription.encoding || null,
            encodingNamespaces: hasParameter('encodingNamespaces')
                ? { ...(parameters.encodingNamespaces || {}) }
                : { ...(subscription.encodingNamespaces || {}) },
            updateTrigger,
            period:
                targetType !== 'datastore'
                    ? null
                    : updatingPolicy
                      ? updateTrigger === 'periodic'
                          ? hasParameter('period')
                              ? parameters.period
                              : switchingPolicy
                                ? null
                                : (subscription.period ?? null)
                          : null
                      : targetChanged
                        ? null
                        : (subscription.period ?? null),
            anchorTime:
                targetType !== 'datastore'
                    ? null
                    : updatingPolicy
                      ? updateTrigger === 'periodic'
                          ? hasParameter('anchorTime')
                              ? parameters.anchorTime
                              : switchingPolicy
                                ? null
                                : subscription.anchorTime || null
                          : null
                      : targetChanged
                        ? null
                        : subscription.anchorTime || null,
            dampeningPeriod:
                targetType !== 'datastore'
                    ? null
                    : updatingPolicy
                      ? updateTrigger === 'on-change'
                          ? hasParameter('dampeningPeriod')
                              ? parameters.dampeningPeriod
                              : switchingPolicy
                                ? 0
                                : (subscription.dampeningPeriod ?? 0)
                          : null
                      : targetChanged
                        ? null
                        : (subscription.dampeningPeriod ?? null),
            // RFC 8641 marks these on-change parameters immutable after
            // establishment.  Keep their established values even while another
            // update-trigger case is active so a later policy switch cannot
            // accidentally manufacture new immutable values.
            syncOnStart: subscription.syncOnStart ?? null,
            excludedChanges: subscription.excludedChanges || [],
            requestXml: requestXml || subscription.requestXml,
            messageId: messageId || subscription.messageId,
            updatedAt: new Date().toISOString(),
            ...(shouldActivate
                ? {
                      error: null,
                      suspensionReason: null,
                      desynchronized: false,
                      desynchronizedAt: null,
                      desynchronizationReason: null
                  }
                : {})
        });
        this.emitSubscription(subscription);
        this.scheduleSubscriptionStop(subscription);
        return this.publicSubscription(subscription);
    }

    applyModernPolicySnapshot(subscription, parameters, notificationXml, transportSequence = null) {
        if (!subscription || !parameters) return null;
        const targetType = parameters.targetType === 'datastore' ? 'datastore' : 'stream';
        const updateTrigger = targetType === 'datastore' ? parameters.updateTrigger || null : null;
        const subscribedFeatures = new Set(subscription.capabilitySupport?.subscribedNotificationFeatures || []);
        const now = new Date().toISOString();
        Object.assign(subscription, {
            targetType,
            type: targetType === 'datastore' ? 'rfc8641' : 'rfc8639',
            subscriptionType: targetType === 'datastore' ? 'yang-push' : 'rfc8639',
            state: 'ACTIVE',
            stream: targetType === 'stream' ? parameters.stream || 'NETCONF' : null,
            datastore: targetType === 'datastore' ? parameters.datastore || null : null,
            datastoreNamespaces: targetType === 'datastore' ? { ...(parameters.datastoreNamespaces || {}) } : {},
            filter: normalizeFilter(parameters.filter),
            replayStartTime: parameters.replayStartTime || null,
            stopTime: parameters.stopTime || null,
            dscp: subscribedFeatures.has('dscp') ? (parameters.dscp ?? 0) : null,
            weighting: parameters.weighting ?? null,
            dependency: parameters.dependency ?? null,
            encoding: parameters.encoding || null,
            encodingNamespaces: { ...(parameters.encodingNamespaces || {}) },
            updateTrigger,
            period: updateTrigger === 'periodic' ? (parameters.period ?? null) : null,
            anchorTime: updateTrigger === 'periodic' ? parameters.anchorTime || null : null,
            dampeningPeriod: updateTrigger === 'on-change' ? (parameters.dampeningPeriod ?? 0) : null,
            syncOnStart:
                updateTrigger === 'on-change' ? (parameters.syncOnStart ?? true) : (subscription.syncOnStart ?? null),
            excludedChanges:
                updateTrigger === 'on-change' && Array.isArray(parameters.excludedChanges)
                    ? [...parameters.excludedChanges]
                    : subscription.excludedChanges || [],
            updatedAt: now,
            modifiedNotificationAt: now,
            modifiedNotificationXml: notificationXml || null,
            suspensionReason: null,
            desynchronized: false,
            desynchronizedAt: null,
            desynchronizationReason: null,
            error: null
        });
        this.recordLifecycleTransition(subscription, transportSequence);
        subscription._lastPolicySnapshotRevision = Number(subscription._lifecycleRevision || 0);
        const snapshotSequence = Number(transportSequence);
        if (Number.isSafeInteger(snapshotSequence) && snapshotSequence > 0) {
            subscription._lastPolicySnapshotTransportSequence = snapshotSequence;
        }
        this.emitSubscription(subscription);
        this.scheduleSubscriptionStop(subscription);
        return this.publicSubscription(subscription);
    }

    markModernPolicySnapshotUnknown(
        subscription,
        error,
        transportSequence = null,
        reason = 'invalid-subscription-modified-notification'
    ) {
        if (!subscription) return null;
        this.clearSubscriptionStopTimer(subscription.id);
        const now = new Date().toISOString();
        subscription.state = 'UNKNOWN';
        subscription.updatedAt = now;
        subscription.desynchronized = true;
        subscription.desynchronizedAt = now;
        subscription.desynchronizationReason = reason;
        subscription.error = error || {
            name: 'Error',
            code: 'NETCONF_INVALID_SUBSCRIPTION_NOTIFICATION',
            message: 'subscription-modified 通知缺少完整或合法的订阅策略'
        };
        this.recordLifecycleTransition(subscription, transportSequence);
        subscription._lastPolicySnapshotRevision = Number(subscription._lifecycleRevision || 0);
        const snapshotSequence = Number(transportSequence);
        if (Number.isSafeInteger(snapshotSequence) && snapshotSequence > 0) {
            subscription._lastPolicySnapshotTransportSequence = snapshotSequence;
        }
        this.emitSubscription(subscription);
        return this.publicSubscription(subscription);
    }

    terminateSubscription(entry, subscription, reason, error = null, emitState = true, transportSequence = null) {
        if (!subscription || !this.isUnresolvedSubscription(subscription)) return null;
        this.clearSubscriptionStopTimer(subscription.id);
        subscription.state = 'TERMINATED';
        subscription.terminatedAt = new Date().toISOString();
        subscription.updatedAt = subscription.terminatedAt;
        subscription.terminationReason = reason || 'session-closed';
        subscription.error = error ? errorData(error) : null;
        subscription.desynchronized = false;
        subscription.desynchronizedAt = null;
        subscription.desynchronizationReason = null;
        this.recordLifecycleTransition(subscription, transportSequence);
        if (entry?.activeSubscriptionId === subscription.id) entry.activeSubscriptionId = null;
        this.emitSubscription(subscription);
        if (emitState && entry) this.emitState(entry, { subscriptionChanged: true });
        this.pruneSubscriptionHistory(subscription.profileId);
        return this.publicSubscription(subscription);
    }

    terminateActiveSubscription(entry, reason, error = null) {
        const subscription = this.activeSubscription(entry);
        return this.terminateSubscription(entry, subscription, reason, error);
    }

    terminateSessionSubscriptions(entry, reason, error = null) {
        const info = entry?.client?.sessionInfo?.() || {};
        const subscriptions = this.sessionSubscriptions(entry, info.sessionId || null, false).filter(subscription =>
            this.isUnresolvedSubscription(subscription)
        );
        const terminated = subscriptions
            .map(subscription => this.terminateSubscription(entry, subscription, reason, error, false))
            .filter(Boolean);
        if (terminated.length > 0) this.emitState(entry, { subscriptionChanged: true });
        return terminated;
    }

    getSubscriptions(profileId = null) {
        const normalizedProfileId =
            profileId === undefined || profileId === null || profileId === '' ? null : String(profileId);
        if (normalizedProfileId) this.reconcileProfileSubscriptionStops(this.sessions.get(normalizedProfileId));
        else for (const entry of this.sessions.values()) this.reconcileProfileSubscriptionStops(entry);
        const subscriptions = [...this.subscriptions.values()]
            .filter(subscription => !normalizedProfileId || subscription.profileId === normalizedProfileId)
            .map(subscription => this.publicSubscription(subscription))
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
        return {
            profileId: normalizedProfileId,
            subscriptions,
            activeCount: subscriptions.filter(subscription => subscription.state === 'ACTIVE').length,
            suspendedCount: subscriptions.filter(subscription => subscription.state === 'SUSPENDED').length,
            liveCount: subscriptions.filter(subscription => this.isLiveSubscription(subscription)).length,
            unknownCount: subscriptions.filter(subscription => subscription.state === 'UNKNOWN').length,
            total: subscriptions.length,
            queriedAt: new Date().toISOString()
        };
    }

    bindClient(entry, client) {
        client.on('notification', notification => {
            const receivedAt = new Date().toISOString();
            const emitNotification = () => {
                const info = client.sessionInfo?.() || {};
                const event = notificationEventDescriptor(notification);
                const eventName = event.name;
                const sessionId = info.sessionId || null;
                const liveSubscriptions = this.sessionSubscriptions(entry, sessionId, true);
                const eventStreamCandidates =
                    !event.modernEvent && !event.hasPublisherSubscriptionId
                        ? liveSubscriptions.filter(candidate => candidate.targetType !== 'datastore')
                        : [];
                let subscription =
                    event.hasPublisherSubscriptionId && event.publisherSubscriptionId
                        ? this.subscriptionByPublisherId(entry, event.publisherSubscriptionId, sessionId, true) ||
                          this.subscriptionByPublisherId(entry, event.publisherSubscriptionId, sessionId, false)
                        : null;
                if (
                    !subscription &&
                    !event.hasPublisherSubscriptionId &&
                    !event.modernEvent &&
                    eventStreamCandidates.length === 1
                ) {
                    subscription = eventStreamCandidates[0];
                }
                if (
                    !subscription &&
                    !event.hasPublisherSubscriptionId &&
                    !event.modernEvent &&
                    entry.client !== client
                ) {
                    const fallback = this.subscriptionForSession(entry, sessionId);
                    if (fallback?.targetType !== 'datastore') subscription = fallback;
                }
                this.emit(YANG_EVT_TYPES.NOTIFICATION, {
                    profileId: entry.profileId,
                    ...profileSummary(entry),
                    sessionId: sessionId || subscription?.sessionId || null,
                    baseVersion: info.baseVersion || subscription?.baseVersion || null,
                    capabilitySupport: capabilitySupportFrom(info.capabilities || [], entry.schemaInventory),
                    subscriptionId: subscription?.subscriptionId || null,
                    publisherSubscriptionId:
                        event.publisherSubscriptionId || subscription?.publisherSubscriptionId || null,
                    candidateSubscriptionIds:
                        !subscription && eventStreamCandidates.length > 1
                            ? eventStreamCandidates.map(candidate => candidate.subscriptionId)
                            : [],
                    subscriptionType: subscription?.subscriptionType || null,
                    targetType: subscription?.targetType || null,
                    stream: subscription?.stream || null,
                    datastore: subscription?.datastore || null,
                    state: subscription?.state || 'UNSUBSCRIBED',
                    receivedAt,
                    eventTime: notification.eventTime,
                    eventName,
                    namespace: event.namespace,
                    subscriptionParameters: event.parameters,
                    subscriptionParameterError: event.parameterError,
                    xml: notification.xml,
                    document: notification.document
                });
                if (
                    eventName === 'notificationComplete' &&
                    event.namespace === NETCONF_NOTIFICATION_NAMESPACE &&
                    subscription?.id === entry.activeSubscriptionId
                ) {
                    this.terminateActiveSubscription(entry, 'notification-complete');
                } else if (
                    subscription &&
                    subscription.subscriptionType !== 'rfc5277' &&
                    event.subscribedNotificationEvent &&
                    event.hasPublisherSubscriptionId &&
                    String(subscription.publisherSubscriptionId || '') ===
                        String(event.publisherSubscriptionId || '') &&
                    String(subscription.state || '').toUpperCase() !== 'TERMINATED'
                ) {
                    const now = new Date().toISOString();
                    if (eventName === 'subscription-suspended') {
                        subscription.state = 'SUSPENDED';
                        subscription.suspendedAt = now;
                        subscription.updatedAt = now;
                        subscription.suspensionReason = event.reason || null;
                        subscription.desynchronized = false;
                        subscription.desynchronizedAt = null;
                        subscription.desynchronizationReason = null;
                        subscription.error = null;
                        this.recordLifecycleTransition(subscription, notification.transportSequence);
                        this.emitSubscription(subscription);
                        this.emitState(entry, { subscriptionChanged: true });
                    } else if (eventName === 'subscription-resumed') {
                        subscription.state = 'ACTIVE';
                        subscription.resumedAt = now;
                        subscription.updatedAt = now;
                        subscription.suspensionReason = null;
                        subscription.desynchronized = false;
                        subscription.desynchronizedAt = null;
                        subscription.desynchronizationReason = null;
                        subscription.error = null;
                        this.recordLifecycleTransition(subscription, notification.transportSequence);
                        this.emitSubscription(subscription);
                        this.emitState(entry, { subscriptionChanged: true });
                    } else if (eventName === 'subscription-modified') {
                        if (event.parameters && !event.parameterError) {
                            this.applyModernPolicySnapshot(
                                subscription,
                                event.parameters,
                                notification.xml,
                                notification.transportSequence
                            );
                        } else {
                            this.markModernPolicySnapshotUnknown(
                                subscription,
                                event.parameterError,
                                notification.transportSequence
                            );
                        }
                        this.emitState(entry, { subscriptionChanged: true });
                    } else if (eventName === 'replay-completed') {
                        subscription.replayCompletedAt = now;
                        subscription.updatedAt = now;
                        this.emitSubscription(subscription);
                    } else if (eventName === 'subscription-completed') {
                        this.terminateSubscription(
                            entry,
                            subscription,
                            'subscription-completed',
                            null,
                            true,
                            notification.transportSequence
                        );
                    } else if (eventName === 'subscription-terminated') {
                        this.terminateSubscription(
                            entry,
                            subscription,
                            event.reason ? `subscription-terminated:${event.reason}` : 'subscription-terminated',
                            null,
                            true,
                            notification.transportSequence
                        );
                    } else {
                        subscription.lastNotificationAt = now;
                    }
                }
            };
            // A server may put the first notification in the same transport read as the
            // successful rpc-reply. Let the waiting RPC continuation register the
            // subscription first so that notification keeps its Session association.
            if (entry.subscriptionPending) setImmediate(emitNotification);
            else emitNotification();
        });
        client.on('protocol-error', error => {
            entry.lastError = errorData(error);
            this.emitState(entry, { protocolError: entry.lastError });
        });
        client.on('close', error => {
            if (entry.client !== client) return;
            this.terminateSessionSubscriptions(
                entry,
                entry.manualClose ? (this.closing ? 'application-close' : 'session-disconnected') : 'connection-lost',
                entry.manualClose ? null : error
            );
            entry.client = null;
            entry.connectedAt = null;
            entry.disconnectedAt = new Date().toISOString();
            entry.lastError = entry.manualClose ? null : errorData(error);
            entry.status = 'disconnected';
            this.emitState(entry);
            if (!entry.manualClose && entry.profile.autoReconnect && !this.closing) this.scheduleReconnect(entry);
            else this.scrubEntrySecrets(entry);
        });
    }

    async connectEntry(entry, reconnecting = false, requestId = null) {
        if (reconnecting) this.terminateSessionSubscriptions(entry, 'session-reconnected');
        entry.manualClose = false;
        entry.status = reconnecting ? 'reconnecting' : 'connecting';
        entry.lastError = null;
        entry.observed = {};
        this.emitState(entry);
        const runtime = this.prepareProfile(entry.profile, entry.observed);
        const client = this.clientFactory({
            rpcTimeout: Number(runtime.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
            helloTimeout: Number(runtime.connectTimeout) || NETCONF_LIMITS.DEFAULT_CONNECT_TIMEOUT,
            maxMessageSize: NETCONF_LIMITS.MAX_MESSAGE_BYTES
        });
        entry.client = client;
        this.bindClient(entry, client);
        try {
            await client.connect(runtime);
            if (entry.client !== client || entry.manualClose || (requestId && this.cancelledRequests.has(requestId))) {
                client.disconnect?.('connection request cancelled');
                throw this.requestCancelledError();
            }
            if (!entry.profile.hostKeyFingerprint && entry.observed.hostKeyFingerprint) {
                entry.profile = {
                    ...entry.profile,
                    hostKeyFingerprint: entry.observed.hostKeyFingerprint
                };
            }
            entry.status = 'connected';
            entry.connectedAt = new Date().toISOString();
            entry.disconnectedAt = null;
            entry.reconnectAttempt = 0;
            this.emitState(entry);
            this.scheduleSchemaDiscovery(entry);
            return this.publicState(entry);
        } catch (error) {
            if (entry.client === client) entry.client = null;
            const cancelled = error?.code === 'NETCONF_CONNECT_CANCELLED' || entry.manualClose;
            if (cancelled) client.disconnect?.('connection request cancelled');
            entry.lastError = cancelled ? null : errorData(error);
            if (reconnecting && entry.profile.autoReconnect && !entry.manualClose && !this.closing) {
                this.scheduleReconnect(entry);
            }
            entry.status = cancelled ? 'disconnected' : entry.reconnectTimer ? 'reconnecting' : 'error';
            if (cancelled) this.scrubEntrySecrets(entry);
            this.emitState(entry);
            if (cancelled && error?.code !== 'NETCONF_CONNECT_CANCELLED') throw this.requestCancelledError();
            throw error;
        }
    }

    scheduleReconnect(entry) {
        if (entry.reconnectTimer || entry.manualClose || this.closing) return;
        entry.reconnectAttempt += 1;
        const delay = Math.min(MAX_RECONNECT_DELAY, 1000 * 2 ** Math.min(entry.reconnectAttempt - 1, 5));
        entry.status = 'reconnecting';
        this.emitState(entry, { reconnectDelay: delay });
        entry.reconnectTimer = setTimeout(async () => {
            entry.reconnectTimer = null;
            try {
                await this.connectEntry(entry, true);
            } catch (_error) {
                // connectEntry schedules the next bounded retry.
            }
        }, delay);
    }

    beginSchemaDiscovery(entry, timeout = 30000) {
        if (!entry?.client?.connected || entry.status !== 'connected') return Promise.resolve(null);
        if (entry.schemaDiscoveryPromise) return entry.schemaDiscoveryPromise;
        const client = entry.client;
        if (typeof client.discoverSchemas !== 'function') return Promise.resolve(null);
        const discovery = client
            .discoverSchemas({
                timeout,
                capabilities: client.sessionInfo?.().capabilities || []
            })
            .then(inventory => {
                if (entry.client !== client || !client.connected || entry.status !== 'connected') return null;
                entry.schemaInventory = inventory;
                entry.schemaDiscoveryError = null;
                return inventory;
            })
            .catch(error => {
                if (entry.client === client) entry.schemaDiscoveryError = errorData(error);
                throw error;
            })
            .finally(() => {
                if (entry.schemaDiscoveryPromise === discovery) entry.schemaDiscoveryPromise = null;
                if (entry.client === client && client.connected && entry.status === 'connected') {
                    this.emitState(entry, { capabilityDiscoveryChanged: true });
                }
            });
        entry.schemaDiscoveryPromise = discovery;
        return discovery;
    }

    scheduleSchemaDiscovery(entry) {
        const info = entry?.client?.sessionInfo?.() || {};
        const capabilities = info.capabilities || [];
        const advertisesYangLibrary = capabilities.some(capability =>
            String(capability || '').includes('urn:ietf:params:netconf:capability:yang-library:')
        );
        if (
            !advertisesYangLibrary ||
            typeof entry.client?.discoverSchemas !== 'function' ||
            entry.schemaInventory ||
            entry.schemaDiscoveryPromise
        )
            return;
        const timeout = Math.min(30000, Number(entry.profile?.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT);
        this.beginSchemaDiscovery(entry, timeout).catch(() => {
            // Capability discovery is best effort and must not tear down an otherwise valid NETCONF Session.
        });
    }

    async ensureModernCapabilityKnown(entry) {
        const info = entry?.client?.sessionInfo?.() || {};
        let support = capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        if (support.subscribedNotificationsModule || entry.schemaInventory) return support;
        const advertisesYangLibrary = (info.capabilities || []).some(capability =>
            String(capability || '').includes('urn:ietf:params:netconf:capability:yang-library:')
        );
        if (entry.schemaDiscoveryPromise || advertisesYangLibrary) {
            try {
                await (entry.schemaDiscoveryPromise ||
                    this.beginSchemaDiscovery(
                        entry,
                        Math.min(30000, Number(entry.profile?.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT)
                    ));
            } catch (_error) {
                // assertCanEstablishSubscription below reports the standards-facing capability error.
            }
            support = capabilitySupportFrom(info.capabilities || [], entry.schemaInventory);
        }
        return support;
    }

    async testConnection(profile) {
        const observed = {};
        const runtime = this.prepareProfile(profile, observed);
        const client = this.clientFactory({
            rpcTimeout: Number(runtime.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
            helloTimeout: Number(runtime.connectTimeout) || NETCONF_LIMITS.DEFAULT_CONNECT_TIMEOUT,
            maxMessageSize: NETCONF_LIMITS.MAX_MESSAGE_BYTES
        });
        try {
            const info = await client.connect(runtime);
            const capabilitySupport = capabilitySupportFrom(info.capabilities || []);
            return {
                ...info,
                ...observed,
                profileId: profile?.id ? String(profile.id) : null,
                profileName: profile?.name || profile?.id || '',
                host: profile?.host || '',
                port: Number(profile?.port) || 830,
                connected: true,
                status: 'connected',
                supportsNotification: capabilitySupport.notification,
                supportsInterleave: capabilitySupport.interleave,
                supportsSubscribedNotifications: capabilitySupport.subscribedNotifications,
                supportsYangPush: capabilitySupport.yangPush,
                notificationFeatures: {
                    rfc5277: capabilitySupport.notification,
                    rfc8639: capabilitySupport.subscribedNotifications,
                    rfc8640: capabilitySupport.subscribedNotifications,
                    rfc8641: capabilitySupport.yangPush,
                    yangPush: capabilitySupport.yangPush,
                    subscribedNotificationFeatures: capabilitySupport.subscribedNotificationFeatures,
                    yangPushFeatures: capabilitySupport.yangPushFeatures
                },
                capabilitySupport
            };
        } finally {
            if (client.connected) {
                try {
                    await client.closeSession({ timeout: 5000 });
                } catch (_error) {
                    client.disconnect('connection test complete');
                }
            } else {
                client.disconnect('connection test complete');
            }
        }
    }

    async connectProfile(profile, requestId = null) {
        if (!profile?.id) throw new Error('NETCONF连接缺少profile id');
        if (requestId && this.cancelledRequests.has(requestId)) throw this.requestCancelledError();
        const profileId = String(profile.id);
        const existing = this.sessions.get(profileId);
        if (existing?.client?.connected) {
            await this.disconnectOtherProfiles(profileId);
            return this.publicState(existing);
        }
        if (existing) await this.disconnect(profileId);
        if (requestId && this.cancelledRequests.has(requestId)) throw this.requestCancelledError();
        const entry = this.createEntry(profile);
        this.sessions.set(profileId, entry);
        if (requestId) this.activeConnectRequests.set(requestId, entry);
        try {
            const state = await this.connectEntry(entry, false, requestId);
            if (requestId && this.cancelledRequests.has(requestId)) throw this.requestCancelledError();
            await this.disconnectOtherProfiles(profileId);
            return state;
        } finally {
            if (requestId) this.activeConnectRequests.delete(requestId);
        }
    }

    connect(profile, requestId = null) {
        const request = this.connectQueue.then(() => this.connectProfile(profile, requestId));
        this.connectQueue = request.catch(() => {});
        return request;
    }

    async disconnectOtherProfiles(activeProfileId) {
        const retainedId = String(activeProfileId || '');
        for (const [profileId, entry] of [...this.sessions.entries()]) {
            if (profileId === retainedId) continue;
            const active =
                entry?.client ||
                entry?.reconnectTimer ||
                ['connected', 'connecting', 'reconnecting', 'disconnecting'].includes(entry?.status);
            if (active) await this.disconnect(profileId);
        }
    }

    requireConnected(profileId) {
        const entry = this.sessions.get(String(profileId || ''));
        if (!entry?.client?.connected || entry.status !== 'connected') {
            const error = new Error('NETCONF会话未连接');
            error.code = 'NETCONF_NOT_CONNECTED';
            throw error;
        }
        return entry;
    }

    getSessionState(profileId) {
        const normalizedProfileId = String(profileId || '');
        const entry = this.sessions.get(normalizedProfileId);
        return entry ? this.publicState(entry) : { ...this.publicState(null), profileId: normalizedProfileId || null };
    }

    async disconnect(profileId) {
        const entry = this.sessions.get(String(profileId || ''));
        if (!entry) return { ...this.publicState(null), profileId: profileId || null };
        entry.manualClose = true;
        if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = null;
        }
        entry.status = 'disconnecting';
        this.emitState(entry);
        const client = entry.client;
        if (client?.connected) {
            try {
                await client.closeSession({ timeout: 5000 });
            } catch (_error) {
                client.disconnect('session disconnected');
            }
        } else if (client) {
            client.disconnect('session disconnected');
        }
        entry.client = null;
        this.terminateSessionSubscriptions(entry, this.closing ? 'application-close' : 'session-disconnected');
        entry.status = 'disconnected';
        entry.connectedAt = null;
        entry.disconnectedAt = new Date().toISOString();
        entry.lastError = null;
        this.scrubEntrySecrets(entry);
        this.emitState(entry);
        return this.publicState(entry);
    }

    async purgeProfile(profileId) {
        const normalizedProfileId = String(profileId || '');
        if (!normalizedProfileId) return { profileId: null, removedSubscriptions: 0 };
        const entry = this.sessions.get(normalizedProfileId);
        if (entry?.client || entry?.reconnectTimer) await this.disconnect(normalizedProfileId);
        this.sessions.delete(normalizedProfileId);
        let removedSubscriptions = 0;
        for (const [subscriptionId, subscription] of this.subscriptions.entries()) {
            if (String(subscription.profileId || '') !== normalizedProfileId) continue;
            if (this.subscriptions.delete(subscriptionId)) removedSubscriptions += 1;
        }
        return { profileId: normalizedProfileId, removedSubscriptions };
    }

    async disconnectAll() {
        this.closing = true;
        try {
            const states = [];
            for (const profileId of this.sessions.keys()) states.push(await this.disconnect(profileId));
            return states;
        } finally {
            this.closing = false;
        }
    }

    async discoverModules(profileId) {
        const entry = this.requireConnected(profileId);
        const inventory = await this.beginSchemaDiscovery(entry, 120000);
        return {
            ...inventory,
            profileId: entry.profileId,
            discoveredAt: new Date().toISOString()
        };
    }

    async getSchema(profileId, module = {}) {
        const entry = this.requireConnected(profileId);
        const identifier = module.identifier || module.name;
        if (!identifier) throw new Error('下载YANG模型需要模块名');
        if ((module.format || 'yang').toLowerCase() !== 'yang') throw new Error('当前仅支持下载YANG格式模型');
        const result = await entry.client.getSchema({
            identifier,
            version: module.version || module.revision || undefined,
            format: 'yang',
            timeout: 120000
        });
        if (Buffer.byteLength(result.content, 'utf8') > NETCONF_LIMITS.MAX_SCHEMA_BYTES) {
            const error = new Error('设备返回的YANG模型超过大小限制');
            error.code = 'NETCONF_SCHEMA_TOO_LARGE';
            throw error;
        }
        const parsed = parseYang(result.content, {
            sourceName: `${identifier}${result.version ? `@${result.version}` : ''}.yang`
        });
        const dependencies = [
            ...(parsed.metadata?.imports || []).map(item => ({ ...item, kind: 'module' })),
            ...(parsed.metadata?.includes || []).map(item => ({ ...item, kind: 'submodule' }))
        ];
        return {
            ...result,
            dependencies,
            source: `netconf://${entry.profileId}/${identifier}${result.version ? `@${result.version}` : ''}`
        };
    }

    buildOperation(request) {
        switch (request.operation) {
            case 'get':
                return buildGet(request);
            case 'get-config':
                return buildGetConfig(request);
            case 'edit-config':
                return buildEditConfig(request);
            case 'copy-config':
                return buildCopyConfig(request);
            case 'delete-config':
                return buildDeleteConfig(request);
            case 'lock':
                return buildLock(request);
            case 'unlock':
                return buildUnlock(request);
            case 'validate':
                return buildValidate(request);
            case 'commit':
                return buildCommit(request);
            case 'cancel-commit':
                return buildCancelCommit(request);
            case 'discard-changes':
                return buildDiscardChanges(request);
            case 'kill-session':
                return buildKillSession(request.sessionId, request);
            case 'create-subscription':
                return buildCreateSubscription(request);
            case 'establish-subscription':
                return buildEstablishSubscription(request);
            case 'modify-subscription':
                return buildModifySubscription(request);
            case 'delete-subscription':
                return buildDeleteSubscription(request);
            case 'kill-subscription':
                return buildKillSubscription(request);
            case 'resync-subscription':
                return buildResyncSubscription(request);
            default: {
                const error = new Error(`不支持的NETCONF操作: ${request.operation}`);
                error.code = 'NETCONF_UNSUPPORTED_OPERATION';
                throw error;
            }
        }
    }

    requestUsesDatastore(request = {}) {
        return Boolean(
            request.targetType === 'datastore' ||
                ['yang-push', 'rfc8641'].includes(request.subscriptionType) ||
                request.datastore ||
                request.datastoreFilter ||
                request.datastoreFilterName ||
                request.selectionFilterRef ||
                request.updateTrigger ||
                request.trigger ||
                request.mode ||
                request.period !== undefined ||
                request.dampeningPeriod !== undefined
        );
    }

    modernParameters(request = {}, defaults = false) {
        const targetType = this.requestUsesDatastore(request) ? 'datastore' : 'stream';
        const hasValue = name =>
            Object.prototype.hasOwnProperty.call(request, name) &&
            request[name] !== undefined &&
            request[name] !== null &&
            request[name] !== '';
        const assignValue = (parameters, name, value, present = hasValue(name)) => {
            if (defaults || present) parameters[name] = value;
        };
        const filterProvided =
            targetType === 'datastore'
                ? ['selectionFilterRef', 'datastoreFilterName', 'datastoreFilter', 'filter'].some(hasValue)
                : ['streamFilterName', 'filterName', 'streamFilter', 'filter'].some(hasValue);
        const filter =
            targetType === 'datastore'
                ? request.selectionFilterRef || request.datastoreFilterName
                    ? { type: 'reference', name: request.selectionFilterRef || request.datastoreFilterName }
                    : (request.datastoreFilter ?? request.filter ?? null)
                : request.streamFilterName || request.filterName
                  ? { type: 'reference', name: request.streamFilterName || request.filterName }
                  : (request.streamFilter ?? request.filter ?? null);
        const parameters = { targetType };
        if (targetType === 'stream') {
            if (defaults) parameters.stream = request.stream || 'NETCONF';
            parameters.datastore = null;
            parameters.datastoreNamespaces = {};
        } else {
            parameters.stream = null;
            parameters.datastore = request.datastore || (defaults ? 'operational' : null);
            parameters.datastoreNamespaces = { ...(request.datastoreNamespaces || {}) };
        }
        assignValue(parameters, 'replayStartTime', request.replayStartTime || null);
        assignValue(parameters, 'stopTime', request.stopTime || null);
        assignValue(parameters, 'dscp', request.dscp ?? null);
        assignValue(parameters, 'weighting', request.weighting ?? null);
        assignValue(parameters, 'dependency', request.dependency ?? null);
        assignValue(parameters, 'encoding', request.encoding || null);
        if (defaults || hasValue('encoding')) {
            parameters.encodingNamespaces = { ...(request.encodingNamespaces || {}) };
        }
        const updateTrigger = request.updateTrigger || request.trigger || request.mode || null;
        const hasUpdateTrigger = ['updateTrigger', 'trigger', 'mode'].some(hasValue);
        assignValue(parameters, 'updateTrigger', updateTrigger, hasUpdateTrigger);
        assignValue(parameters, 'period', request.period ?? null);
        assignValue(parameters, 'anchorTime', request.anchorTime || null);
        assignValue(parameters, 'dampeningPeriod', request.dampeningPeriod ?? null);
        assignValue(parameters, 'syncOnStart', request.syncOnStart ?? null);
        const hasExcludedChanges =
            (Object.prototype.hasOwnProperty.call(request, 'excludedChanges') &&
                request.excludedChanges !== undefined &&
                request.excludedChanges !== null) ||
            (Object.prototype.hasOwnProperty.call(request, 'excludedChange') &&
                request.excludedChange !== undefined &&
                request.excludedChange !== null);
        if (defaults || hasExcludedChanges) {
            parameters.excludedChanges = Array.isArray(request.excludedChanges)
                ? [...request.excludedChanges]
                : request.excludedChange
                  ? [request.excludedChange]
                  : [];
        }
        if (defaults || filterProvided) parameters.filter = filter;
        return parameters;
    }

    resolveManagedSubscription(entry, request = {}, liveOnly = true) {
        this.reconcileProfileSubscriptionStops(entry);
        const requested =
            request.publisherSubscriptionId ??
            request.deviceSubscriptionId ??
            request.id ??
            request.subscriptionId ??
            null;
        if (requested === null || requested === undefined || requested === '') return null;
        const internal = this.subscriptions.get(String(requested));
        if (internal && internal.profileId === entry.profileId && internal.subscriptionType !== 'rfc5277') {
            return !liveOnly || this.isLiveSubscription(internal) ? internal : null;
        }
        const info = entry.client?.sessionInfo?.() || {};
        return this.subscriptionByPublisherId(entry, requested, info.sessionId || null, liveOnly);
    }

    prepareManagementRequest(entry, request = {}) {
        const subscription = this.resolveManagedSubscription(entry, request, true);
        const requested =
            request.publisherSubscriptionId ??
            request.deviceSubscriptionId ??
            request.id ??
            request.subscriptionId ??
            null;
        if (OWNER_ONLY_SUBSCRIPTION_OPERATIONS.has(request.operation) && !subscription) {
            const history = this.resolveManagedSubscription(entry, request, false);
            const unknown = String(history?.state || '').toUpperCase() === 'UNKNOWN';
            const error = new Error(
                unknown
                    ? `订阅 ${requested} 的设备状态因 RPC 超时已失同步；请重连后重新建立订阅`
                    : `当前 NETCONF Session 未跟踪订阅 ${requested ?? ''}，不能执行 ${request.operation}`
            );
            error.code = unknown ? 'NETCONF_SUBSCRIPTION_STATE_UNKNOWN' : 'NETCONF_SUBSCRIPTION_NOT_TRACKED';
            error.subscription = this.publicSubscription(history);
            throw error;
        }
        const publisherSubscriptionId = subscription?.publisherSubscriptionId || requested;
        const normalized = {
            ...request,
            id: publisherSubscriptionId,
            publisherSubscriptionId
        };
        if (request.operation === 'modify-subscription' && subscription) {
            const requestedTargetType = String(request.targetType || '').trim();
            if (
                ['datastore', 'stream'].includes(requestedTargetType) &&
                requestedTargetType !== subscription.targetType
            ) {
                const error = new Error(
                    'modify-subscription 不支持切换 stream/datastore target；请删除订阅后按新 target 重新建立'
                );
                error.code = 'NETCONF_SUBSCRIPTION_TARGET_CHANGE_UNSUPPORTED';
                error.subscription = this.publicSubscription(subscription);
                throw error;
            }
            const targetType = ['datastore', 'stream'].includes(requestedTargetType)
                ? requestedTargetType
                : subscription.targetType;
            normalized.targetType = targetType;
            normalized.subscriptionType = targetType === 'datastore' ? 'yang-push' : 'rfc8639';
            const filterFields = [
                'filter',
                'streamFilter',
                'streamFilterName',
                'filterName',
                'datastoreFilter',
                'datastoreFilterName',
                'selectionFilterRef'
            ];
            const filterMode = String(request.filterMode || request.filterAction || '')
                .trim()
                .toLowerCase();
            const objectFilter = filterFields
                .map(field => request[field])
                .find(value => value && typeof value === 'object' && !Array.isArray(value));
            const objectFilterType = String(objectFilter?.type || '')
                .trim()
                .toLowerCase();
            const clearFilterRequested =
                request.clearFilter === true ||
                ['none', 'clear', 'remove'].includes(filterMode) ||
                ['none', 'clear', 'remove'].includes(objectFilterType);
            if (clearFilterRequested) {
                const error = new Error(
                    'RFC 8639/8641 modify-subscription 没有可移除既有 filter 的清除值；请保持不变或提供新的 filter'
                );
                error.code = 'NETCONF_SUBSCRIPTION_FILTER_CLEAR_UNSUPPORTED';
                error.subscription = this.publicSubscription(subscription);
                throw error;
            }
            for (const field of filterFields) {
                const value = normalized[field];
                if (
                    value === undefined ||
                    value === null ||
                    value === '' ||
                    (value && typeof value === 'object' && value.type === 'unchanged')
                ) {
                    delete normalized[field];
                }
            }
            delete normalized.filterMode;
            delete normalized.filterAction;
            delete normalized.clearFilter;
            const hasFilter = filterFields.some(field => Object.prototype.hasOwnProperty.call(normalized, field));
            if (
                ['updateTrigger', 'trigger', 'mode'].some(
                    field =>
                        String(normalized[field] || '')
                            .trim()
                            .toLowerCase() === 'unchanged'
                )
            ) {
                delete normalized.updateTrigger;
                delete normalized.trigger;
                delete normalized.mode;
            }
            if (normalized.stopTime === undefined || normalized.stopTime === null || normalized.stopTime === '') {
                delete normalized.stopTime;
            }
            if (targetType === 'datastore') {
                normalized.datastore =
                    request.datastore ||
                    (subscription.targetType === 'datastore' ? subscription.datastore : null) ||
                    'operational';
                if (!Object.prototype.hasOwnProperty.call(request, 'datastoreNamespaces')) {
                    normalized.datastoreNamespaces =
                        subscription.targetType === 'datastore' ? { ...(subscription.datastoreNamespaces || {}) } : {};
                }
            } else if (!hasFilter) {
                if (subscription.targetType === 'stream' && subscription.filter) {
                    normalized.streamFilter = subscription.filter;
                } else {
                    const error = new Error(
                        'event stream 的 modify-subscription 必须提供 filter，才能选择 RFC 8639 mandatory target'
                    );
                    error.code = 'NETCONF_SUBSCRIPTION_TARGET_REQUIRED';
                    error.subscription = this.publicSubscription(subscription);
                    throw error;
                }
            }
        }
        return { request: normalized, subscription, publisherSubscriptionId };
    }

    async executeOperation(profileId, request, workerRequestId = null) {
        const entry = this.requireConnected(profileId);
        if (request.operation === 'establish-subscription') await this.ensureModernCapabilityKnown(entry);
        let normalizedRequest = request;
        let managedSubscription = null;
        let publisherSubscriptionId = null;
        if (
            ['modify-subscription', 'delete-subscription', 'kill-subscription', 'resync-subscription'].includes(
                request.operation
            )
        ) {
            const prepared = this.prepareManagementRequest(entry, request);
            normalizedRequest = prepared.request;
            managedSubscription = prepared.subscription;
            publisherSubscriptionId = prepared.publisherSubscriptionId;
        }
        const rpc = this.buildOperation(normalizedRequest);
        let subscriptionOperation = null;
        if (request.operation === 'create-subscription') {
            subscriptionOperation = {
                operation: request.operation,
                type: 'rfc5277',
                parameters: {
                    stream: request.stream || 'NETCONF',
                    filter: request.filter || null,
                    startTime: request.startTime || null,
                    stopTime: request.stopTime || null
                }
            };
        } else if (request.operation === 'establish-subscription') {
            subscriptionOperation = {
                operation: request.operation,
                type: 'rfc8639',
                parameters: this.modernParameters(request, true)
            };
        } else if (managedSubscription || publisherSubscriptionId !== null) {
            subscriptionOperation = {
                operation: request.operation,
                type: 'subscription-management',
                publisherSubscriptionId,
                subscription: managedSubscription,
                parameters:
                    request.operation === 'modify-subscription' ? this.modernParameters(normalizedRequest, false) : null
            };
        }
        return this.performRpc(entry, rpc, { ...normalizedRequest, subscriptionOperation, workerRequestId });
    }

    async sendRpc(profileId, request, workerRequestId = null) {
        const entry = this.requireConnected(profileId);
        const rpc = String(request.rpc || request.xml || '').trim();
        if (!rpc) throw new Error('请输入NETCONF RPC XML');
        if (Buffer.byteLength(rpc, 'utf8') > NETCONF_LIMITS.MAX_RAW_RPC_BYTES) {
            const error = new Error('NETCONF RPC超过大小限制');
            error.code = 'NETCONF_RPC_TOO_LARGE';
            throw error;
        }
        assertSafeXml(rpc, { maxXmlSize: NETCONF_LIMITS.MAX_RAW_RPC_BYTES });
        const subscriptionOperation = rawSubscriptionOperation(rpc);
        if (subscriptionOperation?.operation === 'establish-subscription') {
            await this.ensureModernCapabilityKnown(entry);
        }
        if (subscriptionOperation?.type === 'subscription-management') {
            subscriptionOperation.rawRequest = true;
            subscriptionOperation.subscription = this.subscriptionByPublisherId(
                entry,
                subscriptionOperation.publisherSubscriptionId,
                entry.client?.sessionInfo?.().sessionId || null,
                true
            );
            if (
                OWNER_ONLY_SUBSCRIPTION_OPERATIONS.has(subscriptionOperation.operation) &&
                !subscriptionOperation.subscription
            ) {
                const history = this.subscriptionByPublisherId(
                    entry,
                    subscriptionOperation.publisherSubscriptionId,
                    entry.client?.sessionInfo?.().sessionId || null,
                    false
                );
                const unknown = String(history?.state || '').toUpperCase() === 'UNKNOWN';
                const error = new Error(
                    unknown
                        ? `订阅 ${subscriptionOperation.publisherSubscriptionId} 的设备状态因 RPC 超时已失同步；请重连后重新建立订阅`
                        : `当前 NETCONF Session 未跟踪订阅 ${subscriptionOperation.publisherSubscriptionId ?? ''}，不能执行 ${subscriptionOperation.operation}`
                );
                error.code = unknown ? 'NETCONF_SUBSCRIPTION_STATE_UNKNOWN' : 'NETCONF_SUBSCRIPTION_NOT_TRACKED';
                error.subscription = this.publicSubscription(history);
                throw error;
            }
        }
        return this.performRpc(entry, rpc, { ...request, subscriptionOperation, workerRequestId });
    }

    async performRpc(entry, rpc, options = {}) {
        const startedAt = Date.now();
        const client = entry.client;
        const sessionInfo = client?.sessionInfo?.() || {};
        const subscriptionOperation = options.subscriptionOperation || null;
        const isLegacyEstablish = subscriptionOperation?.operation === 'create-subscription';
        const isModernEstablish = subscriptionOperation?.operation === 'establish-subscription';
        const pendingType = isLegacyEstablish ? 'legacy' : isModernEstablish ? 'modern' : null;
        const managedSubscription = subscriptionOperation?.subscription || null;
        const expectedLifecycleRevision = Number(managedSubscription?._lifecycleRevision || 0);
        if (isLegacyEstablish) {
            this.assertCanCreateSubscription(entry);
        } else if (isModernEstablish) {
            const support = this.assertCanEstablishSubscription(entry);
            this.assertModernRequestSupported(
                entry,
                subscriptionOperation.operation,
                subscriptionOperation.parameters,
                null,
                support
            );
        } else if (['modify-subscription', 'resync-subscription'].includes(subscriptionOperation?.operation)) {
            this.assertModernRequestSupported(
                entry,
                subscriptionOperation.operation,
                subscriptionOperation.parameters || {},
                managedSubscription
            );
        }
        if (pendingType) this.beginSubscription(entry, pendingType);
        let reply;
        let activeRpcRequest = null;
        try {
            const rpcMessageId =
                options.messageId === undefined || options.messageId === null
                    ? (extractRpcMessageId(rpc) ??
                      (typeof client.reserveMessageId === 'function' ? String(client.reserveMessageId()) : null))
                    : String(options.messageId);
            if (options.workerRequestId && this.cancelledRequests.has(options.workerRequestId)) {
                throw new NetconfRpcCancelledError(rpcMessageId || 'pending');
            }
            const rpcPromise = client.rpc(rpc, {
                timeout:
                    Number(options.timeout) || Number(entry.profile.rpcTimeout) || NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT,
                messageId: rpcMessageId ?? options.messageId,
                rejectOnRpcError: false
            });
            if (options.workerRequestId && rpcMessageId !== null) {
                activeRpcRequest = { client, messageId: rpcMessageId, profileId: entry.profile.id };
                this.activeRpcRequests.set(options.workerRequestId, activeRpcRequest);
            }
            reply = await rpcPromise;
        } catch (error) {
            if (error?.code === 'NETCONF_RPC_TIMEOUT') {
                if (isLegacyEstablish || isModernEstablish) {
                    if (client.connected) client.disconnect(error);
                }
            }
            if (
                ['NETCONF_RPC_TIMEOUT', 'NETCONF_RPC_CANCELLED'].includes(error?.code) &&
                ['modify-subscription', 'delete-subscription', 'kill-subscription', 'resync-subscription'].includes(
                    subscriptionOperation?.operation
                ) &&
                managedSubscription
            ) {
                this.markSubscriptionUnknown(entry, managedSubscription, subscriptionOperation.operation, error);
            }
            throw error;
        } finally {
            if (
                options.workerRequestId &&
                activeRpcRequest &&
                this.activeRpcRequests.get(options.workerRequestId) === activeRpcRequest
            ) {
                this.activeRpcRequests.delete(options.workerRequestId);
            }
            if (pendingType) this.endSubscription(entry, pendingType);
        }
        const replyBytes = Buffer.byteLength(reply.xml, 'utf8');
        const largeReply = replyBytes > NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES;
        const result = {
            rpc,
            requestXml: reply.requestXml || rpc,
            reply: reply.xml,
            messageId: reply.messageId,
            ok: reply.ok,
            errors: reply.errors,
            duration: Date.now() - startedAt,
            replyBytes,
            replyTruncated: largeReply
        };
        // A large parsed NETCONF <data> tree can be tens of times larger than its
        // XML source. Keep exactly one full response string for the worker -> main
        // handoff; the main process externalizes it before crossing renderer IPC.
        if (!largeReply) {
            result.xml = reply.xml;
            result.data = reply.data;
        }
        const successful = !Array.isArray(reply.errors) || reply.errors.length === 0;
        if (isLegacyEstablish && successful) {
            result.subscription = this.activateSubscription(
                entry,
                subscriptionOperation.parameters,
                result.requestXml,
                result.messageId,
                sessionInfo
            );
            if (entry.client !== client || !client.connected || entry.status !== 'connected') {
                result.subscription = this.terminateActiveSubscription(entry, 'connection-lost');
            }
        } else if (isModernEstablish && successful) {
            try {
                result.subscription = this.activateModernSubscription(
                    entry,
                    subscriptionOperation.parameters,
                    result.requestXml,
                    result.messageId,
                    reply,
                    sessionInfo
                );
            } catch (error) {
                client.disconnect(error);
                throw error;
            }
            if (entry.client !== client || !client.connected || entry.status !== 'connected') {
                const internal = this.subscriptions.get(result.subscription.id);
                result.subscription = this.terminateSubscription(entry, internal, 'connection-lost');
            }
        } else if (subscriptionOperation?.operation === 'modify-subscription' && successful) {
            const rawTargetChanged =
                subscriptionOperation.rawRequest &&
                subscriptionOperation.parameters?.targetType &&
                subscriptionOperation.subscription?.targetType !== subscriptionOperation.parameters.targetType;
            result.subscription = rawTargetChanged
                ? this.markModernPolicySnapshotUnknown(
                      subscriptionOperation.subscription,
                      {
                          name: 'Error',
                          code: 'NETCONF_SUBSCRIPTION_POLICY_SNAPSHOT_PENDING',
                          message:
                              'raw modify-subscription 已切换 target；等待设备 subscription-modified 完整快照后再恢复跟踪'
                      },
                      reply.transportSequence,
                      'raw-target-change-awaiting-subscription-modified'
                  )
                : this.updateModernSubscription(
                      subscriptionOperation.subscription,
                      subscriptionOperation.parameters,
                      result.requestXml,
                      result.messageId,
                      {
                          expectedLifecycleRevision,
                          replyTransportSequence: reply.transportSequence
                      }
                  );
            if (result.subscription) this.emitState(entry, { subscriptionChanged: true });
        } else if (
            ['delete-subscription', 'kill-subscription'].includes(subscriptionOperation?.operation) &&
            successful
        ) {
            result.subscription = this.terminateSubscription(
                entry,
                subscriptionOperation.subscription,
                subscriptionOperation.operation
            );
        } else if (subscriptionOperation?.operation === 'resync-subscription' && successful) {
            const subscription = subscriptionOperation.subscription;
            if (subscription) {
                subscription.lastResyncAt = new Date().toISOString();
                subscription.updatedAt = subscription.lastResyncAt;
                subscription.requestXml = result.requestXml;
                subscription.messageId = result.messageId;
                this.emitSubscription(subscription);
            }
            result.subscription = this.publicSubscription(subscription);
        } else if (subscriptionOperation) {
            result.subscription = null;
        }
        if (
            options.operation === 'get-config' &&
            options.extractConfig === true &&
            (!Array.isArray(reply.errors) || reply.errors.length === 0)
        ) {
            if (largeReply) {
                result.configTruncated = true;
            } else {
                Object.assign(
                    result,
                    rpcReplyDataToConfig(reply.xml, {
                        maxXmlSize: NETCONF_LIMITS.MAX_RAW_RPC_BYTES
                    })
                );
            }
        }
        return result;
    }
}

if (parentEndpoint && require.main === module) new NetconfWorkerService(parentEndpoint);

module.exports = NetconfWorkerService;
