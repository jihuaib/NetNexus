const { successResponse } = require('./common');

const toolsPageApiScript =
    "    window.toolsApi = {\n        generateString: payload => call('tools.generateString', payload),\n        getGenerateStringHistory: () => call('tools.getGenerateStringHistory'),\n        clearGenerateStringHistory: () => call('tools.clearGenerateStringHistory'),\n        parsePacket: payload => call('tools.parsePacket', payload),\n        parsePacketNoSaveHistory: payload => call('tools.parsePacket', payload),\n        getPacketParserHistory: () => call('tools.getPacketParserHistory'),\n        clearPacketParserHistory: () => call('tools.clearPacketParserHistory'),\n        calculateTcpAoMac: payload => call('tools.calculateTcpAoMac', payload),\n        saveTcpAoMacState: state => call('tools.saveTcpAoMacState', state),\n        getTcpAoMacState: () => call('tools.getTcpAoMacState'),\n        sendHttpApiRequest: config => call('tools.sendHttpApiRequest', config),\n        getHttpApiConnections: () => call('tools.getHttpApiConnections'),\n        saveHttpApiConnections: connections => call('tools.saveHttpApiConnections', connections),\n        resetHttpApiConnections: () => call('tools.resetHttpApiConnections')\n    };";

function createToolsPageState() {
    return {
        stringHistory: [],
        packetHistory: [
            {
                startLayer: 2,
                transportProtocol: 'tcp',
                protocolType: 'auto',
                protocolPort: '179',
                packetData: 'ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff 00 13 04'
            }
        ],
        tcpAoState: null,
        httpConnections: [
            {
                id: 'mock-status',
                name: 'Mock Status',
                method: 'GET',
                url: 'https://netnexus.local/api/status',
                headers: [{ enabled: true, key: 'Accept', value: 'application/json' }],
                body: '',
                timeout: 15000
            }
        ]
    };
}

function handlePageCall(controller, method, args) {
    const tools = controller.state.tools;
    if (method === 'tools.getPacketParserHistory') return successResponse(tools.packetHistory);
    if (method === 'tools.clearPacketParserHistory') {
        tools.packetHistory = [];
        return successResponse(null, '历史记录已清空');
    }
    if (method === 'tools.parsePacket') {
        const payload = args[0];
        tools.packetHistory.push(payload);
        return successResponse({
            summary: 'Mock parsed BGP KEEPALIVE',
            tree: [{ name: 'BGP', children: [{ name: 'Type', value: 'KEEPALIVE' }] }]
        });
    }
    if (method === 'tools.getTcpAoMacState') return successResponse(tools.tcpAoState);
    if (method === 'tools.saveTcpAoMacState') {
        tools.tcpAoState = args[0];
        return successResponse(null);
    }
    if (method === 'tools.calculateTcpAoMac') {
        return successResponse({
            ipVersion: 4,
            pseudoHeaderHex: '0a0000010a00000200060014',
            trafficKeyHex: '00112233445566778899aabbccddeeff',
            messageHex: '45000028000040004006',
            mac: '0123456789abcdef0123456789abcdef01234567',
            mac96: '0123456789abcdef01234567',
            macLen: 12
        });
    }
    if (method === 'tools.getHttpApiConnections') return successResponse(tools.httpConnections);
    if (method === 'tools.saveHttpApiConnections') {
        tools.httpConnections = args[0] || [];
        return successResponse(null);
    }
    if (method === 'tools.resetHttpApiConnections') return successResponse(tools.httpConnections);
    if (method === 'tools.sendHttpApiRequest') {
        return successResponse({
            statusCode: 200,
            statusMessage: 'OK',
            durationMs: 3,
            sizeBytes: 41,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: true, source: 'feature-pages-e2e' })
        });
    }
    if (method === 'tools.generateString') return successResponse(['mock-1', 'mock-2']);
    if (method === 'tools.getGenerateStringHistory') return successResponse(tools.stringHistory);
    if (method === 'tools.clearGenerateStringHistory') return successResponse(null);
    return successResponse(null);
}

module.exports = {
    createToolsPageState,
    handlePageCall,
    toolsPageApiScript
};
