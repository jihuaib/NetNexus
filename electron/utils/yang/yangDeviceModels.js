const { createHash } = require('crypto');

const sortedStrings = values => [...new Set((values || []).map(String))].sort();
const sortedRecords = values => values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

function normalizeDeviceModels(inventory) {
    if (!['rfc8525', 'rfc7895', 'rfc6022'].includes(inventory?.source) || !inventory.modules?.length) return null;
    const modules = sortedRecords(
        inventory.modules
            .filter(module => module.name)
            .map(module => ({
                name: module.name,
                revision: module.revision || '',
                namespace: module.namespace || '',
                kind: module.kind || (module.submodule || module.isSubmodule ? 'submodule' : 'module'),
                conformanceType: module.conformanceType || 'implement',
                features: sortedStrings(module.features),
                deviations: sortedRecords(
                    (module.deviations || []).map(item => ({ name: item.name || item, revision: item.revision || '' }))
                ),
                submodules: sortedRecords(
                    (module.submodules || []).map(item => ({ name: item.name, revision: item.revision || '' }))
                )
            }))
    );
    if (!modules.length) return null;
    const value = {
        source: inventory.source,
        contentId: inventory.contentId || '',
        moduleSetId: inventory.moduleSetId || '',
        modules,
        schemas: sortedRecords(
            (inventory.schemas || [])
                .filter(item => item.moduleSets)
                .map(item => ({
                    name: item.name,
                    moduleSets: sortedStrings(item.moduleSets)
                }))
        ),
        datastores: sortedRecords((inventory.datastores || []).map(item => ({ name: item.name, schema: item.schema })))
    };
    return { ...value, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

function deviceModuleDescriptors(models, kind, name) {
    // RFC 6022 lists schemas without identifying module versus submodule.
    if (models?.source === 'rfc6022') return models.modules.filter(module => module.name === name);
    if (kind === 'submodule') {
        return (models?.modules || []).flatMap(module => [
            ...(module.kind === 'submodule' && module.name === name ? [module] : []),
            ...module.submodules.filter(item => item.name === name)
        ]);
    }
    return (models?.modules || []).filter(module => module.kind === 'module' && module.name === name);
}

function matchesDeviceModule(module, descriptor) {
    const metadata = module.metadata || {};
    return (
        metadata.name === descriptor.name &&
        (!descriptor.revision || metadata.revision === descriptor.revision) &&
        (metadata.kind === 'submodule' || !descriptor.namespace || metadata.namespace === descriptor.namespace)
    );
}

module.exports = { normalizeDeviceModels, deviceModuleDescriptors, matchesDeviceModule };
