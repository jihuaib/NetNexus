const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertNativeLinuxBuild, normalizeArchitecture, optionValue } = require('./prepare-linux-package');
const { ELF_MACHINE_BY_ARCH, readElfHeader } = require('./verify-packaging-runtime');

function debianArchitecture(arch) {
    const normalized = normalizeArchitecture(arch);
    if (normalized === 'x64') return 'amd64';
    if (normalized === 'arm64') return 'arm64';
    throw new Error(`Debian packages support x64 and arm64; received ${normalized || 'unknown'}`);
}

function expandArtifactName(pattern, packageJson, arch) {
    const values = {
        productName: packageJson.build?.productName || packageJson.productName || 'NetNexus',
        name: packageJson.name,
        version: packageJson.version,
        os: 'linux',
        arch,
        ext: 'deb'
    };
    return String(pattern || '${productName}-${version}-${os}-${arch}.${ext}').replace(
        /\$\{(productName|name|version|os|arch|ext)\}/gu,
        (_match, name) => values[name]
    );
}

function renderControl(packageJson, arch, installedSizeKiB) {
    const linux = packageJson.build?.linux || {};
    const deb = packageJson.build?.deb || {};
    const author = packageJson.author || {};
    const packageName = deb.packageName || linux.packageName || packageJson.name;
    const maintainer = linux.maintainer || `${author.name || 'NetNexus'} <${author.email || 'unknown@example.com'}>`;
    const synopsis = linux.synopsis || packageJson.description || packageJson.name;
    const description = String(linux.description || packageJson.description || synopsis)
        .split(/\r?\n/u)
        .map(line => ` ${line || '.'}`);
    const depends = Array.isArray(deb.depends) ? deb.depends.join(', ') : String(deb.depends || '').trim();
    const recommends = Array.isArray(deb.recommends) ? deb.recommends.join(', ') : String(deb.recommends || '').trim();

    const fields = [
        `Package: ${packageName}`,
        `Version: ${packageJson.version}`,
        `Section: ${deb.packageCategory || linux.packageCategory || 'net'}`,
        `Priority: ${deb.priority || 'optional'}`,
        `Architecture: ${debianArchitecture(arch)}`,
        `Installed-Size: ${Math.max(1, Math.ceil(installedSizeKiB))}`,
        `Maintainer: ${maintainer}`
    ];
    if (depends) fields.push(`Depends: ${depends}`);
    if (recommends) fields.push(`Recommends: ${recommends}`);
    if (packageJson.homepage) fields.push(`Homepage: ${packageJson.homepage}`);
    fields.push(`Description: ${synopsis}`, ...description);
    return `${fields.join('\n')}\n`;
}

function renderDesktopEntry(packageJson, executableName, installDirectoryName) {
    const linux = packageJson.build?.linux || {};
    const productName = packageJson.build?.productName || packageJson.productName || 'NetNexus';
    return [
        '[Desktop Entry]',
        `Name=${productName}`,
        `Exec=/opt/${installDirectoryName}/${executableName} %U`,
        'Terminal=false',
        'Type=Application',
        `Icon=${executableName}`,
        `StartupWMClass=${productName}`,
        `Comment=${linux.description || packageJson.description || linux.synopsis || productName}`,
        `Categories=${linux.category || 'Network'};`,
        ''
    ].join('\n');
}

function renderPostInstall(executableName, installDirectoryName) {
    return `#!/bin/sh
set -e

PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

if command -v update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executableName}' ] && [ -e '/usr/bin/${executableName}' ] && [ "$(readlink '/usr/bin/${executableName}')" != '/etc/alternatives/${executableName}' ]; then
        rm -f '/usr/bin/${executableName}'
    fi
    update-alternatives --install '/usr/bin/${executableName}' '${executableName}' '/opt/${installDirectoryName}/${executableName}' 100
else
    ln -sf '/opt/${installDirectoryName}/${executableName}' '/usr/bin/${executableName}'
fi

chmod 4755 '/opt/${installDirectoryName}/chrome-sandbox'

app_binary='/opt/${installDirectoryName}/${executableName}'
if ! command -v setcap >/dev/null 2>&1 || ! command -v getcap >/dev/null 2>&1; then
    echo 'NetNexus installation requires setcap and getcap from libcap2-bin.' >&2
    exit 1
fi
chown root:root "$app_binary"
chmod 0755 "$app_binary"
if ! setcap 'cap_net_bind_service=ep' "$app_binary"; then
    echo "Failed to grant CAP_NET_BIND_SERVICE to $app_binary." >&2
    exit 1
fi
if [ "$(getcap "$app_binary")" != "$app_binary cap_net_bind_service=ep" ]; then
    echo "Failed to grant CAP_NET_BIND_SERVICE to $app_binary." >&2
    exit 1
fi

update-mime-database /usr/share/mime >/dev/null 2>&1 || true
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
exit 0
`;
}

