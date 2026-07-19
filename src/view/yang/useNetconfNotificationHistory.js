import { computed, reactive, readonly, ref } from 'vue';

export const NETCONF_NOTIFICATION_HISTORY_DEFAULTS = Object.freeze({
    maxRecords: 500,
    maxTotalBytes: 16 * 1024 * 1024,
    maxXmlBytes: 2 * 1024 * 1024,
    maxSubscriptions: 256
});

const NETCONF_NOTIFICATION_EVENT = 'netconf:notification';
const NETCONF_SUBSCRIPTION_EVENT = 'netconf:subscriptionEvent';
const COLLECTOR_ID = 'netconf-notification-history-collector';
const MAX_METADATA_BYTES = 16 * 1024;
const MIN_TOTAL_BYTES = 64 * 1024;
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

const records = ref([]);
const subscriptions = ref([]);
const selectedNotificationId = ref('');
const selectedScopeKey = ref('notification-scope:all');
const fullTextQuery = ref('');
const unreadOnly = ref(false);
const totalBytes = ref(0);
const limits = reactive({ ...NETCONF_NOTIFICATION_HISTORY_DEFAULTS });
const collectorInstallations = new WeakMap();
let notificationSequence = 0;
let subscriptionSequence = 0;

const textValue = value => String(value ?? '');
const nowIso = () => new Date().toISOString();
const encodeScopePart = value => encodeURIComponent(textValue(value));

const normalizeSubscriptionStatus = (value, fallback = 'active') => {
    const status = textValue(value).trim().toLowerCase();
    if (['active', 'subscribed'].includes(status)) return 'active';
    if (['pending', 'creating', 'starting', 'in-progress'].includes(status)) return 'pending';
    if (
        [
            'terminated',
            'ended',
            'complete',
            'completed',
            'closed',
            'stopped',
            'cancelled',
            'canceled',
            'expired',
            'disconnected'
        ].includes(status)
    )
        return 'ended';
    if (['error', 'failed', 'failure'].includes(status)) return 'error';
    if (['unsubscribed', 'unassigned', 'none'].includes(status)) return 'unassigned';
    return status || fallback;
};

const utf8Bytes = value => {
    const text = textValue(value);
    if (encoder) return encoder.encode(text).byteLength;
    return text.length * 2;
};

const truncateUtf8 = (value, maxBytes, markerText = 'NetNexus：内容已截断') => {
    const text = textValue(value);
    if (utf8Bytes(text) <= maxBytes) return { value: text, truncated: false };
    const marker = `\n<!-- ${markerText} -->`;
    const markerBytes = utf8Bytes(marker);
    if (markerBytes >= maxBytes)
        return { value: marker.slice(0, Math.max(0, Math.floor(maxBytes / 2))), truncated: true };

    let low = 0;
    let high = text.length;
    const availableBytes = maxBytes - markerBytes;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (utf8Bytes(text.slice(0, middle)) <= availableBytes) low = middle;
        else high = middle - 1;
    }
    return { value: `${text.slice(0, low)}${marker}`, truncated: true };
};

const metadataText = value => truncateUtf8(value, MAX_METADATA_BYTES, 'NetNexus：字段已截断').value;
const metadataJson = value => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return metadataText(value);
    try {
        return metadataText(JSON.stringify(value));
    } catch (_error) {
        return metadataText(value);
    }
};

const recordBytes = record =>
    utf8Bytes(
        JSON.stringify({
            ...record,
            estimatedBytes: undefined
        })
    );

const validDateText = (value, fallback = '') => {
    const text = textValue(value).trim();
    if (!text) return fallback;
    return Number.isNaN(Date.parse(text)) ? metadataText(text) : new Date(text).toISOString();
};

const localName = value => textValue(value).split(':').pop() || '';

