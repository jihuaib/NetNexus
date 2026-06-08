/**
 * ARP Packet Parser Test
 *
 * Simple test to verify ARP packet parsing functionality
 */

const assert = require('assert');
const { parseArpPacket } = require('../../electron/pktParser/arpPacketParser');

// Create a sample ARP request packet (standard Ethernet/IPv4)
function createArpRequestPacket() {
    const buffer = Buffer.alloc(28);
    let offset = 0;

    // Hardware Type (Ethernet = 1)
    buffer.writeUInt16BE(1, offset);
    offset += 2;

    // Protocol Type (IPv4 = 0x0800)
    buffer.writeUInt16BE(0x0800, offset);
    offset += 2;

    // Hardware Address Length (6 for Ethernet)
    buffer[offset] = 6;
    offset += 1;

    // Protocol Address Length (4 for IPv4)
    buffer[offset] = 4;
    offset += 1;

    // Operation (Request = 1)
    buffer.writeUInt16BE(1, offset);
    offset += 2;

    // Sender Hardware Address (AA:BB:CC:DD:EE:FF)
    buffer.writeUInt8(0xaa, offset++);
    buffer.writeUInt8(0xbb, offset++);
    buffer.writeUInt8(0xcc, offset++);
    buffer.writeUInt8(0xdd, offset++);
    buffer.writeUInt8(0xee, offset++);
    buffer.writeUInt8(0xff, offset++);

    // Sender Protocol Address (192.168.1.100)
    buffer.writeUInt8(192, offset++);
    buffer.writeUInt8(168, offset++);
    buffer.writeUInt8(1, offset++);
    buffer.writeUInt8(100, offset++);

    // Target Hardware Address (00:00:00:00:00:00)
    buffer.writeUInt8(0x00, offset++);
    buffer.writeUInt8(0x00, offset++);
    buffer.writeUInt8(0x00, offset++);
    buffer.writeUInt8(0x00, offset++);
    buffer.writeUInt8(0x00, offset++);
    buffer.writeUInt8(0x00, offset++);

    // Target Protocol Address (192.168.1.1)
    buffer.writeUInt8(192, offset++);
    buffer.writeUInt8(168, offset++);
    buffer.writeUInt8(1, offset++);
    buffer.writeUInt8(1, offset++);

    return buffer;
}

function testArpParsing() {
    const arpPacket = createArpRequestPacket();

    const tree = {
        name: 'Root',
        offset: 0,
        length: arpPacket.length,
        value: '',
        children: []
    };

    const result = parseArpPacket(arpPacket, tree, 0);
    assert.equal(result.valid, true, result.error || 'ARP packet should parse successfully');
    assert.equal(tree.children.length, 1);

    const arpNode = tree.children[0];
    assert.equal(arpNode.name, 'ARP Packet');
    assert.equal(arpNode.offset, 0);
    assert.equal(arpNode.length, 28);

    const fields = Object.fromEntries(arpNode.children.map(child => [child.name, child.value]));
    assert.equal(fields['Hardware Type'], '1 (Ethernet)');
    assert.equal(fields['Protocol Type'], '0x0800 (IPv4)');
    assert.equal(fields['Hardware Address Length'], '6 bytes');
    assert.equal(fields['Protocol Address Length'], '4 bytes');
    assert.equal(fields.Operation, '1 (ARP Request)');
    assert.equal(fields['Sender Hardware Address'], 'AA:BB:CC:DD:EE:FF');
    assert.equal(fields['Sender Protocol Address'], '192.168.1.100');
    assert.equal(fields['Target Hardware Address'], '00:00:00:00:00:00');
    assert.equal(fields['Target Protocol Address'], '192.168.1.1');

    return { result, tree };
}

if (require.main === module) {
    testArpParsing();
    console.log('ARP packet parser tests passed');
}

module.exports = {
    testArpParsing,
    createArpRequestPacket
};
