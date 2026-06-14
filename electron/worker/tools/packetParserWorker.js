const { parentPort } = require('worker_threads');
const { parseBgpPacket } = require('../../pktParser/bgpPacketParser');
const registry = require('../../pktParser/packetParserRegistry');
const { hexStringToBuffer } = require('../../utils/commonUtils');
const { PROTOCOL_TYPE, START_LAYER, TRANSPORT_PROTOCOL } = require('../../const/toolsConst');

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
        let customBgpPort = null;
        if (data.protocolType === PROTOCOL_TYPE.BGP) {
            if (data.protocolPort && data.protocolPort !== '') {
                customBgpPort = parseInt(data.protocolPort);
                // 注册BGP解析器到指定端口，第四个参数为true表明这是一个应用层协议
                registry.registerParser('bgp', customBgpPort, parseBgpPacket, true);
            } else {
                // 使用默认BGP端口
                customBgpPort = 179;
                registry.registerParser('bgp', customBgpPort, parseBgpPacket, true);
            }
        } else {
            customBgpPort = 179;
            registry.registerParser('bgp', customBgpPort, parseBgpPacket, true);
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

                        result = registry.parse('bgp', customBgpPort, tree, buffer, 0);
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
            if (customBgpPort) {
                registry.unregisterParser('bgp', customBgpPort);
            }
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