const eventDescriptorFromXml = xml => {
    const source = textValue(xml);
    const tagPattern = /<([A-Za-z_][\w.:-]*)(\s[^<>]*?)?\s*\/?>/gu;
    for (const match of source.matchAll(tagPattern)) {
        const qualifiedName = match[1];
        const name = localName(qualifiedName);
        if (['notification', 'eventTime'].includes(name)) continue;
        const prefix = qualifiedName.includes(':') ? qualifiedName.slice(0, qualifiedName.lastIndexOf(':')) : '';
        const attributes = match[2] || '';
        const namespacePattern = prefix
            ? new RegExp(`\\bxmlns:${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*["']([^"']+)["']`, 'u')
            : /\bxmlns\s*=\s*["']([^"']+)["']/u;
        return {
            name,
            qualifiedName,
            namespace: attributes.match(namespacePattern)?.[1] || source.match(namespacePattern)?.[1] || ''
        };
    }
    return { name: 'notification', qualifiedName: 'notification', namespace: '' };
};

const eventTimeFromXml = xml =>
    textValue(xml)
        .match(/<(?:[A-Za-z_][\w.-]*:)?eventTime\b[^>]*>\s*([^<]+?)\s*<\/(?:[A-Za-z_][\w.-]*:)?eventTime\s*>/u)?.[1]
        ?.trim() || '';

const wrapperKeys = new Set(['status', 'msg', 'message', 'code', 'type', 'data']);

const isUnifiedWrapper = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) return false;
    if (Object.hasOwn(value, 'xml') || Object.hasOwn(value, 'notificationXml')) return false;
    if (Object.hasOwn(value, 'status')) return true;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every(key => wrapperKeys.has(key));
};

export const unwrapNetconfNotificationPayload = payload => {
    let current = payload;
    const inherited = {};
    let depth = 0;
    while (isUnifiedWrapper(current) && depth < 8) {
        for (const [key, value] of Object.entries(current)) {
            if (!wrapperKeys.has(key) && inherited[key] === undefined) inherited[key] = value;
        }
        current = current.data;
        depth += 1;
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) return { ...inherited, ...current };
    return current;
};

const subscriptionMatchesNotification = (subscription, notification) =>
    (!subscription.profileId || subscription.profileId === notification.profileId) &&
    (!subscription.sessionId || subscription.sessionId === notification.sessionId) &&
    (!subscription.eventName || subscription.eventName === notification.eventName) &&
    ['active', 'pending'].includes(subscription.status);

const resolveSubscription = notification => {
    if (notification.subscriptionId) {
        return subscriptions.value.find(item => item.id === notification.subscriptionId) || null;
    }
    const matches = subscriptions.value.filter(item => subscriptionMatchesNotification(item, notification));
    return matches.length === 1 ? matches[0] : null;
};

const keepSelectionValid = () => {
    if (selectedNotificationId.value && records.value.some(record => record.id === selectedNotificationId.value))
        return;
    selectedNotificationId.value = records.value[0]?.id || '';
};

function keepScopeSelectionValid() {
    const containsKey = groups =>
        groups.some(
            group =>
                group.key === selectedScopeKey.value || containsKey(Array.isArray(group.children) ? group.children : [])
        );
    if (!containsKey(notificationGroups.value)) selectedScopeKey.value = 'notification-scope:all';
}

function keepFilteredSelectionValid() {
    const visible = filteredNetconfNotifications.value;
    if (visible.some(record => record.id === selectedNotificationId.value)) return;
    selectedNotificationId.value = visible[0]?.id || '';
}

const trimRecords = () => {
    const retained = [];
    let retainedBytes = 0;
    for (const source of records.value.slice(0, limits.maxRecords)) {
        let record = source;
        let bytes = recordBytes(record);
        if (retained.length === 0 && bytes > limits.maxTotalBytes) {
            const replacement = truncateUtf8(
                record.xml,
                Math.max(1024, limits.maxTotalBytes - 8 * 1024),
                'NetNexus：通知过大，仅保留前部内容'
            );
            record = { ...record, xml: replacement.value, xmlTruncated: true };
            bytes = recordBytes(record);
        }
        if (retainedBytes + bytes > limits.maxTotalBytes) break;
        retained.push({ ...record, estimatedBytes: bytes });
        retainedBytes += bytes;
    }
    records.value = retained;
    totalBytes.value = retainedBytes;
    keepSelectionValid();
    keepScopeSelectionValid();
    keepFilteredSelectionValid();
};

