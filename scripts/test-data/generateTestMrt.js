const fs = require('fs');
const path = require('path');

/**
 * 生成一个小型的 MRT TABLE_DUMP 测试文件
 * 包含少量 BGP 路由用于测试
 */

// MRT 消息类型
const MRT_TYPE_TABLE_DUMP = 12;

// BGP 属性类型
const BGP_ATTR_ORIGIN = 1;
const BGP_ATTR_AS_PATH = 2;
const BGP_ATTR_NEXT_HOP = 3;

function writeUInt32BE(value) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(value, 0);
    return buf;
}

function writeUInt16BE(value) {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUInt16BE(value, 0);
    return buf;
}

function writeUInt8(value) {
    const buf = Buffer.allocUnsafe(1);
    buf.writeUInt8(value, 0);
    return buf;
}

function ipToBytes(ip) {
    return Buffer.from(ip.split('.').map(x => parseInt(x)));
}

function ipv6ToBytes(ipv6) {
    // Simple IPv6 to bytes conversion for test data
    const parts = ipv6.split(':');
    const bytes = [];
    for (const part of parts) {
        const value = parseInt(part, 16);
        bytes.push((value >> 8) & 0xff);
        bytes.push(value & 0xff);
    }
    return Buffer.from(bytes);
}

function buildPathAttribute(typeCode, value) {
    const flags = 0x40; // Transitive
    const header = Buffer.concat([writeUInt8(flags), writeUInt8(typeCode), writeUInt8(value.length)]);
    return Buffer.concat([header, value]);
}

function buildAsPath(asns) {
    // AS_SEQUENCE type
    const segmentType = writeUInt8(2);
    const segmentLength = writeUInt8(asns.length);
    const asNumbers = Buffer.concat(asns.map(asn => writeUInt16BE(asn)));
    return Buffer.concat([segmentType, segmentLength, asNumbers]);
}

function buildTableDumpEntry(
    prefix,
    prefixLen,
    status,
    originatedTime,
    peerIp,
    peerAs,
    originAs,
    nextHop,
    asPath,
    isIPv6 = false
) {
    const viewNumber = writeUInt16BE(0);
    const sequenceNumber = writeUInt16BE(0);
    const prefixBytes = isIPv6 ? ipv6ToBytes(prefix) : ipToBytes(prefix);
    const prefixLenByte = writeUInt8(prefixLen);
    const statusByte = writeUInt8(status);
    const originatedTimeBytes = writeUInt32BE(originatedTime);
    const peerIpBytes = isIPv6 ? ipv6ToBytes(peerIp) : ipToBytes(peerIp);
    const peerAsBytes = writeUInt16BE(peerAs);

    // 构建路径属性
    const originAttr = buildPathAttribute(BGP_ATTR_ORIGIN, writeUInt8(0)); // IGP
    const asPathValue = buildAsPath(asPath);
    const asPathAttr = buildPathAttribute(BGP_ATTR_AS_PATH, asPathValue);
    const nextHopAttr = buildPathAttribute(BGP_ATTR_NEXT_HOP, isIPv6 ? ipv6ToBytes(nextHop) : ipToBytes(nextHop));

    const attributes = Buffer.concat([originAttr, asPathAttr, nextHopAttr]);
    const attributeLength = writeUInt16BE(attributes.length);

    return Buffer.concat([
        viewNumber,
        sequenceNumber,
        prefixBytes,
        prefixLenByte,
        statusByte,
        originatedTimeBytes,
        peerIpBytes,
        peerAsBytes,
        attributeLength,
        attributes
    ]);
}

function buildMrtMessage(type, subtype, timestamp, data) {
    const header = Buffer.concat([
        writeUInt32BE(timestamp),
        writeUInt16BE(type),
        writeUInt16BE(subtype),
        writeUInt32BE(data.length)
    ]);
    return Buffer.concat([header, data]);
}

// 生成测试路由
function generateTestRoutes() {
    const routes = [];
    const timestamp = Math.floor(Date.now() / 1000);

    // 生成 50 条 IPv4 测试路由
    for (let i = 0; i < 50; i++) {
        const prefix = `10.${Math.floor(i / 256)}.${i % 256}.0`;
        const prefixLen = 24;
        const peerIp = '192.168.1.1';
        const peerAs = 65000;
        const nextHop = '192.168.1.1';

        const pathLength = 2 + (i % 4);
        const asPath = [peerAs];
        for (let j = 1; j < pathLength; j++) {
            asPath.push(65001 + i * 10 + j);
        }

        const entry = buildTableDumpEntry(
            prefix,
            prefixLen,
            1,
            timestamp,
            peerIp,
            peerAs,
            asPath[asPath.length - 1],
            nextHop,
            asPath,
            false
        );

        const message = buildMrtMessage(MRT_TYPE_TABLE_DUMP, 1, timestamp, entry); // subtype 1 = IPv4
        routes.push(message);
    }

    // 生成 50 条 IPv6 测试路由
    for (let i = 0; i < 50; i++) {
        const prefix = `2001:db8:${i.toString(16)}:0:0:0:0:0`;
        const prefixLen = 64;
        const peerIp = '2001:db8:ffff:0:0:0:0:1';
        const peerAs = 65000;
        const nextHop = '2001:db8:ffff:0:0:0:0:1';

        const pathLength = 2 + (i % 4);
        const asPath = [peerAs];
        for (let j = 1; j < pathLength; j++) {
            asPath.push(65001 + i * 10 + j);
        }

        const entry = buildTableDumpEntry(
            prefix,
            prefixLen,
            1,
            timestamp,
            peerIp,
            peerAs,
            asPath[asPath.length - 1],
            nextHop,
            asPath,
            true
        );

        const message = buildMrtMessage(MRT_TYPE_TABLE_DUMP, 2, timestamp, entry); // subtype 2 = IPv6
        routes.push(message);
    }

    return Buffer.concat(routes);
}

// 主函数
function main() {
    const outputDir = __dirname;

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFile = path.join(outputDir, 'test_routes_100.mrt');

    console.log('正在生成测试 MRT 文件...');
    const data = generateTestRoutes();

    fs.writeFileSync(outputFile, data);

    const stats = fs.statSync(outputFile);
    console.log(`✓ 成功生成测试文件: ${outputFile}`);
    console.log(`  文件大小: ${(stats.size / 1024).toFixed(2)} KB`);
    console.log(`  包含路由: 100 条 (50 IPv4 + 50 IPv6)`);
}

main();
