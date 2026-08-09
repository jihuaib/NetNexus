const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    LOCAL_UI_ENTRY_MAP,
    LOCAL_UI_OPTIMIZE_EXCLUDES,
    createLocalUiAliases,
    resolveLocalUiRoot
} = require('../../scripts/local-ui-source');

const projectRoot = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

assert.equal(resolveLocalUiRoot(projectRoot, ''), null, 'normal builds must not probe a sibling UI repository');
assert.equal(packageJson.scripts?.['dev:ui'], 'node scripts/run-with-local-ui.js dev');
assert.equal(packageJson.scripts?.['build:ui'], 'node scripts/run-with-local-ui.js build');
assert.match(packageJson.dependencies?.['netnexus-ui'] || '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

const launcherSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'run-with-local-ui.js'), 'utf8');
assert.match(launcherSource, /spawn\(process\.execPath,/u, 'local UI launcher must use the current Node runtime');
assert.match(launcherSource, /shell:\s*false/u, 'local UI launcher must remain cross-platform and shell-free');
assert.match(launcherSource, /NETNEXUS_UI_SOURCE:\s*localUiRoot/u);
assert(
    !/(?:npm\s+(?:add|install|link)|\bfile:|\blink:|\b(?:bash|sh|export|ln|cp)\b)/u.test(launcherSource),
    'local UI development must not install/link packages, mutate the lockfile, or require Unix shell commands'
);

const viteConfigSource = fs.readFileSync(path.join(projectRoot, 'vite.config.js'), 'utf8');
assert.match(viteConfigSource, /process\.env\.NETNEXUS_UI_SOURCE/u);
assert.match(viteConfigSource, /alias:\s*localUiAliases/u);
assert.match(viteConfigSource, /dedupe:\s*\['vue', '@lucide\/vue'\]/u);
assert.match(viteConfigSource, /allow:\s*\[projectRoot, localUiRoot\]/u);
assert.match(viteConfigSource, /exclude:\s*\[\.\.\.LOCAL_UI_OPTIMIZE_EXCLUDES\]/u);

for (const workflowName of ['test.yml', 'release.yml']) {
    const workflowSource = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', workflowName), 'utf8');
    assert(
        !workflowSource.includes('NETNEXUS_UI_SOURCE'),
        `${workflowName} must consume the registry package rather than a developer checkout`
    );
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-ui-local-contract-'));
const fakeAppRoot = path.join(temporaryRoot, 'NetNexus');
const fakeUiRoot = path.join(temporaryRoot, 'NetNexusUI');

try {
    fs.mkdirSync(fakeAppRoot, { recursive: true });
    for (const relativePath of new Set(Object.values(LOCAL_UI_ENTRY_MAP))) {
        const target = path.join(fakeUiRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
            target,
            relativePath === 'package.json' ? JSON.stringify({ name: 'netnexus-ui' }) : `// ${relativePath}\n`
        );
    }

    const resolvedUiRoot = resolveLocalUiRoot(fakeAppRoot, path.join('..', 'NetNexusUI'));
    assert.equal(resolvedUiRoot, fakeUiRoot);

    const aliases = createLocalUiAliases(resolvedUiRoot);
    assert.equal(aliases.length, Object.keys(LOCAL_UI_ENTRY_MAP).length);
    for (const [specifier, relativePath] of Object.entries(LOCAL_UI_ENTRY_MAP)) {
        const matchingAliases = aliases.filter(alias => alias.find.test(specifier));
        assert.equal(matchingAliases.length, 1, `${specifier} must have one exact local alias`);
        assert.equal(matchingAliases[0].replacement, path.join(fakeUiRoot, relativePath));
        assert(
            !matchingAliases[0].find.test(`${specifier}-other`),
            `${specifier} alias must not capture another package`
        );
    }
    assert.equal(
        aliases.find(alias => alias.find.test('netnexus-ui/style.css')).replacement,
        path.join(fakeUiRoot, 'src', 'index.js'),
        'local aggregate CSS must load the same source entry as the component plugin'
    );
    assert.deepStrictEqual(LOCAL_UI_OPTIMIZE_EXCLUDES, [
        'netnexus-ui',
        'netnexus-ui/components',
        'netnexus-ui/icons',
        'netnexus-ui/theme',
        'netnexus-ui/services'
    ]);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Local NetNexusUI source development contract passed');
