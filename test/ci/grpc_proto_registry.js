const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const { ProtoRegistry, ProtoCompileError, normalizeProtoPath } = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'grpc', 'protoRegistry.js')
);
const { GRPC_PROTO_PRESETS, GRPC_METHOD_KIND } = require(
    path.join(__dirname, '..', '..', 'electron', 'const', 'grpcConst.js')
);

const HUAWEI_IFM_PROTO = `syntax = "proto3";
package huawei_ifm;
message Ifm {
  message Interfaces {
    message Interface {
      string ifName = 1;
      uint32 ifIndex = 2;
      message IfDynamicInfo { string ifOperStatus = 1; }
      IfDynamicInfo ifDynamicInfo = 3;
    }
    repeated Interface interface = 1;
  }
  Interfaces interfaces = 1;
}
`;

function withTempDir(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-grpc-proto-'));
    try {
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function resolvePreset(registry, presetId) {
    const preset = GRPC_PROTO_PRESETS.find(item => item.id === presetId);
    assert(preset, `preset ${presetId} must exist`);
    const files = preset.files.map(name => registry.resolveBuiltinFile(name));
    files.forEach((file, index) => assert(file, `builtin ${preset.files[index]} must exist`));
    return { preset, files };
}

function testBuiltinPresetsCompile() {
    const registry = new ProtoRegistry();
    const allFiles = GRPC_PROTO_PRESETS.flatMap(preset => resolvePreset(registry, preset.id).files);
    const catalog = registry.compile({ filePaths: allFiles });

    const serviceNames = catalog.services.map(service => service.fullName);
    for (const preset of GRPC_PROTO_PRESETS) {
        preset.services.forEach(service => assert(serviceNames.includes(service), `${service} must be compiled`));
        preset.decodeRules.forEach(rule => {
            assert(registry.tryLookupType(rule.messageType), `${rule.messageType} must exist for preset rule`);
            if (!rule.targetType.startsWith('@')) {
                assert(registry.tryLookupType(rule.targetType), `${rule.targetType} must exist for preset rule`);
            }
        });
    }

    const dialout = catalog.services.find(service => service.fullName === 'huawei_dialout.gRPCDataservice');
    assert.strictEqual(dialout.methods.length, 1);
    assert.strictEqual(dialout.methods[0].kind, GRPC_METHOD_KIND.BIDI_STREAM);
    assert.strictEqual(dialout.methods[0].path, '/huawei_dialout.gRPCDataservice/dataPublish');

    const gnmi = catalog.services.find(service => service.fullName === 'gnmi.gNMI');
    const kinds = Object.fromEntries(gnmi.methods.map(method => [method.name, method.kind]));
    assert.strictEqual(kinds.Get, GRPC_METHOD_KIND.UNARY);
    assert.strictEqual(kinds.Subscribe, GRPC_METHOD_KIND.BIDI_STREAM);

    const serviceArgs = catalog.messages.find(message => message.fullName === 'huawei_dialout.serviceArgs');
    const dataField = serviceArgs.fields.find(field => field.name === 'data');
    assert.strictEqual(dataField.type, 'bytes');
    assert.strictEqual(dataField.oneof, 'MessageData');
    assert(catalog.summary.fileCount >= 6, 'gnmi_ext import must be resolved via builtin dir');
    console.log('[gRPC proto CI] builtin presets compiled:', catalog.summary);
}

function testNestedDecodeByProtoPath() {
    withTempDir(dir => {
        const ifmPath = path.join(dir, 'huawei-ifm.proto');
        fs.writeFileSync(ifmPath, HUAWEI_IFM_PROTO);

        const registry = new ProtoRegistry();
        const { preset, files } = resolvePreset(registry, 'huawei-dialout');
        registry.compile({ filePaths: [...files, ifmPath] });

        const content = registry.encodeMessage('huawei_ifm.Ifm.Interfaces.Interface', {
            ifName: 'GE0/0/1',
            ifIndex: '3',
            ifDynamicInfo: { ifOperStatus: 'up' }
        });
        const telemetry = registry.encodeMessage('telemetry.Telemetry', {
            node_id_str: 'router-1',
            sensor_path: 'huawei-ifm:ifm/interfaces/interface',
            proto_path: 'huawei_ifm.Ifm.interfaces.interface',
            encoding: 'Encoding_GPB',
            msg_timestamp: '1700000000000',
            data_gpb: { row: [{ timestamp: '1700000000000', content: content.toString('base64') }] }
        });
        const args = registry.encodeMessage('huawei_dialout.serviceArgs', {
            ReqId: '9',
            data: `0x${telemetry.toString('hex')}`
        });

        const decoded = registry.decodeMessage('huawei_dialout.serviceArgs', args, {
            decodeRules: preset.decodeRules,
            maxRawHexBytes: 64
        });
        assert.deepStrictEqual(decoded.warnings, []);
        assert.strictEqual(decoded.value.ReqId, '9');
        assert.strictEqual(decoded.value.MessageData, 'data');
        assert.strictEqual(decoded.value.data.$type, 'telemetry.Telemetry');
        const telemetryValue = decoded.value.data.value;
        assert.strictEqual(telemetryValue.msg_timestamp, '1700000000000', 'uint64 must round-trip as string');
        assert.strictEqual(telemetryValue.encoding, 'Encoding_GPB');
        const row = telemetryValue.data_gpb.row[0];
        assert.strictEqual(row.content.$type, 'huawei_ifm.Ifm.Interfaces.Interface');
        assert.deepStrictEqual(row.content.value, {
            ifName: 'GE0/0/1',
            ifIndex: 3,
            ifDynamicInfo: { ifOperStatus: 'up' }
        });

        const jsonArgs = registry.encodeMessage('huawei_dialout.serviceArgs', {
            ReqId: '10',
            data_json: JSON.stringify({ node_id_str: 'router-1', rows: [1, 2] })
        });
        const jsonDecoded = registry.decodeMessage('huawei_dialout.serviceArgs', jsonArgs, {
            decodeRules: preset.decodeRules
        });
        assert.deepStrictEqual(jsonDecoded.value.data_json, { node_id_str: 'router-1', rows: [1, 2] });

        // 没有配置规则时自动解码：data -> Telemetry（按名称惯例），row.content -> proto_path 定位的业务消息
        const withoutRules = registry.decodeMessage('huawei_dialout.serviceArgs', args, { maxRawHexBytes: 8 });
        assert.strictEqual(withoutRules.value.data.$type, 'telemetry.Telemetry');
        assert.strictEqual(withoutRules.value.data.$auto, true);
        assert.strictEqual(withoutRules.value.data.value.data_gpb.row[0].content.value.ifName, 'GE0/0/1');
        const jsonWithoutRules = registry.decodeMessage('huawei_dialout.serviceArgs', jsonArgs, {});
        assert.deepStrictEqual(
            jsonWithoutRules.value.data_json,
            JSON.stringify({ node_id_str: 'router-1', rows: [1, 2] }),
            'string fields stay text without a rule'
        );
        const opaque = registry.encodeMessage('telemetry.TelemetryRowGPB', {
            timestamp: '1',
            content: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6]).toString('base64')
        });
        const opaqueDecoded = registry.decodeMessage('telemetry.TelemetryRowGPB', opaque, { maxRawHexBytes: 8 });
        assert(
            /^[0-9a-f]{16}\.\.\.\(10 bytes\)$/u.test(opaqueDecoded.value.content),
            'undecodable bytes fall back to hex'
        );

        const template = registry.createTemplate('telemetry.Telemetry');
        assert.strictEqual(template.encoding, 'Encoding_GPB');
        assert.strictEqual(template.msg_timestamp, '0');
        assert(Array.isArray(template.data_gpb.row));
        console.log('[gRPC proto CI] nested decode via proto_path ok');
    });
}

