const fs = require('fs');
const path = require('path');

const LOCAL_UI_ENTRY_MAP = Object.freeze({
    'netnexus-ui': 'src/index.js',
    'netnexus-ui/components': 'src/index.js',
    'netnexus-ui/icons': 'src/icons.entry.js',
    'netnexus-ui/theme': 'src/theme.entry.js',
    'netnexus-ui/services': 'src/services.entry.js',
    // The source root imports every component and its scoped CSS. Resolving the
    // published aggregate stylesheet to the same module keeps local JS and CSS
    // on one HMR graph instead of mixing source components with stale dist CSS.
    'netnexus-ui/style.css': 'src/index.js',
    'netnexus-ui/theme.css': 'src/styles/theme.css',
    'netnexus-ui/services.css': 'src/styles/services.css',
    'netnexus-ui/icons.css': 'src/styles/icons.css',
    'netnexus-ui/base.css': 'src/styles/base.css',
    'netnexus-ui/reset.css': 'src/styles/reset.css',
    'netnexus-ui/package.json': 'package.json'
});

const LOCAL_UI_OPTIMIZE_EXCLUDES = Object.freeze([
    'netnexus-ui',
    'netnexus-ui/components',
    'netnexus-ui/icons',
    'netnexus-ui/theme',
    'netnexus-ui/services'
]);

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveLocalUiRoot(projectRoot, requestedRoot) {
    if (!requestedRoot) return null;

    const localUiRoot = path.resolve(projectRoot, requestedRoot);
    const packageJsonPath = path.join(localUiRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`Local NetNexusUI package was not found at ${localUiRoot}`);
    }

    let packageJson;
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
        throw new Error(`Local NetNexusUI package.json is invalid: ${error.message}`);
    }
    if (packageJson.name !== 'netnexus-ui') {
        throw new Error(`Expected netnexus-ui at ${localUiRoot}, found ${packageJson.name || 'an unnamed package'}`);
    }

    for (const relativePath of new Set(Object.values(LOCAL_UI_ENTRY_MAP))) {
        const entryPath = path.join(localUiRoot, relativePath);
        if (!fs.existsSync(entryPath)) {
            throw new Error(`Local NetNexusUI entry is missing: ${entryPath}`);
        }
    }

    return localUiRoot;
}

function createLocalUiAliases(localUiRoot) {
    if (!localUiRoot) return [];

    return Object.entries(LOCAL_UI_ENTRY_MAP).map(([specifier, relativePath]) => ({
        find: new RegExp(`^${escapeRegExp(specifier)}$`, 'u'),
        replacement: path.join(localUiRoot, relativePath)
    }));
}

module.exports = {
    LOCAL_UI_ENTRY_MAP,
    LOCAL_UI_OPTIMIZE_EXCLUDES,
    createLocalUiAliases,
    resolveLocalUiRoot
};
