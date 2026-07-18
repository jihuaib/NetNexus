const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    getReleaseManifest,
    getRuntimeDirectory,
    getRuntimeExecutable,
    getRuntimeSchemaExecutable,
    normalizeArch,
    normalizePlatform,
    parseSchemaHelperVersion,
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

function extractPowerShellFunction(source, name) {
    const declaration = `function ${name} {`;
    const functionStart = source.indexOf(declaration);
    assert(functionStart >= 0, `PowerShell function ${name} must exist`);

    const bodyStart = source.indexOf('{', functionStart);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] !== '}') continue;
        depth -= 1;
        if (depth === 0) return source.slice(functionStart, index + 1);
    }

    assert.fail(`PowerShell function ${name} is missing its closing brace`);
}

function assertVcpkgBaselinePreflightContract(powershellSource) {
    const probeSource = extractPowerShellFunction(powershellSource, 'Test-VcpkgBaselineAvailable');
    const exitCodeProbePattern =
        /& git -C \$Path cat-file -e [^\r\n]+ 2>\$null\s+if \(\$LASTEXITCODE -ne 0\) \{ return \$false \}/g;
    assert.equal(
        Array.from(probeSource.matchAll(exitCodeProbePattern)).length,
        2,
        'missing vcpkg commit and version-database objects must make the baseline probe return false'
    );
    const tryIndex = probeSource.indexOf('try {');
    const firstCatFileIndex = probeSource.indexOf('& git -C $Path cat-file -e');
    const lastCatFileIndex = probeSource.lastIndexOf('& git -C $Path cat-file -e');
    const catchIndex = probeSource.lastIndexOf('catch {');
    const catchReturnsFalse = /catch\s*\{\s*return \$false\s*\}/.test(probeSource.slice(catchIndex));
    assert(
        tryIndex >= 0 &&
            tryIndex < firstCatFileIndex &&
            firstCatFileIndex < lastCatFileIndex &&
            lastCatFileIndex < catchIndex &&
            catchReturnsFalse,
        'Windows PowerShell NativeCommandError from a missing git object must be caught and converted to false'
    );
    assert.doesNotMatch(probeSource, /\bthrow\b/, 'a missing vcpkg object must not terminate before the fetch');

    const ensureSource = extractPowerShellFunction(powershellSource, 'Ensure-VcpkgBaseline');
    const initialProbe = 'if (Test-VcpkgBaselineAvailable -Path $Path -Baseline $Baseline) { return }';
    const fetchCommand = '& git -C $Path fetch --refetch --no-tags';
    const postFetchProbe = 'if (-not (Test-VcpkgBaselineAvailable -Path $Path -Baseline $Baseline)) {';
    const initialProbeIndex = ensureSource.indexOf(initialProbe);
    const fetchIndex = ensureSource.indexOf(fetchCommand);
    const postFetchProbeIndex = ensureSource.indexOf(postFetchProbe);
    assert(
        initialProbeIndex >= 0 && initialProbeIndex < fetchIndex && fetchIndex < postFetchProbeIndex,
        'an unavailable vcpkg baseline must be fetched before the post-fetch availability check'
    );
    assert.doesNotMatch(
        ensureSource.slice(0, fetchIndex),
        /\bthrow\b/,
        'the vcpkg baseline preflight must not throw before attempting its recovery fetch'
    );
    assert.match(
        ensureSource.slice(postFetchProbeIndex),
        /throw "Pinned vcpkg baseline \$Baseline is missing its required version database objects\."/,
        'the vcpkg baseline preflight may report missing objects only after the recovery fetch is checked'
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
    assert.match(unixBuildSource, /expected_runtime_target=/);
    assert.match(
        unixBuildSource,
        /pcre2-source\/LICENCE\.md[^\r\n]+LICENSE\.pcre2/,
        'the Unix runtime must package the pinned PCRE2 license'
    );
    const unixRuntimeCleanupIndex = unixBuildSource.indexOf('rm -rf -- "${runtime_target}"');
    const unixRuntimeCreateIndex = unixBuildSource.indexOf('mkdir -p "${runtime_target}/bin"');
    assert(
        unixRuntimeCleanupIndex >= 0 && unixRuntimeCleanupIndex < unixRuntimeCreateIndex,
        'the Unix build must clear the exact runtime target before copying new artifacts'
    );

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
    assertVcpkgBaselinePreflightContract(powershellSource);
    assert.match(powershellSource, /CMAKE_FIND_LIBRARY_SUFFIXES \.lib/);
    assert.match(powershellSource, /pcre2-8-static/);
    assert.match(
        powershellSource,
        /Replace-PinnedSourceText\s+`\r?\n\s+\(Join-Path \$SourceDir 'src\/ly_config\.h\.in'\)\s+`\r?\n\s+\$LibyangMsvcApiBlock\s+`\r?\n\s+\$LibyangMsvcStaticApiBlock/,
        'the Windows build must patch the pinned libyang API macro template'
    );
    assert.match(
        powershellSource,
        /#  else\r?\n#    define LIBYANG_API_DEF\r?\n#    define LIBYANG_API_DECL\r?\n#  endif/,
        'static MSVC builds must use undecorated libyang declarations and definitions'
    );
    assert.match(powershellSource, /Assert-GitCommit/);
    assert.match(powershellSource, /netnexus_getopt/);
    assert.match(powershellSource, /Assert-WindowsSystemDependencies/);
    assert.match(powershellSource, /netnexus-libyang-schema\.exe/);
    assert.match(powershellSource, /--target yanglint netnexus-libyang-schema/);
    assert.match(powershellSource, /target_link_libraries\(netnexus-libyang-schema yang\)/);
    assert.match(powershellSource, /target_compile_definitions\(netnexus-libyang-schema PRIVATE STATIC\)/);
    assert.match(powershellSource, /C_STANDARD 11/);
    assert.match(powershellSource, /target_compile_options\(netnexus-libyang-schema PRIVATE \/W4 \/utf-8\)/);
    assert.match(powershellSource, /\$WindowsRuntimeManifestSource/);
    assert.match(powershellSource, /Copy-Item \$WindowsRuntimeManifestSource/);
    assert.match(powershellSource, /\/MANIFEST:EMBED,ID=1/);
    assert.match(powershellSource, /\/MANIFESTINPUT:\$\{manifest_output\}/);
    assert.match(powershellSource, /netnexus_embed_windows_manifest\(yanglint "NetNexus\.libyang\.yanglint"\)/);
    assert.match(
        powershellSource,
        /netnexus_embed_windows_manifest\(netnexus-libyang-schema "NetNexus\.libyang\.schema"\)/
    );
    assert.match(powershellSource, /Assert-WindowsRuntimeManifest \(\$BuiltYanglint\[0\]\.FullName\)/);
    assert.match(powershellSource, /Assert-WindowsRuntimeManifest \(\$BuiltSchemaHelper\[0\]\.FullName\)/);
    assert.match(powershellSource, /mt\.exe/);
    assert.match(powershellSource, /dumpbin\.exe/);
    assert.match(powershellSource, /--x-install-root=/);
    assert.match(powershellSource, /Test-VcpkgBaselineAvailable/);
    assert.match(powershellSource, /cat-file -e "\$\{Baseline\}:\$\{RequiredVersionFile\}"/);
    assert.match(powershellSource, /versions\/d-\/dirent\.json/);
    assert.match(powershellSource, /versions\/p-\/pthreads\.json/);
    assert.match(
        powershellSource,
        /git -C \$Path fetch --refetch --no-tags https:\/\/github\.com\/microsoft\/vcpkg\.git/
    );
    assert.doesNotMatch(powershellSource, /git -C \$Path fetch[^\r\n]*--depth/);
    const baselinePreflight = 'Ensure-VcpkgBaseline -Path $VcpkgRoot -Baseline $VcpkgBaseline';
    const baselinePreflightIndex = powershellSource.lastIndexOf(baselinePreflight);
    const vcpkgInstallIndex = powershellSource.indexOf('& $Vcpkg install');
    assert(
        baselinePreflightIndex >= 0 && baselinePreflightIndex < vcpkgInstallIndex,
        'the pinned vcpkg baseline must be available before manifest installation starts'
    );
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

    const windowsManifestSource = fs.readFileSync(
        path.join(projectRoot, 'scripts', 'netnexus-libyang-windows.manifest.in'),
        'utf8'
    );
    assert.match(windowsManifestSource, /@NETNEXUS_MANIFEST_IDENTITY@/);
    assert.match(
        windowsManifestSource,
        /<activeCodePage xmlns="http:\/\/schemas\.microsoft\.com\/SMI\/2019\/WindowsSettings">UTF-8<\/activeCodePage>/
    );
    assert.match(
        windowsManifestSource,
        /<longPathAware xmlns="http:\/\/schemas\.microsoft\.com\/SMI\/2016\/WindowsSettings">true<\/longPathAware>/
    );

    const schemaExporterSource = fs.readFileSync(
        path.join(projectRoot, 'scripts', 'netnexus-libyang-schema.c'),
        'utf8'
    );
    for (const limitName of ['MAX_EXPORT_NODES', 'MAX_EXPORT_DEPTH', 'MAX_JSON_ALLOCATION_BYTES', 'MAX_JSON_BYTES']) {
        assert.match(schemaExporterSource, new RegExp(`(?:#define|${limitName}).*${limitName}|#define ${limitName}`));
    }
    assert.match(schemaExporterSource, /Schema export exceeded the maxNodes limit/);
    assert.match(schemaExporterSource, /Schema export exceeded the maxDepth limit/);
    assert.match(schemaExporterSource, /Schema export exceeded the maxJsonBytes limit/);
    assert.match(schemaExporterSource, /candidate->augmented_by/);
    assert.match(schemaExporterSource, /candidate->deviated_by/);
    assert.match(schemaExporterSource, /if \(!node->parent_id\)/);
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
    assert.equal(
        getRuntimeSchemaExecutable({ projectRoot: tempDir, platform: 'windows', arch: 'amd64' }),
        path.join(tempDir, 'resources', 'libyang', 'win32-x64', 'bin', 'netnexus-libyang-schema.exe')
    );
    assert.equal(
        getRuntimeSchemaExecutable({ projectRoot: tempDir, platform: 'macos', arch: 'aarch64' }),
        path.join(tempDir, 'resources', 'libyang', 'darwin-arm64', 'bin', 'netnexus-libyang-schema')
    );
    assert.equal(parseYanglintVersion('yanglint 5.8.6'), '5.8.6');
    assert.equal(parseYanglintVersion('yanglint version v5.8.6\n'), '5.8.6');
    assert.equal(parseYanglintVersion('libyang 5.8.6'), null);
    assert.deepEqual(parseSchemaHelperVersion('netnexus-libyang-schema 1 (libyang 5.8.6)\n'), {
        contractVersion: 1,
        libyangVersion: '5.8.6'
    });
    assert.equal(parseSchemaHelperVersion('yanglint 5.8.6'), null);
}

function testRuntimeVerifierWithoutNativeRuntime() {
    const runtimeDirectory = path.join(tempDir, 'fake-runtime');
    const verifierPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
    const verifierArch = process.platform === 'win32' ? 'x64' : 'arm64';
    const executable = path.join(runtimeDirectory, 'bin', verifierPlatform === 'win32' ? 'yanglint.exe' : 'yanglint');
    const schemaExecutable = path.join(
        runtimeDirectory,
        'bin',
        verifierPlatform === 'win32' ? 'netnexus-libyang-schema.exe' : 'netnexus-libyang-schema'
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'test fixture', 'utf8');
    fs.writeFileSync(schemaExecutable, 'schema test fixture', 'utf8');
    if (process.platform !== 'win32') {
        fs.chmodSync(executable, 0o755);
        fs.chmodSync(schemaExecutable, 0o755);
    }

    assertCommandSucceeds(
        process.execPath,
        ['scripts/write-libyang-runtime-manifest.js', runtimeDirectory, executable, schemaExecutable],
        'runtime manifest generation'
    );
    const generatedManifest = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'runtime.json'), 'utf8'));
    assert.equal(generatedManifest.schemaVersion, 2);
    assert.equal(generatedManifest.executable, 'yanglint');
    assert.equal(generatedManifest.schemaExecutable, 'netnexus-libyang-schema');
    assert.equal(generatedManifest.schemaContractVersion, 1);
    assert.match(generatedManifest.sha256, /^[a-f0-9]{64}$/);
    assert.match(generatedManifest.schemaSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(generatedManifest.sha256, generatedManifest.schemaSha256);

    const status = verifyRuntime({
        projectRoot,
        platform: verifierPlatform,
        arch: verifierArch,
        runtimeDirectory,
        executable,
        schemaExecutable,
        spawnSync(command, args, options) {
            assert.deepEqual(args, ['--version']);
            assert.equal(options.cwd, path.dirname(command));
            assert.equal(options.windowsHide, true);
            if (command === executable) return { status: 0, stdout: 'yanglint 5.8.6\n', stderr: '' };
            assert.equal(command, schemaExecutable);
            return {
                status: 0,
                stdout: 'netnexus-libyang-schema 1 (libyang 5.8.6)\n',
                stderr: ''
            };
        }
    });
    assert.equal(status.available, true);
    assert.equal(status.required, true);
    assert.equal(status.engine, 'libyang');
    assert.equal(status.version, '5.8.6');
    assert.equal(status.source, 'bundled');
    assert.equal(status.schemaPath, schemaExecutable);
    assert.equal(status.schemaContractVersion, 1);

    assert.throws(
        () =>
            verifyRuntime({
                projectRoot,
                platform: verifierPlatform,
                arch: verifierArch,
                runtimeDirectory,
                executable,
                schemaExecutable,
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
                schemaExecutable,
                spawnSync: () => ({ status: 2, stdout: '', stderr: 'cannot load runtime' })
            }),
        /cannot execute: cannot load runtime/
    );

    fs.rmSync(schemaExecutable);
    assert.throws(
        () =>
            verifyRuntime({
                projectRoot,
                platform: verifierPlatform,
                arch: verifierArch,
                runtimeDirectory,
                executable,
                schemaExecutable
            }),
        /Schema helper is missing/
    );
    fs.writeFileSync(schemaExecutable, 'schema test fixture', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(schemaExecutable, 0o755);

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
                    executable: symlink,
                    schemaExecutable
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
                    executable,
                    schemaExecutable
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
                return {
                    version: '5.8.6',
                    path: `/runtime/${options.arch}/yanglint`,
                    schemaPath: `/runtime/${options.arch}/netnexus-libyang-schema`,
                    schemaContractVersion: 1
                };
            },
            write: message => messages.push(message)
        }
    );
    assert.deepEqual(calls, [
        { projectRoot: '/fixture/project', platform: 'darwin', arch: 'x64' },
        { projectRoot: '/fixture/project', platform: 'darwin', arch: 'arm64' }
    ]);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Verified bundled libyang 5\.8\.6 and effective Schema helper contract 1/);

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