function renderPreRemove(executableName, installDirectoryName) {
    return `#!/bin/sh
set -e

case "$1" in
    remove|deconfigure)
        if command -v update-alternatives >/dev/null 2>&1; then
            update-alternatives --remove '${executableName}' '/opt/${installDirectoryName}/${executableName}' || true
        else
            rm -f '/usr/bin/${executableName}'
        fi
        ;;
esac
exit 0
`;
}

function renderPostRemove(executableName, installDirectoryName) {
    return `#!/bin/sh
set -e

case "$1" in
    purge)
        if command -v update-alternatives >/dev/null 2>&1; then
            update-alternatives --remove '${executableName}' '/opt/${installDirectoryName}/${executableName}' || true
        else
            rm -f '/usr/bin/${executableName}'
        fi
        ;;
esac
exit 0
`;
}

function directorySizeBytes(rootPath, fsApi = fs) {
    let total = 0;
    for (const entry of fsApi.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) total += directorySizeBytes(entryPath, fsApi);
        else if (entry.isFile()) total += fsApi.lstatSync(entryPath).size;
    }
    return total;
}

function normalizeTreeModes(rootPath, fsApi = fs) {
    const stats = fsApi.lstatSync(rootPath);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
        fsApi.chmodSync(rootPath, 0o755);
        for (const entry of fsApi.readdirSync(rootPath)) normalizeTreeModes(path.join(rootPath, entry), fsApi);
        return;
    }
    if (stats.isFile()) fsApi.chmodSync(rootPath, (stats.mode & 0o111) === 0 ? 0o644 : 0o755);
}

function verifyUnpackedExecutable(executablePath, arch, fsApi = fs) {
    const header = readElfHeader(executablePath, fsApi);
    if (!header || header.elfClass !== 2 || header.machine !== ELF_MACHINE_BY_ARCH[arch]) {
        throw new Error(
            `Unpacked Electron executable has the wrong ELF architecture for linux-${arch}: ${executablePath}`
        );
    }
}

function patchPackagedElectronRpath(executablePath, installedDirectory, dependencies = {}) {
    if (!path.isAbsolute(installedDirectory) || /[\r\n]/u.test(installedDirectory)) {
        throw new Error(`Packaged Electron RPATH must be an absolute installation directory: ${installedDirectory}`);
    }

    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const commandOptions = {
        cwd: dependencies.cwd || path.dirname(executablePath),
        env: dependencies.env || process.env,
        encoding: 'utf8'
    };
    const patchResult = spawnSync(
        'patchelf',
        ['--force-rpath', '--set-rpath', installedDirectory, executablePath],
        commandOptions
    );
    if (patchResult.error) {
        throw new Error(
            `Unable to start patchelf; install the patchelf build dependency: ${patchResult.error.message}`
        );
    }
    if (patchResult.status !== 0) {
        const detail = String(patchResult.stderr || patchResult.stdout || '').trim();
        throw new Error(`patchelf failed with exit code ${patchResult.status}${detail ? `: ${detail}` : ''}`);
    }

    const verifyResult = spawnSync('patchelf', ['--print-rpath', executablePath], commandOptions);
    if (verifyResult.error) throw new Error(`Unable to verify packaged Electron RPATH: ${verifyResult.error.message}`);
    if (verifyResult.status !== 0) {
        const detail = String(verifyResult.stderr || verifyResult.stdout || '').trim();
        throw new Error(
            `Unable to verify packaged Electron RPATH (exit ${verifyResult.status})${detail ? `: ${detail}` : ''}`
        );
    }
    const actualRpath = String(verifyResult.stdout || '').trim();
    if (actualRpath !== installedDirectory) {
        throw new Error(
            `Packaged Electron RPATH mismatch: expected ${installedDirectory}, received ${actualRpath || '(empty)'}`
        );
    }
    return actualRpath;
}

