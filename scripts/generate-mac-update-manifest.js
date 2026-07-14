const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('base64')));
    });
}

function quoteYaml(value) {
    return JSON.stringify(String(value));
}

async function main() {
    const assetsDir = path.resolve(process.argv[2] || path.join(projectRoot, 'release'));
    const packageJson = require(path.join(projectRoot, 'package.json'));
    const version = packageJson.version;
    const zipFiles = fs
        .readdirSync(assetsDir)
        .filter(fileName => fileName.endsWith('.zip') && fileName.includes(`-${version}-mac-`));
    const byArch = new Map();

    for (const arch of ['arm64', 'x64']) {
        const matches = zipFiles.filter(fileName => fileName.endsWith(`-mac-${arch}.zip`));
        if (matches.length !== 1) {
            throw new Error(`expected exactly one macOS ${arch} zip for version ${version}, found ${matches.length}`);
        }
        const fileName = matches[0];
        const filePath = path.join(assetsDir, fileName);
        byArch.set(arch, {
            url: fileName,
            sha512: await hashFile(filePath),
            size: fs.statSync(filePath).size
        });
    }

    const files = [byArch.get('arm64'), byArch.get('x64')];
    const primary = files[0];
    const lines = [`version: ${quoteYaml(version)}`, 'files:'];
    files.forEach(file => {
        lines.push(`  - url: ${quoteYaml(file.url)}`);
        lines.push(`    sha512: ${quoteYaml(file.sha512)}`);
        lines.push(`    size: ${file.size}`);
    });
    lines.push(`path: ${quoteYaml(primary.url)}`);
    lines.push(`sha512: ${quoteYaml(primary.sha512)}`);
    lines.push(`releaseDate: ${quoteYaml(new Date().toISOString())}`);
    lines.push('');

    const manifestPath = path.join(assetsDir, 'latest-mac.yml');
    fs.writeFileSync(manifestPath, lines.join('\n'));
    console.log(`Generated ${manifestPath} with arm64 and x64 update artifacts`);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