const nextNotificationId = () => `netconf-notification-${Date.now()}-${++notificationSequence}`;
const nextSubscriptionId = () => `netconf-subscription-${Date.now()}-${++subscriptionSequence}`;

const normalizeSubscription = input => {
    const source = unwrapNetconfNotificationPayload(input) || {};
    const nested = source.subscription && typeof source.subscription === 'object' ? source.subscription : {};
    const value = { ...source, ...nested };
    const existingId = textValue(value.id || value.subscriptionId).trim();
    const id = metadataText(existingId || nextSubscriptionId());
    const previous = subscriptions.value.find(item => item.id === id);
    const createdAt = validDateText(value.createdAt || value.startedAt, previous?.createdAt || nowIso());
    const rawError = value.errorMessage || value.error?.message || value.error?.msg || value.error;
    return {
        ...previous,
        id,
        key: id,
        profileId: metadataText(value.profileId ?? previous?.profileId),
        profileName: metadataText(value.profileName ?? previous?.profileName),
        host: metadataText(value.host ?? previous?.host),
        port: value.port ?? previous?.port ?? '',
        sessionId: metadataText(value.sessionId ?? previous?.sessionId),
        label: metadataText(value.label || value.name || previous?.label || value.eventName || value.stream || '订阅'),
        stream: metadataText(value.stream || previous?.stream || 'NETCONF'),
        eventName: metadataText(value.eventName || value.notificationName || previous?.eventName),
        filter: metadataJson(value.filterXml || value.filter || previous?.filter),
        status: normalizeSubscriptionStatus(
            value.subscriptionStatus || value.state || value.status || previous?.status || 'active'
        ),
        createdAt,
        updatedAt: validDateText(value.updatedAt || value.receivedAt, nowIso()),
        terminatedAt: validDateText(value.terminatedAt || value.endedAt, previous?.terminatedAt || ''),
        terminationReason: metadataText(value.terminationReason || value.reason || previous?.terminationReason),
        errorMessage: metadataJson(rawError || previous?.errorMessage)
    };
};

export const upsertNetconfNotificationSubscription = input => {
    const subscription = normalizeSubscription(input);
    const index = subscriptions.value.findIndex(item => item.id === subscription.id);
    const next = [...subscriptions.value];
    if (index >= 0) next.splice(index, 1);
    next.unshift(subscription);
    subscriptions.value = next.slice(0, limits.maxSubscriptions);
    return subscription;
};

export const updateNetconfNotificationSubscription = (subscriptionId, patch = {}) =>
    upsertNetconfNotificationSubscription({ ...patch, id: subscriptionId });

export const removeNetconfNotificationSubscription = (subscriptionId, options = {}) => {
    const id = textValue(subscriptionId);
    const subscription = subscriptions.value.find(item => item.id === id);
    subscriptions.value = subscriptions.value.filter(subscription => subscription.id !== id);
    if (options.clearNotifications && subscription) {
        clearNetconfNotifications({
            kind: 'subscription',
            profileId: subscription.profileId,
            sessionId: subscription.sessionId,
            subscriptionId: id
        });
    }
    if (scopeForKey(selectedScopeKey.value).subscriptionId === id) selectedScopeKey.value = 'notification-scope:all';
    keepScopeSelectionValid();
    keepFilteredSelectionValid();
};

export const endNetconfNotificationSession = (profileId, sessionId, status = 'ended') => {
    const updatedAt = nowIso();
    const normalizedStatus = normalizeSubscriptionStatus(status, 'ended');
    subscriptions.value = subscriptions.value.map(subscription =>
        subscription.profileId === textValue(profileId) && subscription.sessionId === textValue(sessionId)
            ? { ...subscription, status: normalizedStatus, updatedAt, terminatedAt: updatedAt }
            : subscription
    );
};