function assertRuntimeBuiltBeforeTests(workflowFile, jobName, nextJobName, buildCommand) {
    const workflowSource = fs.readFileSync(path.join(projectRoot, workflowFile), 'utf8');
    const jobStart = workflowSource.indexOf(`    ${jobName}:`);
    const jobEnd = nextJobName ? workflowSource.indexOf(`    ${nextJobName}:`, jobStart + 1) : workflowSource.length;
    assert(jobStart >= 0 && jobEnd > jobStart, `${workflowFile} must contain the ${jobName} job`);
    const jobSource = workflowSource.slice(jobStart, jobEnd);
    const buildIndex = jobSource.indexOf(`run: ${buildCommand}`);
    const smokeIndex = jobSource.indexOf('run: npm run libyang:smoke');
    const testIndex = jobSource.indexOf('run: npm test');
    const minifiedIndex = jobSource.indexOf('run: npm run test:ci:minified');
    assert(
        buildIndex >= 0 && buildIndex < smokeIndex && smokeIndex < testIndex && testIndex < minifiedIndex,
        `${workflowFile} ${jobName} must build and smoke-test bundled libyang before running YANG CI tests`
    );
}

function testCiRuntimeBuildOrdering() {
    assertRuntimeBuiltBeforeTests(
        '.github/workflows/test.yml',
        'e2e-macos',
        'e2e-windows',
        'npm run libyang:build:unix'
    );
    assertRuntimeBuiltBeforeTests('.github/workflows/test.yml', 'e2e-windows', null, 'npm run libyang:build:windows');
    assertRuntimeBuiltBeforeTests(
        '.github/workflows/release.yml',
        'build-windows',
        'build-macos',
        'npm run libyang:build:windows'
    );
    assertRuntimeBuiltBeforeTests(
        '.github/workflows/release.yml',
        'build-macos',
        'publish',
        'npm run libyang:build:unix'
    );
}

async function run() {
    try {
        testPinnedReleaseAndPackageContract();
        testRuntimePathMapping();
        testRuntimeVerifierWithoutNativeRuntime();
        await testBeforePackHook();
        testCiRuntimeBuildOrdering();
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
