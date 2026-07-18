const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const DEFAULT_VERSION_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_EXECUTION_TIMEOUT_MS = 10 * 60_000;
const MAX_ALLOWED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const MINIMUM_LIBYANG_MAJOR = 2;

function createRuntimeError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function executableNameForPlatform(platform = process.platform) {
    return platform === 'win32' ? 'yanglint.exe' : 'yanglint';
}

function normalizeArchitecture(architecture = process.arch) {
    const aliases = {
        amd64: 'x64',
        x86_64: 'x64',
        aarch64: 'arm64'
    };
    return aliases[architecture] || architecture;
}

function pathApiForPlatform(platform = process.platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

function pushCandidate(candidates, seen, candidate, platform) {
    if (!candidate?.path) return;
    const candidatePath = pathApiForPlatform(platform).resolve(candidate.path);
    const key = platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...candidate, path: candidatePath });
}

function runtimeCandidates(root, options = {}) {
    if (!root) return [];
    const platform = options.platform || process.platform;
    const architecture = normalizeArchitecture(options.arch || process.arch);
    const executableName = executableNameForPlatform(platform);
    const pathApi = pathApiForPlatform(platform);
    const resolvedRoot = pathApi.resolve(root);
    const platformRoot = pathApi.join(resolvedRoot, `${platform}-${architecture}`);

    return [
        {
            path: pathApi.join(platformRoot, 'bin', executableName),
            runtimeRoot: platformRoot
        },
        {
            path: pathApi.join(platformRoot, executableName),
            runtimeRoot: platformRoot
        },
        {
            path: pathApi.join(resolvedRoot, 'bin', executableName),
            runtimeRoot: resolvedRoot
        },
        {
            path: pathApi.join(resolvedRoot, executableName),
            runtimeRoot: resolvedRoot
        }
    ];
}

function explicitCandidates(configuredPath, options = {}) {
    if (!configuredPath || typeof configuredPath !== 'string') return [];
    const platform = options.platform || process.platform;
    const configuredValue = configuredPath.trim();
    if (!configuredValue) return [];
    const executableName = executableNameForPlatform(platform);
    const pathApi = pathApiForPlatform(platform);
    const resolved = pathApi.resolve(options.cwd || process.cwd(), configuredValue);
    const executableDirectory = pathApi.dirname(resolved);
    const inferredRuntimeRoot =
        pathApi.basename(executableDirectory).toLowerCase() === 'bin' ? pathApi.dirname(executableDirectory) : null;
    return [
        { path: resolved, runtimeRoot: inferredRuntimeRoot },
        { path: pathApi.join(resolved, 'bin', executableName), runtimeRoot: resolved },
        { path: pathApi.join(resolved, executableName), runtimeRoot: resolved }
    ];
}

function pathCandidates(environment = process.env, options = {}) {
    const platform = options.platform || process.platform;
    const executableName = executableNameForPlatform(platform);
    const pathApi = pathApiForPlatform(platform);
    const delimiter = options.pathDelimiter || (platform === 'win32' ? ';' : path.delimiter);
    const pathValue = environment.PATH || environment.Path || environment.path || '';
    return String(pathValue)
        .split(delimiter)
        .map(directory => directory.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean)
        .map(directory => ({
            path: pathApi.join(directory, executableName),
            runtimeRoot: null
        }));
}

