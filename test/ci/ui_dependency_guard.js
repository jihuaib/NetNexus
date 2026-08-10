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
assert.match(
    packageJson.scripts?.start || '',
    /(?:^|\s)vite\b[\s\S]*\s--force(?:\s|$)/u,
    'the Vite dev server must force dependency re-optimization after a netnexus-ui package update'
);

const viteConfigSource = fs.readFileSync(path.join(projectRoot, 'vite.config.js'), 'utf8');
assert.match(
    viteConfigSource,
    /server\s*:\s*\{[\s\S]*?port\s*:\s*3000\s*,[\s\S]*?strictPort\s*:\s*true/u,
    'the Vite dev server must fail instead of silently moving away from Electron port 3000'
);

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

const settingsDialogSource = fs.readFileSync(path.join(sourceRoot, 'components', 'SettingsDialog.vue'), 'utf8');
assert.match(settingsDialogSource, /<nn-navigation-modal(?:\s|>)/u, 'SettingsDialog must use NnNavigationModal');
assert(
    !/<nn-(?:modal|menu|menu-item)(?:\s|>)/u.test(settingsDialogSource),
    'SettingsDialog retains a local modal or navigation implementation'
);

const fileImportModalFiles = ['RouteViewsImportModal.vue', 'RpkiRoaImportModal.vue', 'RpkiAspaImportModal.vue'];
for (const fileName of fileImportModalFiles) {
    const source = fs.readFileSync(path.join(sourceRoot, 'components', fileName), 'utf8');
    assert.match(source, /<nn-file-import-modal(?:\s|>)/u, `${fileName} must use NnFileImportModal`);
    assert(!/<nn-modal(?:\s|>)/u.test(source), `${fileName} retains a local NnModal shell`);
    assert(
        !/\.(?:file-selector|selected-path|importing-feedback)\b/u.test(source),
        `${fileName} retains duplicate import shell CSS`
    );
}

const settingsPageFiles = [
    'GeneralSettings.vue',
    'ToolsSettings.vue',
    'FtpSettings.vue',
    'ApiSettings.vue',
    'BmpDataSettings.vue',
    'RuntimeSettings.vue',
    'UpdateSettings.vue'
];
const settingsPageSources = new Map(
    settingsPageFiles.map(fileName => [
        fileName,
        fs.readFileSync(path.join(sourceRoot, 'view', 'settings', fileName), 'utf8')
    ])
);
const expectedSettingsItemCounts = new Map([
    ['GeneralSettings.vue', 2],
    ['ToolsSettings.vue', 2],
    ['FtpSettings.vue', 1],
    ['ApiSettings.vue', 5],
    ['BmpDataSettings.vue', 1],
    ['RuntimeSettings.vue', 0],
    ['UpdateSettings.vue', 3]
]);
const expectedSettingsSectionTitles = new Map([
    ['GeneralSettings.vue', ['主题', '日志']],
    ['ToolsSettings.vue', ['字符串生成', '报文解析', 'Wireshark']],
    ['FtpSettings.vue', ['用户存储']],
    ['ApiSettings.vue', ['接入配置', '运行状态']],
    ['BmpDataSettings.vue', ['BMP SQLite 数据库']],
    ['RuntimeSettings.vue', ['YANG 编译器']],
    ['UpdateSettings.vue', ['版本与安装', '自动更新']]
]);

for (const [fileName, source] of settingsPageSources) {
    assert.match(source, /<nn-settings(?:\s|>)/u, `${fileName} must use the NnSettings page container`);
    assert.deepStrictEqual(
        [...source.matchAll(/<nn-settings-section\b[^>]*\btitle="([^"]+)"/gu)].map(match => match[1]),
        expectedSettingsSectionTitles.get(fileName),
        `${fileName} must expose only its real business sections below the navigation heading`
    );
    assert(!/<nn-card(?:\s|>)/u.test(source), `${fileName} retains a page-level Card instead of a settings section`);
    assert.strictEqual(
        (source.match(/<nn-settings-item(?:\s|>)/gu) || []).length,
        expectedSettingsItemCounts.get(fileName),
        `${fileName} must only map simple preference rows to NnSettingsItem`
    );
}

const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
assert.match(mainSource, /from 'netnexus-ui'/u);
assert.match(mainSource, /import 'netnexus-ui\/style\.css'/u);
assert.match(mainSource, /app\.use\(NetNexusUi\)/u);

console.log(
    `NetNexus UI package consumer guard passed (${sourceFiles.length} app source files, ${usedTags.size}/${registeredNames.size} component types)`
);
