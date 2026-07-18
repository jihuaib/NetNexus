const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    getReleaseManifest,
    getRuntimeDirectory,
    getRuntimeExecutable,
    normalizeArch,
    normalizePlatform,
    parseYanglintVersion,
    verifyRuntime
} = require('../../scripts/libyang-runtime-config');
const beforePack = require('../../scripts/verify-libyang-runtime');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-packaging-'));

function assertCommandSucceeds(command, args, description) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        encoding: 'utf8',
        env: process.env
    });
    assert.equal(
        result.status,
        0,
        `${description} failed:\n${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`
    );
}

function verifyScriptSyntax() {
    const javascriptScripts = [
        'scripts/libyang-runtime-config.js',
        'scripts/verify-libyang-runtime.js',
        'scripts/write-libyang-runtime-manifest.js',
        'scripts/smoke-libyang-runtime.js'
    ];
    for (const relativePath of javascriptScripts) {
        assertCommandSucceeds(process.execPath, ['--check', relativePath], `syntax check for ${relativePath}`);
    }

    const unixBuildScript = path.join(projectRoot, 'scripts', 'build-libyang-runtime.sh');
    if (process.platform !== 'win32') {
        assertCommandSucceeds('bash', ['-n', unixBuildScript], 'syntax check for build-libyang-runtime.sh');
    } else {
        assert.match(fs.readFileSync(unixBuildScript, 'utf8'), /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    }
    const unixBuildSource = fs.readFileSync(unixBuildScript, 'utf8');
    assert.match(unixBuildSource, /libyangCommit/);
    assert.match(unixBuildSource, /pcre2Commit/);
    assert.match(unixBuildSource, /assert_git_commit/);

    const powershellScript = path.join(projectRoot, 'scripts', 'build-libyang-runtime.ps1');
    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const escapedPath = powershellScript.replace(/'/g, "''");
    const parseCommand = [
        '$tokens = $null',
        '$errors = $null',
        `[System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors) > $null`,
        'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }'
    ].join('; ');
    const powershellResult = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', parseCommand], {
        cwd: projectRoot,
        encoding: 'utf8'
    });
    if (!powershellResult.error || powershellResult.error.code !== 'ENOENT') {
        assert.equal(
            powershellResult.status,
            0,
            `syntax check for build-libyang-runtime.ps1 failed:\n${powershellResult.stderr || powershellResult.stdout}`
        );
    } else {
        const powershellSource = fs.readFileSync(powershellScript, 'utf8');
        assert.match(powershellSource, /^\$ErrorActionPreference = 'Stop'/);
        assert.match(powershellSource, /finally\s*\{/);
    }
    const powershellSource = fs.readFileSync(powershellScript, 'utf8');
    assert.match(powershellSource, /CMAKE_FIND_LIBRARY_SUFFIXES \.lib/);
    assert.match(powershellSource, /pcre2-8-static/);
    assert.match(powershellSource, /Assert-GitCommit/);
    assert.match(powershellSource, /netnexus_getopt/);
    assert.match(powershellSource, /Assert-WindowsSystemDependencies/);
    assert.match(powershellSource, /dumpbin\.exe/);
    assert.match(powershellSource, /--x-install-root=/);
    assert.doesNotMatch(powershellSource, /vcpkg install pthreads dirent getopt-win32/);
    for (const generatedLicense of [
        'LICENSE.libyang',
        'LICENSE.pcre2',
        'LICENSE.getopt',
        'LICENSE.pthreads',
        'NOTICE.pthreads',
        'LICENSE.dirent'
    ]) {
        assert.match(powershellSource, new RegExp(generatedLicense.replace('.', '\\.')));
    }
}

function testPinnedReleaseAndPackageContract() {
    const release = getReleaseManifest(projectRoot);
    assert.deepEqual(release, {
        schemaVersion: 1,
        libyangVersion: '5.8.6',
        tag: 'v5.8.6',
        libyangCommit: '47351e59e2965e350f9d4098f15ecbe6b3850f6f',
        source: 'https://github.com/CESNET/libyang',
        pcre2Version: '10.47',
        pcre2Tag: 'pcre2-10.47',
        pcre2Commit: 'f454e231fe5006dd7ff8f4693fd2b8eb94333429',
        pcre2Source: 'https://github.com/PCRE2Project/pcre2',
        license: 'BSD-3-Clause',
        buildMode: 'static',
        interactive: false,
        windowsDependencies: {
            vcpkgBaseline: '4e82e29f14eac2b3422f18f72c7524d04f19924e',
            getopt: {
                version: 'f46459cbe64b',
                commit: 'f46459cbe64b8b05ef617f59b576e81f7ec8ed9c',
                source: 'https://github.com/matveyt/getopt',
                license: 'Unlicense'
            },
            pthreads: {
                version: '3.0.0#14',
                source: 'https://sourceforge.net/projects/pthreads4w/',
                license: 'Apache-2.0'
            },
            dirent: {
                version: '1.26',
                source: 'https://github.com/tronkko/dirent',
                license: 'MIT'
            }
        }
    });

    const vcpkgManifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'scripts', 'libyang-vcpkg', 'vcpkg.json'), 'utf8')
    );
    assert.equal(vcpkgManifest['builtin-baseline'], release.windowsDependencies.vcpkgBaseline);
    assert.deepEqual(vcpkgManifest.dependencies, ['dirent', 'pthreads']);
    assert(!vcpkgManifest.dependencies.includes('getopt-win32'), 'LGPL getopt-win32 must not be statically linked');
    assert.deepEqual(
        vcpkgManifest.overrides.map(item => `${item.name}@${item.version}#${item['port-version'] || 0}`),
        ['dirent@1.26#0', 'pthreads@3.0.0#14']
    );

    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.build.beforePack, 'scripts/verify-libyang-runtime.js');
    assert(
        packageJson.build.extraResources.some(
            resource => resource.from === 'resources/libyang' && resource.to === 'libyang'
        ),
        'electron-builder must copy the bundled libyang runtime into the application resources'
    );
    assert.equal(packageJson.scripts['libyang:verify'], 'node scripts/verify-libyang-runtime.js');
    assert.equal(packageJson.scripts['libyang:build:unix'], 'bash scripts/build-libyang-runtime.sh');
    assert.match(packageJson.scripts['libyang:build:windows'], /build-libyang-runtime\.ps1/);
    for (const licenseFile of ['LICENSE.libyang', 'LICENSE.pcre2', 'NOTICE.pthreads']) {
        assert(fs.statSync(path.join(projectRoot, 'resources', 'libyang', licenseFile)).isFile());
    }
}

