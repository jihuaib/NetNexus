const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const lockRoot = packageLock.packages?.[''];

assert.strictEqual(
    process.versions.electron,
    '22.3.27',
    'the CI suite must run in the exact final Electron release line that supports Windows 7'
);
assert.match(process.versions.node, /^16\./u, 'Electron 22 must keep its embedded Node.js 16 runtime');
if (process.versions.chrome) {
    assert.match(process.versions.chrome, /^108\./u, 'Electron 22 must keep its Chromium 108 runtime');
}

assert.strictEqual(packageJson.engines.node, '>=16.20.2');
assert.strictEqual(packageJson.devDependencies.electron, '22.3.27');
assert.match(packageJson.devDependencies['electron-builder'], /^\^24\./u);
assert.match(packageJson.devDependencies['electron-rebuild'], /^\^3\./u);
assert(!Object.prototype.hasOwnProperty.call(packageJson.devDependencies, '@electron/rebuild'));
assert.match(packageJson.devDependencies.vite, /^\^4\./u);
assert.match(packageJson.devDependencies['@vitejs/plugin-vue'], /^\^4\./u);
assert.strictEqual(packageJson.devDependencies['@playwright/test'], '1.44.1');
assert.strictEqual(packageJson.dependencies['better-sqlite3'], '11.10.0');

assert(lockRoot, 'package-lock.json must contain a root package record');
assert.strictEqual(lockRoot.devDependencies.electron, packageJson.devDependencies.electron);
assert.strictEqual(lockRoot.devDependencies['electron-builder'], packageJson.devDependencies['electron-builder']);
assert.strictEqual(lockRoot.devDependencies['electron-rebuild'], packageJson.devDependencies['electron-rebuild']);
assert.strictEqual(lockRoot.devDependencies.vite, packageJson.devDependencies.vite);
assert.strictEqual(lockRoot.devDependencies['@vitejs/plugin-vue'], packageJson.devDependencies['@vitejs/plugin-vue']);
assert.strictEqual(lockRoot.devDependencies['@playwright/test'], packageJson.devDependencies['@playwright/test']);
assert.strictEqual(lockRoot.dependencies['better-sqlite3'], packageJson.dependencies['better-sqlite3']);

const installedElectron = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
);
assert.strictEqual(installedElectron.version, '22.3.27');

const releaseWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const testWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'test.yml'), 'utf8');
assert.match(releaseWorkflow, /NODE_VERSION:\s*['"]16\.20\.2['"]/u);
assert.doesNotMatch(releaseWorkflow, /NODE_VERSION:\s*['"](?:1[7-9]|2\d)\./u);
assert.doesNotMatch(testWorkflow, /NODE_VERSION:\s*['"](?:1[7-9]|2\d)\./u);

assert(fs.statSync(path.join(projectRoot, 'vite.config.js')).isFile());
assert(!fs.existsSync(path.join(projectRoot, 'vite.config.mjs')));
const rebuildScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'rebuild-better-sqlite3.js'), 'utf8');
assert.match(rebuildScript, /electron-rebuild\/lib\/src\/cli\.js/u);
assert.doesNotMatch(rebuildScript, /@electron\/rebuild/u);

const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
const developmentGuide = fs.readFileSync(path.join(projectRoot, 'docs', 'DEVELOPMENT.md'), 'utf8');
assert.match(readme, /Electron-22-/u);
assert.match(developmentGuide, /Windows 7\/8\/8\.1/u);
assert.match(developmentGuide, /Electron `22\.3\.27`/u);

console.log('Windows 7 Electron runtime compatibility policy tests passed');