function getLibyangDiscoveryCandidates(options = {}) {
    const platform = options.platform || process.platform;
    const architecture = normalizeArchitecture(options.arch || process.arch);
    const pathApi = pathApiForPlatform(platform);
    const environment = options.env || process.env;
    const candidates = [];
    const seen = new Set();
    const addCandidates = (items, source) => {
        for (const item of items) {
            pushCandidate(candidates, seen, { ...item, source }, platform);
        }
    };

    addCandidates(explicitCandidates(options.executablePath || options.compilerPath, options), 'explicit');
    addCandidates(explicitCandidates(environment.NETNEXUS_YANGLINT_PATH, options), 'environment');

    const resourcesPath = options.resourcesPath || process.resourcesPath;
    if (resourcesPath) {
        addCandidates(
            runtimeCandidates(pathApi.join(resourcesPath, 'libyang'), { platform, arch: architecture }),
            'bundled'
        );
        addCandidates(
            runtimeCandidates(pathApi.join(resourcesPath, 'app', 'electron', 'resources', 'libyang'), {
                platform,
                arch: architecture
            }),
            'bundled'
        );
    }

    if (!options.isPackaged) {
        const developmentRoots = [
            options.devResourcesPath,
            options.appPath && pathApi.join(options.appPath, 'resources'),
            options.appPath && pathApi.join(options.appPath, 'electron', 'resources'),
            pathApi.resolve(__dirname, '..', '..', '..', 'resources'),
            pathApi.resolve(__dirname, '..', '..', 'resources')
        ];
        for (const developmentRoot of developmentRoots.filter(Boolean)) {
            addCandidates(
                runtimeCandidates(pathApi.join(developmentRoot, 'libyang'), { platform, arch: architecture }),
                'bundled'
            );
        }
    }

    if (!options.isPackaged || options.allowPathFallback === true) {
        addCandidates(pathCandidates(environment, { platform, pathDelimiter: options.pathDelimiter }), 'path');
    }
    return candidates;
}

async function validateExecutable(candidate, options = {}) {
    const platform = options.platform || process.platform;
    let canonicalPath;
    let stats;
    try {
        canonicalPath = await fs.promises.realpath(candidate.path);
        stats = await fs.promises.stat(canonicalPath);
    } catch (error) {
        return { valid: false, error: `Cannot access ${candidate.path}: ${error.message}` };
    }

    if (!stats.isFile()) {
        return { valid: false, error: `${candidate.path} is not a regular file` };
    }

    if (candidate.source === 'bundled' && candidate.runtimeRoot) {
        try {
            const canonicalRoot = await fs.promises.realpath(candidate.runtimeRoot);
            const pathApi = pathApiForPlatform(platform);
            const relativePath = pathApi.relative(canonicalRoot, canonicalPath);
            if (relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) {
                return { valid: false, error: `${candidate.path} resolves outside the bundled runtime` };
            }
        } catch (error) {
            return { valid: false, error: `Cannot validate bundled runtime: ${error.message}` };
        }
    }

    if (platform !== 'win32') {
        try {
            await fs.promises.access(canonicalPath, fs.constants.X_OK);
        } catch (error) {
            return { valid: false, error: `${candidate.path} is not executable: ${error.message}` };
        }
    } else if (pathApiForPlatform(platform).extname(canonicalPath).toLowerCase() !== '.exe') {
        return { valid: false, error: `${candidate.path} is not a Windows executable` };
    }

    return { valid: true, path: canonicalPath, stats };
}

function prependEnvironmentPath(environment, variableName, values, delimiter, caseInsensitive = false) {
    const actualName = caseInsensitive
        ? Object.keys(environment).find(name => name.toLowerCase() === variableName.toLowerCase()) || variableName
        : variableName;
    const existing = environment[actualName];
    environment[actualName] = [...values.filter(Boolean), existing].filter(Boolean).join(delimiter);
}

function firstExistingDirectory(directories) {
    return directories.find(directory => {
        try {
            return fs.statSync(directory).isDirectory();
        } catch (_error) {
            return false;
        }
    });
}

function getBundledModuleSearchPath(runtimeRoot) {
    if (!runtimeRoot) return null;
    return (
        firstExistingDirectory([
            path.join(runtimeRoot, 'share', 'yang', 'modules', 'libyang'),
            path.join(runtimeRoot, 'share', 'yang', 'modules')
        ]) || null
    );
}

