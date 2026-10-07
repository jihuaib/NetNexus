const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const https = require('https');
const yaml = require('js-yaml');
const { loadReleaseNotes, verifyReleaseNotes } = require('./generate-release-notes');

const projectRoot = path.resolve(__dirname, '..');

// Parse command line arguments
const args = process.argv.slice(2);
const giteeOnly = args.includes('--gitee-only');
const showHelp = args.includes('--help') || args.includes('-h');
const isMac = args.includes('--mac');
const isWin = args.includes('--win');
const isLinux = args.includes('--linux');
const isX64 = args.includes('--x64');
const isArm64 = args.includes('--arm64');
const MAC_RELEASE_DISABLED_MESSAGE = 'macOS 发布已停用；仅保留 test.yml 中的 macOS CI 验证';

// Show help
if (showHelp) {
    console.log(`
NetNexus Release Script

Usage: node release.js [options]

Options:
  --help, -h          显示帮助信息
  --gitee-only        只发布到 Gitee（不编译，需要先有 tag 和 release 文件）
  --win               构建 Windows 版本
  --mac               已停用：不再发布 macOS 版本
  --linux             构建 Linux Debian 软件包
  --x64               构建 x64 版本（Linux 必须在原生 x64 主机运行）
  --arm64             构建 arm64 版本（Linux 必须在原生 arm64 主机运行）
Examples:
  node release.js                    # 编译 Windows x64 并发布到 GitHub 和 Gitee（默认）
  node release.js --linux            # 编译当前 Linux 主机架构并发布
  node release.js --linux --arm64    # 在 arm64 Linux 主机编译 .deb
  node release.js --gitee-only       # 只发布到 Gitee（不编译）
`);
    process.exit(0);
}

// Load .env file (从项目根目录加载)
function loadEnvironment() {
    const envPath = path.join(projectRoot, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf-8')
        .split(/\r?\n/)
        .forEach(line => {
            if (line.trim().startsWith('#') || !line.trim()) {
                return;
            }

            const parts = line.match(/^([^=]+)=(.*)$/);
            if (parts) {
                const key = parts[1].trim();
                const value = parts[2].trim();
                if (!process.env[key]) {
                    process.env[key] = value;
                    const logValue =
                        key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') ? '******' : value;
                    console.log(`Set ${key}=${logValue}`);
                }
            }
        });
}

// Function to create Gitee release
async function createGiteeRelease(release, dependencies = {}) {
    const giteeToken = (dependencies.env || process.env).GITEE_TOKEN;

    if (!giteeToken) {
        console.log('\n⚠️  GITEE_TOKEN not found, skipping Gitee release');
        console.log('To enable Gitee release, add GITEE_TOKEN to your .env file');
        return;
    }

    verifyReleaseSource(release, dependencies.projectRoot || projectRoot);
    const currentTag = release.tag;
    const httpsApi = dependencies.https || https;
    console.log(`\n📦 Creating Gitee release for tag: ${currentTag}`);

    // Step 1: Create release
    const releaseId = await new Promise((resolve, _reject) => {
        const data = JSON.stringify({
            access_token: giteeToken,
            tag_name: currentTag,
            name: `NetNexus ${currentTag}`,
            body: release.markdown,
            prerelease: false,
            target_commitish: 'master'
        });

        const options = {
            hostname: 'gitee.com',
            path: '/api/v5/repos/muping18/NetNexus/releases',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = httpsApi.request(options, res => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 201) {
                    const result = JSON.parse(body);
                    console.log('✅ Gitee release created successfully');
                    console.log('   View at: https://gitee.com/muping18/NetNexus/releases');
                    resolve(result.id);
                } else {
                    console.log(`⚠️  Gitee release response (${res.statusCode}):`, body);
                    resolve(null);
                }
            });
        });

        req.on('error', error => {
            console.error('❌ Gitee release failed:', error.message);
            resolve(null);
        });

        req.write(data);
        req.end();
    });

    if (!releaseId) {
        return;
    }

    // Step 2: Upload files
    const distPath = path.join(dependencies.projectRoot || projectRoot, 'release');
    if (!fs.existsSync(distPath)) {
        console.log('⚠️  release directory not found, skipping file upload');
        return;
    }

    const files = fs
        .readdirSync(distPath)
        .filter(file => isCurrentInstallationAsset(file, release.version, dependencies.target));

    if (files.length === 0) {
        console.log('⚠️  No installation files found in release directory');
        return;
    }

    console.log(`\n📤 Uploading ${files.length} file(s) to Gitee release...`);

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB (Gitee limit)
    let uploadedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
        const filePath = path.join(distPath, file);
        const fileStats = fs.statSync(filePath);
        const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

        // Check file size
        if (fileStats.size > MAX_FILE_SIZE) {
            console.log(`   ⚠️  Skipped: ${file} (${fileSizeMB} MB - exceeds Gitee 100 MB limit)`);
            skippedCount++;
            continue;
        }

        const fileContent = fs.readFileSync(filePath);

        await new Promise(resolve => {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('access_token', giteeToken);
            form.append('file', fileContent, file);

            const req = httpsApi.request(
                {
                    hostname: 'gitee.com',
                    path: `/api/v5/repos/muping18/NetNexus/releases/${releaseId}/attach_files`,
                    method: 'POST',
                    headers: form.getHeaders()
                },
                res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 201) {
                            console.log(`   ✅ Uploaded: ${file} (${fileSizeMB} MB)`);
                            uploadedCount++;
                        } else {
                            console.log(`   ⚠️  Failed to upload ${file}: ${body}`);
                            skippedCount++;
                        }
                        resolve();
                    });
                }
            );

            req.on('error', error => {
                console.error(`   ❌ Upload error for ${file}:`, error.message);
                skippedCount++;
                resolve();
            });

            form.pipe(req);
        });
    }

    console.log(`\n✅ Gitee release completed: ${uploadedCount} uploaded, ${skippedCount} skipped`);
    if (skippedCount > 0) {
        console.log('💡 Tip: Large files (>100 MB) cannot be uploaded to Gitee due to platform limits');
        console.log('   Consider using GitHub Releases for large files or compressing them');
    }
}

