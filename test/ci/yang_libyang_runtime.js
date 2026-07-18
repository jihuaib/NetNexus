const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    LibyangRuntime,
    buildLibyangEnvironment,
    discoverLibyangRuntime,
    executeYanglint,
    getLibyangDiscoveryCandidates,
    parseYanglintVersion,
    validateExecutable
} = require('../../electron/utils/yang/libyangRuntime');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-runtime-'));

async function run() {
    try {
        const helperPath = path.join(tempDir, 'fake-yanglint.js');
        fs.writeFileSync(
            helperPath,
            `const command = process.argv[2];
if (command === '--version') {
  console.log('yanglint 5.8.6');
} else if (command === 'echo') {
  console.log(JSON.stringify(process.argv.slice(3)));
} else if (command === 'sleep') {
  setTimeout(() => {}, 5000);
} else if (command === 'flood') {
  process.stdout.write('x'.repeat(65536));
}
`,
            'utf8'
        );

        assert.deepEqual(parseYanglintVersion('yanglint 5.8.6'), {
            version: '5.8.6',
            major: 5,
            output: 'yanglint 5.8.6'
        });
        assert.equal(parseYanglintVersion('unrelated tool 5.8.6'), null);

        const windowsCandidates = getLibyangDiscoveryCandidates({
            platform: 'win32',
            arch: 'amd64',
            isPackaged: true,
            allowPathFallback: true,
            resourcesPath: 'C:\\NetNexus\\resources',
            env: { PATH: '"C:\\Program Files\\libyang";D:\\tools' }
        });
        assert(
            windowsCandidates.some(
                candidate =>
                    candidate.source === 'bundled' &&
                    candidate.path === 'C:\\NetNexus\\resources\\libyang\\win32-x64\\bin\\yanglint.exe'
            )
        );
        assert(
            !getLibyangDiscoveryCandidates({
                platform: 'win32',
                arch: 'amd64',
                isPackaged: true,
                resourcesPath: 'C:\\NetNexus\\resources',
                env: { PATH: 'D:\\tools' }
            }).some(candidate => candidate.source === 'path'),
            'packaged builds must use their verified bundle unless an explicit developer override is configured'
        );
        const windowsEnvironment = buildLibyangEnvironment(
            { runtimeRoot: 'C:\\NetNexus\\resources\\libyang\\win32-x64' },
            { platform: 'win32', env: { Path: 'C:\\Windows\\System32' } }
        );
        assert(windowsEnvironment.Path.startsWith('C:\\NetNexus\\resources\\libyang\\win32-x64\\bin;'));
        assert.equal(windowsEnvironment.PATH, undefined, 'Windows PATH key casing must not be duplicated');
        assert(
            windowsCandidates.some(
                candidate =>
                    candidate.source === 'path' && candidate.path === 'C:\\Program Files\\libyang\\yanglint.exe'
            )
        );

        const orderedCandidates = getLibyangDiscoveryCandidates({
            executablePath: path.join(tempDir, 'explicit-yanglint'),
            resourcesPath: path.join(tempDir, 'resources-order'),
            isPackaged: true,
            allowPathFallback: true,
            env: {
                NETNEXUS_YANGLINT_PATH: path.join(tempDir, 'environment-yanglint'),
                PATH: path.join(tempDir, 'path-bin')
            }
        });
        const firstEnvironment = orderedCandidates.findIndex(candidate => candidate.source === 'environment');
        const firstBundled = orderedCandidates.findIndex(candidate => candidate.source === 'bundled');
        const firstPath = orderedCandidates.findIndex(candidate => candidate.source === 'path');
        assert.equal(orderedCandidates[0].source, 'explicit');
        assert(firstEnvironment > 0 && firstEnvironment < firstBundled);
        assert(firstBundled < firstPath);

        const resourcesPath = path.join(tempDir, 'resources');
        const runtimeRoot = path.join(resourcesPath, 'libyang', `${process.platform}-${process.arch}`);
        const bundledExecutable = path.join(
            runtimeRoot,
            'bin',
            process.platform === 'win32' ? 'yanglint.exe' : 'yanglint'
        );
        fs.mkdirSync(path.dirname(bundledExecutable), { recursive: true });
        fs.writeFileSync(
            bundledExecutable,
            process.platform === 'win32'
                ? 'test executable'
                : `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('yanglint 5.8.6');
else console.log(JSON.stringify(args));
`,
            'utf8'
        );
        if (process.platform !== 'win32') fs.chmodSync(bundledExecutable, 0o755);
        const moduleSearchPath = path.join(runtimeRoot, 'share', 'yang', 'modules', 'libyang');
        fs.mkdirSync(moduleSearchPath, { recursive: true });

        let probeCount = 0;
        const discoveryOptions = {
            resourcesPath,
            isPackaged: true,
            env: { ...process.env, NETNEXUS_YANGLINT_PATH: '' },
            execute: async () => {
                probeCount += 1;
                return {
                    stdout: 'yanglint 5.8.6\n',
                    stderr: '',
                    exitCode: 0,
                    error: null
                };
            }
        };
        const discovered = await discoverLibyangRuntime(discoveryOptions);
        assert.equal(discovered.available, true);
        assert.equal(discovered.required, true);
        assert.equal(discovered.engine, 'libyang');
        assert.equal(discovered.executable, 'yanglint');
        assert.equal(discovered.version, '5.8.6');
        assert.equal(discovered.path, fs.realpathSync(bundledExecutable));
        assert.equal(discovered.source, 'bundled');
        assert.equal(discovered.moduleSearchPath, moduleSearchPath);
        assert.equal(discovered.capabilities.schemaValidation, true);
        assert.equal(discovered.capabilities.bundledModules, true);

        const runtime = new LibyangRuntime(discoveryOptions);
        await runtime.getStatus();
        await runtime.getStatus();
        assert.equal(probeCount, 2, 'the runtime instance should cache its own first probe');
        await runtime.getStatus({ force: true });
        assert.equal(probeCount, 3);
        if (process.platform !== 'win32') {
            const runtimeExecution = await runtime.execute(['schema.yang']);
            assert.equal(runtimeExecution.exitCode, 0, runtimeExecution.stderr);
            assert.deepEqual(JSON.parse(runtimeExecution.stdout), ['-p', moduleSearchPath, 'schema.yang']);
        }

        const extensionsDirectory = path.join(runtimeRoot, 'lib', 'libyang', 'extensions');
        const typesDirectory = path.join(runtimeRoot, 'lib', 'libyang', 'types');
        fs.mkdirSync(extensionsDirectory, { recursive: true });
        fs.mkdirSync(typesDirectory, { recursive: true });
        const runtimeEnvironment = buildLibyangEnvironment(
            { runtimeRoot, path: bundledExecutable, source: 'bundled' },
            { env: { PATH: '/base' } }
        );
        if (process.platform === 'win32') {
            assert(runtimeEnvironment.PATH.startsWith(path.join(runtimeRoot, 'bin')));
            assert.equal(runtimeEnvironment.LIBYANG_TYPES_PLUGINS_DIR, undefined);
        } else {
            assert.equal(runtimeEnvironment.LIBYANG_EXTENSIONS_PLUGINS_DIR, extensionsDirectory);
            assert.equal(runtimeEnvironment.LIBYANG_TYPES_PLUGINS_DIR, typesDirectory);
            assert.equal(runtimeEnvironment.LIBYANG_USER_TYPES_PLUGINS_DIR, typesDirectory);
        }

        if (process.platform !== 'win32') {
            const escapedLink = path.join(runtimeRoot, 'bin', 'escaped-yanglint');
            fs.symlinkSync(process.execPath, escapedLink);
            const escapedValidation = await validateExecutable({
                path: escapedLink,
                runtimeRoot,
                source: 'bundled'
            });
            assert.equal(escapedValidation.valid, false);
            assert.match(escapedValidation.error, /outside the bundled runtime/);
        }

        const echo = await executeYanglint(process.execPath, [helperPath, 'echo', '$(touch unsafe)', 'a;echo b'], {
            timeoutMs: 2_000,
            maxOutputBytes: 4_096
        });
        assert.equal(echo.exitCode, 0, echo.stderr);
        assert.deepEqual(JSON.parse(echo.stdout), ['$(touch unsafe)', 'a;echo b']);
        assert.equal(
            fs.existsSync(path.join(process.cwd(), 'unsafe')),
            false,
            'arguments must never be shell-expanded'
        );

        const timeout = await executeYanglint(process.execPath, [helperPath, 'sleep'], {
            timeoutMs: 50,
            maxOutputBytes: 4_096
        });
        assert.equal(timeout.timedOut, true);
        assert.equal(timeout.error.code, 'YANGLINT_TIMEOUT');

        const abortController = new AbortController();
        const abortedPromise = executeYanglint(process.execPath, [helperPath, 'sleep'], {
            timeoutMs: 2_000,
            maxOutputBytes: 4_096,
            signal: abortController.signal
        });
        setTimeout(() => abortController.abort(), 25);
        const aborted = await abortedPromise;
        assert.equal(aborted.aborted, true);
        assert.equal(aborted.error.code, 'YANGLINT_ABORTED');

        const outputLimit = await executeYanglint(process.execPath, [helperPath, 'flood'], {
            timeoutMs: 2_000,
            maxOutputBytes: 256
        });
        assert.equal(outputLimit.outputLimitExceeded, true);
        assert.equal(outputLimit.error.code, 'YANGLINT_OUTPUT_LIMIT');
        assert(Buffer.byteLength(outputLimit.stdout) <= 256);
        assert.throws(() => executeYanglint(process.execPath, ['invalid\u0000argument']), /invalid value/);

        const unavailable = await discoverLibyangRuntime({
            resourcesPath: path.join(tempDir, 'missing-resources'),
            isPackaged: true,
            env: { PATH: '' }
        });
        assert.equal(unavailable.available, false);
        assert.equal(unavailable.required, true);
        assert.equal(unavailable.engine, 'libyang');
        assert.equal(unavailable.source, 'unavailable');
        assert.match(unavailable.installHint, /reinstall NetNexus/i);

        console.log('libyang runtime discovery and safe execution tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