function buildLibyangEnvironment(candidate, options = {}) {
    const platform = options.platform || process.platform;
    const pathApi = pathApiForPlatform(platform);
    const environment = { ...(options.env || process.env) };
    const runtimeRoot = candidate?.runtimeRoot;
    if (!runtimeRoot) return environment;

    const binDirectory = pathApi.join(runtimeRoot, 'bin');
    const libraryDirectories = [pathApi.join(runtimeRoot, 'lib'), pathApi.join(runtimeRoot, 'lib64')].filter(
        directory => {
            try {
                return fs.statSync(directory).isDirectory();
            } catch (_error) {
                return false;
            }
        }
    );

    if (platform === 'win32') {
        prependEnvironmentPath(environment, 'PATH', [binDirectory, ...libraryDirectories], ';', true);
        return environment;
    }

    if (platform === 'darwin') {
        prependEnvironmentPath(environment, 'DYLD_LIBRARY_PATH', libraryDirectories, ':');
        prependEnvironmentPath(environment, 'DYLD_FALLBACK_LIBRARY_PATH', libraryDirectories, ':');
    } else {
        prependEnvironmentPath(environment, 'LD_LIBRARY_PATH', libraryDirectories, ':');
    }

    const extensionsDirectory = firstExistingDirectory([
        pathApi.join(runtimeRoot, 'lib', 'libyang', 'extensions'),
        pathApi.join(runtimeRoot, 'lib64', 'libyang', 'extensions'),
        pathApi.join(runtimeRoot, 'plugins', 'extensions')
    ]);
    const typesDirectory = firstExistingDirectory([
        pathApi.join(runtimeRoot, 'lib', 'libyang', 'types'),
        pathApi.join(runtimeRoot, 'lib64', 'libyang', 'types'),
        pathApi.join(runtimeRoot, 'plugins', 'types'),
        pathApi.join(runtimeRoot, 'lib', 'libyang', 'user_types'),
        pathApi.join(runtimeRoot, 'lib64', 'libyang', 'user_types')
    ]);
    if (extensionsDirectory) {
        environment.LIBYANG_EXTENSIONS_PLUGINS_DIR = extensionsDirectory;
    }
    if (typesDirectory) {
        environment.LIBYANG_TYPES_PLUGINS_DIR = typesDirectory;
        // libyang 2.x used this older name. Keeping it makes a v2 bundle usable while
        // LIBYANG_TYPES_PLUGINS_DIR remains the authoritative current setting.
        environment.LIBYANG_USER_TYPES_PLUGINS_DIR = typesDirectory;
    }
    return environment;
}

function validateArguments(args) {
    if (!Array.isArray(args)) {
        throw createRuntimeError('yanglint arguments must be an array', 'INVALID_ARGUMENTS');
    }
    if (args.length > 4_096 || args.some(argument => typeof argument !== 'string' || argument.includes('\u0000'))) {
        throw createRuntimeError('yanglint arguments contain an invalid value', 'INVALID_ARGUMENTS');
    }
    if (args.reduce((size, argument) => size + Buffer.byteLength(argument), 0) > MAX_ARGUMENT_BYTES) {
        throw createRuntimeError(`yanglint arguments exceed ${MAX_ARGUMENT_BYTES} bytes`, 'INVALID_ARGUMENTS');
    }
    return args;
}

function boundedPositiveInteger(value, fallback, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.floor(number)));
}