function testRuntimePathMapping() {
    assert.equal(normalizePlatform('macOS'), 'darwin');
    assert.equal(normalizePlatform('windows'), 'win32');
    assert.equal(normalizePlatform('linux'), 'linux');
    assert.equal(normalizeArch('amd64'), 'x64');
    assert.equal(normalizeArch('aarch64'), 'arm64');
    assert.equal(normalizeArch(0), 'ia32');
    assert.equal(normalizeArch(1), 'x64');
    assert.equal(normalizeArch(2), 'armv7l');
    assert.equal(normalizeArch(3), 'arm64');
    assert.equal(normalizeArch(4), 'universal');

    assert.equal(
        getRuntimeDirectory({ projectRoot: tempDir, platform: 'windows', arch: 'amd64' }),
        path.join(tempDir, 'resources', 'libyang', 'win32-x64')
    );
    assert.equal(
        getRuntimeExecutable({ projectRoot: tempDir, platform: 'win32', arch: 'x64' }),
        path.join(tempDir, 'resources', 'libyang', 'win32-x64', 'bin', 'yanglint.exe')
    );
    assert.equal(
        getRuntimeExecutable({ projectRoot: tempDir, platform: 'macos', arch: 'aarch64' }),
        path.join(tempDir, 'resources', 'libyang', 'darwin-arm64', 'bin', 'yanglint')
    );
    assert.equal(parseYanglintVersion('yanglint 5.8.6'), '5.8.6');
    assert.equal(parseYanglintVersion('yanglint version v5.8.6\n'), '5.8.6');
    assert.equal(parseYanglintVersion('libyang 5.8.6'), null);
}

