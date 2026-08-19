/**
 * 修补 electron-builder 的符号链接处理问题
 *
 * 问题: ensureSymlink 使用相对路径时会检查目标是否存在，
 * 但它检查的是相对于当前工作目录的路径，而不是相对于符号链接位置的路径。
 *
 * 解决方案: 将 ensureSymlink 替换为 fs.symlink
 */

const fs = require('fs');
const path = require('path');

const appFileCopierPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'app-builder-lib',
    'out',
    'util',
    'appFileCopier.js'
);

if (!fs.existsSync(appFileCopierPath)) {
    console.error('Error: appFileCopier.js not found');
    process.exit(1);
}

let content = fs.readFileSync(appFileCopierPath, 'utf8');

// 检查是否已经修补过
if (content.includes('// PATCHED FOR SYMLINK FIX')) {
    console.log('Already patched.');
    process.exit(0);
}

// electron-builder 24 uses Bluebird for this copy pass. Keep the replacement
// exact so an upstream implementation change cannot be patched silently.
const oldCode = `await bluebird_lst_1.default.map(links, it => (0, fs_extra_1.ensureSymlink)(it.link, it.file), fs_1.CONCURRENCY);`;
const newCode = `// PATCHED FOR SYMLINK FIX - preserve relative link targets without resolving them against cwd
        await bluebird_lst_1.default.map(links, async (it) => {
            try {
                const parentDir = require('path').dirname(it.file);
                await require('fs').promises.mkdir(parentDir, { recursive: true });
                await require('fs').promises.symlink(it.link, it.file);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
        }, fs_1.CONCURRENCY);`;

if (!content.includes(oldCode)) {
    console.error('Error: Could not find the code to patch');
    console.log('The electron-builder version may have changed.');
    process.exit(1);
}

content = content.replace(oldCode, newCode);

fs.writeFileSync(appFileCopierPath, content);
console.log('Successfully patched appFileCopier.js');
console.log('Symlink handling has been fixed for macOS builds.');