function testProtoPathFallbackWarning() {
    const registry = new ProtoRegistry();
    const { preset, files } = resolvePreset(registry, 'huawei-dialout');
    registry.compile({ filePaths: files });
    const telemetry = registry.encodeMessage('telemetry.Telemetry', {
        proto_path: 'huawei_missing.Missing.rows.row',
        data_gpb: { row: [{ timestamp: '1', content: Buffer.from([0x08, 0x01]).toString('base64') }] }
    });
    const decoded = registry.decodeMessage('telemetry.Telemetry', telemetry, { decodeRules: preset.decodeRules });
    assert.strictEqual(decoded.warnings.length, 1);
    assert(decoded.warnings[0].includes('proto_path'));
    assert.strictEqual(decoded.value.data_gpb.row[0].content, '0801');
    assert.deepStrictEqual(normalizeProtoPath('huawei-ifm:ifm/interfaces/interface'), [
        'huawei_ifm',
        'ifm',
        'interfaces',
        'interface'
    ]);
    console.log('[gRPC proto CI] missing proto_path type keeps raw bytes with warning');
}

function testCompileErrors() {
    withTempDir(dir => {
        const registry = new ProtoRegistry();
        assert.throws(() => registry.compile({ filePaths: [] }), ProtoCompileError);

        const missing = path.join(dir, 'missing.proto');
        assert.throws(
            () => registry.compile({ filePaths: [missing] }),
            error => error instanceof ProtoCompileError && error.file === missing
        );

        const broken = path.join(dir, 'broken.proto');
        fs.writeFileSync(broken, 'syntax = "proto3";\nmessage Broken {\n  strin value = 1;\n}\n');
        assert.throws(
            () => registry.compile({ filePaths: [broken] }),
            error =>
                error instanceof ProtoCompileError && error.file === broken && error.message.startsWith('broken.proto:')
        );
        assert.strictEqual(registry.isCompiled(), false, 'failed compile must not leave a partial registry');

        const importer = path.join(dir, 'importer.proto');
        fs.writeFileSync(
            importer,
            'syntax = "proto3";\nimport "huawei-telemetry.proto";\nmessage Wrapper { telemetry.Telemetry inner = 1; }\n'
        );
        const catalog = registry.compile({ filePaths: [importer] });
        assert(
            catalog.files.some(file => file.name === 'huawei-telemetry.proto'),
            'imports must resolve from the builtin proto dir'
        );

        assert.throws(() => registry.encodeMessage('telemetry.Telemetry', { node_id_str: 42 }), /校验失败/u);
        console.log('[gRPC proto CI] compile error reporting ok');
    });
}