function testRuntimeVerifierWithoutNativeRuntime() {
    const runtimeDirectory = path.join(tempDir, 'fake-runtime');
    const verifierPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
    const verifierArch = process.platform === 'win32' ? 'x64' : 'arm64';
    const executable = path.join(runtimeDirectory, 'bin', verifierPlatform === 'win32' ? 'yanglint.exe' : 'yanglint');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'test fixture', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);

    const status = verifyRuntime({
        projectRoot,
        platform: verifierPlatform,
        arch: verifierArch,
        runtimeDirectory,
        executable,
        spawnSync(command, args, options) {
            assert.equal(command, executable);
            assert.deepEqual(args, ['--version']);
            assert.equal(options.cwd, path.dirname(executable));
            assert.equal(options.windowsHide, true);
            return { status: 0, stdout: 'yanglint 5.8.6\n', stderr: '' };
        }
    });
    assert.equal(status.available, true);
    assert.equal(status.required, true);
    assert.equal(status.engine, 'libyang');
    assert.equal(status.version, '5.8.6');
    assert.equal(status.source, 'bundled');

    assert.throws(
        () =>
            verifyRuntime({
                projectRoot,
                platform: verifierPlatform,
                arch: verifierArch,
                runtimeDirectory,
                executable,
                spawnSync: () => ({ status: 0, stdout: 'yanglint 5.8.5\n', stderr: '' })
            }),
        /does not match required libyang 5\.8\.6/
    );
    assert.throws(
        () =>
            verifyRuntime({
                projectRoot,
                platform: verifierPlatform,
                arch: verifierArch,
                runtimeDirectory,
                executable,
                spawnSync: () => ({ status: 2, stdout: '', stderr: 'cannot load runtime' })
            }),
        /cannot execute: cannot load runtime/
    );

    const missingExecutable = path.join(runtimeDirectory, 'bin', 'missing-yanglint');
    assert.throws(
        () =>
            verifyRuntime({
                projectRoot,
                platform: 'linux',
                arch: 'x64',
                runtimeDirectory,
                executable: missingExecutable
            }),
        /runtime is missing for linux-x64/
    );

    if (process.platform !== 'win32') {
        const symlink = path.join(runtimeDirectory, 'bin', 'linked-yanglint');
        fs.symlinkSync(executable, symlink);
        assert.throws(
            () =>
                verifyRuntime({
                    projectRoot,
                    platform: 'darwin',
                    arch: 'arm64',
                    runtimeDirectory,
                    executable: symlink
                }),
            /regular non-symlink file/
        );

        fs.chmodSync(executable, 0o644);
        assert.throws(
            () =>
                verifyRuntime({
                    projectRoot,
                    platform: 'darwin',
                    arch: 'arm64',
                    runtimeDirectory,
                    executable
                }),
            /not executable/
        );
    }
}

async function testBeforePackHook() {
    assert.equal(beforePack.platformFromContext({ electronPlatformName: 'mac' }), 'darwin');
    assert.equal(beforePack.platformFromContext({ packager: { platform: { nodeName: 'win32' } } }), 'win32');
    assert.equal(beforePack.archFromContext({ arch: 1 }), 'x64');
    assert.deepEqual(beforePack.targetArchitecturesFromContext({ electronPlatformName: 'darwin', arch: 4 }), [
        'x64',
        'arm64'
    ]);
    assert.deepEqual(beforePack.targetArchitecturesFromContext({ electronPlatformName: 'win32', arch: 1 }), ['x64']);

    const calls = [];
    const messages = [];
    await beforePack(
        {
            electronPlatformName: 'darwin',
            arch: 4,
            packager: { projectDir: '/fixture/project' }
        },
        {
            verifyRuntime(options) {
                calls.push(options);
                return { version: '5.8.6', path: `/runtime/${options.arch}/yanglint` };
            },
            write: message => messages.push(message)
        }
    );
    assert.deepEqual(calls, [
        { projectRoot: '/fixture/project', platform: 'darwin', arch: 'x64' },
        { projectRoot: '/fixture/project', platform: 'darwin', arch: 'arm64' }
    ]);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Verified bundled libyang 5\.8\.6/);

    await assert.rejects(
        beforePack(
            { electronPlatformName: 'win32', arch: 1, packager: { projectDir: '/fixture/project' } },
            {
                verifyRuntime() {
                    throw new Error('runtime missing');
                },
                write() {}
            }
        ),
        /runtime missing/
    );
}

async function run() {
    try {
        testPinnedReleaseAndPackageContract();
        testRuntimePathMapping();
        testRuntimeVerifierWithoutNativeRuntime();
        await testBeforePackHook();
        verifyScriptSyntax();
        console.log('libyang packaging contract and clean-CI verification tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