const normalizeNotification = input => {
    const source = unwrapNetconfNotificationPayload(input) || {};
    const nested = source.notification && typeof source.notification === 'object' ? source.notification : {};
    const value = { ...source, ...nested };
    const rawXml = textValue(value.xml || value.notificationXml || value.payloadXml || nested.xml).trim();
    if (!rawXml) return null;
    const boundedXmlBytes = Math.max(1024, Math.min(limits.maxXmlBytes, limits.maxTotalBytes - 8 * 1024));
    const xml = truncateUtf8(rawXml, boundedXmlBytes, 'NetNexus：通知 XML 已截断');
    const descriptor = eventDescriptorFromXml(xml.value);
    const receivedAt = validDateText(value.receivedAt || value.receivedTime, nowIso());
    const rawSubscriptionStatus = value.subscriptionStatus || value.subscriptionState || value.state;
    const notification = {
        id: metadataText(value.id || value.eventId || nextNotificationId()),
        profileId: metadataText(value.profileId),
        profileName: metadataText(value.profileName),
        host: metadataText(value.host),
        port: value.port ?? '',
        sessionId: metadataText(value.sessionId),
        subscriptionId: metadataText(value.subscriptionId),
        subscriptionName: metadataText(value.subscriptionName || value.subscriptionLabel),
        subscriptionStatus: normalizeSubscriptionStatus(rawSubscriptionStatus, ''),
        stream: metadataText(value.stream),
        eventName: metadataText(value.eventName || value.notificationName || descriptor.name),
        qualifiedName: metadataText(value.qualifiedName || descriptor.qualifiedName),
        namespace: metadataText(value.namespace || descriptor.namespace),
        generatedAt: validDateText(value.generatedAt || value.eventTime || eventTimeFromXml(xml.value), ''),
        receivedAt,
        xml: xml.value,
        xmlTruncated: xml.truncated || Boolean(value.xmlTruncated),
        read: value.read === true,
        sequence: ++notificationSequence
    };
    const matchedSubscription = resolveSubscription(notification);
    if (matchedSubscription) {
        notification.subscriptionId = matchedSubscription.id;
        notification.subscriptionName = notification.subscriptionName || matchedSubscription.label;
        notification.stream = notification.stream || matchedSubscription.stream;
        notification.profileId = notification.profileId || matchedSubscription.profileId;
        notification.profileName = notification.profileName || matchedSubscription.profileName;
        notification.host = notification.host || matchedSubscription.host;
        notification.port = notification.port || matchedSubscription.port;
        notification.sessionId = notification.sessionId || matchedSubscription.sessionId;
    }
    return notification;
};

export const addNetconfNotification = input => {
    const notification = normalizeNotification(input);
    if (!notification) return null;
    const existingIndex = records.value.findIndex(record => record.id === notification.id);
    const next = [...records.value];
    if (existingIndex >= 0) next.splice(existingIndex, 1);
    next.unshift(notification);
    records.value = next;
    if (!selectedNotificationId.value) selectedNotificationId.value = notification.id;
    trimRecords();
    return records.value.find(record => record.id === notification.id) || null;
};

export const ingestNetconfNotificationEvent = payload => {
    const source = unwrapNetconfNotificationPayload(payload);
    if (!source || typeof source !== 'object') return null;
    const nestedNotification =
        source.notification && typeof source.notification === 'object' ? source.notification : null;
    if (source.xml || source.notificationXml || nestedNotification?.xml) {
        return { kind: 'notification', value: addNetconfNotification(source) };
    }
    const kind = textValue(source.kind || source.type || source.event).toLowerCase();
    if (source.subscription || source.subscriptionId || kind.includes('subscription')) {
        return { kind: 'subscription', value: upsertNetconfNotificationSubscription(source) };
    }
    return null;
};

export const netconfNotificationScopeKey = (scope = {}) => {
    const kind = scope.kind || 'all';
    if (kind === 'profile') return `notification-scope:profile:${encodeScopePart(scope.profileId)}`;
    if (kind === 'session') {
        return `notification-scope:session:${encodeScopePart(scope.profileId)}:${encodeScopePart(scope.sessionId)}`;
    }
    if (kind === 'subscription') {
        return `notification-scope:subscription:${encodeScopePart(scope.profileId)}:${encodeScopePart(
            scope.sessionId
        )}:${encodeScopePart(scope.subscriptionId)}`;
    }
    return 'notification-scope:all';
};

