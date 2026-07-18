'use strict';

const {
    parseXml,
    parseNetconfMessage,
    childValues,
    childText,
    childTexts,
    findFirst,
    textValue,
    decodeXmlText,
    extractElementContentDetails,
    NetconfRpcError
} = require('./xml');
const {
    buildGet,
    buildGetSchema,
    buildYangLibraryFilter,
    buildModulesStateFilter,
    buildNetconfSchemasFilter
} = require('./builders');

function documentFrom(input) {
    if (typeof input === 'string' || Buffer.isBuffer(input)) {
        return parseXml(input);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('schema inventory must be XML or a parsed XML document');
    }
    return input;
}

function normalizeLocationList(node, names = ['location', 'schema']) {
    const locations = [];
    for (const name of names) {
        locations.push(...childTexts(node, name));
    }
    return [...new Set(locations)];
}

function inferFormat(locations, fallback = 'yang') {
    if (locations.some(location => /\.yin(?:$|[?#])/i.test(location))) {
        return 'yin';
    }
    return fallback;
}

function normalizeDeviation(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return {
            name: childText(value, 'name') || textValue(value),
            revision: childText(value, 'revision') || null
        };
    }
    return { name: textValue(value), revision: null };
}

function normalizeSubmodule(node, source) {
    const locations = normalizeLocationList(node);
    return {
        name: childText(node, 'name'),
        revision: childText(node, 'revision') || null,
        locations,
        format: inferFormat(locations),
        source
    };
}

function normalizeModule(node, options = {}) {
    const source = options.source || 'unknown';
    const locations = normalizeLocationList(node);
    const conformanceType = options.conformanceType || childText(node, 'conformance-type') || 'implement';
    return {
        name: childText(node, 'name'),
        revision: childText(node, 'revision') || null,
        namespace: childText(node, 'namespace') || null,
        locations,
        format: inferFormat(locations),
        features: [...new Set(childTexts(node, 'feature'))],
        deviations: childValues(node, 'deviation')
            .map(normalizeDeviation)
            .filter(deviation => deviation.name),
        submodules: childValues(node, 'submodule')
            .map(submodule => normalizeSubmodule(submodule, source))
            .filter(submodule => submodule.name),
        conformanceType,
        implemented: conformanceType !== 'import',
        moduleSet: options.moduleSet || null,
        moduleSetNames: options.moduleSet ? [options.moduleSet] : [],
        source
    };
}

function moduleKey(module) {
    return [module.name || '', module.revision || '', module.namespace || '', module.conformanceType || ''].join(
        '\u0000'
    );
}

function mergeModules(modules) {
    const byKey = new Map();
    for (const module of modules) {
        if (!module.name) {
            continue;
        }
        const key = moduleKey(module);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { ...module });
            continue;
        }
        existing.locations = [...new Set([...existing.locations, ...module.locations])];
        existing.features = [...new Set([...existing.features, ...module.features])];
        existing.moduleSetNames = [...new Set([...existing.moduleSetNames, ...module.moduleSetNames])];
        const existingDeviations = new Map(
            existing.deviations.map(deviation => [`${deviation.name}\u0000${deviation.revision || ''}`, deviation])
        );
        for (const deviation of module.deviations) {
            existingDeviations.set(`${deviation.name}\u0000${deviation.revision || ''}`, deviation);
        }
        existing.deviations = [...existingDeviations.values()];
        const existingSubmodules = new Map(
            existing.submodules.map(submodule => [`${submodule.name}\u0000${submodule.revision || ''}`, submodule])
        );
        for (const submodule of module.submodules) {
            existingSubmodules.set(`${submodule.name}\u0000${submodule.revision || ''}`, submodule);
        }
        existing.submodules = [...existingSubmodules.values()];
    }
    return [...byKey.values()];
}

function emptyInventory(source) {
    return {
        source,
        contentId: null,
        moduleSetId: null,
        modules: [],
        moduleSets: [],
        schemas: [],
        datastores: []
    };
}

