const RADIUS_EVT_TYPES = {
    RADIUS_EVT: 1
};

const RADIUS_SUB_EVT_TYPES = {
    REQUEST_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    SESSION_UPDATED: 4
};

const RADIUS_REQ_TYPES = {
    START_RADIUS: 1,
    STOP_RADIUS: 2,
    GET_REQUEST_LIST: 3,
    CLEAR_REQUEST_HISTORY: 4,
    GET_SESSION_LIST: 5
};

const RADIUS_CODES = {
    ACCESS_REQUEST: 1,
    ACCESS_ACCEPT: 2,
    ACCESS_REJECT: 3,
    ACCOUNTING_REQUEST: 4,
    ACCOUNTING_RESPONSE: 5,
    ACCESS_CHALLENGE: 11,
    DISCONNECT_REQUEST: 40,
    DISCONNECT_ACK: 41,
    DISCONNECT_NAK: 42,
    COA_REQUEST: 43,
    COA_ACK: 44,
    COA_NAK: 45
};

const RADIUS_ATTRIBUTES = {
    USER_NAME: 1,
    USER_PASSWORD: 2,
    CHAP_PASSWORD: 3,
    NAS_IP_ADDRESS: 4,
    NAS_PORT: 5,
    SERVICE_TYPE: 6,
    FRAMED_PROTOCOL: 7,
    FRAMED_IP_ADDRESS: 8,
    FRAMED_IP_NETMASK: 9,
    FILTER_ID: 11,
    FRAMED_MTU: 12,
    REPLY_MESSAGE: 18,
    STATE: 24,
    CLASS: 25,
    VENDOR_SPECIFIC: 26,
    SESSION_TIMEOUT: 27,
    IDLE_TIMEOUT: 28,
    CALLED_STATION_ID: 30,
    CALLING_STATION_ID: 31,
    NAS_IDENTIFIER: 32,
    PROXY_STATE: 33,
    CHAP_CHALLENGE: 60,
    NAS_PORT_TYPE: 61,
    ACCT_STATUS_TYPE: 40,
    ACCT_DELAY_TIME: 41,
    ACCT_INPUT_OCTETS: 42,
    ACCT_OUTPUT_OCTETS: 43,
    ACCT_SESSION_ID: 44,
    ACCT_AUTHENTIC: 45,
    ACCT_SESSION_TIME: 46,
    ACCT_INPUT_PACKETS: 47,
    ACCT_OUTPUT_PACKETS: 48,
    ACCT_TERMINATE_CAUSE: 49,
    ACCT_MULTI_SESSION_ID: 50,
    ACCT_LINK_COUNT: 51,
    EVENT_TIMESTAMP: 55,
    MESSAGE_AUTHENTICATOR: 80,
    NAS_PORT_ID: 87,
    CHARGEABLE_USER_IDENTITY: 89,
    NAS_IPV6_ADDRESS: 95,
    FRAMED_INTERFACE_ID: 96,
    FRAMED_IPV6_PREFIX: 97,
    ERROR_CAUSE: 101
};

const RADIUS_SERVICE_TYPES = {
    LOGIN: 1,
    FRAMED: 2,
    CALLBACK_LOGIN: 3,
    CALLBACK_FRAMED: 4,
    OUTBOUND: 5,
    ADMINISTRATIVE: 6,
    NAS_PROMPT: 7,
    AUTHENTICATE_ONLY: 8,
    CALLBACK_NAS_PROMPT: 9,
    CALL_CHECK: 10,
    CALLBACK_ADMINISTRATIVE: 11,
    AUTHORIZE_ONLY: 17
};

const RADIUS_FRAMED_PROTOCOLS = {
    PPP: 1,
    SLIP: 2,
    ARAP: 3,
    GANDALF: 4,
    XYLOGICS: 5,
    X75: 6
};

const RADIUS_ACCT_STATUS_TYPES = {
    START: 1,
    STOP: 2,
    INTERIM_UPDATE: 3,
    ACCOUNTING_ON: 7,
    ACCOUNTING_OFF: 8
};

const RADIUS_ERROR_CAUSES = {
    UNSUPPORTED_ATTRIBUTE: 401,
    MISSING_ATTRIBUTE: 402,
    UNSUPPORTED_SERVICE: 405,
    INVALID_ATTRIBUTE_VALUE: 407,
    SESSION_CONTEXT_NOT_FOUND: 503,
    RESOURCES_UNAVAILABLE: 506,
    REQUEST_INITIATED: 507,
    MULTIPLE_SESSION_SELECTION_UNSUPPORTED: 508
};

const RADIUS_AUTH_METHODS = {
    PAP: 'PAP',
    CHAP: 'CHAP',
    CHALLENGE: 'CHALLENGE',
    UNKNOWN: 'UNKNOWN'
};

const RADIUS_REQUEST_STATUS = {
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
    CHALLENGED: 'challenged',
    ACCOUNTED: 'accounted',
    ACK: 'ack',
    NAK: 'nak',
    IGNORED: 'ignored',
    ERROR: 'error'
};

const DEFAULT_RADIUS_CONFIG = {
    bindAddress: '0.0.0.0',
    bindAddress6: '::',
    authPort: 1812,
    accountingPort: 1813,
    coaPort: 3799,
    enableAuth: true,
    enableAccounting: true,
    enableDynamicAuth: true,
    enableIpv6: true,
    sharedSecret: 'testing123',
    requireMessageAuthenticator: false,
    rejectUnknownClients: false,
    maxHistory: 500,
    duplicateCacheTtlMs: 30000,
    clients: [],
    users: [
        {
            username: 'demo',
            password: 'demo',
            enabled: true,
            authType: RADIUS_AUTH_METHODS.PAP,
            serviceType: RADIUS_SERVICE_TYPES.FRAMED,
            framedProtocol: RADIUS_FRAMED_PROTOCOLS.PPP,
            framedIpAddress: '255.255.255.254',
            replyMessage: 'Access accepted'
        },
        {
            username: 'chap',
            password: 'chap',
            enabled: true,
            authType: RADIUS_AUTH_METHODS.CHAP,
            serviceType: RADIUS_SERVICE_TYPES.FRAMED,
            framedProtocol: RADIUS_FRAMED_PROTOCOLS.PPP,
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
    ]
};

module.exports = {
    RADIUS_EVT_TYPES,
    RADIUS_SUB_EVT_TYPES,
    RADIUS_REQ_TYPES,
    RADIUS_CODES,
    RADIUS_ATTRIBUTES,
    RADIUS_SERVICE_TYPES,
    RADIUS_FRAMED_PROTOCOLS,
    RADIUS_ACCT_STATUS_TYPES,
    RADIUS_ERROR_CAUSES,
    RADIUS_AUTH_METHODS,
    RADIUS_REQUEST_STATUS,
    DEFAULT_RADIUS_CONFIG
};
