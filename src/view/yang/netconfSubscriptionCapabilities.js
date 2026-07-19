export const SUBSCRIBED_NOTIFICATIONS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
export const YANG_PUSH_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';

const asArray = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const normalizedFeatureSet = value =>
    new Set(
        asArray(value)
            .flatMap(entry => String(entry || '').split(','))
            .map(entry => entry.trim().toLowerCase())
            .filter(Boolean)
    );

const explicitBoolean = values => {
    const value = values.find(entry => typeof entry === 'boolean');
    return typeof value === 'boolean' ? value : null;
};

const moduleInventory = session => {
    const inventory = session?.modules || session?.yangModules || session?.yangLibrary;
    if (Array.isArray(inventory)) return inventory;
    if (Array.isArray(inventory?.modules)) return inventory.modules;
    return [];
};

const implementedModule = (session, moduleName) =>
    moduleInventory(session).find(module => {
        if (String(module?.name || module?.identifier || '') !== moduleName) return false;
        const conformance = String(module?.conformanceType || module?.conformance || '').toLowerCase();
        return module?.implemented !== false && !module?.importOnly && !['import', 'import-only'].includes(conformance);
    }) || null;

const capabilityModule = (capabilities, moduleName, namespace) => {
    const features = new Set();
    let advertised = false;
    for (const capability of capabilities) {
        const text = String(capability || '');
        const separator = text.indexOf('?');
        const base = separator < 0 ? text : text.slice(0, separator);
        const parameters = new URLSearchParams(separator < 0 ? '' : text.slice(separator + 1));
        if (base !== namespace && parameters.get('module') !== moduleName) continue;
        advertised = true;
        normalizedFeatureSet(parameters.get('features')).forEach(feature => features.add(feature));
    }
    return { advertised, features };
};

const moduleFeatures = (session, moduleName, namespace, explicitKeys) => {
    const capabilities = asArray(session?.capabilities || session?.serverCapabilities);
    const capability = capabilityModule(capabilities, moduleName, namespace);
    const inventory = implementedModule(session, moduleName);
    const features = new Set(capability.features);
    normalizedFeatureSet(inventory?.features || inventory?.feature).forEach(feature => features.add(feature));

    let hasModuleScopedFeatures = false;
    for (const key of explicitKeys) {
        const sources = [session?.capabilitySupport?.[key], session?.notificationFeatures?.[key]];
        for (const source of sources) {
            if (source === undefined || source === null) continue;
            hasModuleScopedFeatures = true;
            normalizedFeatureSet(source).forEach(feature => features.add(feature));
        }
    }

    // Older bridge payloads exposed one flat list. Use it only when there is no
    // module-scoped feature source or module capability to avoid cross-module matches.
    if (!hasModuleScopedFeatures && !capability.advertised && !inventory) {
        normalizedFeatureSet(session?.notificationFeatures).forEach(feature => features.add(feature));
    }
    return { advertised: capability.advertised || Boolean(inventory), features };
};

export const resolveNetconfSubscriptionCapabilities = (session = {}) => {
    const subscribedNotifications = moduleFeatures(
        session,
        'ietf-subscribed-notifications',
        SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
        ['subscribedNotificationFeatures']
    );
    const yangPush = moduleFeatures(session, 'ietf-yang-push', YANG_PUSH_NAMESPACE, ['yangPushFeatures']);
    const capabilitySupport = session?.capabilitySupport || {};
    const notificationFeatures = session?.notificationFeatures || {};
    const explicitModern = explicitBoolean([
        session?.supportsSubscribedNotifications,
        capabilitySupport.subscribedNotifications,
        capabilitySupport.modernNotifications
    ]);
    const explicitRfc8640 = explicitBoolean([notificationFeatures.rfc8640, capabilitySupport.rfc8640]);
    const explicitYangPush = explicitBoolean([session?.supportsYangPush, capabilitySupport.yangPush]);
    const subscribedNotificationsModule =
        explicitBoolean([capabilitySupport.subscribedNotificationsModule]) ?? subscribedNotifications.advertised;
    const yangPushModule = explicitBoolean([capabilitySupport.yangPushModule]) ?? yangPush.advertised;
    const rfc8640 =
        explicitRfc8640 ?? (subscribedNotificationsModule && subscribedNotifications.features.has('encode-xml'));
    const modern = explicitModern ?? rfc8640;
    const supportsYangPush = explicitYangPush ?? (rfc8640 && yangPushModule);

    return {
        subscribedNotificationsModule: Boolean(subscribedNotificationsModule),
        yangPushModule: Boolean(yangPushModule),
        supportsModernNotifications: Boolean(modern),
        supportsRfc8640: Boolean(rfc8640),
        supportsYangPush: Boolean(supportsYangPush),
        subscribedNotificationFeatures: subscribedNotifications.features,
        yangPushFeatures: yangPush.features,
        hasSubscribedNotificationFeature: feature =>
            subscribedNotifications.features.has(String(feature || '').toLowerCase()),
        hasYangPushFeature: feature => yangPush.features.has(String(feature || '').toLowerCase())
    };
};