function normalizeYangLibrary8525(input) {
    const document = documentFrom(input);
    const yangLibrary = findFirst(document, 'yang-library');
    if (!yangLibrary) {
        throw new Error('RFC 8525 yang-library container was not found in the reply');
    }

    const inventory = emptyInventory('rfc8525');
    inventory.contentId = childText(yangLibrary, 'content-id') || null;
    const allModules = [];

    inventory.moduleSets = childValues(yangLibrary, 'module-set').map(moduleSetNode => {
        const name = childText(moduleSetNode, 'name');
        const modules = childValues(moduleSetNode, 'module').map(moduleNode =>
            normalizeModule(moduleNode, { source: 'rfc8525', moduleSet: name, conformanceType: 'implement' })
        );
        const importOnlyModules = childValues(moduleSetNode, 'import-only-module').map(moduleNode =>
            normalizeModule(moduleNode, { source: 'rfc8525', moduleSet: name, conformanceType: 'import' })
        );
        allModules.push(...modules, ...importOnlyModules);
        return { name, modules, importOnlyModules };
    });

    inventory.modules = mergeModules(allModules);
    inventory.schemas = childValues(yangLibrary, 'schema').map(schemaNode => ({
        name: childText(schemaNode, 'name'),
        moduleSets: childTexts(schemaNode, 'module-set')
    }));
    inventory.datastores = childValues(yangLibrary, 'datastore').map(datastoreNode => ({
        name: childText(datastoreNode, 'name'),
        schema: childText(datastoreNode, 'schema')
    }));
    return inventory;
}

function normalizeModulesState7895(input) {
    const document = documentFrom(input);
    const modulesState = findFirst(document, 'modules-state');
    if (!modulesState) {
        throw new Error('RFC 7895 modules-state container was not found in the reply');
    }

    const inventory = emptyInventory('rfc7895');
    inventory.moduleSetId = childText(modulesState, 'module-set-id') || null;
    inventory.modules = mergeModules(
        childValues(modulesState, 'module').map(moduleNode => normalizeModule(moduleNode, { source: 'rfc7895' }))
    );
    return inventory;
}

function normalizeNetconfSchemas6022(input) {
    const document = documentFrom(input);
    const schemas = findFirst(document, 'schemas');
    if (!schemas) {
        throw new Error('RFC 6022 schemas container was not found in the reply');
    }

    const inventory = emptyInventory('rfc6022');
    const schemaEntries = childValues(schemas, 'schema');
    inventory.schemas = schemaEntries.map(schemaNode => ({
        identifier: childText(schemaNode, 'identifier'),
        version: childText(schemaNode, 'version') || null,
        format: childText(schemaNode, 'format') || 'yang',
        namespace: childText(schemaNode, 'namespace') || null,
        locations: normalizeLocationList(schemaNode, ['location'])
    }));
    inventory.modules = mergeModules(
        inventory.schemas.map(schema => ({
            name: schema.identifier,
            revision: schema.version,
            namespace: schema.namespace,
            locations: schema.locations,
            format: schema.format,
            features: [],
            deviations: [],
            submodules: [],
            conformanceType: 'implement',
            implemented: true,
            moduleSet: null,
            moduleSetNames: [],
            source: 'rfc6022'
        }))
    );
    return inventory;
}

function normalizeSchemaInventory(input) {
    const document = documentFrom(input);
    if (findFirst(document, 'yang-library')) {
        return normalizeYangLibrary8525(document);
    }
    if (findFirst(document, 'modules-state')) {
        return normalizeModulesState7895(document);
    }
    if (findFirst(document, 'schemas')) {
        return normalizeNetconfSchemas6022(document);
    }
    throw new Error('reply contains no RFC 8525, RFC 7895, or RFC 6022 schema inventory');
}

function splitQueryList(value) {
    return value
        ? value
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
        : [];
}

function normalizeCapabilityInventory(capabilities) {
    const inventory = emptyInventory('hello');
    const modules = [];
    for (const capability of Array.isArray(capabilities) ? capabilities : []) {
        if (typeof capability !== 'string') {
            continue;
        }
        const questionMark = capability.indexOf('?');
        if (questionMark < 0) {
            continue;
        }
        const params = new URLSearchParams(capability.slice(questionMark + 1));
        const name = params.get('module');
        if (!name) {
            continue;
        }
        modules.push({
            name,
            revision: params.get('revision') || null,
            namespace: capability.slice(0, questionMark) || null,
            locations: [],
            format: 'yang',
            features: splitQueryList(params.get('features')),
            deviations: splitQueryList(params.get('deviations')).map(deviation => ({
                name: deviation,
                revision: null
            })),
            submodules: [],
            conformanceType: 'implement',
            implemented: true,
            moduleSet: null,
            moduleSetNames: [],
            source: 'hello'
        });
    }
    inventory.modules = mergeModules(modules);
    return inventory;
}

