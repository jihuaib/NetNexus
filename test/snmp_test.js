/**
 * SNMP Trap 测试脚本
 * 使用方法: node test/snmp_test.js [target_ip] [target_port] [bulk_varbind_count]
 *
 * 示例:
 * node test/snmp_test.js 127.0.0.1 162
 * node test/snmp_test.js 127.0.0.1 10162
 * node test/snmp_test.js 127.0.0.1 10162 80
 */

const snmp = require('net-snmp');

const DEFAULT_TARGET_IP = '127.0.0.1';
const DEFAULT_TARGET_PORT = 162;
const COMMUNITY = 'public';
const TEST_TRAP_OID = '1.3.6.1.4.1.9999.1.1.1';

const targetIp = process.argv[2] || DEFAULT_TARGET_IP;
const targetPort = Number(process.argv[3]) || DEFAULT_TARGET_PORT;
const bulkVarbindCount = Math.min(Math.max(Number(process.argv[4]) || 0, 0), 500);

console.log('SNMP Trap 测试脚本');
console.log(`目标地址: ${targetIp}:${targetPort}`);
console.log(`Community: ${COMMUNITY}`);
console.log(`大量变量绑定: ${bulkVarbindCount > 0 ? `${bulkVarbindCount} 个` : '不发送'}`);
console.log('-----------------------------------');

const createSession = version =>
    snmp.createSession(targetIp, COMMUNITY, {
        version,
        trapPort: targetPort,
        transport: targetIp.includes(':') ? 'udp6' : 'udp4',
        retries: 0,
        timeout: 1000
    });

const closeSession = session => {
    try {
        session.close();
    } catch (error) {
        // net-snmp may already have closed the underlying socket after a send error.
    }
};

const sendTrap = (versionName, version, trapOid, varbinds, options = {}) =>
    new Promise((resolve, reject) => {
        const session = createSession(version);
        session.trap(trapOid, varbinds, options, error => {
            closeSession(session);
            if (error) {
                reject(error);
                return;
            }

            console.log(`✓ 发送${versionName} Trap成功`);
            resolve();
        });
    });

const createV1Varbinds = () => [
    {
        oid: '1.3.6.1.4.1.9999.1.1.1',
        type: snmp.ObjectType.OctetString,
        value: 'Test SNMPv1 Trap'
    }
];

const createV2cVarbinds = () => [
    {
        oid: '1.3.6.1.4.1.9999.1.1.2',
        type: snmp.ObjectType.OctetString,
        value: 'Test SNMPv2c Trap'
    }
];

const createBulkVarbinds = count =>
    Array.from({ length: count }, (_, index) => ({
        oid: `1.3.6.1.4.1.9999.1.2.${index + 1}`,
        type: snmp.ObjectType.OctetString,
        value: `Bulk varbind ${String(index + 1).padStart(3, '0')} - Trap detail scroll test`
    }));

async function main() {
    try {
        console.log('开始发送测试Trap...\n');

        console.log('1. 发送SNMPv1 Trap');
        await sendTrap('SNMPv1', snmp.Version1, TEST_TRAP_OID, createV1Varbinds(), {
            agentAddr: targetIp.includes(':') ? '127.0.0.1' : targetIp,
            upTime: 12345
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        console.log('\n2. 发送SNMPv2c Trap');
        await sendTrap('SNMPv2c', snmp.Version2c, TEST_TRAP_OID, createV2cVarbinds(), {
            upTime: 12345
        });

        if (bulkVarbindCount > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            console.log(`\n3. 发送SNMPv2c 大量变量绑定Trap (${bulkVarbindCount} 个自定义变量)`);
            await sendTrap('SNMPv2c Bulk', snmp.Version2c, TEST_TRAP_OID, createBulkVarbinds(bulkVarbindCount), {
                upTime: 12345
            });
        }

        console.log('\n-----------------------------------');
        console.log('✓ 所有测试Trap发送完成');
        console.log('请检查 NetNexus 的 SNMP Trap 监控页面');
        console.log('如果页面没有记录，请确认 SNMP 服务已启动、Community匹配、目标端口与配置一致');
    } catch (error) {
        console.error('\n❌ 测试失败:', error.message);
        process.exit(1);
    }
}

main();
