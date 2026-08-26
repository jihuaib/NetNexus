#!/usr/bin/env node
/**
 * 模拟网络设备通过 gRPC Dial-out 向 NetNexus gRPC 服务器上报 Telemetry。
 *
 * 覆盖场景：
 *   1. 华为 gRPCDataservice.dataPublish 双向流，GPB 编码（Telemetry 头 + 行内容）
 *   2. 华为 dataPublish，JSON 编码（data_json）
 *   3. Cisco gRPCMdtDialout.MdtDialout 双向流，GPB-KV 编码
 *   4. 持续周期上报，并打印服务端在同一条流上下发的消息
 *
 * 使用前请在 NetNexus 的「gRPC服务器 → Proto编译」页导入 resources/grpc/protos 下对应的模板并编译，
 * 然后在「gRPC服务器」页勾选服务并启动。
 *
 * 使用方法：
 *   node scripts/mockGrpcDialout.js [选项]
 *
 * 选项：
 *   --host <ip>        gRPC 服务器地址，默认 127.0.0.1
 *   --port <n>         gRPC 服务器端口，默认 57400
 *   --vendor <name>    huawei | cisco，默认 huawei
 *   --encoding <enc>   gpb | json（仅华为），默认 gpb
 *   --interval <ms>    上报间隔，默认 5000；0 表示只发一次
 *   --count <n>        上报次数，默认 0（不限，Ctrl+C 结束）
 *   --node <id>        设备名，默认 mock-router
 *   --username <u>     metadata username，默认 admin
 *   --password <p>     metadata password，默认 admin
 *
 * 示例：
 *   node scripts/mockGrpcDialout.js --port 57400
 *   node scripts/mockGrpcDialout.js --vendor huawei --encoding json --interval 2000
 *   node scripts/mockGrpcDialout.js --vendor cisco --count 3
 */

'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const { ProtoRegistry } = require('../electron/worker/grpc/protoRegistry');

function parseArgs(argv) {
    const options = {
        host: '127.0.0.1',
        port: 57400,
        vendor: 'huawei',
        encoding: 'gpb',
        interval: 5000,
        count: 0,
        node: 'mock-router',
        username: 'admin',
        password: 'admin'
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            i += 1;
            return argv[i];
        };
        switch (arg) {
            case '--host':
                options.host = next();
                break;
            case '--port':
                options.port = Number(next());
                break;
            case '--vendor':
                options.vendor = String(next()).toLowerCase();
                break;
            case '--encoding':
                options.encoding = String(next()).toLowerCase();
                break;
            case '--interval':
                options.interval = Number(next());
                break;
            case '--count':
                options.count = Number(next());
                break;
            case '--node':
                options.node = next();
                break;
            case '--username':
                options.username = next();
                break;
            case '--password':
                options.password = next();
                break;
            case '--help':
            case '-h':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default:
                console.error(`未知参数: ${arg}`);
                process.exit(1);
        }
    }
    return options;
}

const HUAWEI_IFM_PROTO = `syntax = "proto3";
package huawei_ifm;
message Ifm {
  message Interfaces {
    message Interface {
      string ifName = 1;
      uint32 ifIndex = 2;
      message IfDynamicInfo {
        string ifOperStatus = 1;
        string ifPhyStatus = 2;
      }
      IfDynamicInfo ifDynamicInfo = 3;
      message IfStatistics {
        uint64 receiveByte = 1;
        uint64 sendByte = 2;
        uint64 receivePacket = 3;
        uint64 sendPacket = 4;
      }
      IfStatistics ifStatistics = 4;
    }
    repeated Interface interface = 1;
  }
  Interfaces interfaces = 1;
}
`;

function buildRegistry(vendor) {
    const registry = new ProtoRegistry();
    const files =
        vendor === 'cisco'
            ? ['cisco-mdt-grpc-dialout.proto', 'cisco-telemetry.proto']
            : ['huawei-grpc-dialout.proto', 'huawei-telemetry.proto'];
    const filePaths = files.map(name => registry.resolveBuiltinFile(name));
    if (vendor !== 'cisco') {
        const fs = require('fs');
        const os = require('os');
        const tmp = path.join(os.tmpdir(), 'netnexus-mock-huawei-ifm.proto');
        fs.writeFileSync(tmp, HUAWEI_IFM_PROTO);
        filePaths.push(tmp);
    }
    registry.compile({ filePaths });
    return registry;
}

let counter = 0;

