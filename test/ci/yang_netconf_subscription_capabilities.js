'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const sourcePath = path.join(projectRoot, 'src', 'view', 'yang', 'netconfSubscriptionCapabilities.js');
const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const capabilityModule = new Module(sourcePath, module);
capabilityModule.filename = sourcePath;
capabilityModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
capabilityModule._compile(transformed, sourcePath);

const { SUBSCRIBED_NOTIFICATIONS_NAMESPACE, YANG_PUSH_NAMESPACE, resolveNetconfSubscriptionCapabilities } =
    capabilityModule.exports;

let result = resolveNetconfSubscriptionCapabilities({
    capabilities: [
        `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&features=encode-xml,xpath,subtree,replay`,
        `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&features=on-change`
    ]
});
assert.equal(result.supportsModernNotifications, true);
assert.equal(result.supportsRfc8640, true);
assert.equal(result.supportsYangPush, true);
assert.equal(result.hasSubscribedNotificationFeature('xpath'), true);
assert.equal(result.hasSubscribedNotificationFeature('on-change'), false);
assert.equal(result.hasYangPushFeature('on-change'), true);

result = resolveNetconfSubscriptionCapabilities({
    modules: [
        { name: 'ietf-subscribed-notifications', conformanceType: 'implement', features: [] },
        { name: 'vendor-module', conformanceType: 'implement', features: ['encode-xml', 'xpath', 'on-change'] }
    ]
});
assert.equal(result.subscribedNotificationsModule, true);
assert.equal(result.supportsRfc8640, false, 'features from another module must not enable RFC 8640');
assert.equal(result.hasSubscribedNotificationFeature('xpath'), false);
assert.equal(result.hasYangPushFeature('on-change'), false);

result = resolveNetconfSubscriptionCapabilities({
    capabilities: [
        `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&features=encode-xml`,
        `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&features=on-change`
    ],
    capabilitySupport: {
        subscribedNotifications: false,
        rfc8640: false,
        yangPush: false
    }
});
assert.equal(result.supportsModernNotifications, false, 'explicit false must override inferred capabilities');
assert.equal(result.supportsRfc8640, false);
assert.equal(result.supportsYangPush, false);

result = resolveNetconfSubscriptionCapabilities({
    modules: [
        {
            name: 'ietf-subscribed-notifications',
            conformanceType: 'import',
            importOnly: true,
            features: ['encode-xml']
        },
        { name: 'ietf-yang-push', conformanceType: 'import-only', features: ['on-change'] }
    ]
});
assert.equal(result.subscribedNotificationsModule, false);
assert.equal(result.yangPushModule, false);
assert.equal(result.supportsRfc8640, false);
assert.equal(result.supportsYangPush, false);

console.log('NETCONF subscription capability tests passed');
