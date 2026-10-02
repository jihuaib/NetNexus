const BmpBgpSession = require('./bmpBgpSession');
const BmpBgpInstance = require('./bmpBgpInstance');
const IdentityFallbackMap = require('./identityFallbackMap');

const SESSION_LOCAL_FIELDS = new Set([
    'socket',
    'messageHandler',
    'bmpWorker',
    'ingestRecord',
    'messageBuffer',
    'bgpSessionMap',
    'bgpInstanceMap'
]);

// Structured clone turns Buffers into Uint8Arrays and drops class prototypes.
// Only data crosses the channel; sockets, methods and owner links stay local.
function cloneIngestValue(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    let clone;
    if (value instanceof Uint8Array) {
        clone = Buffer.from(value);
    } else if (value instanceof Date) {
        clone = new Date(value.getTime());
    } else if (value instanceof ArrayBuffer) {
        clone = value.slice(0);
    } else if (ArrayBuffer.isView(value)) {
        const buffer = cloneIngestValue(value.buffer, seen);
        clone =
            value instanceof DataView
                ? new DataView(buffer, value.byteOffset, value.byteLength)
                : new value.constructor(buffer, value.byteOffset, value.length);
    } else if (value instanceof Map) {
        clone = new Map();
        seen.set(value, clone);
        for (const [key, item] of value) {
            clone.set(cloneIngestValue(key, seen), cloneIngestValue(item, seen));
        }
        return clone;
    } else if (value instanceof Set) {
        clone = new Set();
        seen.set(value, clone);
        for (const item of value) clone.add(cloneIngestValue(item, seen));
        return clone;
    } else {
        clone = Array.isArray(value) ? [] : {};
        seen.set(value, clone);
        for (const [key, item] of Object.entries(value)) {
            if (typeof item !== 'function') clone[key] = cloneIngestValue(item, seen);
        }
        return clone;
    }
    seen.set(value, clone);
    return clone;
}

function snapshotFields(owner, excluded) {
    const fields = {};
    const seen = new Map();
    for (const [key, value] of Object.entries(owner || {})) {
        if (!excluded.has(key) && typeof value !== 'function') {
            fields[key] = cloneIngestValue(value, seen);
        }
    }
    return fields;
}

function createIngestSnapshot(session) {
    if (!session) return null;
    const ownerLinks = new Set(['bmpSession']);
    return {
        session: snapshotFields(session, SESSION_LOCAL_FIELDS),
        bgpSessions: Array.from(session.bgpSessionMap || [], ([key, peer]) => [key, snapshotFields(peer, ownerLinks)]),
        bgpInstances: Array.from(session.bgpInstanceMap || [], ([key, instance]) => [
            key,
            snapshotFields(instance, ownerLinks)
        ])
    };
}

function applyIngestSnapshot(parentMirror, snapshot) {
    if (!parentMirror || !snapshot) return parentMirror;
    const fields = cloneIngestValue(snapshot.session || {});
    for (const [key, value] of Object.entries(fields)) {
        if (!SESSION_LOCAL_FIELDS.has(key) && typeof parentMirror[key] !== 'function') {
            parentMirror[key] = value;
        }
    }

    if (!(parentMirror.bgpSessionMap instanceof Map)) {
        parentMirror.bgpSessionMap = new IdentityFallbackMap(peer =>
            BmpBgpSession.makeKey(peer.sessionType, peer.sessionRd, peer.sessionIp, peer.sessionAs)
        );
    }
    if (!(parentMirror.bgpInstanceMap instanceof Map)) {
        parentMirror.bgpInstanceMap = new IdentityFallbackMap(instance =>
            BmpBgpInstance.makeKey(instance.instanceType, instance.instanceRd, instance.afi, instance.safi)
        );
    }

    parentMirror.bgpSessionMap.clear();
    for (const [key, state] of snapshot.bgpSessions || []) {
        const peer = new BmpBgpSession(parentMirror);
        const fields = cloneIngestValue(state);
        delete fields.bmpSession;
        Object.assign(peer, fields);
        parentMirror.bgpSessionMap.set(key, peer);
    }
    parentMirror.bgpInstanceMap.clear();
    for (const [key, state] of snapshot.bgpInstances || []) {
        const instance = new BmpBgpInstance(parentMirror);
        const fields = cloneIngestValue(state);
        delete fields.bmpSession;
        Object.assign(instance, fields);
        parentMirror.bgpInstanceMap.set(key, instance);
    }
    return parentMirror;
}

module.exports = { createIngestSnapshot, applyIngestSnapshot, cloneIngestValue };