function executeYanglint(executablePath, args, options = {}) {
    validateArguments(args);
    const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS, MAX_EXECUTION_TIMEOUT_MS);
    const maxOutputBytes = boundedPositiveInteger(
        options.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        MAX_ALLOWED_OUTPUT_BYTES
    );
    const startedAt = Date.now();

    return new Promise(resolve => {
        let child;
        const stdoutChunks = [];
        const stderrChunks = [];
        let totalOutputBytes = 0;
        let timedOut = false;
        let outputLimitExceeded = false;
        let aborted = false;
        let spawnError = null;
        let settled = false;

        const finish = (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (options.signal) options.signal.removeEventListener('abort', abortHandler);

            let error = spawnError;
            if (outputLimitExceeded) {
                error = createRuntimeError(
                    `yanglint output exceeded the ${maxOutputBytes} byte limit`,
                    'YANGLINT_OUTPUT_LIMIT'
                );
            } else if (timedOut) {
                error = createRuntimeError(`yanglint timed out after ${timeoutMs} ms`, 'YANGLINT_TIMEOUT');
            } else if (aborted) {
                error = createRuntimeError('yanglint execution was cancelled', 'YANGLINT_ABORTED');
            }

            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                exitCode: typeof exitCode === 'number' ? exitCode : null,
                signal: signal || null,
                timedOut,
                outputLimitExceeded,
                aborted,
                durationMs: Date.now() - startedAt,
                error
            });
        };

        const terminate = () => {
            if (child && !child.killed) child.kill('SIGKILL');
        };
        const abortHandler = () => {
            aborted = true;
            terminate();
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            terminate();
        }, timeoutMs);
        timeout.unref?.();

        if (options.signal?.aborted) {
            aborted = true;
            finish(null, null);
            return;
        }
        options.signal?.addEventListener('abort', abortHandler, { once: true });

        try {
            child = spawn(executablePath, args, {
                cwd: options.cwd,
                env: options.env || process.env,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            spawnError = createRuntimeError(`Cannot start yanglint: ${error.message}`, 'YANGLINT_SPAWN_FAILED');
            finish(null, null);
            return;
        }

        const collect = (chunks, chunk) => {
            if (outputLimitExceeded) return;
            const remaining = maxOutputBytes - totalOutputBytes;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (buffer.length > remaining) {
                const retained = remaining > 0 ? buffer.subarray(0, remaining) : Buffer.alloc(0);
                if (retained.length) chunks.push(retained);
                totalOutputBytes = maxOutputBytes;
                outputLimitExceeded = true;
                terminate();
                return;
            }
            totalOutputBytes += buffer.length;
            chunks.push(buffer);
        };

        child.stdout.on('data', chunk => {
            collect(stdoutChunks, chunk);
        });
        child.stderr.on('data', chunk => {
            collect(stderrChunks, chunk);
        });
        child.once('error', error => {
            spawnError = createRuntimeError(`Cannot start yanglint: ${error.message}`, 'YANGLINT_SPAWN_FAILED');
        });
        child.once('close', finish);
    });
}

function parseYanglintVersion(output) {
    const text = String(output || '').trim();
    const match = text.match(/\b(?:yanglint|libyang)\b[^\d\r\n]*(\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?)/i);
    if (!match) return null;
    return {
        version: match[1],
        major: Number(match[1].split('.')[0]),
        output: text.split(/\r?\n/)[0].trim()
    };
}

function installHintForPlatform(platform = process.platform) {
    if (platform === 'win32') return 'Repair or reinstall NetNexus to restore the bundled Windows libyang runtime.';
    if (platform === 'darwin') {
        return 'Repair or reinstall NetNexus. Developers may override yanglint with NETNEXUS_YANGLINT_PATH.';
    }
    return 'Repair or reinstall NetNexus. Developers may override yanglint with NETNEXUS_YANGLINT_PATH.';
}

function unavailableStatus(error, options = {}) {
    return {
        available: false,
        required: true,
        engine: 'libyang',
        executable: 'yanglint',
        version: null,
        path: null,
        source: 'unavailable',
        error,
        installHint: installHintForPlatform(options.platform),
        capabilities: {
            schemaValidation: false,
            dataValidation: false,
            yang10: false,
            yang11: false,
            extensionsPlugins: false,
            bundledModules: false
        }
    };
}