function replyXml(reply) {
    if (typeof reply === 'string') {
        return reply;
    }
    if (reply && typeof reply.xml === 'string') {
        return reply.xml;
    }
    throw new TypeError('NETCONF client returned a reply without XML');
}

function errorSummary(error) {
    return {
        name: error && error.name ? error.name : 'Error',
        code: error && error.code ? error.code : null,
        message: error && error.message ? error.message : String(error)
    };
}

async function discoverSchemaInventory(client, options = {}) {
    if (!client || typeof client.rpc !== 'function') {
        throw new TypeError('client.rpc is required for schema discovery');
    }
    const attempts = [];
    const strategies = [
        {
            source: 'rfc8525',
            operation: buildGet({ filter: buildYangLibraryFilter() }),
            normalize: normalizeYangLibrary8525
        },
        {
            source: 'rfc7895',
            operation: buildGet({ filter: buildModulesStateFilter() }),
            normalize: normalizeModulesState7895
        },
        {
            source: 'rfc6022',
            operation: buildGet({ filter: buildNetconfSchemasFilter() }),
            normalize: normalizeNetconfSchemas6022
        }
    ];

    for (const strategy of strategies) {
        try {
            const reply = await client.rpc(strategy.operation, {
                timeout: options.timeout,
                rejectOnRpcError: true
            });
            const inventory = strategy.normalize(replyXml(reply));
            if (inventory.modules.length === 0) {
                attempts.push({ source: strategy.source, ok: false, error: { message: 'inventory is empty' } });
                continue;
            }
            attempts.push({ source: strategy.source, ok: true });
            inventory.attempts = attempts;
            return inventory;
        } catch (error) {
            attempts.push({ source: strategy.source, ok: false, error: errorSummary(error) });
        }
    }

    const capabilityInventory = normalizeCapabilityInventory(
        options.capabilities || client.capabilities || client.serverCapabilities || []
    );
    capabilityInventory.attempts = attempts;
    if (capabilityInventory.modules.length > 0) {
        attempts.push({ source: 'hello', ok: true });
        return capabilityInventory;
    }
    attempts.push({ source: 'hello', ok: false, error: { message: 'no module capability URIs were advertised' } });
    return capabilityInventory;
}

async function getSchema(client, identifierOrOptions, maybeOptions = {}) {
    if (!client || typeof client.rpc !== 'function') {
        throw new TypeError('client.rpc is required to download a schema');
    }
    const options =
        typeof identifierOrOptions === 'object'
            ? { ...identifierOrOptions }
            : { ...maybeOptions, identifier: identifierOrOptions };
    const operation = buildGetSchema(options);
    const reply = await client.rpc(operation, {
        timeout: options.timeout,
        rejectOnRpcError: true
    });
    const xml = replyXml(reply);
    const message = parseNetconfMessage(xml);
    if (message.type !== 'rpc-reply') {
        throw new Error(`get-schema expected rpc-reply but received ${message.type}`);
    }
    if (message.errors.length > 0) {
        throw new NetconfRpcError(message.errors, { messageId: message.messageId, replyXml: xml });
    }
    const contentDetails = extractElementContentDetails(xml, 'data');
    if (contentDetails === null) {
        throw new Error(`get-schema reply for ${options.identifier} contains no data element`);
    }
    const format = options.format || 'yang';
    const rawContent = contentDetails.content;
    let content =
        contentDetails.cdata || (format === 'yin' && /<[^>]+>/.test(rawContent))
            ? rawContent
            : decodeXmlText(rawContent);
    if (options.trim !== false) {
        content = content.trim();
    }
    if (content === '') {
        throw new Error(`get-schema reply for ${options.identifier} contains empty schema data`);
    }
    return {
        identifier: options.identifier,
        version: options.version || options.revision || null,
        format,
        content,
        replyXml: xml
    };
}

module.exports = {
    normalizeModule,
    normalizeYangLibrary8525,
    normalizeModulesState7895,
    normalizeNetconfSchemas6022,
    normalizeSchemaInventory,
    normalizeCapabilityInventory,
    discoverSchemaInventory,
    getSchema
};