const updateGroupCounters = (group, record) => {
    group.count += 1;
    if (!record.read) group.unread += 1;
    if (!group.lastReceivedAt || record.receivedAt > group.lastReceivedAt) group.lastReceivedAt = record.receivedAt;
};

const sortGroups = groups =>
    groups.sort(
        (left, right) =>
            (right.lastReceivedAt || right.updatedAt || '').localeCompare(
                left.lastReceivedAt || left.updatedAt || ''
            ) || left.label.localeCompare(right.label)
    );

export const notificationGroups = computed(() => {
    const profileMap = new Map();
    const sessionMap = new Map();
    const subscriptionMap = new Map();

    const ensureProfile = value => {
        const profileId = textValue(value.profileId);
        const key = netconfNotificationScopeKey({ kind: 'profile', profileId });
        if (!profileMap.has(key)) {
            profileMap.set(key, {
                key,
                kind: 'profile',
                scope: { kind: 'profile', profileId },
                profileId,
                label: value.profileName || value.host || profileId || '未知 Profile',
                count: 0,
                unread: 0,
                lastReceivedAt: '',
                children: []
            });
        }
        return profileMap.get(key);
    };

    const ensureSession = value => {
        const profile = ensureProfile(value);
        const sessionId = textValue(value.sessionId);
        const key = netconfNotificationScopeKey({ kind: 'session', profileId: profile.profileId, sessionId });
        if (!sessionMap.has(key)) {
            const session = {
                key,
                kind: 'session',
                scope: { kind: 'session', profileId: profile.profileId, sessionId },
                profileId: profile.profileId,
                sessionId,
                label: sessionId ? `Session ${sessionId}` : '未标识 Session',
                count: 0,
                unread: 0,
                lastReceivedAt: '',
                children: []
            };
            sessionMap.set(key, session);
            profile.children.push(session);
        }
        return sessionMap.get(key);
    };

    const ensureSubscription = (value, registered = false) => {
        const session = ensureSession(value);
        const subscriptionId = textValue(value.subscriptionId || (registered ? value.id : ''));
        const key = netconfNotificationScopeKey({
            kind: 'subscription',
            profileId: session.profileId,
            sessionId: session.sessionId,
            subscriptionId
        });
        if (!subscriptionMap.has(key)) {
            const subscription = {
                key,
                kind: 'subscription',
                scope: {
                    kind: 'subscription',
                    profileId: session.profileId,
                    sessionId: session.sessionId,
                    subscriptionId
                },
                profileId: session.profileId,
                sessionId: session.sessionId,
                subscriptionId,
                label: value.subscriptionName || value.label || value.eventName || value.stream || '未关联订阅',
                status:
                    value.status ||
                    value.subscriptionStatus ||
                    (registered ? 'active' : subscriptionId ? 'unknown' : 'unassigned'),
                updatedAt: value.updatedAt || '',
                terminatedAt: value.terminatedAt || '',
                terminationReason: value.terminationReason || '',
                errorMessage: value.errorMessage || '',
                count: 0,
                unread: 0,
                lastReceivedAt: '',
                children: []
            };
            subscriptionMap.set(key, subscription);
            session.children.push(subscription);
        }
        return subscriptionMap.get(key);
    };

    subscriptions.value.forEach(subscription => ensureSubscription(subscription, true));
    records.value.forEach(record => {
        const profile = ensureProfile(record);
        const session = ensureSession(record);
        const subscription = ensureSubscription(record);
        updateGroupCounters(profile, record);
        updateGroupCounters(session, record);
        updateGroupCounters(subscription, record);
    });

    for (const session of sessionMap.values()) sortGroups(session.children);
    for (const profile of profileMap.values()) sortGroups(profile.children);
    const profiles = sortGroups([...profileMap.values()]);
    return [
        {
            key: 'notification-scope:all',
            kind: 'all',
            scope: { kind: 'all' },
            label: '全部通知',
            count: records.value.length,
            unread: records.value.filter(record => !record.read).length,
            lastReceivedAt: records.value[0]?.receivedAt || '',
            children: []
        },
        ...profiles
    ];
});

