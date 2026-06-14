const http = require('http');
const logger = require('../log/logger');
const { DEFAULT_API_SETTINGS } = require('../const/apiConst');

class ExternalApiServer {
    constructor() {
        this.server = null;
        this.routes = [];
        this.settings = { ...DEFAULT_API_SETTINGS };
        this.maxBodyBytes = 64 * 1024;
    }

    setRoutes(routes) {
        this.routes = Array.isArray(routes)
            ? routes.map(route => ({
                  ...route,
                  method: String(route.method || 'GET').toUpperCase()
              }))
            : [];
    }

    clearRoutes() {
        this.routes = [];
    }

    getRunning() {
        return this.server !== null;
    }

    getStatus() {
        return {
            running: this.getRunning(),
            enabled: Boolean(this.settings.enabled),
            host: this.settings.host,
            port: this.settings.port
        };
    }

    async updateSettings(settings) {
        const nextSettings = {
            ...DEFAULT_API_SETTINGS,
            ...(settings || {})
        };

        nextSettings.enabled = Boolean(nextSettings.enabled);
        nextSettings.host = DEFAULT_API_SETTINGS.host;
        nextSettings.port = Number(nextSettings.port) || DEFAULT_API_SETTINGS.port;
        nextSettings.maxPageSize = Number(nextSettings.maxPageSize) || DEFAULT_API_SETTINGS.maxPageSize;
        delete nextSettings.token;

        if (!nextSettings.enabled) {
            this.settings = nextSettings;
            await this.stop();
            return;
        }

        const needsRestart =
            !this.getRunning() ||
            this.settings.host !== nextSettings.host ||
            Number(this.settings.port) !== Number(nextSettings.port);

        const previousSettings = this.settings;
        this.settings = nextSettings;
        if (needsRestart) {
            try {
                await this.stop();
                await this.start();
            } catch (error) {
                this.settings = previousSettings;
                throw error;
            }
        }
    }

    async start() {
        if (this.server) {
            return;
        }

        await new Promise((resolve, reject) => {
            const server = http.createServer(this.handleRequest.bind(this));
            const onError = error => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                this.server = server;
                logger.info(`External API server listening on ${this.settings.host}:${this.settings.port}`);
                resolve();
            };

            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(this.settings.port, this.settings.host);
        });
    }

    async stop() {
        const server = this.server;
        if (!server) {
            return;
        }

        this.server = null;
        await new Promise(resolve => {
            server.close(error => {
                if (error) {
                    logger.error(`External API server close error: ${error.message}`);
                } else {
                    logger.info('External API server stopped');
                }
                resolve();
            });
        });
    }

    findRoute(method, pathname) {
        return this.routes.find(route => route.method === method && route.path === pathname) || null;
    }

    getAllowedMethods(pathname) {
        return Array.from(new Set(this.routes.filter(route => route.path === pathname).map(route => route.method)));
    }

    readJsonBody(req) {
        return new Promise((resolve, reject) => {
            const contentLength = Number(req.headers['content-length'] || 0);
            if (contentLength > this.maxBodyBytes) {
                reject(this.createError(413, 'REQUEST_TOO_LARGE', '请求体过大'));
                return;
            }

            let rawBody = '';
            req.setEncoding('utf8');
            req.on('data', chunk => {
                rawBody += chunk;
                if (Buffer.byteLength(rawBody, 'utf8') > this.maxBodyBytes) {
                    reject(this.createError(413, 'REQUEST_TOO_LARGE', '请求体过大'));
                    req.destroy();
                }
            });
            req.on('end', () => {
                const text = rawBody.trim();
                if (!text) {
                    resolve({});
                    return;
                }

                try {
                    resolve(JSON.parse(text));
                } catch (_error) {
                    reject(this.createError(400, 'INVALID_JSON', '请求体必须是合法 JSON'));
                }
            });
            req.on('error', error => {
                reject(error);
            });
        });
    }

    async handleRequest(req, res) {
        try {
            const method = String(req.method || 'GET').toUpperCase();
            const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
            const pathname = requestUrl.pathname;

            if (method === 'OPTIONS') {
                this.sendJson(res, 204, null);
                return;
            }

            const route = this.findRoute(method, pathname);
            if (!route) {
                const allowedMethods = this.getAllowedMethods(pathname);
                if (allowedMethods.length > 0) {
                    this.sendError(res, 405, 'METHOD_NOT_ALLOWED', '请求方法不支持', {
                        allowedMethods
                    });
                    return;
                }
                this.sendError(res, 404, 'ROUTE_NOT_FOUND', '接口不存在');
                return;
            }

            const body = method === 'GET' || method === 'HEAD' ? {} : await this.readJsonBody(req);
            const query = Object.fromEntries(requestUrl.searchParams.entries());
            const result = await route.handler({
                body,
                query,
                req,
                settings: this.settings
            });

            this.sendApiResult(res, result);
        } catch (error) {
            if (error && error.apiError) {
                this.sendError(res, error.statusCode, error.code, error.message, error.data);
                return;
            }

            logger.error(`External API request error: ${error.message}`);
            this.sendError(res, 500, 'INTERNAL_ERROR', '服务内部错误');
        }
    }

    sendApiResult(res, result) {
        if (!result) {
            this.sendJson(res, 200, {
                status: 'success',
                msg: '',
                data: null
            });
            return;
        }

        if (result.status === 'error') {
            this.sendError(
                res,
                result.httpStatus || 400,
                result.code || 'QUERY_FAILED',
                result.msg || '查询失败',
                result.data
            );
            return;
        }

        this.sendJson(res, 200, {
            status: 'success',
            msg: result.msg || '',
            data: result.data === undefined ? null : result.data
        });
    }

    sendError(res, statusCode, code, msg, data = null) {
        this.sendJson(res, statusCode, {
            status: 'error',
            code,
            msg,
            data
        });
    }

    sendJson(res, statusCode, payload) {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (payload === null) {
            res.end();
            return;
        }
        res.end(JSON.stringify(payload));
    }

    createError(statusCode, code, message, data = null) {
        const error = new Error(message);
        error.apiError = true;
        error.statusCode = statusCode;
        error.code = code;
        error.data = data;
        return error;
    }
}

module.exports = ExternalApiServer;