function normalizeArchitecture(value) {
    const architecture = String(value || '').toLowerCase();
    if (architecture === 'amd64' || architecture === 'x86_64') return 'x64';
    if (architecture === 'aarch64') return 'arm64';
    return architecture;
}

function isCurrentInstallationAsset(file, version, target) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = file.match(
        new RegExp(`^NetNexus(?:-Setup)?-${escapedVersion}-(win|linux)-(x64|arm64)\\.(?:exe|msi|deb)$`)
    );
    return Boolean(match && (!target || (match[1] === target.platform && match[2] === target.arch)));
}

function githubRepository(root = projectRoot) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const publish = packageJson.build.publish;
    const github = (Array.isArray(publish) ? publish : [publish]).find(config => config?.provider === 'github');
    if (!github?.owner || !github?.repo) {
        throw new Error('GitHub publishing requires build.publish owner and repo');
    }
    return `${github.owner}/${github.repo}`;
}

function verifyReleaseSource(release, root) {
    const canonical = loadReleaseNotes({ projectRoot: root, tag: release.tag });
    if (canonical.version !== release.version) {
        throw new Error(`Release version ${release.version} does not match package version ${canonical.version}`);
    }
    verifyReleaseNotes(canonical.markdown, release.markdown);
}

function verifyGithubPrerequisites(dependencies = {}) {
    const run = dependencies.execFileSync || execFileSync;
    const options = {
        cwd: dependencies.projectRoot || projectRoot,
        env: dependencies.env || process.env,
        stdio: 'pipe'
    };
    try {
        run('gh', ['--version'], options);
        run('gh', ['auth', 'status'], options);
    } catch (_error) {
        throw new Error(
            'GitHub CLI is unavailable or GH_TOKEN authentication failed; install gh and configure GH_TOKEN'
        );
    }
}

function rebuildRenderer(dependencies = {}) {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    const npmCli = dependencies.npmCli || candidates.find(candidate => candidate && fs.existsSync(candidate));
    if (!npmCli) throw new Error('Cannot find npm CLI; run this script through npm run release');
    const run = dependencies.execFileSync || execFileSync;
    run(process.execPath, [npmCli, 'run', 'build'], {
        cwd: dependencies.projectRoot || projectRoot,
        env: dependencies.env || process.env,
        stdio: 'inherit'
    });
}