const flattenGroups = (groups, result = []) => {
    groups.forEach(group => {
        result.push(group);
        flattenGroups(group.children || [], result);
    });
    return result;
};

const scopeForKey = key =>
    flattenGroups(notificationGroups.value).find(group => group.key === key)?.scope || { kind: 'all' };

const matchesScope = (record, scope = {}) => {
    if (!scope.kind || scope.kind === 'all') return true;
    if (record.profileId !== textValue(scope.profileId)) return false;
    if (scope.kind === 'profile') return true;
    if (record.sessionId !== textValue(scope.sessionId)) return false;
    if (scope.kind === 'session') return true;
    const subscriptionId = Object.hasOwn(record, 'xml') ? record.subscriptionId : record.subscriptionId || record.id;
    return subscriptionId === textValue(scope.subscriptionId);
};

const matchesFullText = (record, rawQuery) => {
    const query = textValue(rawQuery).trim().toLowerCase();
    if (!query) return true;
    return [
        record.eventName,
        record.qualifiedName,
        record.namespace,
        record.generatedAt,
        record.receivedAt,
        record.profileId,
        record.profileName,
        record.host,
        record.port,
        record.sessionId,
        record.subscriptionId,
        record.subscriptionName,
        record.subscriptionStatus,
        record.stream,
        record.xml
    ].some(value => textValue(value).toLowerCase().includes(query));
};

const filteredFor = ({ scope, query = '', onlyUnread = false } = {}) =>
    records.value.filter(
        record =>
            matchesScope(record, scope || { kind: 'all' }) &&
            (!onlyUnread || !record.read) &&
            matchesFullText(record, query)
    );

export const filteredNetconfNotifications = computed(() =>
    filteredFor({
        scope: scopeForKey(selectedScopeKey.value),
        query: fullTextQuery.value,
        onlyUnread: unreadOnly.value
    })
);

export const selectedNetconfNotification = computed(
    () => records.value.find(record => record.id === selectedNotificationId.value) || null
);

export const netconfNotificationUnreadCount = computed(() => records.value.filter(record => !record.read).length);

export const selectNetconfNotification = (notificationId, options = {}) => {
    const id = textValue(notificationId);
    if (!id) {
        selectedNotificationId.value = '';
        return null;
    }
    if (!records.value.some(record => record.id === id)) return null;
    selectedNotificationId.value = id;
    if (options.markRead !== false) markNetconfNotificationRead(id);
    return records.value.find(record => record.id === id) || null;
};

export const selectNetconfNotificationScope = scopeOrKey => {
    const key =
        typeof scopeOrKey === 'string'
            ? scopeOrKey
            : netconfNotificationScopeKey(scopeOrKey && typeof scopeOrKey === 'object' ? scopeOrKey : {});
    selectedScopeKey.value = flattenGroups(notificationGroups.value).some(group => group.key === key)
        ? key
        : 'notification-scope:all';
    const first = filteredNetconfNotifications.value[0];
    selectedNotificationId.value = first?.id || '';
    return selectedScopeKey.value;
};

export const setNetconfNotificationQuery = value => {
    fullTextQuery.value = textValue(value);
    keepFilteredSelectionValid();
};

export const setNetconfNotificationUnreadOnly = value => {
    unreadOnly.value = Boolean(value);
    keepFilteredSelectionValid();
};

export function markNetconfNotificationRead(notificationId, read = true) {
    const id = textValue(notificationId);
    records.value = records.value.map(record => (record.id === id ? { ...record, read: Boolean(read) } : record));
    trimRecords();
}

export const markNetconfNotificationScopeRead = (scope = scopeForKey(selectedScopeKey.value), read = true) => {
    records.value = records.value.map(record =>
        matchesScope(record, scope) ? { ...record, read: Boolean(read) } : record
    );
    trimRecords();
};

