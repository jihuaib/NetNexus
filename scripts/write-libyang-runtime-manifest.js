const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    PROJECT_ROOT,
    computeBuildInputHash,
    getReleaseManifest,
    normalizePlatform,
    normalizeArch,
    verifyPinnedIanaModules,
    collectRequiredRuntimeIetfModules
} = require('./libyang-runtime-config');

const runtimeDirectory = path.resolve(process.argv[2] || '');
const executable = path.resolve(process.argv[3] || '');
const schemaExecutable = path.resolve(process.argv[4] || '');
if (
    !runtimeDirectory ||
    !executable ||
    !schemaExecutable ||
    !fs.statSync(executable).isFile() ||
    !fs.statSync(schemaExecutable).isFile()
) {
    throw new Error(
        'Usage: node write-libyang-runtime-manifest.js <runtime-directory> <yanglint-executable> <schema-executable>'
    );
}
const release = getReleaseManifest(PROJECT_ROOT);
const platform = normalizePlatform(process.platform);
const arch = normalizeArch(process.arch);
const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
const schemaDigest = crypto.createHash('sha256').update(fs.readFileSync(schemaExecutable)).digest('hex');
const ianaModules = verifyPinnedIanaModules({ projectRoot: PROJECT_ROOT, runtimeDirectory });
const requiredIetfYangModules = collectRequiredRuntimeIetfModules(runtimeDirectory);
const runtime = {
    schemaVersion: 3,
    engine: 'libyang',
    executable: 'yanglint',
    schemaExecutable: 'netnexus-libyang-schema',
    schemaContractVersion: 1,
    version: release.libyangVersion,
    tag: release.tag,
    libyangCommit: release.libyangCommit,
    source: release.source,
    pcre2Version: release.pcre2Version,
    pcre2Tag: release.pcre2Tag,
    pcre2Commit: release.pcre2Commit,
    pcre2Source: release.pcre2Source,
    license: release.license,
    buildMode: release.buildMode,
    interactive: release.interactive,
    platform,
    arch,
    buildInputHash: computeBuildInputHash({ projectRoot: PROJECT_ROOT, platform, arch }),
    ianaYangModules: ianaModules.modules,
    requiredIetfYangModules,
    sha256: digest,
    schemaSha256: schemaDigest,
    builtAt: new Date().toISOString()
};
if (runtime.platform === 'win32') runtime.windowsDependencies = release.windowsDependencies;
fs.writeFileSync(path.join(runtimeDirectory, 'runtime.json'), `${JSON.stringify(runtime, null, 4)}\n`, 'utf8');