function huaweiPayload(registry, options) {
    counter += 1;
    const now = Date.now();
    const interfaces = ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'LoopBack0'].map((name, index) => ({
        ifName: name,
        ifIndex: index + 1,
        ifDynamicInfo: { ifOperStatus: index === 1 && counter % 4 === 0 ? 'down' : 'up', ifPhyStatus: 'up' },
        ifStatistics: {
            receiveByte: String(1000 * counter + index),
            sendByte: String(800 * counter + index),
            receivePacket: String(10 * counter),
            sendPacket: String(8 * counter)
        }
    }));

    if (options.encoding === 'json') {
        const telemetryJson = {
            node_id_str: options.node,
            subscription_id_str: 'sub-ifm',
            sensor_path: 'huawei-ifm:ifm/interfaces/interface',
            collection_id: counter,
            msg_timestamp: now,
            encoding: 'Encoding_JSON',
            data_gpb: { row: interfaces.map(item => ({ timestamp: now, content: item })) }
        };
        return registry.encodeMessage('huawei_dialout.serviceArgs', {
            ReqId: String(counter),
            data_json: JSON.stringify(telemetryJson)
        });
    }

    const rows = interfaces.map(item => ({
        timestamp: String(now),
        content: registry.encodeMessage('huawei_ifm.Ifm.Interfaces.Interface', item).toString('base64')
    }));
    const telemetry = registry.encodeMessage('telemetry.Telemetry', {
        node_id_str: options.node,
        subscription_id_str: 'sub-ifm',
        sensor_path: 'huawei-ifm:ifm/interfaces/interface',
        proto_path: 'huawei_ifm.Ifm.interfaces.interface',
        collection_id: String(counter),
        collection_start_time: String(now - 10),
        msg_timestamp: String(now),
        collection_end_time: Math.floor(now / 1000),
        current_period: Math.max(1, Math.floor(options.interval / 1000)),
        product_name: 'NetNexus-Mock',
        encoding: 'Encoding_GPB',
        software_version: '1.0.0',
        data_gpb: { row: rows }
    });
    return registry.encodeMessage('huawei_dialout.serviceArgs', {
        ReqId: String(counter),
        data: telemetry.toString('base64')
    });
}

function ciscoPayload(registry, options) {
    counter += 1;
    const now = Date.now();
    const telemetry = registry.encodeMessage('cisco_telemetry.Telemetry', {
        node_id_str: options.node,
        subscription_id_str: 'sub-ifstats',
        encoding_path: 'Cisco-IOS-XR-infra-statsd-oper:infra-statistics/interfaces/interface/latest/generic-counters',
        collection_id: String(counter),
        collection_start_time: String(now - 10),
        msg_timestamp: String(now),
        collection_end_time: String(now),
        data_gpbkv: [
            {
                timestamp: String(now),
                fields: [
                    {
                        name: 'keys',
                        fields: [{ name: 'interface-name', string_value: 'GigabitEthernet0/0/0/0' }]
                    },
                    {
                        name: 'content',
                        fields: [
                            { name: 'packets-received', uint64_value: String(100 * counter) },
                            { name: 'bytes-received', uint64_value: String(6400 * counter) },
                            { name: 'packets-sent', uint64_value: String(90 * counter) },
                            { name: 'input-errors', uint32_value: counter % 5 === 0 ? 1 : 0 }
                        ]
                    }
                ]
            }
        ]
    });
    return registry.encodeMessage('mdt_dialout.MdtDialoutArgs', {
        ReqId: String(counter),
        data: telemetry.toString('base64')
    });
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const registry = buildRegistry(options.vendor);
    const serviceName = options.vendor === 'cisco' ? 'mdt_dialout.gRPCMdtDialout' : 'huawei_dialout.gRPCDataservice';
    const methodName = options.vendor === 'cisco' ? 'MdtDialout' : 'dataPublish';
    const { definition } = registry.buildServiceDefinition(serviceName);
    const method = definition[methodName];
    const buildPayload = options.vendor === 'cisco' ? ciscoPayload : huaweiPayload;

    const target = `${options.host}:${options.port}`;
    const client = new grpc.Client(target, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata();
    metadata.add('username', options.username);
    metadata.add('password', options.password);

    console.log(`[mock ${options.vendor}] 连接 ${target}，方法 ${method.path}，编码 ${options.encoding}`);
    const call = client.makeBidiStreamRequest(
        method.path,
        value => method.requestSerialize(value),
        buffer => method.responseDeserialize(buffer),
        metadata
    );

    call.on('data', response => {
        const decoded = registry.decodeMessage(
            options.vendor === 'cisco' ? 'mdt_dialout.MdtDialoutArgs' : 'huawei_dialout.serviceArgs',
            response.message
        ).value;
        console.log(`[mock ${options.vendor}] 收到服务端下发: ${JSON.stringify(decoded)}`);
    });
    call.on('error', error => {
        console.error(`[mock ${options.vendor}] 流错误: ${error.message}`);
    });
    call.on('status', status => {
        console.log(`[mock ${options.vendor}] 流结束: ${grpc.status[status.code]} ${status.details || ''}`);
        client.close();
        process.exit(status.code === grpc.status.OK ? 0 : 1);
    });

    let sent = 0;
    const sendOnce = () => {
        const buffer = buildPayload(registry, options);
        call.write(buffer);
        sent += 1;
        console.log(`[mock ${options.vendor}] 已上报 #${sent} (${buffer.length} bytes)`);
        if ((options.count > 0 && sent >= options.count) || options.interval <= 0) {
            setTimeout(() => call.end(), 300);
            return;
        }
        setTimeout(sendOnce, options.interval);
    };

    sendOnce();
    process.on('SIGINT', () => {
        console.log(`[mock ${options.vendor}] 结束发送`);
        call.end();
    });
}

main();