export const deleteNetconfNotification = notificationId => {
    const id = textValue(notificationId);
    const before = records.value.length;
    records.value = records.value.filter(record => record.id !== id);
    trimRecords();
    return before !== records.value.length;
};

export function clearNetconfNotifications(scope = { kind: 'all' }) {
    const normalizedScope = typeof scope === 'string' ? scopeForKey(scope) : scope || { kind: 'all' };
    const removed = records.value.filter(record => matchesScope(record, normalizedScope)).length;
    records.value = records.value.filter(record => !matchesScope(record, normalizedScope));
    trimRecords();
    return removed;
}

export const deleteNetconfNotificationGroup = (scope = { kind: 'all' }) => {
    const normalizedScope = typeof scope === 'string' ? scopeForKey(scope) : scope || { kind: 'all' };
    const removed = clearNetconfNotifications(normalizedScope);
    if (normalizedScope.kind === 'all') subscriptions.value = [];
    else {
        subscriptions.value = subscriptions.value.filter(subscription => !matchesScope(subscription, normalizedScope));
    }
    selectedScopeKey.value = 'notification-scope:all';
    return removed;
};

const subscriptionsForScope = scope => subscriptions.value.filter(subscription => matchesScope(subscription, scope));

export const createNetconfNotificationExport = (options = {}) => {
    const scope = options.scope || scopeForKey(options.scopeKey || selectedScopeKey.value);
    const query = options.query ?? fullTextQuery.value;
    const onlyUnread = options.onlyUnread ?? unreadOnly.value;
    const notifications = filteredFor({ scope, query, onlyUnread }).map(record => {
        const { estimatedBytes: _estimatedBytes, ...exported } = record;
        return exported;
    });
    return {
        schemaVersion: 1,
        exportedAt: nowIso(),
        scope: { ...scope },
        query: textValue(query),
        onlyUnread: Boolean(onlyUnread),
        count: notifications.length,
        subscriptions: subscriptionsForScope(scope).map(subscription => ({ ...subscription })),
        notifications
    };
};

const escapeXmlAttribute = value =>
    textValue(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const stripXmlDeclaration = value => textValue(value).replace(/^\s*<\?xml[\s\S]*?\?>\s*/u, '');
const xmlCdata = value => `<![CDATA[${stripXmlDeclaration(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

export const serializeNetconfNotificationExport = (options = {}) => {
    const format = textValue(options.format || 'json').toLowerCase();
    const data = createNetconfNotificationExport(options);
    if (format !== 'xml') return JSON.stringify(data, null, 2);
    const entries = data.notifications
        .map(
            notification =>
                `  <entry id="${escapeXmlAttribute(notification.id)}" generated="${escapeXmlAttribute(
                    notification.generatedAt
                )}" received="${escapeXmlAttribute(notification.receivedAt)}">\n    <notification-xml>${xmlCdata(
                    notification.xml
                )}</notification-xml>\n  </entry>`
        )
        .join('\n');
    return `<netnexus-notification-export xmlns="urn:netnexus:notification-export:1" exported-at="${escapeXmlAttribute(
        data.exportedAt
    )}" count="${data.count}">\n${entries}\n</netnexus-notification-export>`;
};

export const netconfNotificationExportDescriptor = (options = {}) => {
    const format = textValue(options.format || 'json').toLowerCase() === 'xml' ? 'xml' : 'json';
    const timestamp = nowIso()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, 'Z');
    return {
        filename: `netconf-notifications-${timestamp}.${format}`,
        mimeType: format === 'xml' ? 'application/xml;charset=utf-8' : 'application/json;charset=utf-8',
        content: serializeNetconfNotificationExport({ ...options, format })
    };
};