function publishGitHubRelease(release, dependencies = {}) {
    const root = dependencies.projectRoot || projectRoot;
    verifyReleaseSource(release, root);
    const env = dependencies.env || process.env;
    const run = dependencies.execFileSync || execFileSync;
    const probe = dependencies.spawnSync || spawnSync;
    const repo = githubRepository(root);
    const target = dependencies.target || { platform: 'win', arch: 'x64' };
    const distPath = path.join(root, 'release');
    const installationFiles = fs
        .readdirSync(distPath)
        .filter(file => isCurrentInstallationAsset(file, release.version, target));
    if (installationFiles.length === 0) {
        throw new Error(`No installation files found for version ${release.version}`);
    }
    const files = fs.readdirSync(distPath).filter(file => {
        if (installationFiles.includes(file)) return true;
        if (file.endsWith('.blockmap')) return installationFiles.includes(file.slice(0, -'.blockmap'.length));
        return file === 'latest.yml' && installationFiles.some(name => name.endsWith('.exe'));
    });
    if (files.includes('latest.yml')) {
        const manifest = yaml.load(fs.readFileSync(path.join(distPath, 'latest.yml'), 'utf8'));
        if (manifest?.version !== release.version) {
            throw new Error(`latest.yml does not match release version ${release.version}`);
        }
        const currentInstaller = `NetNexus-Setup-${release.version}-win-${target.arch}.exe`;
        if (manifest.path !== currentInstaller || !manifest.files?.some(file => file.url === currentInstaller)) {
            throw new Error('latest.yml does not reference the current Windows installer');
        }
    }
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-release-notes-'));
    const notesFile = path.join(temporaryDirectory, 'release-notes.md');
    const commandOptions = { cwd: root, env, encoding: 'utf8', stdio: 'pipe' };
    const tag = release.tag;
    try {
        fs.writeFileSync(notesFile, release.markdown, 'utf8');
        const existing = probe('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], commandOptions);
        if (existing.error) throw existing.error;
        if (existing.status === 0) {
            if (!JSON.parse(existing.stdout).isDraft) {
                throw new Error(`Release ${tag} is already public; refusing to mutate it`);
            }
            run('gh', ['release', 'edit', tag, '--repo', repo, '--notes-file', notesFile], commandOptions);
        } else {
            run(
                'gh',
                [
                    'release',
                    'create',
                    tag,
                    '--repo',
                    repo,
                    '--verify-tag',
                    '--draft',
                    '--title',
                    `NetNexus ${tag}`,
                    '--notes-file',
                    notesFile
                ],
                commandOptions
            );
        }
        run(
            'gh',
            ['release', 'upload', tag, '--repo', repo, ...files.map(file => path.join(distPath, file)), '--clobber'],
            commandOptions
        );
        const uploaded = JSON.parse(
            run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,body,assets'], commandOptions)
        );
        if (uploaded.isDraft !== true) {
            throw new Error(`Release ${tag} is no longer a draft; refusing to publish`);
        }
        const uploadedFiles = uploaded.assets.map(asset => asset.name).sort();
        if (JSON.stringify(files.sort()) !== JSON.stringify(uploadedFiles)) {
            throw new Error(`Release ${tag} uploaded assets differ from the current version build`);
        }
        verifyReleaseNotes(release.markdown, uploaded.body);
        run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false'], commandOptions);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function validateBuildTarget() {
    assertManagedBuildArgs(args);
    if (isMac) {
        throw new Error(MAC_RELEASE_DISABLED_MESSAGE);
    }

    const selectedPlatforms = [isWin && 'win', isMac && 'mac', isLinux && 'linux'].filter(Boolean);
    if (selectedPlatforms.length > 1) {
        throw new Error(`只能选择一个目标平台：${selectedPlatforms.join(', ')}`);
    }
    if (isX64 && isArm64) {
        throw new Error('不能同时指定 --x64 和 --arm64');
    }
    if (!isLinux) return;

    if (process.platform !== 'linux') {
        throw new Error(`Linux 软件包必须在 Linux 主机上构建；当前平台是 ${process.platform}`);
    }
    if (args.includes('--universal')) {
        throw new Error('Linux 不支持 --universal；请分别在原生 x64 和 arm64 主机上构建');
    }

    const hostArch = normalizeArchitecture(process.arch);
    const targetArch = isArm64 ? 'arm64' : isX64 ? 'x64' : hostArch;
    if (!['x64', 'arm64'].includes(targetArch)) {
        throw new Error(`Linux 软件包仅支持 x64 和 arm64；当前主机架构是 ${hostArch}`);
    }
    if (hostArch !== targetArch) {
        throw new Error(
            `不支持交叉构建 Linux 软件包：当前主机是 ${hostArch}，目标是 ${targetArch}。` +
                '请在相同架构的原生 Linux 主机上构建。'
        );
    }
}

// Build command based on platform and architecture
function assertManagedBuildArgs(releaseArgs) {
    if (
        releaseArgs.some(
            arg => arg === '--publish' || arg === '-p' || arg.startsWith('--publish=') || arg.startsWith('-p=')
        )
    ) {
        throw new Error('Publication flags are managed by this release script; omit --publish and -p');
    }
}

function getBuildCommand(releaseArgs = args) {
    assertManagedBuildArgs(releaseArgs);
    const customArgs = ['--gitee-only', '--help', '-h', '--win', '--mac', '--linux', '--x64', '--arm64', '--universal'];
    const extraArgs = releaseArgs.filter(arg => !customArgs.includes(arg));

    if (releaseArgs.includes('--linux')) {
        const targetArch = releaseArgs.includes('--arm64')
            ? 'arm64'
            : releaseArgs.includes('--x64')
              ? 'x64'
              : normalizeArchitecture(process.arch);
        return { command: 'npm', args: ['run', `dist:linux:${targetArch}`, '--', '--publish', 'never'] };
    }

    let platform = '--win';
    let arch = '--x64';

    if (isWin) {
        platform = '--win';
        arch = '--x64';
    }

    return {
        command: process.execPath,
        args: [require.resolve('electron-builder/cli.js'), platform, arch, ...extraArgs, '--publish', 'never']
    };
}

// Run electron-builder
async function build() {
    try {
        validateBuildTarget();
        let release = loadReleaseNotes();
        const target = {
            platform: isLinux ? 'linux' : 'win',
            arch: isLinux ? (isArm64 ? 'arm64' : isX64 ? 'x64' : normalizeArchitecture(process.arch)) : 'x64'
        };
        const publishGithub = !giteeOnly && Boolean(process.env.GH_TOKEN);
        if (publishGithub || process.env.GITEE_TOKEN) {
            const tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
                cwd: projectRoot,
                encoding: 'utf8'
            }).trim();
            release = loadReleaseNotes({ tag });
        }
        if (publishGithub) verifyGithubPrerequisites();

        if (giteeOnly) {
            // Gitee only mode: 只发布到 Gitee，不编译
            console.log('\n⏭️  Skipping build (Gitee only mode)');
            await createGiteeRelease(release);
        } else {
            // 默认模式：编译并发布到 GitHub 和 Gitee
            console.log('\n🔨 Starting electron-builder...');

            if (!isLinux) rebuildRenderer();
            const command = getBuildCommand();
            console.log(`   Command: ${command.command} ${command.args.join(' ')}`);

            execFileSync(command.command, command.args, {
                cwd: projectRoot,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    // 如果没有证书，禁用代码签名
                    CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false'
                }
            });

            console.log('\n✅ Build completed successfully');

            if (publishGithub) {
                publishGitHubRelease(release, { target });
                console.log('✅ GitHub release notes and assets verified and published');
            } else {
                console.log('⚠️  GH_TOKEN not found, GitHub release skipped');
            }

            // Gitee release
            await createGiteeRelease(release, { target });
        }

        console.log('\n🎉 Release process completed!\n');
    } catch (error) {
        console.error('\n❌ Build failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    console.log(`\n📦 NetNexus Release Script - ${giteeOnly ? 'Gitee Only' : 'Full Release'} Mode`);
    loadEnvironment();
    build();
}

module.exports = {
    createGiteeRelease,
    getBuildCommand,
    isCurrentInstallationAsset,
    publishGitHubRelease,
    rebuildRenderer,
    verifyGithubPrerequisites
};
