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

assert(!fs.existsSync(path.join(sourceRoot, 'theme', 'antDesignTheme.js')), 'legacy Ant theme adapter still exists');
assert(!fs.existsSync(path.join(sourceRoot, 'ui', 'UiProvider.vue')), 'legacy Ant ConfigProvider wrapper still exists');

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
assert(!packageJson.dependencies?.['ant-design-vue'], 'ant-design-vue remains in dependencies');
assert(!packageJson.devDependencies?.['ant-design-vue'], 'ant-design-vue remains in devDependencies');

const registrationSource = fs.readFileSync(path.join(sourceRoot, 'ui', 'registerUiComponents.js'), 'utf8');
const registeredNames = new Set(
    [...registrationSource.matchAll(/^\s{4}(Nn[A-Za-z0-9]+),?$/gmu)].map(match => match[1])
);
const usedTags = new Set();

for (const filePath of sourceFiles.filter(file => file.endsWith('.vue'))) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const match of content.matchAll(/<nn-([a-z0-9-]+)/gu)) {
        usedTags.add(`Nn${toPascalCase(match[1])}`);
    }
}

const missingRegistrations = [...usedTags].filter(name => !registeredNames.has(name)).sort();
assert.deepStrictEqual(
    missingRegistrations,
    [],
    `unregistered NetNexus UI components: ${missingRegistrations.join(', ')}`
);

console.log(
    `NetNexus UI dependency guard passed (${sourceFiles.length} source files, ${usedTags.size} registered component types)`
);
