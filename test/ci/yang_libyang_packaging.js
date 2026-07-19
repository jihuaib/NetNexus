const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Platform } = require('app-builder-lib');
const { Arch } = require('builder-util');
const { configureBuildCommand, createYargs, normalizeOptions } = require('electron-builder/out/builder');
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory');
const {
    PINNED_IANA_MODULE_FILES,
    REQUIRED_RUNTIME_IETF_MODULES,
    collectRequiredRuntimeIetfModules,
    computeBuildInputHash,
    getBuildInputPaths,
    getPinnedIanaModuleManifest,
    getReleaseManifest,
    getRuntimeDirectory,
    getRuntimeExecutable,
    getRuntimeSchemaExecutable,
    normalizeArch,
    normalizePlatform,
    parseSchemaHelperVersion,
    parseYanglintVersion,
    verifyPinnedIanaModules,
    verifyRuntime
} = require('../../scripts/libyang-runtime-config');
const {
    ensureLibyangRuntime,
    isTruthyEnv,
    optionValue,
    resolveBuildCommand
} = require('../../scripts/ensure-libyang-runtime');
const beforePack = require('../../scripts/verify-libyang-runtime');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.resolve(__dirname, '..', '..'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-libyang-packaging-'));

function resolvedMacDistributionTargets(command, macOptions) {
    const [executable, ...args] = String(command || '')
        .trim()
        .split(/\s+/u);
    assert.equal(executable, 'electron-builder');
    const parsed = configureBuildCommand(createYargs()).exitProcess(false).parse(args);
    const rawTargets = normalizeOptions(parsed).targets.get(Platform.MAC);
    assert(rawTargets, `macOS distribution command did not select the macOS platform: ${command}`);
    const resolvedTargets = computeArchToTargetNamesMap(
        rawTargets,
        {
            platformSpecificBuildOptions: macOptions,
            defaultTarget: ['dmg', 'zip']
        },
        Platform.MAC
    );
    return [...resolvedTargets.entries()].map(([arch, targets]) => [Arch[arch], [...targets]]);
}

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

function assertUserInstalledVcpkgContract(powershellSource) {
    const resolverSource = extractPowerShellFunction(powershellSource, 'Resolve-VcpkgLocation');
    const explicitRootIndex = resolverSource.indexOf('$env:VCPKG_ROOT');
    const installationRootIndex = resolverSource.indexOf('$env:VCPKG_INSTALLATION_ROOT');
    const pathIndex = resolverSource.indexOf("Get-Command 'vcpkg.exe'");
    const visualStudioIndex = resolverSource.indexOf("Join-Path $VisualStudioRoot 'VC/vcpkg'");
    assert(
        explicitRootIndex >= 0 &&
            explicitRootIndex < installationRootIndex &&
            installationRootIndex < pathIndex &&
            pathIndex < visualStudioIndex,
        'vcpkg resolution must prefer VCPKG_ROOT, then the CI installation root, PATH, and the VS component'
    );
    assert.match(resolverSource, /Get-Command 'vcpkg\.exe' -CommandType Application/);
    assert.match(resolverSource, /Test-Path \$Executable -PathType Leaf/);
    assert.match(resolverSource, /scripts\/buildsystems\/vcpkg\.cmake/);
    assert.match(
        resolverSource,
        /Install the Visual Studio 2022 vcpkg component, or install vcpkg separately and set VCPKG_ROOT/,
        'a missing user-installed vcpkg must produce an actionable prerequisite error'
    );
    assert.match(
        resolverSource,
        /IsGitCheckout = Test-Path \(Join-Path \$Root '\.git'\)/,
        'Git checkouts must be identified without rejecting the Visual Studio manifest bundle'
    );
    assert.doesNotMatch(
        resolverSource,
        /not a Git checkout/,
        'the read-only Visual Studio vcpkg manifest bundle must not require local Git metadata'
    );
    assert.doesNotMatch(
        powershellSource,
        /function (?:Invoke-VcpkgBootstrap|Test-VcpkgCheckoutAtBaseline|Ensure-VcpkgCheckout)|LocalApplicationData|NetNexus\\BuildTools\\vcpkg|System\.Threading\.Mutex|git init \$Staging/,
        'the project must not download, bootstrap, cache, or publish its own vcpkg installation'
    );

    const resolveIndex = powershellSource.lastIndexOf('Resolve-VcpkgLocation -VisualStudioRoot $VisualStudioRoot');
    const gitCheckoutGuardIndex = powershellSource.lastIndexOf('if ($VcpkgLocation.IsGitCheckout) {');
    const ensureBaselineIndex = powershellSource.lastIndexOf(
        'Ensure-VcpkgBaseline -Path $VcpkgRoot -Baseline $VcpkgBaseline'
    );
    const installIndex = powershellSource.indexOf('& $Vcpkg install');
    assert(
        resolveIndex >= 0 &&
            resolveIndex < gitCheckoutGuardIndex &&
            gitCheckoutGuardIndex < ensureBaselineIndex &&
            ensureBaselineIndex < installIndex,
        'a user-provided Git checkout must repair its pinned baseline before dependency installation'
    );
}

function verifyScriptSyntax() {
    const javascriptScripts = [
        'scripts/ensure-libyang-runtime.js',
        'scripts/libyang-runtime-config.js',
        'scripts/verify-libyang-iana-modules.js',
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
    assert.match(unixBuildSource, /verify-libyang-iana-modules\.js/);
    assert.match(unixBuildSource, /x64\) cmake_target_arch="x86_64"/);
    assert.match(unixBuildSource, /macos_deployment_target="11\.0"/);
    assert.equal(
        Array.from(unixBuildSource.matchAll(/cmake_configure -S/g)).length,
        3,
        'PCRE2, libyang and the Schema helper must all receive the selected macOS architecture'
    );
    assert.match(unixBuildSource, /lipo "\$\{runtime_executable\}" -verify_arch "\$\{cmake_target_arch\}"/);
    assert.match(unixBuildSource, /"\$\{runtime_platform\}" "\$\{runtime_arch\}"/);
    assert.match(unixBuildSource, /find "\$\{iana_module_source\}"[^\r\n]+-name '\*\.yang'[^\r\n]+-exec cp/);
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
    assertUserInstalledVcpkgContract(powershellSource);
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
    assert.match(
        powershellSource,
        /Replace-PinnedSourceText\s+`\r?\n\s+\(Join-Path \$SourceDir 'tools\/lint\/main_ni_only\.c'\)\s+`\r?\n\s+\$YanglintMainBlock\s+`\r?\n\s+\$YanglintUtf8MainBlock/,
        'the Windows build must apply the drift-checked yanglint UTF-8 locale patch'
    );
    assert.match(
        powershellSource,
        /setlocale\(LC_CTYPE, "\.UTF8"\)[\s\S]*return main_ni\(argc, argv\);/,
        'Windows yanglint must enable the UTF-8 C runtime locale before invoking libyang'
    );
    assert.match(powershellSource, /Assert-GitCommit/);
    assert.match(powershellSource, /verify-libyang-iana-modules\.js/);
    assert.match(powershellSource, /Copy-Item \(Join-Path \$IanaModuleSource '\*\.yang'\) \$ModuleDir -Force/);
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
    assert.match(powershellSource, /versions\/v-\/vcpkg-cmake-config\.json/);
    assert.match(
        powershellSource,
        /git -C \$Path fetch --refetch --no-tags https:\/\/github\.com\/microsoft\/vcpkg\.git/
    );
    assert.doesNotMatch(powershellSource, /git -C \$Path fetch[^\r\n]*--depth/);
    assert.match(powershellSource, /--x-buildtrees-root=/);
    assert.match(powershellSource, /--x-packages-root=/);
    assert.match(powershellSource, /--downloads-root=/);
    assert.match(powershellSource, /CMake 3\.22 or newer/);
    assert.doesNotMatch(powershellSource, /CMake 3\.15/);
    assert.match(powershellSource, /-version '\[17\.0,18\.0\)'/);
    assert.match(powershellSource, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/);
    assert.equal(
        Array.from(powershellSource.matchAll(/-G 'Visual Studio 17 2022' -A x64/g)).length,
        2,
        'PCRE2 and libyang must both use the Visual Studio 2022 x64 generator'
    );
    assert.match(powershellSource, /\$env:VCPKG_VISUAL_STUDIO_PATH = \$VisualStudioRoot/);
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
    assert.match(schemaExporterSource, /#include <locale\.h>/, 'schema helper must include the C locale API');
    const schemaMainIndex = schemaExporterSource.indexOf('main(int argc, char **argv)');
    const schemaLocaleIndex = schemaExporterSource.indexOf('setlocale(LC_CTYPE, ".UTF8")', schemaMainIndex);
    const schemaArgumentLoopIndex = schemaExporterSource.indexOf('for (argument = 1;', schemaMainIndex);
    assert(
        schemaMainIndex >= 0 && schemaLocaleIndex > schemaMainIndex && schemaLocaleIndex < schemaArgumentLoopIndex,
        'schema helper must enable the UTF-8 C runtime locale before processing arguments'
    );
    for (const limitName of ['MAX_EXPORT_NODES', 'MAX_EXPORT_DEPTH', 'MAX_JSON_ALLOCATION_BYTES', 'MAX_JSON_BYTES']) {
        assert.match(schemaExporterSource, new RegExp(`(?:#define|${limitName}).*${limitName}|#define ${limitName}`));
    }
    assert.match(schemaExporterSource, /Schema export exceeded the maxNodes limit/);
    assert.match(schemaExporterSource, /Schema export exceeded the maxDepth limit/);
    assert.match(schemaExporterSource, /Schema export exceeded the maxJsonBytes limit/);
    assert.match(schemaExporterSource, /MAX_SCHEMA_LIST_BYTES/);
    assert.match(schemaExporterSource, /load_schema_path_list/);
    assert.match(schemaExporterSource, /--schema-list/);
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

    const ianaManifest = getPinnedIanaModuleManifest(projectRoot);
    assert.deepEqual(ianaManifest, {
        schemaVersion: 1,
        source: 'https://www.iana.org/assignments/yang-parameters/',
        retrievedAt: '2026-07-19',
        modules: [
            {
                file: 'ietf-interfaces@2018-02-20.yang',
                sha256: '742cf4ad04459e1018ea69015adafe0202ade27b85d8350c1845b640ee32da16'
            },
            {
                file: 'ietf-ip@2018-02-22.yang',
                sha256: '00c87aab91d95199927ba109c572eef3bca0fb949cedb3849b883e2d969d04b7'
            },
            {
                file: 'ietf-netconf-acm@2018-02-14.yang',
                sha256: '796951c3b64cc602d62a012312cf1a14255c97d12e99a5c5a2c932c2df4cadbf'
            },
            {
                file: 'ietf-network-instance@2019-01-21.yang',
                sha256: 'dc2b85fa0d8eefdf411b9c2fb2b032983324371ca6b277fabf939011f97bd2ea'
            },
            {
                file: 'ietf-restconf@2017-01-26.yang',
                sha256: 'e757021148926cc9b39b593598a2bd8f212423c68ea1cbb1ed1b65532d091297'
            },
            {
                file: 'ietf-subscribed-notifications@2019-09-09.yang',
                sha256: 'bccf35fad3785d25dd6ba4b1ff7e8533670d0fcf2fbe4dd5aa87682a10badced'
            },
            {
                file: 'ietf-yang-patch@2017-02-22.yang',
                sha256: '69cb8502718e0960d068bc2a5ea03daf8b5579b4a08b80146f4c11b875e465e9'
            },
            {
                file: 'ietf-yang-push@2019-09-09.yang',
                sha256: '7ba7d6733a10feba5bf72d0060a0f24f25212b0a3524a21d8e255b9b04f50dc1'
            }
        ]
    });
    assert.deepEqual(
        verifyPinnedIanaModules({ projectRoot }).modules,
        ianaManifest.modules,
        'source-controlled IANA modules must match their pinned SHA-256 digests'
    );
    const buildInputs = getBuildInputPaths(process.platform);
    for (const file of PINNED_IANA_MODULE_FILES) {
        assert(
            buildInputs.includes(path.join('resources', 'libyang', 'iana', file)),
            `${file} must participate in the runtime build-input fingerprint`
        );
    }
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
    assert.equal(packageJson.scripts['libyang:ensure'], 'node scripts/ensure-libyang-runtime.js');
    assert.equal(packageJson.scripts['libyang:build'], 'node scripts/ensure-libyang-runtime.js --force');
    assert.match(
        packageJson.scripts.postinstall,
        /(?:^|&&\s*)node scripts\/ensure-libyang-runtime\.js\s*$/,
        'npm install/npm ci must ensure the bundled libyang runtime automatically after existing install work'
    );
    assert.equal(packageJson.scripts['libyang:build:unix'], 'bash scripts/build-libyang-runtime.sh');
    assert.match(packageJson.scripts['libyang:build:windows'], /build-libyang-runtime\.ps1/);
    for (const licenseFile of ['LICENSE.libyang', 'LICENSE.pcre2', 'NOTICE.pthreads']) {
        assert(fs.statSync(path.join(projectRoot, 'resources', 'libyang', licenseFile)).isFile());
    }
}

function testMacDistributionArchitectureSelection() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.deepEqual(resolvedMacDistributionTargets(packageJson.scripts['dist:mac:arm64'], packageJson.build.mac), [
        ['arm64', ['dmg', 'zip']]
    ]);
    assert.deepEqual(resolvedMacDistributionTargets(packageJson.scripts['dist:mac'], packageJson.build.mac), [
        ['x64', ['dmg', 'zip']]
    ]);
    assert.deepEqual(resolvedMacDistributionTargets(packageJson.scripts['dist:mac:all'], packageJson.build.mac), [
        ['x64', ['dmg', 'zip']],
        ['arm64', ['dmg', 'zip']]
    ]);
    assert.deepEqual(resolvedMacDistributionTargets(packageJson.scripts['dist:mac:universal'], packageJson.build.mac), [
        ['universal', ['dmg', 'zip']]
    ]);
}

async function testInstallRuntimeEnsureContract() {
    const fixtureProjectRoot = path.join(tempDir, 'fixture-project');
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(isTruthyEnv(value), true);
    for (const value of [undefined, null, '', '0', 'false', 'no', 'off']) assert.equal(isTruthyEnv(value), false);
    assert.equal(optionValue('--arch', ['--platform', 'darwin', '--arch', 'x64']), 'x64');
    assert.throws(() => optionValue('--arch', ['--arch']), /--arch requires a value/);

    const unixBuild = resolveBuildCommand({
        projectRoot: fixtureProjectRoot,
        platform: 'darwin',
        arch: 'arm64'
    });
    assert.equal(unixBuild.command, 'bash');
    assert.equal(path.basename(unixBuild.args[0]), 'build-libyang-runtime.sh');
    assert.deepEqual(unixBuild.args.slice(1), ['--platform', 'darwin', '--arch', 'arm64']);

    const windowsBuild = resolveBuildCommand({
        projectRoot: 'C:\\fixture\\project',
        platform: 'win32',
        arch: 'x64'
    });
    assert.match(windowsBuild.command, /^powershell(?:\.exe)?$/i);
    assert.deepEqual(windowsBuild.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(path.win32.basename(windowsBuild.args.at(-1)), 'build-libyang-runtime.ps1');
    assert.throws(
        () => resolveBuildCommand({ projectRoot: fixtureProjectRoot, platform: 'win32', arch: 'arm64' }),
        /Windows support x64 only/
    );
    assert.throws(
        () => resolveBuildCommand({ projectRoot: fixtureProjectRoot, platform: 'freebsd', arch: 'x64' }),
        /not supported on platform freebsd/
    );

    const verifyOptions = [];
    await ensureLibyangRuntime(
        {
            projectRoot: fixtureProjectRoot,
            platform: 'darwin',
            arch: 'arm64',
            env: {}
        },
        {
            verifyRuntime(options) {
                verifyOptions.push(options);
                return { available: true, version: '5.8.6' };
            },
            spawnSync() {
                assert.fail('a valid bundled runtime must not be rebuilt');
            },
            write() {}
        }
    );
    assert.deepEqual(verifyOptions, [{ projectRoot: fixtureProjectRoot, platform: 'darwin', arch: 'arm64' }]);

    let verifyAttempt = 0;
    const buildCalls = [];
    await ensureLibyangRuntime(
        {
            projectRoot: fixtureProjectRoot,
            platform: 'darwin',
            arch: 'arm64',
            env: {}
        },
        {
            verifyRuntime(options) {
                verifyAttempt += 1;
                assert.equal(options.projectRoot, fixtureProjectRoot);
                assert.equal(options.platform, 'darwin');
                assert.equal(options.arch, 'arm64');
                if (verifyAttempt === 1) throw new Error('runtime missing');
                return { available: true, version: '5.8.6' };
            },
            spawnSync(command, args, options) {
                buildCalls.push({ command, args, options });
                return { status: 0, stdout: '', stderr: '' };
            },
            write() {}
        }
    );
    assert.equal(verifyAttempt, 2, 'a rebuilt runtime must be verified before npm install succeeds');
    assert.equal(buildCalls.length, 1);
    assert.equal(buildCalls[0].command, 'bash');
    assert.equal(path.basename(buildCalls[0].args[0]), 'build-libyang-runtime.sh');
    assert.deepEqual(buildCalls[0].args.slice(1), ['--platform', 'darwin', '--arch', 'arm64']);
    assert.equal(buildCalls[0].options.cwd, fixtureProjectRoot);

    let skippedWork = false;
    await ensureLibyangRuntime(
        {
            projectRoot: fixtureProjectRoot,
            platform: 'linux',
            arch: 'x64',
            env: { NETNEXUS_SKIP_LIBYANG_BUILD: '1' }
        },
        {
            verifyRuntime() {
                skippedWork = true;
            },
            spawnSync() {
                skippedWork = true;
            },
            write() {}
        }
    );
    assert.equal(skippedWork, false, 'the explicit skip flag must bypass verification and compilation');

    let forcedVerifyCount = 0;
    let forcedBuildCount = 0;
    await ensureLibyangRuntime(
        {
            projectRoot: fixtureProjectRoot,
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            force: true
        },
        {
            verifyRuntime() {
                forcedVerifyCount += 1;
                return { available: true, version: '5.8.6' };
            },
            spawnSync() {
                forcedBuildCount += 1;
                return { status: 0, stdout: '', stderr: '' };
            },
            write() {}
        }
    );
    assert.equal(forcedBuildCount, 1);
    assert.equal(forcedVerifyCount, 1, 'force mode must build first and then verify once');

    assert.throws(
        () =>
            ensureLibyangRuntime(
                {
                    projectRoot: fixtureProjectRoot,
                    platform: 'darwin',
                    arch: 'arm64',
                    env: {},
                    force: true
                },
                {
                    verifyRuntime() {
                        assert.fail('a failed build must not be verified');
                    },
                    spawnSync() {
                        return { status: 9, signal: null };
                    },
                    write() {}
                }
            ),
        /build failed with exit code 9/
    );
    assert.throws(
        () =>
            ensureLibyangRuntime(
                {
                    projectRoot: fixtureProjectRoot,
                    platform: 'darwin',
                    arch: 'arm64',
                    env: {},
                    force: true
                },
                {
                    verifyRuntime() {
                        assert.fail('a build that could not start must not be verified');
                    },
                    spawnSync() {
                        return { error: new Error('spawn unavailable'), status: null };
                    },
                    write() {}
                }
            ),
        /Unable to start the bundled libyang build: spawn unavailable/
    );
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
    const verifierPlatform = normalizePlatform(process.platform);
    const verifierArch = normalizeArch(process.arch);
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
    const runtimeModuleDirectory = path.join(runtimeDirectory, 'share', 'yang', 'modules', 'libyang');
    fs.mkdirSync(runtimeModuleDirectory, { recursive: true });
    for (const file of PINNED_IANA_MODULE_FILES) {
        fs.copyFileSync(
            path.join(projectRoot, 'resources', 'libyang', 'iana', file),
            path.join(runtimeModuleDirectory, file)
        );
    }
    for (const [index, moduleName] of REQUIRED_RUNTIME_IETF_MODULES.entries()) {
        const file = `${moduleName}@2000-01-${String(index + 1).padStart(2, '0')}.yang`;
        fs.writeFileSync(
            path.join(runtimeModuleDirectory, file),
            `module ${moduleName} { namespace "urn:netnexus:test:${moduleName}"; prefix test; }\n`,
            'utf8'
        );
    }

    assertCommandSucceeds(
        process.execPath,
        [
            'scripts/write-libyang-runtime-manifest.js',
            runtimeDirectory,
            executable,
            schemaExecutable,
            verifierPlatform,
            verifierArch
        ],
        'runtime manifest generation'
    );
    const runtimeManifestPath = path.join(runtimeDirectory, 'runtime.json');
    const generatedManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
    assert.equal(generatedManifest.schemaVersion, 3);
    assert.equal(generatedManifest.executable, 'yanglint');
    assert.equal(generatedManifest.schemaExecutable, 'netnexus-libyang-schema');
    assert.equal(generatedManifest.schemaContractVersion, 1);
    assert.match(generatedManifest.buildInputHash, /^[a-f0-9]{64}$/);
    assert.equal(
        generatedManifest.buildInputHash,
        computeBuildInputHash({ projectRoot, platform: verifierPlatform, arch: verifierArch })
    );
    assert.match(generatedManifest.sha256, /^[a-f0-9]{64}$/);
    assert.match(generatedManifest.schemaSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(generatedManifest.sha256, generatedManifest.schemaSha256);
    assert.deepEqual(generatedManifest.ianaYangModules, getPinnedIanaModuleManifest(projectRoot).modules);
    assert.deepEqual(generatedManifest.requiredIetfYangModules, collectRequiredRuntimeIetfModules(runtimeDirectory));

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

    const firstIanaRuntimeModule = path.join(runtimeModuleDirectory, PINNED_IANA_MODULE_FILES[0]);
    fs.appendFileSync(firstIanaRuntimeModule, '\n// corrupted test fixture\n', 'utf8');
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
        /Bundled IANA YANG module .* SHA-256 mismatch/
    );
    fs.copyFileSync(
        path.join(projectRoot, 'resources', 'libyang', 'iana', PINNED_IANA_MODULE_FILES[0]),
        firstIanaRuntimeModule
    );

    const firstDependencyModule = path.join(runtimeModuleDirectory, generatedManifest.requiredIetfYangModules[0].file);
    const firstDependencySource = fs.readFileSync(firstDependencyModule);
    fs.appendFileSync(firstDependencyModule, '\n// corrupted dependency fixture\n', 'utf8');
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
        /dependency closure/
    );
    fs.writeFileSync(firstDependencyModule, firstDependencySource);

    const executableSource = fs.readFileSync(executable);
    fs.appendFileSync(executable, '\ncorrupted executable fixture\n', 'utf8');
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
        /Bundled yanglint SHA-256 mismatch/
    );
    fs.writeFileSync(executable, executableSource);

    const schemaExecutableSource = fs.readFileSync(schemaExecutable);
    fs.appendFileSync(schemaExecutable, '\ncorrupted schema helper fixture\n', 'utf8');
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
        /Bundled libyang Schema helper SHA-256 mismatch/
    );
    fs.writeFileSync(schemaExecutable, schemaExecutableSource);

    fs.writeFileSync(
        runtimeManifestPath,
        `${JSON.stringify({ ...generatedManifest, buildInputHash: '0'.repeat(64) }, null, 4)}\n`,
        'utf8'
    );
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
        /build inputs changed.*rebuild is required/
    );
    fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(generatedManifest, null, 4)}\n`, 'utf8');

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
                    platform: verifierPlatform,
                    arch: verifierArch,
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
                    platform: verifierPlatform,
                    arch: verifierArch,
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

function getWorkflowJobSource(workflowFile, jobName, nextJobName) {
    const workflowSource = fs.readFileSync(path.join(projectRoot, workflowFile), 'utf8');
    const jobStart = workflowSource.indexOf(`    ${jobName}:`);
    const jobEnd = nextJobName ? workflowSource.indexOf(`    ${nextJobName}:`, jobStart + 1) : workflowSource.length;
    assert(jobStart >= 0 && jobEnd > jobStart, `${workflowFile} must contain the ${jobName} job`);
    return workflowSource.slice(jobStart, jobEnd);
}

function assertRuntimeEnsuredBeforeTests(workflowFile, jobName, nextJobName, { macos = false } = {}) {
    const jobSource = getWorkflowJobSource(workflowFile, jobName, nextJobName);
    const installIndex = jobSource.indexOf('run: npm ci');
    const smokeIndex = jobSource.indexOf('run: npm run libyang:smoke');
    const testIndex = jobSource.indexOf('run: npm test');
    const minifiedIndex = jobSource.indexOf('run: npm run test:ci:minified');
    assert(
        installIndex >= 0 && installIndex < smokeIndex && smokeIndex < testIndex && testIndex < minifiedIndex,
        `${workflowFile} ${jobName} must install/ensure and smoke-test bundled libyang before YANG CI tests`
    );
    assert.doesNotMatch(
        jobSource,
        /run: npm run libyang:build:(?:unix|windows)/,
        `${workflowFile} ${jobName} must rely on postinstall instead of compiling libyang twice`
    );
    if (!macos) return;
    const buildDependenciesIndex = jobSource.indexOf('run: brew install cmake');
    assert(
        buildDependenciesIndex >= 0 && buildDependenciesIndex < installIndex,
        `${workflowFile} ${jobName} must install CMake before npm ci invokes the libyang postinstall build`
    );
}

function testCiRuntimeInstallOrdering() {
    assertRuntimeEnsuredBeforeTests('.github/workflows/test.yml', 'e2e-macos', 'e2e-windows', { macos: true });
    assertRuntimeEnsuredBeforeTests('.github/workflows/test.yml', 'e2e-windows', null);
    assertRuntimeEnsuredBeforeTests('.github/workflows/release.yml', 'build-windows', 'build-macos');
    assertRuntimeEnsuredBeforeTests('.github/workflows/release.yml', 'build-macos', 'publish', { macos: true });

    const frrJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'frr-bmp-e2e', 'e2e-macos');
    assert.match(
        frrJobSource,
        /NETNEXUS_SKIP_LIBYANG_BUILD:\s*['"]1['"]/,
        'the FRR-only job must explicitly skip the unrelated libyang postinstall build'
    );

    const macTestJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'e2e-macos', 'e2e-windows');
    for (const [jobSource, workflowFile] of [
        [macTestJobSource, '.github/workflows/test.yml'],
        [
            getWorkflowJobSource('.github/workflows/release.yml', 'build-macos', 'publish'),
            '.github/workflows/release.yml'
        ]
    ]) {
        assert.equal(
            Array.from(jobSource.matchAll(/BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\s*['"]20000['"]/g)).length,
            2,
            `${workflowFile} must apply the hosted macOS performance budget to both CI test passes`
        );
        assert.match(
            jobSource,
            /- name: Run macOS tests\s+run: npm test\s+env:\s+BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\s*['"]20000['"]/,
            `${workflowFile} must scope the hosted-runner budget to the normal macOS test step`
        );
        assert.match(
            jobSource,
            /- name: Run macOS minified CI tests\s+run: npm run test:ci:minified\s+env:\s+BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\s*['"]20000['"]/,
            `${workflowFile} must scope the hosted-runner budget to the minified macOS test step`
        );
    }

    const windowsJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'e2e-windows', null);
    assert.match(
        windowsJobSource,
        /- name: Install dependencies\s+run: npm ci/,
        'Windows CI must use its preinstalled vcpkg while npm ci ensures the bundled runtime'
    );
    assert.doesNotMatch(
        windowsJobSource,
        /(?:VCPKG_ROOT|VCPKG_INSTALLATION_ROOT):\s*['"]{2}/,
        'Windows CI must not hide the runner-provided vcpkg installation from the build'
    );
    assert.doesNotMatch(windowsJobSource, /BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS/);

    const windowsReleaseJobSource = getWorkflowJobSource(
        '.github/workflows/release.yml',
        'build-windows',
        'build-macos'
    );
    assert.doesNotMatch(windowsReleaseJobSource, /BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS/);

    const performanceTestSource = fs.readFileSync(
        path.join(projectRoot, 'test', 'ci', 'bmp_route_assurance_performance.js'),
        'utf8'
    );
    assert.match(
        performanceTestSource,
        /FIRST_BUILD_BUDGET_MS\s*=\s*Number\([^\r\n]+\|\|\s*15_000\)/,
        'local and non-macOS CI must retain the 15-second default performance budget'
    );

    const macReleaseJobSource = getWorkflowJobSource('.github/workflows/release.yml', 'build-macos', 'publish');
    assert.match(macReleaseJobSource, /name:\s*Build macOS arm64 and x64/);
    assert.match(macReleaseJobSource, /runs-on:\s*macos-15/);
    assert.doesNotMatch(macReleaseJobSource, /macos-15-intel|matrix\./);
    assert.match(macReleaseJobSource, /architecture:\s*arm64/);
    assert.match(macReleaseJobSource, /architecture:\s*x64/);
    assert.match(macReleaseJobSource, /npm_config_arch:\s*x64/);
    assert.match(macReleaseJobSource, /npm run libyang:ensure -- --platform darwin --arch x64/);
    assert.match(macReleaseJobSource, /E2E_APP_EXECUTABLE:\s*release\/mac\/NetNexus\.app\/Contents\/MacOS\/NetNexus/);
    assert.match(macReleaseJobSource, /name:\s*macos(?:\s|$)/);

    const armPackageIndex = macReleaseJobSource.indexOf('run: npm run dist:mac:arm64 -- --publish never');
    const armSmokeIndex = macReleaseJobSource.indexOf('PACKAGED_SQLITE_EXPECTED_ARCH: arm64');
    const rosettaIndex = macReleaseJobSource.indexOf('- name: Ensure Rosetta 2 is available');
    const x64RuntimeBuildIndex = macReleaseJobSource.indexOf('- name: Build bundled x64 libyang runtime');
    const x64InstallIndex = macReleaseJobSource.indexOf('- name: Install x64 dependencies');
    const x64RuntimeVerifyIndex = macReleaseJobSource.indexOf('- name: Verify bundled x64 libyang runtime');
    const x64PackageIndex = macReleaseJobSource.indexOf('run: npm run dist:mac -- --publish never');
    const x64SmokeIndex = macReleaseJobSource.indexOf('PACKAGED_SQLITE_EXPECTED_ARCH: x64');
    const uploadIndex = macReleaseJobSource.indexOf('- name: Upload macOS artifacts');
    assert(
        armPackageIndex >= 0 &&
            armPackageIndex < armSmokeIndex &&
            armSmokeIndex < rosettaIndex &&
            rosettaIndex < x64RuntimeBuildIndex &&
            x64RuntimeBuildIndex < x64InstallIndex &&
            x64InstallIndex < x64RuntimeVerifyIndex &&
            x64RuntimeVerifyIndex < x64PackageIndex &&
            x64PackageIndex < x64SmokeIndex &&
            x64SmokeIndex < uploadIndex,
        'the single Apple Silicon release job must pass arm64 before rebuilding, packaging and verifying x64'
    );
}

async function run() {
    try {
        testPinnedReleaseAndPackageContract();
        testMacDistributionArchitectureSelection();
        await testInstallRuntimeEnsureContract();
        testRuntimePathMapping();
        testRuntimeVerifierWithoutNativeRuntime();
        await testBeforePackHook();
        testCiRuntimeInstallOrdering();
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
