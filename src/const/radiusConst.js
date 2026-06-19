export const DEFAULT_VALUES = {
    DEFAULT_AUTH_PORT: 1812,
    DEFAULT_ACCOUNTING_PORT: 1813,
    DEFAULT_COA_PORT: 3799,
    DEFAULT_SHARED_SECRET: 'testing123'
};

export const RADIUS_SUB_EVT_TYPES = {
    REQUEST_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    SESSION_UPDATED: 4
};

export const RADIUS_EVENT_PAGE_ID = {
    PAGE_ID_RADIUS_CONFIG: 1,
    PAGE_ID_RADIUS_REQUEST_LOG: 2,
    PAGE_ID_RADIUS_SESSION: 3
};

export const RADIUS_REQUEST_STATUS = {
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
    CHALLENGED: 'challenged',
    ACCOUNTED: 'accounted',
    ACK: 'ack',
    NAK: 'nak',
    IGNORED: 'ignored',
    ERROR: 'error'
};

export const RADIUS_AUTH_METHODS = {
    PAP: 'PAP',
    CHAP: 'CHAP',
    CHALLENGE: 'CHALLENGE'
};

export const DEFAULT_RADIUS_USERS = [
    {
        username: 'demo',
        password: 'demo',
        enabled: true,
        authType: RADIUS_AUTH_METHODS.PAP,
        serviceType: 2,
        framedProtocol: 1,
        framedIpAddress: '255.255.255.254',
        replyMessage: 'Access accepted'
    },
    {
        username: 'chap',
        password: 'chap',
        enabled: true,
        authType: RADIUS_AUTH_METHODS.CHAP,
        serviceType: 2,
        framedProtocol: 1,
        replyMessage: 'CHAP access accepted'
    },
    {
        username: 'challenge',
        password: 'challenge',
        enabled: true,
        authType: RADIUS_AUTH_METHODS.CHALLENGE,
        challengePrompt: 'Enter challenge response',
        challengeResponse: '654321',
        replyMessage: 'Challenge accepted'
    }
];