function testServiceDefinitionRoundTrip() {
    const registry = new ProtoRegistry();
    const { files } = resolvePreset(registry, 'gnmi');
    registry.compile({ filePaths: files });
    const { definition, serviceFullName } = registry.buildServiceDefinition('gnmi.gNMI');
    assert.strictEqual(serviceFullName, 'gnmi.gNMI');
    const get = definition.Get;
    assert.strictEqual(get.path, '/gnmi.gNMI/Get');
    assert.strictEqual(get.requestStream, false);
    const buffer = get.requestSerialize({ path: [{ elem: [{ name: 'interfaces' }] }], type: 'STATE' });
    const { raw, message } = get.requestDeserialize(buffer);
    assert(Buffer.isBuffer(raw));
    const decoded = registry.decodeMessage('gnmi.GetRequest', message).value;
    assert.strictEqual(decoded.type, 'STATE');
    assert.strictEqual(decoded.path[0].elem[0].name, 'interfaces');
    assert.strictEqual(get.requestSerialize(buffer), buffer, 'pre-encoded buffers pass through');
    console.log('[gRPC proto CI] service definition round trip ok');
}

testBuiltinPresetsCompile();
testNestedDecodeByProtoPath();
testProtoPathFallbackWarning();
testCompileErrors();
testServiceDefinitionRoundTrip();
console.log('gRPC proto registry test passed');
