const { parentPort } = require('worker_threads');
const { parseBgpPacket } = require('../../pktParser/bgpPacketParser');
const { parseBmpPacket } = require('../../pktParser/bmpPacketParser');
const registry = require('../../pktParser/packetParserRegistry');
const { hexStringToBuffer } = require('../../utils/commonUtils');
const { PROTOCOL_TYPE, START_LAYER, TRANSPORT_PROTOCOL } = require('../../const/toolsConst');

const DEFAULT_BGP_PORT = 179;
const DEFAULT_BMP_PORT = 1790;

// 处理传入的消息
parentPort.on('message', data => {
    try {
        // 转换十六进制字符串为Buffer
        const buffer = hexStringToBuffer(data.packetData);

        let result = {
            valid: false,
            error: '不支持的报文类型或解析层级'
        };

        // 如果提供了协议端口，先注册端口解析器
        const registeredParsers = [];
        const registerProtocolParser = (layer, port, parser) => {
            registry.registerParser(layer, port, parser, true);
            registeredParsers.push({ layer, port });
        };
        let customProtocolPort = null;
        if (data.protocolType === PROTOCOL_TYPE.BGP) {
            if (data.protocolPort && data.protocolPort !== '') {
                customProtocolPort = parseInt(data.protocolPort);
                // 注册BGP解析器到指定端口，第四个参数为true表明这是一个应用层协议
                registerProtocolParser('bgp', customProtocolPort, parseBgpPacket);
            } else {
                // 使用默认BGP端口
                customProtocolPort = DEFAULT_BGP_PORT;
                registerProtocolParser('bgp', customProtocolPort, parseBgpPacket);
            }
        } else if (data.protocolType === PROTOCOL_TYPE.BMP) {
            customProtocolPort =
                data.protocolPort && data.protocolPort !== '' ? parseInt(data.protocolPort) : DEFAULT_BMP_PORT;
            registerProtocolParser('bmp', customProtocolPort, parseBmpPacket);
        } else {
            customProtocolPort = DEFAULT_BGP_PORT;
            registerProtocolParser('bgp', DEFAULT_BGP_PORT, parseBgpPacket);
            registerProtocolParser('bmp', DEFAULT_BMP_PORT, parseBmpPacket);
        }

        let tree = null;

        try {
            switch (data.startLayer) {
                case START_LAYER.L5: {
                    // 直接解析应用层协议
                    if (data.protocolType === PROTOCOL_TYPE.BGP) {
                        // 解析BGP报文
                        tree = {
                            name: 'Packet ' + buffer.length + ' bytes',
                            offset: 0,
                            length: buffer.length,
                            value: '',
                            children: []
                        };

                        result = registry.parse('bgp', customProtocolPort, tree, buffer, 0);
                    } else if (data.protocolType === PROTOCOL_TYPE.BMP) {
                        tree = {
                            name: 'Packet ' + buffer.length + ' bytes',
                            offset: 0,
                            length: buffer.length,
                            value: '',
                            children: []
                        };

                        result = registry.parse('bmp', customProtocolPort, tree, buffer, 0);
                    }
                    break;
                }
                case START_LAYER.L2: {
                    // 从数据链路层开始解析 (以太网)
                    tree = {
                        name: `Ethernet Frame ${buffer.length} bytes`,
                        offset: 0,
                        length: buffer.length,
                        value: '',
                        children: []
                    };
                    result = registry.parse('ethernet', 0, tree, buffer, 0);
                    break;
                }
                case START_LAYER.L3: {
                    // 从网络层开始解析 (IP)
                    // 判断IP版本: 第一个字节的高4位是版本号
                    const ipVersion = (buffer[0] >> 4) & 0x0f;
                    tree = {
                        name: `Packet ${buffer.length} bytes`,
                        offset: 0,
                        length: buffer.length,
                        value: '',
                        children: []
                    };

                    // 根据IP版本选择解析器
                    const ipType = ipVersion === 6 ? 0x86dd : 0x0800; // IPv6 or IPv4
                    result = registry.parse('ip', ipType, tree, buffer, 0);
                    break;
                }
                case START_LAYER.L4: {
                    const transportProtocol = data.transportProtocol || TRANSPORT_PROTOCOL.TCP;
                    const isUdp = transportProtocol === TRANSPORT_PROTOCOL.UDP;
                    tree = {
                        name: `${isUdp ? 'UDP Datagram' : 'TCP Segment'} ${buffer.length} bytes`,
                        offset: 0,
                        length: buffer.length,
                        value: '',
                        children: []
                    };
                    result = isUdp
                        ? registry.parse('udp', TRANSPORT_PROTOCOL.UDP, tree, buffer, 0)
                        : registry.parse('tcp', TRANSPORT_PROTOCOL.TCP, tree, buffer, 0);
                    break;
                }
                default:
                    result = {
                        valid: false,
                        error: `不支持的起始层级: ${data.startLayer}`
                    };
            }
        } finally {
            // 清理注册的解析器，防止影响后续解析
            registeredParsers.forEach(({ layer, port }) => registry.unregisterParser(layer, port));
        }

        if (result.valid) {
            parentPort.postMessage({
                status: 'success',
                data: { tree }
            });
        } else {
            parentPort.postMessage({
                status: 'error',
                msg: result.error
            });
        }
    } catch (err) {
        parentPort.postMessage({
            status: 'error',
            msg: `解析报文时出错: ${err.message}`
        });
    }
});
