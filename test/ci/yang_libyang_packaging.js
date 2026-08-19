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
const packagingBeforePack = require('../../scripts/verify-packaging-runtime');
const { ensureTcpAoHelper, getBuildReason, resolveHelperPaths } = require('../../scripts/ensure-tcp-ao-helper');
const {
    assertNativeLinuxBuild,
    optionValue: linuxOptionValue,
    prepareLinuxPackage
} = require('../../scripts/prepare-linux-package');
const {
    patchPackagedElectronRpath,
    renderControl,
    renderPostInstall,
    renderPostRemove,
    renderPreRemove
} = require('../../scripts/build-linux-deb');
const { builderArguments: linuxDistributionBuilderArguments } = require('../../scripts/build-linux-distribution');

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
        'scripts/ensure-tcp-ao-helper.js',
        'scripts/build-linux-deb.js',
        'scripts/build-linux-distribution.js',
        'scripts/installed-bgp-port179-smoke.js',
        'scripts/libyang-runtime-config.js',
        'scripts/prepare-e2e-release.js',
        'scripts/prepare-linux-package.js',
        'scripts/release.js',
        'scripts/better-sqlite3-rebuild-lock.js',
        'scripts/rebuild-better-sqlite3.js',
        'scripts/smoke-better-sqlite3-runtime.js',
        'scripts/verify-libyang-iana-modules.js',
        'scripts/verify-libyang-runtime.js',
        'scripts/verify-packaging-runtime.js',
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
        /# {2}else\r?\n# {4}define LIBYANG_API_DEF\r?\n# {4}define LIBYANG_API_DECL\r?\n# {2}endif/,
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
    assert.match(
        schemaExporterSource,
        /#define EXPORT_SCHEMA_VERSION 4/,
        'empty-string schema metadata must advance the native helper compatibility contract'
    );
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
    assert.equal(packageJson.build.beforePack, 'scripts/verify-packaging-runtime.js');
    assert.equal(
        packageJson.build.buildDependenciesFromSource,
        true,
        'electron-builder must not restore prebuilt native modules after Linux packaging preparation'
    );
    assert(
        packageJson.build.extraResources.some(
            resource => resource.from === 'resources/libyang' && resource.to === 'libyang'
        ),
        'electron-builder must copy the bundled libyang runtime into the application resources'
    );
    assert.deepEqual(packageJson.build.linux.target, ['deb']);
    assert(
        packageJson.build.linux.extraResources.some(
            resource => resource.from === 'resources/tcp-ao/linux-${arch}' && resource.to === 'tcp-ao/linux-${arch}'
        ),
        'Linux packages must copy only the target-architecture TCP-AO helper into application resources'
    );
    for (const dependency of [
        'libc6 (>= 2.38)',
        'libstdc++6 (>= 13.1)',
        'libglib2.0-0 | libglib2.0-0t64',
        'libgtk-3-0 | libgtk-3-0t64',
        'libnspr4',
        'libnss3',
        'libatk1.0-0 | libatk1.0-0t64',
        'libcups2 | libcups2t64',
        'libdbus-1-3',
        'libcairo2',
        'libpango-1.0-0',
        'libx11-6',
        'libxcomposite1',
        'libxdamage1',
        'libxext6',
        'libxfixes3',
        'libxrandr2',
        'libgbm1',
        'libexpat1',
        'libxcb1',
        'libudev1',
        'libasound2 | libasound2t64',
        'libuuid1',
        'libcap2-bin',
        'fonts-noto-cjk'
    ]) {
        assert(packageJson.build.deb.depends.includes(dependency), `Debian package must depend on ${dependency}`);
    }
    const debControl = renderControl(packageJson, 'arm64', 1024);
    assert.match(debControl, /^Depends: .*libcap2-bin/mu);
    assert.match(debControl, /^Depends: .*fonts-noto-cjk/mu);
    assert.doesNotMatch(debControl, /^Recommends:/mu);
    assert.equal(packageJson.scripts['tcp-ao:build'], 'bash scripts/build-tcp-ao-helper.sh');
    assert.equal(packageJson.scripts['tcp-ao:ensure'], 'node scripts/ensure-tcp-ao-helper.js');
    assert.equal(packageJson.scripts['tcp-ao:test:native'], 'bash scripts/test-tcp-ao-helper.sh');
    assert.equal(packageJson.scripts['better-sqlite3:rebuild'], 'node scripts/rebuild-better-sqlite3.js');
    assert.equal(packageJson.scripts['better-sqlite3:smoke'], 'node scripts/smoke-better-sqlite3-runtime.js');
    assert.equal(packageJson.scripts['pack:linux:x64'], 'electron-builder --linux --x64 --dir');
    assert.equal(packageJson.scripts['pack:linux:arm64'], 'electron-builder --linux --arm64 --dir');
    assert.equal(packageJson.scripts['dist:linux'], 'node scripts/build-linux-distribution.js');
    assert.equal(packageJson.scripts['dist:linux:x64'], 'node scripts/build-linux-distribution.js --arch x64');
    assert.equal(packageJson.scripts['dist:linux:arm64'], 'node scripts/build-linux-distribution.js --arch arm64');
    assert.equal(packageJson.scripts['prepack:linux:x64'], 'node scripts/prepare-linux-package.js --arch x64');
    assert.equal(packageJson.scripts['prepack:linux:arm64'], 'node scripts/prepare-linux-package.js --arch arm64');
    assert.equal(packageJson.scripts['predist:linux:x64'], 'node scripts/prepare-linux-package.js --arch x64');
    assert.equal(packageJson.scripts['predist:linux:arm64'], 'node scripts/prepare-linux-package.js --arch arm64');
    assert.equal(packageJson.scripts['release:mac'], undefined, 'macOS must not expose a release command');
    assert.equal(packageJson.scripts['prerelease:mac'], undefined, 'macOS must not expose a release lifecycle hook');
    for (const scriptName of ['dist:mac', 'dist:mac:arm64', 'dist:mac:all', 'dist:mac:universal']) {
        assert.match(
            packageJson.scripts[scriptName],
            /--publish never$/u,
            `${scriptName} may build a local validation artifact but must never publish it`
        );
    }
    for (const scriptPath of [
        'scripts/ensure-tcp-ao-helper.js',
        'scripts/build-linux-deb.js',
        'scripts/build-linux-distribution.js',
        'scripts/installed-bgp-port179-smoke.js',
        'scripts/prepare-linux-package.js',
        'scripts/better-sqlite3-rebuild-lock.js',
        'scripts/rebuild-better-sqlite3.js',
        'scripts/smoke-better-sqlite3-runtime.js',
        'scripts/verify-packaging-runtime.js'
    ]) {
        assert(fs.statSync(path.join(projectRoot, scriptPath)).isFile(), `${scriptPath} must exist`);
    }
    const e2ePrepareSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'prepare-e2e-release.js'), 'utf8');
    const e2eHelperBuildIndex = e2ePrepareSource.indexOf("runCommand(npmCommand, ['run', 'tcp-ao:build'])");
    const e2ePackIndex = e2ePrepareSource.indexOf('const { command, args, shell } = getPackCommand()');
    assert(
        e2eHelperBuildIndex >= 0 && e2eHelperBuildIndex < e2ePackIndex,
        'Linux E2E packaging must build the native TCP-AO helper before invoking electron-builder'
    );
    assert.equal(packageJson.scripts['libyang:verify'], 'node scripts/verify-libyang-runtime.js');
    assert.equal(packageJson.scripts['libyang:ensure'], 'node scripts/ensure-libyang-runtime.js');
    assert.equal(packageJson.scripts['libyang:build'], 'node scripts/ensure-libyang-runtime.js --force');
    assert.equal(
        packageJson.scripts.predev,
        'npm run libyang:ensure && npm run tcp-ao:ensure',
        'development startup must ensure both native runtime helpers before Electron launches'
    );
    assert.match(
        packageJson.scripts.postinstall,
        /(?:^|&&\s*)node scripts\/ensure-libyang-runtime\.js\s*$/,
        'npm install/npm ci must ensure the bundled libyang runtime automatically after existing install work'
    );
    const postinstallSourceRebuildIndex = packageJson.scripts.postinstall.indexOf('npm run better-sqlite3:rebuild');
    const postinstallSmokeIndex = packageJson.scripts.postinstall.indexOf('npm run better-sqlite3:smoke');
    assert(postinstallSourceRebuildIndex >= 0, 'npm install/npm ci must rebuild better-sqlite3 from source');
    assert(
        postinstallSmokeIndex > postinstallSourceRebuildIndex,
        'npm install/npm ci must smoke-test better-sqlite3 after its source rebuild'
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
    assert.deepEqual(parseSchemaHelperVersion('netnexus-libyang-schema 4 (libyang 5.8.6)\n'), {
        contractVersion: 4,
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
    assert.equal(generatedManifest.schemaContractVersion, 4);
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
                stdout: 'netnexus-libyang-schema 4 (libyang 5.8.6)\n',
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
    assert.equal(status.schemaContractVersion, 4);

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
                    schemaContractVersion: 4
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
    assert.match(messages[0], /Verified bundled libyang 5\.8\.6 and effective Schema helper contract 4/);

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

function testLinuxPackagingPreparation() {
    assert.equal(linuxOptionValue('--arch', ['--arch', 'arm64']), 'arm64');
    assert.throws(() => linuxOptionValue('--arch', ['--arch']), /--arch requires a value/);
    assert.deepEqual(assertNativeLinuxBuild({ platform: 'linux', hostArch: 'aarch64', targetArch: 'arm64' }), {
        platform: 'linux',
        hostArch: 'arm64',
        targetArch: 'arm64'
    });
    assert.throws(
        () => assertNativeLinuxBuild({ platform: 'darwin', hostArch: 'arm64', targetArch: 'arm64' }),
        /must be built on Linux/
    );
    assert.throws(
        () => assertNativeLinuxBuild({ platform: 'linux', hostArch: 'arm64', targetArch: 'x64' }),
        /cross-architecture packaging is not supported/
    );

    const checkMessages = [];
    prepareLinuxPackage(
        { platform: 'linux', hostArch: 'arm64', targetArch: 'arm64', checkOnly: true },
        {
            write: message => checkMessages.push(message),
            spawnSync() {
                assert.fail('check-only preparation must not execute build commands');
            }
        }
    );
    assert.match(checkMessages.join(''), /native arm64 configuration/);

    const invocations = [];
    prepareLinuxPackage(
        { platform: 'linux', hostArch: 'arm64', targetArch: 'arm64' },
        {
            spawnSync(command, args) {
                invocations.push([command, args]);
                return { status: 0 };
            }
        }
    );
    assert.deepEqual(invocations, [
        ['npm', ['run', 'better-sqlite3:rebuild']],
        ['npm', ['run', 'better-sqlite3:smoke']],
        ['npm', ['run', 'build']],
        ['npm', ['run', 'tcp-ao:build']],
        ['npm', ['run', 'libyang:ensure', '--', '--platform', 'linux', '--arch', 'arm64']]
    ]);
    assert.deepEqual(linuxDistributionBuilderArguments(['--arch', 'arm64', '--publish', 'never'], 'arm64'), [
        '--linux',
        '--arm64',
        '--dir'
    ]);
    assert.deepEqual(linuxDistributionBuilderArguments(['--publish=never'], 'x64'), ['--linux', '--x64', '--dir']);
    assert.throws(
        () => linuxDistributionBuilderArguments(['AppImage'], 'arm64'),
        /Unsupported Linux distribution argument: AppImage/
    );

    const postInstall = renderPostInstall('net-nexus', 'NetNexus');
    assert.match(postInstall, /chmod 4755 '\/opt\/NetNexus\/chrome-sandbox'/);
    assert.doesNotMatch(postInstall, /chmod 4755[^\n]+\|\| true/);
    assert.match(postInstall, /PATH='\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/);
    assert.match(postInstall, /app_binary='\/opt\/NetNexus\/net-nexus'/);
    assert.match(postInstall, /chown root:root "\$app_binary"/);
    assert.match(postInstall, /chmod 0755 "\$app_binary"/);
    assert.match(postInstall, /if ! setcap 'cap_net_bind_service=ep' "\$app_binary"; then/);
    assert.match(postInstall, /if \[ "\$\(getcap "\$app_binary"\)" != "\$app_binary cap_net_bind_service=ep" \]; then/);
    assert.doesNotMatch(postInstall, /setcap[^\n]+\|\| true/);

    const preRemove = renderPreRemove('net-nexus', 'NetNexus');
    assert.match(preRemove, /remove\|deconfigure\)/);
    assert.match(preRemove, /--remove 'net-nexus' '\/opt\/NetNexus\/net-nexus'/);
    assert.doesNotMatch(preRemove, /purge\)/);
    assert.doesNotMatch(preRemove, /setcap/);

    const postRemove = renderPostRemove('net-nexus', 'NetNexus');
    assert.match(postRemove, /purge\)/);
    assert.doesNotMatch(postRemove, /remove\|deconfigure\)/);
    assert.doesNotMatch(postRemove, /setcap/);

    const patchelfCalls = [];
    assert.equal(
        patchPackagedElectronRpath('/fixture/staging/opt/NetNexus/net-nexus', '/opt/NetNexus', {
            cwd: '/fixture/project',
            env: { PATH: '/usr/bin' },
            spawnSync(command, args, options) {
                patchelfCalls.push({ command, args, options });
                return args[0] === '--print-rpath'
                    ? { status: 0, stdout: '/opt/NetNexus\n' }
                    : { status: 0, stdout: '' };
            }
        }),
        '/opt/NetNexus'
    );
    assert.deepEqual(
        patchelfCalls.map(call => [call.command, call.args]),
        [
            ['patchelf', ['--force-rpath', '--set-rpath', '/opt/NetNexus', '/fixture/staging/opt/NetNexus/net-nexus']],
            ['patchelf', ['--print-rpath', '/fixture/staging/opt/NetNexus/net-nexus']]
        ]
    );
    assert.throws(
        () =>
            patchPackagedElectronRpath('/fixture/net-nexus', '/opt/NetNexus', {
                spawnSync() {
                    return { error: new Error('ENOENT') };
                }
            }),
        /install the patchelf build dependency/
    );
    assert.throws(
        () => patchPackagedElectronRpath('/fixture/net-nexus', 'relative/path'),
        /must be an absolute installation directory/
    );

    const debBuilderSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'build-linux-deb.js'), 'utf8');
    assert.match(debBuilderSource, /chmodSync\(path\.join\(installRoot, 'chrome-sandbox'\), 0o4755\)/);
    assert.match(debBuilderSource, /'--root-owner-group'/);
}

