export const API_ACCESS_MODE = {
    NONE: 'none',
    HTTP: 'http',
    CLI: 'cli'
};

export const DEFAULT_API_SETTINGS = {
    enabled: false,
    mode: API_ACCESS_MODE.NONE,
    host: '127.0.0.1',
    port: 18080,
    maxPageSize: 1000,
    cliHost: '127.0.0.1',
    cliPort: 3788,
    cliMaxSessions: 5
};