function buildLinuxDeb(options = {}, dependencies = {}) {
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
    const target = assertNativeLinuxBuild({
        platform: options.platform,
        hostArch: options.hostArch,
        targetArch: options.arch
    });
    const arch = target.targetArch;
    const fsApi = dependencies.fs || fs;
    const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
    const packageJson = JSON.parse(fsApi.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const outputDirectory = path.join(projectRoot, packageJson.build?.directories?.output || 'release');
    const unpackedDirectory = path.join(outputDirectory, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked');
    const unpackedStats = fsApi.lstatSync(unpackedDirectory);
    if (!unpackedStats.isDirectory() || unpackedStats.isSymbolicLink()) {
        throw new Error(`Linux unpacked application must be a regular directory: ${unpackedDirectory}`);
    }

    const linux = packageJson.build?.linux || {};
    const productName = packageJson.build?.productName || packageJson.productName || 'NetNexus';
    const installDirectoryName = productName.replace(/[^A-Za-z0-9._-]+/gu, '-');
    const executableName = linux.executableName || packageJson.name;
    verifyUnpackedExecutable(path.join(unpackedDirectory, executableName), arch, fsApi);

    const stagingDirectory = fsApi.mkdtempSync(path.join(os.tmpdir(), `netnexus-deb-${arch}-`));
    const artifactName = expandArtifactName(linux.artifactName, packageJson, arch);
    const artifactPath = path.join(outputDirectory, artifactName);
    try {
        const installRoot = path.join(stagingDirectory, 'opt', installDirectoryName);
        fsApi.mkdirSync(path.dirname(installRoot), { recursive: true });
        fsApi.cpSync(unpackedDirectory, installRoot, {
            recursive: true,
            dereference: false,
            preserveTimestamps: true,
            verbatimSymlinks: true
        });
        fsApi.writeFileSync(path.join(installRoot, 'resources', 'package-type'), 'deb\n');
        patchPackagedElectronRpath(path.join(installRoot, executableName), `/opt/${installDirectoryName}`, {
            spawnSync,
            cwd: projectRoot,
            env: options.env || process.env
        });

        const iconDirectory = path.join(stagingDirectory, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
        const desktopDirectory = path.join(stagingDirectory, 'usr', 'share', 'applications');
        fsApi.mkdirSync(iconDirectory, { recursive: true });
        fsApi.mkdirSync(desktopDirectory, { recursive: true });
        const buildResources = packageJson.build?.directories?.buildResources || 'build';
        fsApi.copyFileSync(
            path.join(projectRoot, buildResources, linux.icon || 'logo.png'),
            path.join(iconDirectory, `${executableName}.png`)
        );
        fsApi.writeFileSync(
            path.join(desktopDirectory, `${executableName}.desktop`),
            renderDesktopEntry(packageJson, executableName, installDirectoryName)
        );

        normalizeTreeModes(stagingDirectory, fsApi);
        fsApi.chmodSync(path.join(installRoot, 'chrome-sandbox'), 0o4755);
        const controlDirectory = path.join(stagingDirectory, 'DEBIAN');
        fsApi.mkdirSync(controlDirectory, { recursive: true, mode: 0o755 });
        const installedSizeKiB = directorySizeBytes(stagingDirectory, fsApi) / 1024;
        fsApi.writeFileSync(
            path.join(controlDirectory, 'control'),
            renderControl(packageJson, arch, installedSizeKiB),
            { mode: 0o644 }
        );
        fsApi.writeFileSync(
            path.join(controlDirectory, 'postinst'),
            renderPostInstall(executableName, installDirectoryName),
            { mode: 0o755 }
        );
        fsApi.writeFileSync(
            path.join(controlDirectory, 'prerm'),
            renderPreRemove(executableName, installDirectoryName),
            { mode: 0o755 }
        );
        fsApi.writeFileSync(
            path.join(controlDirectory, 'postrm'),
            renderPostRemove(executableName, installDirectoryName),
            { mode: 0o755 }
        );

        fsApi.mkdirSync(outputDirectory, { recursive: true });
        if (fsApi.existsSync(artifactPath)) fsApi.unlinkSync(artifactPath);
        const result = spawnSync(
            'dpkg-deb',
            ['--root-owner-group', '-Zxz', '--build', stagingDirectory, artifactPath],
            {
                cwd: projectRoot,
                env: options.env || process.env,
                stdio: 'inherit'
            }
        );
        if (result.error) throw new Error(`Unable to start dpkg-deb: ${result.error.message}`);
        if (result.status !== 0) {
            const signal = result.signal ? ` (signal ${result.signal})` : '';
            throw new Error(`dpkg-deb failed with exit code ${result.status}${signal}`);
        }
        process.stdout.write(`Built native ${debianArchitecture(arch)} Debian package: ${artifactPath}\n`);
        return { arch, artifactPath, unpackedDirectory };
    } finally {
        fsApi.rmSync(stagingDirectory, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        buildLinuxDeb({ arch: optionValue('--arch') });
    } catch (error) {
        process.stderr.write(`${error.stack || error.message || error}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    buildLinuxDeb,
    debianArchitecture,
    directorySizeBytes,
    expandArtifactName,
    normalizeTreeModes,
    patchPackagedElectronRpath,
    renderControl,
    renderDesktopEntry,
    renderPostInstall,
    renderPreRemove,
    renderPostRemove,
    verifyUnpackedExecutable
};