export const configureNetconfNotificationHistory = options => {
    const value = options || {};
    const number = (candidate, fallback, min, max) => {
        const parsed = Number(candidate);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
    };
    limits.maxRecords = number(value.maxRecords, limits.maxRecords, 1, 5000);
    limits.maxTotalBytes = number(value.maxTotalBytes, limits.maxTotalBytes, MIN_TOTAL_BYTES, 64 * 1024 * 1024);
    limits.maxXmlBytes = number(
        value.maxXmlBytes,
        limits.maxXmlBytes,
        1024,
        Math.max(1024, limits.maxTotalBytes - 8 * 1024)
    );
    limits.maxSubscriptions = number(value.maxSubscriptions, limits.maxSubscriptions, 1, 1024);
    subscriptions.value = subscriptions.value.slice(0, limits.maxSubscriptions);
    trimRecords();
    return { ...limits };
};

export const resetNetconfNotificationHistory = (options = {}) => {
    records.value = [];
    subscriptions.value = [];
    selectedNotificationId.value = '';
    selectedScopeKey.value = 'notification-scope:all';
    fullTextQuery.value = '';
    unreadOnly.value = false;
    totalBytes.value = 0;
    notificationSequence = 0;
    subscriptionSequence = 0;
    if (options.resetLimits !== false) Object.assign(limits, NETCONF_NOTIFICATION_HISTORY_DEFAULTS);
};

export const installNetconfNotificationCollector = (eventBus, eventNames = {}) => {
    if (!eventBus || typeof eventBus.on !== 'function' || typeof eventBus.off !== 'function') {
        throw new TypeError('installNetconfNotificationCollector requires an EventBus-compatible object');
    }
    collectorInstallations.get(eventBus)?.();

    const notificationEvent =
        typeof eventNames === 'string' ? eventNames : eventNames.NOTIFICATION || NETCONF_NOTIFICATION_EVENT;
    const subscriptionEvent =
        typeof eventNames === 'object' && eventNames.SUBSCRIPTION_EVENT
            ? eventNames.SUBSCRIPTION_EVENT
            : NETCONF_SUBSCRIPTION_EVENT;
    const eventTypes = [...new Set([notificationEvent, subscriptionEvent].filter(Boolean))];
    const handler = payload => ingestNetconfNotificationEvent(payload);
    eventTypes.forEach(eventType => eventBus.on(eventType, COLLECTOR_ID, handler));

    let active = true;
    const dispose = () => {
        if (!active) return;
        active = false;
        eventTypes.forEach(eventType => eventBus.off(eventType, COLLECTOR_ID));
        if (collectorInstallations.get(eventBus) === dispose) collectorInstallations.delete(eventBus);
    };
    collectorInstallations.set(eventBus, dispose);
    return dispose;
};

export const useNetconfNotificationHistory = () => ({
    records: readonly(records),
    subscriptions: readonly(subscriptions),
    groups: notificationGroups,
    filteredRecords: filteredNetconfNotifications,
    selectedRecord: selectedNetconfNotification,
    selectedNotificationId: readonly(selectedNotificationId),
    selectedScopeKey: readonly(selectedScopeKey),
    query: readonly(fullTextQuery),
    unreadOnly: readonly(unreadOnly),
    unreadCount: netconfNotificationUnreadCount,
    totalBytes: readonly(totalBytes),
    limits: readonly(limits),
    addNotification: addNetconfNotification,
    ingestEvent: ingestNetconfNotificationEvent,
    upsertSubscription: upsertNetconfNotificationSubscription,
    updateSubscription: updateNetconfNotificationSubscription,
    removeSubscription: removeNetconfNotificationSubscription,
    endSession: endNetconfNotificationSession,
    selectNotification: selectNetconfNotification,
    selectScope: selectNetconfNotificationScope,
    setQuery: setNetconfNotificationQuery,
    setUnreadOnly: setNetconfNotificationUnreadOnly,
    markRead: markNetconfNotificationRead,
    markScopeRead: markNetconfNotificationScopeRead,
    deleteNotification: deleteNetconfNotification,
    clearNotifications: clearNetconfNotifications,
    deleteGroup: deleteNetconfNotificationGroup,
    createExport: createNetconfNotificationExport,
    serializeExport: serializeNetconfNotificationExport,
    exportDescriptor: netconfNotificationExportDescriptor
});