async function discoverLibyangRuntime(options = {}) {
    const candidates = getLibyangDiscoveryCandidates(options);
    const failures = [];
    const minimumMajor = boundedPositiveInteger(options.minimumMajor, MINIMUM_LIBYANG_MAJOR, 100);
    const execute = options.execute || executeYanglint;

    for (const candidate of candidates) {
        const validation = await validateExecutable(candidate, options);
        if (!validation.valid) {
            failures.push(validation.error);
            continue;
        }

        const executableCandidate = { ...candidate, path: validation.path };
        const environment = buildLibyangEnvironment(executableCandidate, options);
        let versionResult;
        try {
            versionResult = await execute(
                validation.path,
                Array.isArray(options.versionArgs) ? options.versionArgs : ['--version'],
                {
                    timeoutMs: options.discoveryTimeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS,
                    maxOutputBytes: options.versionOutputBytes || DEFAULT_VERSION_OUTPUT_BYTES,
                    env: environment
                }
            );
        } catch (error) {
            failures.push(`${candidate.path}: version check failed: ${error.message}`);
            continue;
        }
        const version = parseYanglintVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
        if (versionResult.error || versionResult.exitCode !== 0 || !version) {
            const reason = versionResult.error?.message || `unexpected version output (exit ${versionResult.exitCode})`;
            failures.push(`${candidate.path}: ${reason}`);
            continue;
        }
        if (version.major < minimumMajor) {
            failures.push(`${candidate.path}: libyang ${version.version} is older than required major ${minimumMajor}`);
            continue;
        }

        const moduleSearchPath = getBundledModuleSearchPath(candidate.runtimeRoot);

        return {
            available: true,
            required: true,
            engine: 'libyang',
            executable: 'yanglint',
            version: version.version,
            versionOutput: version.output,
            path: validation.path,
            source: candidate.source,
            runtimeRoot: candidate.runtimeRoot,
            moduleSearchPath,
            capabilities: {
                schemaValidation: true,
                dataValidation: true,
                yang10: true,
                yang11: true,
                extensionsPlugins: (options.platform || process.platform) !== 'win32',
                bundledModules: Boolean(moduleSearchPath)
            }
        };
    }

    const meaningfulFailure = failures.find(failure => !/Cannot access/.test(failure));
    return unavailableStatus(
        meaningfulFailure || 'The required bundled libyang/yanglint runtime was not found.',
        options
    );
}

async function getLibyangRuntimeStatus(options = {}) {
    return discoverLibyangRuntime(options);
}

class LibyangRuntime {
    constructor(options = {}) {
        this.options = { ...options };
        this.cachedStatus = null;
    }

    async getStatus(options = {}) {
        if (this.cachedStatus && !options.force) return this.cachedStatus;
        this.cachedStatus = await discoverLibyangRuntime({ ...this.options, ...options });
        return this.cachedStatus;
    }

    clearCache() {
        this.cachedStatus = null;
    }

    async execute(args, options = {}) {
        validateArguments(args);
        const status = await this.getStatus();
        if (!status.available) {
            throw createRuntimeError(status.error, 'LIBYANG_RUNTIME_UNAVAILABLE', { status });
        }
        const candidate = {
            path: status.path,
            source: status.source,
            runtimeRoot: status.runtimeRoot
        };
        const hasBundledSearchPath = args.some(
            (argument, index) =>
                (argument === '-p' || argument === '--path') && args[index + 1] === status.moduleSearchPath
        );
        const executionArgs =
            status.moduleSearchPath && !hasBundledSearchPath ? ['-p', status.moduleSearchPath, ...args] : args;
        return executeYanglint(status.path, executionArgs, {
            ...options,
            env: buildLibyangEnvironment(candidate, {
                ...this.options,
                platform: this.options.platform || process.platform,
                env: options.env || this.options.env || process.env
            })
        });
    }
}

module.exports = {
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_BYTES,
    MINIMUM_LIBYANG_MAJOR,
    LibyangRuntime,
    buildLibyangEnvironment,
    discoverLibyangRuntime,
    executeYanglint,
    executableNameForPlatform,
    getBundledModuleSearchPath,
    getLibyangDiscoveryCandidates,
    getLibyangRuntimeStatus,
    installHintForPlatform,
    parseYanglintVersion,
    validateExecutable
};
