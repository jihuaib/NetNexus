const fs = require('fs/promises');
const path = require('path');
const { transform } = require('esbuild');

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function findElectronRoot(context) {
    const appOutDir = context.appOutDir;
    const candidates = [path.join(appOutDir, 'resources', 'app', 'electron')];

    if (context.electronPlatformName === 'darwin') {
        const appNames = await fs.readdir(appOutDir).catch(() => []);
        for (const appName of appNames) {
            if (appName.endsWith('.app')) {
                candidates.push(path.join(appOutDir, appName, 'Contents', 'Resources', 'app', 'electron'));
            }
        }
    }

    for (const candidate of candidates) {
        if (await pathExists(candidate)) {
            return candidate;
        }
    }

    return null;
}

async function collectJsFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await collectJsFiles(fullPath)));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

async function writeFileBreakingHardlink(filePath, contents) {
    const stat = await fs.stat(filePath);

    if (stat.nlink <= 1) {
        await fs.writeFile(filePath, contents);
        return;
    }

    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

    try {
        await fs.writeFile(tempPath, contents, { mode: stat.mode });
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function minifyFile(filePath) {
    const source = await fs.readFile(filePath, 'utf8');
    const result = await transform(source, {
        loader: 'js',
        target: 'node16',
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: true,
        keepNames: true,
        legalComments: 'none'
    });

    await writeFileBreakingHardlink(filePath, result.code);

    return {
        before: Buffer.byteLength(source),
        after: Buffer.byteLength(result.code)
    };
}

async function minifyElectronRoot(electronRoot) {
    const files = await collectJsFiles(electronRoot);
    let beforeBytes = 0;
    let afterBytes = 0;

    for (const file of files) {
        const result = await minifyFile(file);
        beforeBytes += result.before;
        afterBytes += result.after;
    }

    const savedBytes = beforeBytes - afterBytes;
    const savedPercent = beforeBytes > 0 ? ((savedBytes / beforeBytes) * 100).toFixed(1) : '0.0';

    console.log(`[minify-electron-js] minified ${files.length} files, saved ${savedBytes} bytes (${savedPercent}%)`);
}

async function minifyElectronJs(context) {
    const electronRoot = await findElectronRoot(context);

    if (!electronRoot) {
        console.log('[minify-electron-js] electron output directory not found, skipped');
        return;
    }

    await minifyElectronRoot(electronRoot);
}

module.exports = minifyElectronJs;
module.exports.minifyElectronRoot = minifyElectronRoot;
