'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const sourcePath = path.join(__dirname, '..', '..', 'src', 'view', 'yang', 'netconfRpcValidation.js');
const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const validationModule = new Module(sourcePath, module);
validationModule.filename = sourcePath;
validationModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
validationModule._compile(transformed, sourcePath);

const { NETCONF_BASE_NAMESPACE, validateNetconfRpc } = validationModule.exports;

const rpc = body => `<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="101">${body}</rpc>`;
const firstError = value => validateNetconfRpc(value).diagnostics[0];

let result = validateNetconfRpc(rpc('<get/>'));
assert.equal(result.valid, true);
assert.equal(result.operation, 'get');
assert.deepEqual(result.diagnostics, []);

result = validateNetconfRpc(`<nc:rpc xmlns:nc="${NETCONF_BASE_NAMESPACE}" message-id="102"><nc:get/></nc:rpc>`);
assert.equal(result.valid, true);
assert.equal(result.operation, 'get');

assert.match(firstError('').message, /不能为空/u);
assert.match(
    firstError(`<!DOCTYPE rpc><rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></rpc>`).message,
    /DOCTYPE/u
);
assert.match(
    firstError(`<!ENTITY x "value"><rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></rpc>`).message,
    /ENTITY/u
);

result = validateNetconfRpc(`\n${rpc('<get><!-- NETNEXUS_REQUIRED: value --></get>')}`);
assert.equal(result.valid, false);
assert.equal(result.diagnostics[0].line, 2);
assert(result.diagnostics[0].index > 0);
assert.equal(result.diagnostics[0].length, 'NETNEXUS_REQUIRED'.length);

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1">\n  <get>\n</rpc>`);
assert.equal(result.valid, false);
assert.equal(result.diagnostics.at(-1).line, 3);
assert.equal(result.diagnostics.at(-1).column, 1);

result = validateNetconfRpc(`<reply xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></reply>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /根元素必须是 rpc/u.test(item.message)));

result = validateNetconfRpc('<rpc xmlns="urn:example:wrong" message-id="1"><get/></rpc>');
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /NETCONF base 命名空间/u.test(item.message)));

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}"><get/></rpc>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /message-id/u.test(item.message)));
assert.equal(result.operation, 'get');

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"></rpc>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /一个操作元素/u.test(item.message)));

const multipleOperationRpc = rpc('<get/><get-config/>');
result = validateNetconfRpc(multipleOperationRpc);
assert.equal(result.valid, false);
const operationError = result.diagnostics.find(item => /一个操作元素/u.test(item.message));
assert(operationError);
assert.equal(operationError.index, multipleOperationRpc.indexOf('get-config'));
assert.equal(operationError.length, 'get-config'.length);

console.log('NETCONF RPC frontend validation tests passed');