function testTcpAoHelperEnsure() {
    let touched = false;
    assert.equal(
        ensureTcpAoHelper(
            { projectRoot: '/unused', platform: 'darwin', arch: 'arm64' },
            {
                spawnSync() {
                    touched = true;
                },
                verifyTcpAoHelper() {
                    touched = true;
                }
            }
        ),
        null
    );
    assert.equal(touched, false, 'non-Linux TCP-AO setup must skip without touching build dependencies');

    const helperProjectRoot = path.join(tempDir, 'tcp-ao-ensure-fixture');
    const paths = resolveHelperPaths({ projectRoot: helperProjectRoot, platform: 'linux', arch: 'aarch64' });
    fs.mkdirSync(path.dirname(paths.sourceFile), { recursive: true });
    fs.mkdirSync(path.dirname(paths.helperPath), { recursive: true });
    fs.writeFileSync(paths.sourceFile, '/* fixture */\n');
    fs.writeFileSync(paths.buildScript, '#!/usr/bin/env bash\n');
    fs.writeFileSync(paths.helperPath, 'fixture\n', { mode: 0o755 });
    const older = new Date(Date.now() - 20_000);
    const newer = new Date(Date.now() - 10_000);
    fs.utimesSync(paths.sourceFile, older, older);
    fs.utimesSync(paths.buildScript, older, older);
    fs.utimesSync(paths.helperPath, newer, newer);
    assert.equal(getBuildReason(paths), '');

    const currentMessages = [];
    const currentStatus = { versionOutput: 'netnexus-tcp-ao-helper 1.0.0' };
    assert.equal(
        ensureTcpAoHelper(
            { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
            {
                spawnSync() {
                    assert.fail('a current TCP-AO helper must not be rebuilt');
                },
                verifyTcpAoHelper(options) {
                    assert.deepEqual(options, {
                        projectRoot: helperProjectRoot,
                        platform: 'linux',
                        arch: 'arm64'
                    });
                    return currentStatus;
                },
                write: message => currentMessages.push(message)
            }
        ),
        currentStatus
    );
    assert.match(currentMessages.join(''), /is current; skipping rebuild/);

    const latest = new Date();
    fs.utimesSync(paths.sourceFile, latest, latest);
    assert.match(getBuildReason(paths), /tcp-ao-helper\.c is newer/);
    const buildCalls = [];
    ensureTcpAoHelper(
        { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
        {
            spawnSync(command, args, options) {
                buildCalls.push({ command, args, options });
                return { status: 0 };
            },
            verifyTcpAoHelper: () => currentStatus,
            write() {}
        }
    );
    assert.equal(buildCalls.length, 1);
    assert.equal(buildCalls[0].command, 'bash');
    assert.deepEqual(buildCalls[0].args, [paths.buildScript]);
    assert.equal(buildCalls[0].options.cwd, helperProjectRoot);

    fs.utimesSync(paths.helperPath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    let verificationCount = 0;
    let rebuildCount = 0;
    ensureTcpAoHelper(
        { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
        {
            spawnSync() {
                rebuildCount++;
                return { status: 0 };
            },
            verifyTcpAoHelper() {
                verificationCount++;
                if (verificationCount === 1) throw new Error('fixture validation failure');
                return currentStatus;
            },
            write() {}
        }
    );
    assert.equal(rebuildCount, 1, 'a helper that fails validation must be rebuilt once');
    assert.equal(verificationCount, 2, 'a rebuilt helper must be verified again');
}

async function testPackagingBeforePackHook() {
    const calls = [];
    const messages = [];
    await packagingBeforePack(
        {
            electronPlatformName: 'linux',
            arch: Arch.arm64,
            packager: { projectDir: '/fixture/project' }
        },
        {
            async verifyLibyangBeforePack() {
                calls.push('libyang');
            },
            verifyTcpAoHelper(options) {
                calls.push('tcp-ao');
                assert.deepEqual(options, {
                    projectRoot: '/fixture/project',
                    platform: 'linux',
                    arch: 'arm64'
                });
                return {
                    platform: 'linux',
                    arch: 'arm64',
                    helpers: ['/fixture/project/resources/tcp-ao/linux-arm64/tcp-ao-helper']
                };
            },
            write: message => messages.push(message)
        }
    );
    assert.deepEqual(calls, ['libyang', 'tcp-ao']);
    assert.match(messages.join(''), /Verified bundled TCP-AO helper for linux-arm64/);

    calls.length = 0;
    await packagingBeforePack(
        { electronPlatformName: 'darwin', arch: Arch.arm64 },
        {
            async verifyLibyangBeforePack() {
                calls.push('libyang');
            },
            verifyTcpAoHelper() {
                calls.push('tcp-ao');
            }
        }
    );
    assert.deepEqual(calls, ['libyang'], 'non-Linux packaging must retain only the libyang verifier');

    if (process.platform !== 'win32') {
        const helperProjectRoot = path.join(tempDir, 'tcp-ao-helper-fixture');
        const helperDirectory = path.join(helperProjectRoot, 'resources', 'tcp-ao', 'linux-arm64');
        const helperPath = path.join(helperDirectory, 'tcp-ao-helper');
        fs.mkdirSync(helperDirectory, { recursive: true });
        const elfHeader = Buffer.alloc(64);
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elfHeader);
        elfHeader[4] = 2;
        elfHeader[5] = 1;
        elfHeader.writeUInt16LE(packagingBeforePack.ELF_MACHINE_BY_ARCH.arm64, 18);
        fs.writeFileSync(helperPath, elfHeader, { mode: 0o755 });

        const helperStatus = packagingBeforePack.verifyTcpAoHelper(
            { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
            {
                spawnSync(executable, args) {
                    assert.equal(executable, helperPath);
                    assert.deepEqual(args, ['--version']);
                    return { status: 0, stdout: 'netnexus-tcp-ao-helper 1.0.0\n', stderr: '' };
                }
            }
        );
        assert.equal(helperStatus.versionOutput, 'netnexus-tcp-ao-helper 1.0.0');
        assert.deepEqual(helperStatus.helpers, [helperPath]);

        fs.chmodSync(helperPath, 0o775);
        assert.throws(
            () =>
                packagingBeforePack.verifyTcpAoHelper(
                    { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
                    { spawnSync: () => ({ status: 0, stdout: 'version' }) }
                ),
            /must not be group-writable or world-writable/
        );

        fs.chmodSync(helperPath, 0o757);
        assert.throws(
            () =>
                packagingBeforePack.verifyTcpAoHelper(
                    { projectRoot: helperProjectRoot, platform: 'linux', arch: 'arm64' },
                    { spawnSync: () => ({ status: 0, stdout: 'version' }) }
                ),
            /must not be group-writable or world-writable/
        );
    }
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
    const testIndex = jobSource.indexOf('npm test');
    const minifiedIndex = jobSource.indexOf('npm run test:ci:minified');
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
    assertRuntimeEnsuredBeforeTests('.github/workflows/release.yml', 'build-windows', 'build-linux');
    assertRuntimeEnsuredBeforeTests('.github/workflows/release.yml', 'build-linux', 'publish');

    const frrJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'frr-bmp-e2e', 'e2e-macos');
    assert.match(
        frrJobSource,
        /NETNEXUS_SKIP_LIBYANG_BUILD:\s*['"]1['"]/,
        'the FRR-only job must explicitly skip the unrelated libyang postinstall build'
    );

    const macTestJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'e2e-macos', 'e2e-windows');
    const windowsJobSource = getWorkflowJobSource('.github/workflows/test.yml', 'e2e-windows', null);
    const windowsReleaseJobSource = getWorkflowJobSource(
        '.github/workflows/release.yml',
        'build-windows',
        'build-linux'
    );
    const linuxReleaseJobSource = getWorkflowJobSource('.github/workflows/release.yml', 'build-linux', 'publish');
    for (const [jobSource, workflowFile, platformName] of [
        [macTestJobSource, '.github/workflows/test.yml', 'macOS'],
        [windowsJobSource, '.github/workflows/test.yml', 'Windows'],
        [windowsReleaseJobSource, '.github/workflows/release.yml', 'Windows'],
        [linuxReleaseJobSource, '.github/workflows/release.yml', 'Linux']
    ]) {
        assert.equal(
            Array.from(jobSource.matchAll(/BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\s*['"]20000['"]/g)).length,
            2,
            `${workflowFile} must apply the hosted ${platformName} performance budget to both CI test passes`
        );
        assert.match(
            jobSource,
            new RegExp(
                `- name: Run ${platformName} tests\\s+run: (?:xvfb-run -a )?npm test\\s+env:\\s+` +
                    `BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\\s*['"]20000['"]`
            ),
            `${workflowFile} must scope the hosted-runner budget to the normal ${platformName} test step`
        );
        assert.match(
            jobSource,
            new RegExp(
                `- name: Run ${platformName} minified CI tests\\s+run: (?:xvfb-run -a )?npm run test:ci:minified\\s+env:\\s+` +
                    `BMP_ASSURANCE_FIRST_BUILD_BUDGET_MS:\\s*['"]20000['"]`
            ),
            `${workflowFile} must scope the hosted-runner budget to the minified ${platformName} test step`
        );
    }

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

    const performanceTestSource = fs.readFileSync(
        path.join(projectRoot, 'test', 'ci', 'bmp_route_assurance_performance.js'),
        'utf8'
    );
    assert.match(
        performanceTestSource,
        /FIRST_BUILD_BUDGET_MS\s*=\s*Number\([^\r\n]+\|\|\s*15_000\)/,
        'local/default runs must retain the 15-second performance budget'
    );

    assert.match(macTestJobSource, /name:\s*macOS arm64 Tests and Packaged E2E/);
    assert.match(macTestJobSource, /runs-on:\s*macos-15/);
    assert.match(macTestJobSource, /run:\s*npm run test:e2e/);
    assert.match(macTestJobSource, /run:\s*npm run test:packaged:sqlite/);
    assert.match(macTestJobSource, /name:\s*playwright-report-macos-arm64/);

    const releaseWorkflowSource = fs.readFileSync(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8');
    const publishJobSource = getWorkflowJobSource('.github/workflows/release.yml', 'publish', null);
    assert.match(releaseWorkflowSource, /macOS 发布打包已停用.*test\.yml.*e2e-macos/u);
    assert.doesNotMatch(releaseWorkflowSource, /^\s{4}build-macos:/mu);
    assert.doesNotMatch(releaseWorkflowSource, /^\s*- build-macos\s*$/mu);
    assert.doesNotMatch(releaseWorkflowSource, /npm run dist:mac|release\/\*\.(?:dmg|zip)/u);
    assert.doesNotMatch(releaseWorkflowSource, /generate-mac-update-manifest/u);
    assert.match(publishJobSource, /runs-on:\s*ubuntu-24\.04/);
    assert.match(publishJobSource, /test "\$RELEASE_TAG" = "v\$\{package_version\}"/);
    assert.match(publishJobSource, /NetNexus-Setup-\$\{version\}-win-x64\.exe/);
    assert.match(publishJobSource, /NetNexus-\$\{version\}-linux-x64\.deb/);
    assert.match(publishJobSource, /NetNexus-\$\{version\}-linux-arm64\.deb/);
    const draftCreateIndex = publishJobSource.indexOf('gh release create "$RELEASE_TAG"');
    const assetUploadIndex = publishJobSource.indexOf('gh release upload "$RELEASE_TAG"');
    const assetVerifyIndex = publishJobSource.indexOf("<(gh release view \"$RELEASE_TAG\" --json assets");
    const publishReleaseIndex = publishJobSource.indexOf('gh release edit "$RELEASE_TAG" --draft=false');
    assert(
        draftCreateIndex >= 0 &&
            draftCreateIndex < assetUploadIndex &&
            assetUploadIndex < assetVerifyIndex &&
            assetVerifyIndex < publishReleaseIndex,
        'release workflow must keep the release draft until every uploaded asset is verified'
    );
    assert.match(publishJobSource, /gh release create "\$RELEASE_TAG"\s+\\\s+--verify-tag\s+\\\s+--draft/u);
    assert.match(publishJobSource, /is already public; refusing to mutate it/u);
    assert.doesNotMatch(
        publishJobSource,
        /gh release create "\$RELEASE_TAG" release-assets/u,
        'release creation must not publish while assets are still uploading'
    );

    const releaseScriptSource = fs.readFileSync(path.join(projectRoot, 'scripts/release.js'), 'utf8');
    assert.match(releaseScriptSource, /if \(isMac\) \{\s*throw new Error\(MAC_RELEASE_DISABLED_MESSAGE\);/u);
    assert.match(releaseScriptSource, /已停用：不再发布 macOS 版本/u);
    assert.doesNotMatch(releaseScriptSource, /file\.endsWith\(['"]\.(?:dmg|zip)['"]\)/u);
    assert.doesNotMatch(releaseScriptSource, /platform\s*=\s*['"]--mac['"]/u);

    assert.match(linuxReleaseJobSource, /runner:\s*ubuntu-24\.04(?:\s|$)/);
    assert.match(linuxReleaseJobSource, /runner:\s*ubuntu-24\.04-arm/);
    assert.match(linuxReleaseJobSource, /arch:\s*x64/);
    assert.match(linuxReleaseJobSource, /arch:\s*arm64/);
    assert.match(
        linuxReleaseJobSource,
        /sudo apt-get install --yes build-essential cmake linux-libc-dev patchelf xvfb/
    );
    assert.match(linuxReleaseJobSource, /test "\$\(id -u\)" -ne 0/);
    assert.match(linuxReleaseJobSource, /npm run tcp-ao:test:native/);
    assert.match(linuxReleaseJobSource, /run:\s*xvfb-run -a npm test/);
    assert.match(linuxReleaseJobSource, /run:\s*xvfb-run -a npm run test:ci:minified/);
    assert.match(linuxReleaseJobSource, /dist_script:\s*dist:linux:x64/);
    assert.match(linuxReleaseJobSource, /dist_script:\s*dist:linux:arm64/);
    assert.match(linuxReleaseJobSource, /resources\/tcp-ao\/linux-\$\{\{ matrix\.arch \}\}\/tcp-ao-helper/);
    assert.match(linuxReleaseJobSource, /resources\/libyang\/linux-\$\{\{ matrix\.arch \}\}\/bin\/yanglint/);
    assert.match(linuxReleaseJobSource, /node_modules\/better-sqlite3\/build\/Release\/better_sqlite3\.node/);
    assert.match(
        linuxReleaseJobSource,
        /PACKAGED_SQLITE_EXPECTED_ARCH="\$\{\{ matrix\.arch \}\}" npm run test:packaged:sqlite/
    );
    assert.doesNotMatch(
        linuxReleaseJobSource,
        /readelf[^\n]+better_sqlite3|GLIBCXX_3\.4\.31/,
        'packaged SQLite compatibility must be proven by architecture and runtime smoke, not an exact referenced symbol'
    );
    assert.match(linuxReleaseJobSource, /dpkg-deb --field/);
    assert.match(linuxReleaseJobSource, /dpkg-deb --ctrl-tarfile/);
    assert.match(linuxReleaseJobSource, /chmod 4755/);
    assert.match(linuxReleaseJobSource, /chrome-sandbox/);
    assert.match(linuxReleaseJobSource, /setcap 'cap_net_bind_service=ep'/);
    assert.match(linuxReleaseJobSource, /getcap/);
    assert.match(linuxReleaseJobSource, /sudo apt-get install --yes "\$\{debs\[0\]\}"/);
    assert.match(linuxReleaseJobSource, /root:root:755/);
    assert.match(linuxReleaseJobSource, /patchelf --print-rpath \/opt\/NetNexus\/net-nexus/);
    assert.match(linuxReleaseJobSource, /\/opt\/NetNexus\/net-nexus cap_net_bind_service=ep/);
    assert.match(linuxReleaseJobSource, /server\.listen\(179,'127\.0\.0\.1'/);
    assert.match(linuxReleaseJobSource, /sudo setcap -r \/opt\/NetNexus\/net-nexus/);
    assert.match(linuxReleaseJobSource, /sudo apt-get install --reinstall --yes "\$\{debs\[0\]\}"/);
    assert.match(linuxReleaseJobSource, /E2E_APP_EXECUTABLE=\/opt\/NetNexus\/net-nexus/);
    assert.match(linuxReleaseJobSource, /xvfb-run -a node scripts\/installed-bgp-port179-smoke\.js/);
    assert.match(linuxReleaseJobSource, /-rwsr-xr-x/);
    assert.match(linuxReleaseJobSource, /remove\|deconfigure\)/);
    assert.match(linuxReleaseJobSource, /purge\)/);
    assert.match(linuxReleaseJobSource, /netnexus-libyang-schema/);
    assert.doesNotMatch(linuxReleaseJobSource, /AppImage|release\/\*\.blockmap|latest-linux/);
    assert.match(linuxReleaseJobSource, /release\/\*\.deb/);
    assert.match(linuxReleaseJobSource, /for package_name in [^\n]*libcap2-bin[^\n]*fonts-noto-cjk[^\n]*; do/u);

    const installedBgpSmokeSource = fs.readFileSync(
        path.join(projectRoot, 'scripts', 'installed-bgp-port179-smoke.js'),
        'utf8'
    );
    assert.match(installedBgpSmokeSource, /delete environment\.ELECTRON_RUN_AS_NODE/);
    assert.match(installedBgpSmokeSource, /delete environment\.NETNEXUS_E2E/);
    assert.match(installedBgpSmokeSource, /spawnargs\.includes\('--no-sandbox'\)/);
    assert.match(installedBgpSmokeSource, /window\.bgpApi\.startBgp/);
    assert.match(installedBgpSmokeSource, /netnexus\.protocol\.bgp/);
    assert.match(installedBgpSmokeSource, /connectToBgpPort/);
}

async function run() {
    try {
        testPinnedReleaseAndPackageContract();
        testMacDistributionArchitectureSelection();
        await testInstallRuntimeEnsureContract();
        testRuntimePathMapping();
        testRuntimeVerifierWithoutNativeRuntime();
        await testBeforePackHook();
        testLinuxPackagingPreparation();
        testTcpAoHelperEnsure();
        await testPackagingBeforePackHook();
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
