'use strict';

const assert = require('node:assert/strict');
const { filterSubtreeXml } = require('../../electron/utils/netconf');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const MODEL_NAMESPACE = 'urn:netnexus:test:subtree';
const KEY_DEFINITIONS = [
    {
        namespace: MODEL_NAMESPACE,
        element: 'interface',
        keys: [{ namespace: MODEL_NAMESPACE, name: 'name' }]
    }
];
const DATA =
    `<system xmlns="${MODEL_NAMESPACE}"><hostname>router-a</hostname><location>lab</location></system>` +
    `<interfaces xmlns="${MODEL_NAMESPACE}">` +
    '<interface role="edge"><name>eth0</name><enabled>true</enabled><mtu>1500</mtu></interface>' +
    '<interface role="core"><name>eth1</name><enabled>false</enabled><mtu>9000</mtu></interface>' +
    '</interfaces>' +
    `<state xmlns="${MODEL_NAMESPACE}"><uptime>30</uptime><session-count>2</session-count></state>`;

function request(filterContent, attributes = 'type="subtree"') {
    return (
        `<rpc xmlns="${BASE_NAMESPACE}" message-id="1"><get>` +
        `<filter ${attributes}>${filterContent}</filter>` +
        '</get></rpc>'
    );
}

function apply(filterContent, attributes) {
    return filterSubtreeXml(DATA, request(filterContent, attributes), { keyDefinitions: KEY_DEFINITIONS });
}

assert.equal(filterSubtreeXml(DATA, `<rpc xmlns="${BASE_NAMESPACE}"><get/></rpc>`), DATA);
assert.equal(apply(''), '');

const stateLeaf = apply(`<state xmlns="${MODEL_NAMESPACE}"><session-count/></state>`);
assert.equal(stateLeaf, `<state xmlns="${MODEL_NAMESPACE}"><session-count>2</session-count></state>`);

const wildcardNamespace = apply('<state xmlns=""><uptime/></state>');
assert.equal(wildcardNamespace, `<state xmlns="${MODEL_NAMESPACE}"><uptime>30</uptime></state>`);
assert.equal(apply('<state xmlns="urn:wrong"><uptime/></state>'), '');

const prefixedNamespace = apply(`<m:system xmlns:m="${MODEL_NAMESPACE}"><m:hostname/></m:system>`);
assert.equal(prefixedNamespace, `<system xmlns="${MODEL_NAMESPACE}"><hostname>router-a</hostname></system>`);

const selectedListLeaf = apply(
    `<interfaces xmlns="${MODEL_NAMESPACE}"><interface>` + '<name>eth1</name><enabled/></interface></interfaces>'
);
assert.equal(
    selectedListLeaf,
    `<interfaces xmlns="${MODEL_NAMESPACE}"><interface role="core">` +
        '<name>eth1</name><enabled>false</enabled></interface></interfaces>'
);

const contentMatchOnly = apply(
    `<interfaces xmlns="${MODEL_NAMESPACE}"><interface><name>eth0</name></interface></interfaces>`
);
assert.match(contentMatchOnly, /<name>eth0<\/name><enabled>true<\/enabled><mtu>1500<\/mtu>/u);
assert.doesNotMatch(contentMatchOnly, /<name>eth1<\/name>/u);

const attributeMatch = apply(
    `<interfaces xmlns="${MODEL_NAMESPACE}"><interface role="edge"><mtu/></interface></interfaces>`
);
assert.match(attributeMatch, /<interface role="edge"><name>eth0<\/name><mtu>1500<\/mtu><\/interface>/u);
assert.doesNotMatch(attributeMatch, /<name>eth1<\/name>/u);

const multipleSubtrees = apply(
    `<system xmlns="${MODEL_NAMESPACE}"><hostname/></system>` + `<state xmlns="${MODEL_NAMESPACE}"><uptime/></state>`
);
assert.equal(
    multipleSubtrees,
    `<system xmlns="${MODEL_NAMESPACE}"><hostname>router-a</hostname></system>` +
        `<state xmlns="${MODEL_NAMESPACE}"><uptime>30</uptime></state>`
);

assert.equal(
    apply(
        `<interfaces xmlns="${MODEL_NAMESPACE}"><interface>` + '<name>missing</name><enabled/></interface></interfaces>'
    ),
    ''
);

console.log('NETCONF namespace-aware subtree filter tests passed');
