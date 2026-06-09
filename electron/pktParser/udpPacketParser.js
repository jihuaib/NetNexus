/**
 * UDP Packet Parser
 *
 * Parses UDP protocol packets from raw buffers and returns structured data.
 */

const registry = require('./registryInstance');

/**
 * Parse a UDP packet into a tree structure
 * @param {Buffer} buffer - The raw UDP packet buffer
 * @param {Object} tree - The tree structure to add UDP information to
 * @param {number} offset - Starting offset in the buffer
 * @returns {Object} Parse result with valid flag, payload info, and tree structure
 */
function parseUdpPacket(buffer, tree, offset = 0) {
    try {
        // Check if buffer is valid
        if (!Buffer.isBuffer(buffer) || buffer.length < offset + 8) {
            // UDP header length
            return {
                valid: false,
                error: 'Invalid buffer or buffer too small'
            };
        }

        let curOffset = offset;

        // Parse UDP Header
        const headerNode = {
            name: 'UDP Header',
            offset: curOffset,
            length: 8,
            value: '',
            children: []
        };
        tree.children.push(headerNode);

        // Source Port
        const sourcePort = buffer.readUInt16BE(curOffset);
        const sourcePortNode = {
            name: 'Source Port',
            offset: curOffset,
            length: 2,
            value: sourcePort,
            children: []
        };
        curOffset += 2;
        headerNode.children.push(sourcePortNode);

        // Destination Port
        const destPort = buffer.readUInt16BE(curOffset);
        const destPortNode = {
            name: 'Destination Port',
            offset: curOffset,
            length: 2,
            value: destPort,
            children: []
        };
        curOffset += 2;
        headerNode.children.push(destPortNode);

        // Length
        const length = buffer.readUInt16BE(curOffset);
        const lengthNode = {
            name: 'Length',
            offset: curOffset,
            length: 2,
            value: length,
            children: []
        };
        curOffset += 2;
        headerNode.children.push(lengthNode);

        // Checksum
        const checksum = buffer.readUInt16BE(curOffset);
        const checksumNode = {
            name: 'Checksum',
            offset: curOffset,
            length: 2,
            value: `0x${checksum.toString(16).padStart(4, '0')}`,
            children: []
        };
        curOffset += 2;
        headerNode.children.push(checksumNode);

        // Parse Payload
        let payload = null;
        if (buffer.length > offset + 8) {
            let nextLayer = null;
            let type = null;

            if (registry.hasProtocolForPort(sourcePort)) {
                nextLayer = registry.getProtocolByPort(sourcePort);
                type = sourcePort;
            } else if (registry.hasProtocolForPort(destPort)) {
                nextLayer = registry.getProtocolByPort(destPort);
                type = destPort;
            }

            payload = {
                name: 'Payload',
                offset: curOffset,
                length: buffer.length - curOffset,
                value: '',
                children: [],
                nextLayer: nextLayer,
                type: type
            };
        }

        return {
            valid: true,
            payload
        };
    } catch (error) {
        return {
            valid: false,
            error: `Error parsing UDP packet: ${error.message}`
        };
    }
}

module.exports = {
    parseUdpPacket
};
