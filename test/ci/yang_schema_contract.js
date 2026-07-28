const assert = require('assert');
const {
    COMPILE_CACHE_SCHEMA_VERSION,
    LIBYANG_SCHEMA_OUTPUT_VERSION,
    validateAuthoritativeSchemaTree
} = require('../../electron/utils/yang/yangCompiler');
const { SCHEMA_HELPER_CONTRACT_VERSION } = require('../../electron/utils/yang/libyangRuntime');

function createSchemaTree() {
    const moduleId = 'module:demo';
    const leafId = 'node:demo:mode';
    return {
        schemaVersion: 3,
        authoritative: true,
        source: 'libyang-effective',
        scope: 'core-effective-schema',
        rootId: 'yang-schema-root',
        roots: [moduleId],
        nodes: {
            [moduleId]: {
                id: moduleId,
                parentId: 'yang-schema-root',
                name: 'demo',
                keyword: 'module',
                path: '/demo',
                baseType: null,
                acceptsEmptyString: null,
                schemaKey: [],
                schemaKeyDetails: [],
                enumValues: [],
                presence: null,
                hasChildren: true,
                childCount: 1
            },
            [leafId]: {
                id: leafId,
                parentId: moduleId,
                name: 'mode',
                keyword: 'leaf',
                path: '/demo:mode',
                baseType: 'enumeration',
                acceptsEmptyString: false,
                enumValues: [
                    {
                        name: 'enable',
                        value: 0,
                        description: 'Enable the feature.',
                        reference: null,
                        status: 'current'
                    },
                    {
                        name: 'disable',
                        value: 1,
                        description: null,
                        reference: 'Demo section 1',
                        status: 'deprecated'
                    }
                ],
                presence: null,
                schemaKey: [],
                schemaKeyDetails: [],
                hasChildren: false,
                childCount: 0
            }
        },
        childIndex: {
            'yang-schema-root': [moduleId],
            [moduleId]: [leafId],
            [leafId]: []
        },
        nodeCount: 2
    };
}

function assertInvalid(mutate, expectedMessage) {
    const tree = createSchemaTree();
    mutate(tree, tree.nodes['node:demo:mode']);
    assert.throws(
        () => validateAuthoritativeSchemaTree(tree),
        error => {
            assert.equal(error.code, 'LIBYANG_SCHEMA_INVALID_OUTPUT');
            assert.match(error.message, expectedMessage);
            return true;
        }
    );
}

assert.equal(SCHEMA_HELPER_CONTRACT_VERSION, 4);
assert.equal(LIBYANG_SCHEMA_OUTPUT_VERSION, 3);
assert.equal(COMPILE_CACHE_SCHEMA_VERSION, 7);

const validTree = createSchemaTree();
assert.strictEqual(validateAuthoritativeSchemaTree(validTree), validTree);

assertInvalid((tree, leaf) => delete leaf.baseType, /baseType must be a non-empty string or null/u);
assertInvalid((tree, leaf) => {
    leaf.baseType = 'enumeratoin';
    leaf.enumValues = [];
}, /unknown baseType enumeratoin/u);
assertInvalid((tree, leaf) => {
    leaf.enumValues = null;
}, /enumValues must be an array/u);
assertInvalid((tree, leaf) => {
    delete leaf.acceptsEmptyString;
}, /acceptsEmptyString must be boolean/u);
assertInvalid((tree, leaf) => {
    leaf.schemaKeyDetails = null;
}, /schemaKeyDetails must be an array/u);
assertInvalid((tree, leaf) => {
    leaf.schemaKey = ['mode'];
    leaf.schemaKeyDetails = [{ name: 'mode', acceptsEmptyString: false }];
}, /non-list node .* must not declare schema keys/u);
assertInvalid((tree, leaf) => {
    leaf.baseType = 'string';
}, /non-enumeration node .* must not declare enumValues/u);
assertInvalid((tree, leaf) => delete leaf.enumValues[0].reference, /reference must be a string or null/u);
assertInvalid((tree, leaf) => {
    leaf.enumValues[1].name = 'enable';
}, /duplicate enum name enable/u);
assertInvalid((tree, leaf) => {
    leaf.enumValues[1].value = 0;
}, /duplicate enum value 0/u);
assertInvalid((tree, leaf) => {
    leaf.enumValues[0].value = 2_147_483_648;
}, /value must be a signed 32-bit integer/u);
assertInvalid((tree, leaf) => {
    leaf.enumValues[0].status = 'unknown';
}, /has an invalid status/u);
assertInvalid(tree => {
    tree.schemaVersion = 1;
}, /schemaVersion must be 3/u);

console.log('libyang effective Schema version, enumeration, and empty-string contract tests passed');
