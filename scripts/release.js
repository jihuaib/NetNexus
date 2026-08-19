const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

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

if (giteeOnly) {
    console.log('\n📦 NetNexus Release Script - Gitee Only Mode');
} else {
    console.log('\n📦 NetNexus Release Script - Full Release Mode');
}

// Load .env file (从项目根目录加载)
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf-8');
    envConfig.split(/\r?\n/).forEach(line => {
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
async function createGiteeRelease() {
    const giteeToken = process.env.GITEE_TOKEN;

    if (!giteeToken) {
        console.log('\n⚠️  GITEE_TOKEN not found, skipping Gitee release');
        console.log('To enable Gitee release, add GITEE_TOKEN to your .env file');
        return;
    }

    // Get current git tag
    let currentTag;
    try {
        currentTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf-8' }).trim();
    } catch (error) {
        console.log('\n⚠️  No git tag found, skipping Gitee release');
        return;
    }

    console.log(`\n📦 Creating Gitee release for tag: ${currentTag}`);

    // Step 1: Create release
    const releaseId = await new Promise((resolve, _reject) => {
        const data = JSON.stringify({
            access_token: giteeToken,
            tag_name: currentTag,
            name: `NetNexus ${currentTag}`,
            body: `自动发布 ${currentTag}\n\n通过自动构建和发布。`,
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

        const req = https.request(options, res => {
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
    const distPath = path.join(__dirname, '../release');
    if (!fs.existsSync(distPath)) {
        console.log('⚠️  release directory not found, skipping file upload');
        return;
    }

    const files = fs
        .readdirSync(distPath)
        .filter(file => file.endsWith('.exe') || file.endsWith('.msi') || file.endsWith('.deb'));

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

            const req = https.request(
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

function validateBuildTarget() {
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
function getBuildCommand() {
    const customArgs = ['--gitee-only', '--help', '-h', '--win', '--mac', '--linux', '--x64', '--arm64', '--universal'];
    const extraArgs = args.filter(arg => !customArgs.includes(arg)).join(' ');

    if (isLinux) {
        const targetArch = isArm64 ? 'arm64' : isX64 ? 'x64' : normalizeArchitecture(process.arch);
        return ['npm', 'run', `dist:linux:${targetArch}`, '--', '--publish', 'never'].join(' ');
    }

    let platform = '--win';
    let arch = '--x64';

    if (isWin) {
        platform = '--win';
        arch = '--x64';
    }

    return ['electron-builder', platform, arch, '--publish always', extraArgs].filter(Boolean).join(' ').trim();
}

// Run electron-builder
async function build() {
    try {
        validateBuildTarget();

        if (giteeOnly) {
            // Gitee only mode: 只发布到 Gitee，不编译
            console.log('\n⏭️  Skipping build (Gitee only mode)');
            await createGiteeRelease();
        } else {
            // 默认模式：编译并发布到 GitHub 和 Gitee
            console.log('\n🔨 Starting electron-builder...');

            const command = getBuildCommand();
            console.log(`   Command: ${command}`);

            execSync(command, {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    // 如果没有证书，禁用代码签名
                    CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false'
                }
            });

            console.log('\n✅ Build completed successfully');

            // GitHub release (handled by electron-builder if GH_TOKEN is set)
            if (process.env.GH_TOKEN) {
                if (isLinux) {
                    console.log('ℹ️  Linux .deb 已在本地生成；请使用 release workflow 发布到 GitHub');
                } else {
                    console.log('✅ GitHub release created by electron-builder');
                }
            } else {
                console.log('⚠️  GH_TOKEN not found, GitHub release skipped');
            }

            // Gitee release
            await createGiteeRelease();
        }

        console.log('\n🎉 Release process completed!\n');
    } catch (error) {
        console.error('\n❌ Build failed:', error.message);
        process.exit(1);
    }
}

build();
