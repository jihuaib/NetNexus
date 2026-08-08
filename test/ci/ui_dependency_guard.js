const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = process.env.NETNEXUS_SOURCE_PROJECT_ROOT
    ? path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT)
    : path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(projectRoot, 'src');

assert(fs.existsSync(sourceRoot), `UI source root does not exist: ${sourceRoot}`);

function collectFiles(directory, extensions) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath, extensions));
        } else if (extensions.has(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }
    return files;
}

function toPascalCase(kebabName) {
    return kebabName
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

const sourceFiles = collectFiles(sourceRoot, new Set(['.vue', '.js', '.css']));
const migrationFiles = [
    ...sourceFiles,
    path.join(projectRoot, 'vite.config.js'),
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'README.md'),
    path.join(projectRoot, 'CLAUDE.md'),
    path.join(projectRoot, 'scripts', 'captureDocsScreenshots.js')
];
const legacyPatterns = [
    { label: 'Ant Design dependency/import', pattern: /ant-design-vue|@ant-design/u },
    { label: 'legacy Ant component tag', pattern: /<\/?a-[a-z0-9-]+/u },
    { label: 'legacy Ant CSS/DOM class', pattern: /(?:\.|['"`\s])ant-[a-z0-9-]+/u }
];

for (const filePath of migrationFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const { label, pattern } of legacyPatterns) {
        assert(!pattern.test(content), `${label} remains in ${path.relative(projectRoot, filePath)}`);
    }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const dependencySpec = packageJson.dependencies?.['netnexus-ui'];
assert(dependencySpec, 'netnexus-ui must be a runtime dependency');
assert.match(
    dependencySpec,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    'netnexus-ui must use an exact npm registry version'
);
assert(!packageJson.dependencies?.['@lucide/vue'], '@lucide/vue must be owned by netnexus-ui');
assert(!packageJson.devDependencies?.['@lucide/vue'], '@lucide/vue must be owned by netnexus-ui');
assert(!packageJson.dependencies?.['ant-design-vue'], 'ant-design-vue remains in dependencies');
assert(!packageJson.devDependencies?.['ant-design-vue'], 'ant-design-vue remains in devDependencies');

assert(!fs.existsSync(path.join(sourceRoot, 'ui')), 'the embedded UI source must live in the netnexus-ui package');
assert(
    !fs.existsSync(path.join(sourceRoot, 'theme')),
    'the embedded theme source must live in the netnexus-ui package'
);
assert(
    !fs.existsSync(path.join(sourceRoot, 'assets', 'styles', 'theme.css')),
    'local theme.css duplicates the package'
);
assert(
    !fs.existsSync(path.join(sourceRoot, 'assets', 'styles', 'ui-services.css')),
    'local ui-services.css duplicates the package'
);

const netnexusUi = require('netnexus-ui');
const installedPackageJson = require('netnexus-ui/package.json');
assert.equal(installedPackageJson.name, 'netnexus-ui');
assert.equal(installedPackageJson.version, dependencySpec, 'installed netnexus-ui version does not match package.json');
assert.equal(typeof netnexusUi.default?.install, 'function', 'netnexus-ui default export is not a Vue plugin');
const registeredNames = new Set(Object.keys(netnexusUi.uiComponents || {}));
assert(registeredNames.size > 0, 'netnexus-ui did not export its component registry');

const usedTags = new Set();
for (const filePath of sourceFiles.filter(file => file.endsWith('.vue'))) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const match of content.matchAll(/<nn-([a-z0-9-]+)/gu)) {
        usedTags.add(`Nn${toPascalCase(match[1])}`);
    }
    assert(!/from ['"][^'"]*\/ui(?:\/|['"])/u.test(content), `relative UI import remains in ${filePath}`);
}

const missingRegistrations = [...usedTags].filter(name => !registeredNames.has(name)).sort();
assert.deepStrictEqual(
    missingRegistrations,
    [],
    `unregistered NetNexus UI components: ${missingRegistrations.join(', ')}`
);

const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
assert.match(mainSource, /from 'netnexus-ui'/u);
assert.match(mainSource, /import 'netnexus-ui\/style\.css'/u);
assert.match(mainSource, /app\.use\(NetNexusUi\)/u);

console.log(
    `NetNexus UI package consumer guard passed (${sourceFiles.length} app source files, ${usedTags.size}/${registeredNames.size} component types)`
);
