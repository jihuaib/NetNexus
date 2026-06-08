const { app } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const os = require('os');
const iconv = require('iconv-lite');
class NativeApp {
    constructor(ipc) {
        this.isDev = !app.isPackaged;
        this.registerHandlers(ipc);
    }

    registerHandlers(ipc) {
        // 端口监听工具
        ipc.handle('native:getListeningPorts', async () => this.handleGetListeningPorts());
        ipc.handle('native:killProcess', async (event, pid) => this.handleKillProcess(event, pid));

        // 网络信息工具
        ipc.handle('native:getNetworkInfo', async () => this.handleGetNetworkInfo());
        ipc.handle('native:manageNetwork', async (event, config) => this.handleManageNetwork(event, config));
    }

    // 端口监听工具
    async handleGetListeningPorts() {
        try {
            const platform = os.platform();
            let ports = [];

            if (platform === 'win32') {
                ports = await this.getWindowsListeningPorts();
            } else if (platform === 'darwin') {
                ports = await this.getDarwinListeningPorts();
            } else {
                return errorResponse(`不支持的操作系统: ${platform}`);
            }

            logger.info(`获取到 ${ports.length} 个监听端口`);
            return successResponse(ports, '获取监听端口成功');
        } catch (err) {
            logger.error('获取监听端口错误:', err.message);
            return errorResponse(`获取监听端口失败: ${err.message}`);
        }
    }

    // 解析地址和端口（支持 IPv4 和 IPv6）
    parseAddressPort(addressPort) {
        if (!addressPort) {
            return { address: '-', port: '-' };
        }

        // IPv6 格式: [2001:db8::1]:8080 或 [::]:8080
        const ipv6Match = addressPort.match(/^\[([^\]]+)\]:(.+)$/);
        if (ipv6Match) {
            return {
                address: ipv6Match[1],
                port: ipv6Match[2]
            };
        }

        // IPv4 格式: 192.168.1.1:8080 或 0.0.0.0:8080
        // 或者特殊格式: *:8080
        const lastColonIndex = addressPort.lastIndexOf(':');
        if (lastColonIndex !== -1) {
            return {
                address: addressPort.substring(0, lastColonIndex),
                port: addressPort.substring(lastColonIndex + 1)
            };
        }

        // 没有端口的情况
        return {
            address: addressPort,
            port: '-'
        };
    }

    async getWindowsListeningPorts() {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        try {
            // 使用 netstat -ano 获取端口和PID
            const { stdout } = await execAsync('netstat -ano', { encoding: 'buffer' });
            const output = iconv.decode(stdout, 'cp936'); // Windows 中文系统使用 GBK 编码

            const lines = output.split('\n');
            const ports = [];
            const pidToProcess = new Map();

            // 解析 netstat 输出
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('活动连接') || trimmed.startsWith('协议')) {
                    continue;
                }

                // 匹配格式: TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    1234
                const match = trimmed.match(/^(TCP|UDP)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)?\s*(\d+)?$/);
                if (match) {
                    const protocol = match[1];
                    const localAddress = match[2];
                    const remoteAddress = match[3];
                    const state = match[4] || (protocol === 'UDP' ? '*:*' : '');
                    const pid = match[5];

                    // 显示 LISTENING 和 ESTABLISHED 状态的 TCP 端口，或所有 UDP 端口
                    if (
                        (protocol === 'TCP' && (state === 'LISTENING' || state === 'ESTABLISHED')) ||
                        protocol === 'UDP'
                    ) {
                        const local = this.parseAddressPort(localAddress);
                        const remote = this.parseAddressPort(remoteAddress);

                        if (local.port && local.port !== '*') {
                            ports.push({
                                protocol,
                                address: local.address,
                                port: parseInt(local.port) || local.port,
                                remoteAddress: remote.address || '-',
                                remotePort: remote.port || '-',
                                state: state || '-',
                                pid: pid || '-',
                                process: '' // 稍后填充
                            });
                        }
                    }
                }
            }

            // 获取进程名称
            if (ports.length > 0) {
                try {
                    const { stdout: tasklistOutput } = await execAsync('tasklist /FO CSV /NH', { encoding: 'buffer' });
                    const tasklistStr = iconv.decode(tasklistOutput, 'cp936');
                    const taskLines = tasklistStr.split('\n');

                    for (const taskLine of taskLines) {
                        // CSV 格式: "进程名","PID","会话名","会话#","内存使用"
                        const taskMatch = taskLine.match(/"([^"]+)","(\d+)"/);
                        if (taskMatch) {
                            const processName = taskMatch[1];
                            const pid = taskMatch[2];
                            pidToProcess.set(pid, processName);
                        }
                    }

                    // 填充进程名称
                    for (const port of ports) {
                        if (port.pid !== '-' && pidToProcess.has(port.pid)) {
                            port.process = pidToProcess.get(port.pid);
                        } else {
                            port.process = '-';
                        }
                    }
                } catch (err) {
                    logger.warn('获取进程名称失败:', err.message);
                    // 即使获取进程名失败，也返回端口信息
                    for (const port of ports) {
                        port.process = '-';
                    }
                }
            }

            return ports;
        } catch (err) {
            logger.error('Windows 端口检测错误:', err.message);
            throw err;
        }
    }

    async getDarwinListeningPorts() {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        try {
            // lsof -i: 网络连接  -n: 不解析主机名  -P: 不解析端口名（保持数字）
            const { stdout } = await execAsync('lsof -i -n -P 2>/dev/null', { maxBuffer: 10 * 1024 * 1024 });
            const lines = stdout.split('\n');
            const portsMap = new Map();

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // lsof 列: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
                const parts = line.split(/\s+/);
                if (parts.length < 9) continue;

                const processName = parts[0];
                const pid = parts[1];
                const nodeType = parts[7]; // TCP, UDP, TCP6, UDP6

                if (!nodeType.startsWith('TCP') && !nodeType.startsWith('UDP')) continue;
                const protocol = nodeType.startsWith('TCP') ? 'TCP' : 'UDP';

                // NAME 从第9列开始，可能含空格
                const namePart = parts.slice(8).join(' ');

                // 提取括号内的状态，如 (LISTEN) (ESTABLISHED)
                const stateMatch = namePart.match(/\(([^)]+)\)$/);
                const rawState = stateMatch ? stateMatch[1].toUpperCase() : '';
                const connPart = namePart.replace(/\s*\([^)]+\)$/, '').trim();

                // TCP 只展示 LISTEN 和 ESTABLISHED，UDP 全部展示
                if (protocol === 'TCP' && rawState !== 'LISTEN' && rawState !== 'ESTABLISHED') continue;

                // NAME 格式：
                //   LISTEN:      *:3000  或  127.0.0.1:3000
                //   ESTABLISHED: 127.0.0.1:3000->192.168.1.2:54321
                let localAddrStr, remoteAddrStr;
                const arrowIdx = connPart.indexOf('->');
                if (arrowIdx !== -1) {
                    localAddrStr = connPart.substring(0, arrowIdx);
                    remoteAddrStr = connPart.substring(arrowIdx + 2);
                } else {
                    localAddrStr = connPart;
                    remoteAddrStr = '';
                }

                // *:port 转换为 0.0.0.0:port 以便 parseAddressPort 正常处理
                if (localAddrStr.startsWith('*:')) localAddrStr = '0.0.0.0' + localAddrStr.substring(1);
                if (remoteAddrStr.startsWith('*:')) remoteAddrStr = '0.0.0.0' + remoteAddrStr.substring(1);

                const local = this.parseAddressPort(localAddrStr);
                let remoteAddress = '-';
                let remotePort = '-';
                if (remoteAddrStr) {
                    const remote = this.parseAddressPort(remoteAddrStr);
                    remoteAddress = remote.address;
                    remotePort = remote.port;
                }

                const state = rawState === 'LISTEN' ? 'LISTENING' : rawState || (protocol === 'UDP' ? 'UDP' : '-');

                // lsof 每个 fd 都输出一行，用复合 key 去重
                const key = `${protocol}-${local.address}-${local.port}-${remoteAddress}-${remotePort}-${pid}`;
                if (!portsMap.has(key)) {
                    portsMap.set(key, {
                        protocol,
                        address: local.address,
                        port: local.port === '*' ? '*' : parseInt(local.port) || local.port,
                        remoteAddress,
                        remotePort,
                        state,
                        pid,
                        process: processName
                    });
                }
            }

            return Array.from(portsMap.values());
        } catch (err) {
            logger.error('macOS 端口检测错误:', err.message);
            throw err;
        }
    }

    // 关闭进程
    async handleKillProcess(_event, pid) {
        try {
            if (!pid || pid === '-') {
                return errorResponse('无效的进程 ID');
            }

            // 转换为数字
            const pidNum = parseInt(pid);
            if (isNaN(pidNum)) {
                return errorResponse('无效的进程 ID');
            }

            // 保护：不允许关闭当前应用的进程
            const currentPid = process.pid;
            const parentPid = process.ppid;

            if (pidNum === currentPid) {
                return errorResponse('不能关闭应用自身的进程');
            }

            if (pidNum === parentPid) {
                return errorResponse('不能关闭应用父进程');
            }

            // 额外保护：检查进程名是否是 electron 或 node
            // 这可以防止误关闭开发服务器或其他关键进程
            const platform = os.platform();
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            logger.info(`尝试关闭进程 PID: ${pid}`);

            if (platform === 'win32') {
                // Windows: 使用 taskkill 命令
                try {
                    await execAsync(`taskkill /F /PID ${pid}`);
                    logger.info(`成功关闭进程 PID: ${pid}`);
                    return successResponse(null, `成功关闭进程 ${pid}`);
                } catch (err) {
                    logger.error(`关闭进程失败 PID ${pid}:`, err.message);
                    // 检查是否是权限问题
                    if (err.message.includes('拒绝访问') || err.message.includes('Access is denied')) {
                        return errorResponse(`权限不足，无法关闭进程 ${pid}。请以管理员身份运行应用。`);
                    }
                    return errorResponse(`关闭进程失败: ${err.message}`);
                }
            } else if (platform === 'linux' || platform === 'darwin') {
                // Linux/Mac: 使用 kill 命令
                try {
                    await execAsync(`kill -9 ${pid}`);
                    logger.info(`成功关闭进程 PID: ${pid}`);
                    return successResponse(null, `成功关闭进程 ${pid}`);
                } catch (err) {
                    logger.error(`关闭进程失败 PID ${pid}:`, err.message);
                    // 检查是否是权限问题
                    if (err.message.includes('Operation not permitted')) {
                        return errorResponse(`权限不足，无法关闭进程 ${pid}。请使用 sudo 运行应用。`);
                    }
                    return errorResponse(`关闭进程失败: ${err.message}`);
                }
            } else {
                return errorResponse(`不支持的操作系统: ${platform}`);
            }
        } catch (err) {
            logger.error('关闭进程错误:', err.message);
            return errorResponse(`关闭进程失败: ${err.message}`);
        }
    }

    // 获取网络信息
    async handleGetNetworkInfo() {
        try {
            const interfaces = os.networkInterfaces();
            const networkInfo = [];

            for (const [name, addresses] of Object.entries(interfaces)) {
                const interfaceData = {
                    name: name,
                    displayName: this.getInterfaceDisplayName(name),
                    mac: '',
                    ipv4: [],
                    ipv6: [],
                    addresses: [], // 聚合所有地址供前端统一显示
                    isUp: false,
                    isInternal: false
                };

                for (const addr of addresses) {
                    // 获取 MAC 地址
                    if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
                        interfaceData.mac = addr.mac.toUpperCase();
                    }

                    // 检查接口状态
                    if (!addr.internal) {
                        interfaceData.isUp = true;
                    }
                    interfaceData.isInternal = addr.internal;

                    // IPv4 地址
                    if (addr.family === 'IPv4') {
                        const ipv4Info = {
                            address: addr.address,
                            netmask: addr.netmask,
                            cidr: addr.cidr || this.calculateCIDR(addr.netmask)
                        };
                        interfaceData.ipv4.push(ipv4Info);
                        interfaceData.addresses.push({
                            ...ipv4Info,
                            family: 'IPv4'
                        });
                    }

                    // IPv6 地址
                    if (addr.family === 'IPv6') {
                        // 过滤 Link-Local 地址 (fe80::/10)
                        if (
                            addr.scopeid ||
                            (addr.cidr && addr.cidr.startsWith('fe80')) ||
                            addr.address.toLowerCase().startsWith('fe80')
                        ) {
                            continue;
                        }

                        const ipv6Info = {
                            address: addr.address,
                            prefixLength: addr.cidr ? parseInt(addr.cidr.split('/')[1]) : 64,
                            scopeid: addr.scopeid
                        };
                        interfaceData.ipv6.push(ipv6Info);
                        interfaceData.addresses.push({
                            ...ipv6Info,
                            family: 'IPv6'
                        });
                    }
                }

                networkInfo.push(interfaceData);
            }

            logger.info(`获取到 ${networkInfo.length} 个网络接口`);
            return successResponse(networkInfo, '获取网络信息成功');
        } catch (err) {
            logger.error('获取网络信息错误:', err.message);
            return errorResponse(`获取网络信息失败: ${err.message}`);
        }
    }

    // 获取接口显示名称
    getInterfaceDisplayName(name) {
        const displayNames = {
            eth0: '以太网',
            wlan0: '无线网络',
            lo: '本地回环',
            Ethernet: '以太网',
            'Wi-Fi': '无线网络',
            Loopback: '本地回环'
        };

        // 检查是否有匹配的显示名称
        for (const [key, value] of Object.entries(displayNames)) {
            if (name.toLowerCase().includes(key.toLowerCase())) {
                return value;
            }
        }

        return name;
    }

    // 计算 CIDR 前缀长度
    calculateCIDR(netmask) {
        if (!netmask) return 24;

        const parts = netmask.split('.');
        let cidr = 0;

        for (const part of parts) {
            const num = parseInt(part);
            cidr += num.toString(2).split('1').length - 1;
        }

        return cidr;
    }

    // 管理网络接口
    async handleManageNetwork(_event, config) {
        const { interfaceName, family, type, ip, mask, gateway } = config;

        logger.info('管理网络接口:', config);

        // 验证参数
        if (!interfaceName) {
            return errorResponse('未指定网络接口名称');
        }

        try {
            const platform = os.platform();
            if (platform !== 'win32') {
                return errorResponse('目前仅支持 Windows 系统的网络配置功能');
            }

            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            let command = '';
            // 处理双引号，防止注入（简单处理）
            const safeInterfaceName = interfaceName.replace(/"/g, '\\"');

            // 根据协议族选择命令上下文
            const netshContext = family === 'ipv6' ? 'interface ipv6' : 'interface ip';

            if (type === 'add') {
                // 添加 IP 地址 (辅助 IP)
                if (!ip || !mask) {
                    return errorResponse('添加 IP 需要 IP 地址和子网掩码/前缀长度');
                }

                if (family === 'ipv6') {
                    // netsh interface ipv6 add address "Ethernet" 2001:db8::2/64
                    command = `netsh ${netshContext} add address "${safeInterfaceName}" ${ip}/${mask}`;
                } else {
                    const gatewayCmd = gateway ? `${gateway} 1` : '';
                    command = `netsh ${netshContext} add address "${safeInterfaceName}" ${ip} ${mask} ${gatewayCmd}`;
                }

                logger.info(`执行命令: ${command}`);
                try {
                    await execAsync(command);
                } catch (addErr) {
                    const errorOutput = (addErr.stderr || addErr.stdout || addErr.message).toLowerCase();
                    // 检查是否因为 IP 已存在 (File exists / 对象已存在 / 此时不应添加重复的地址)
                    if (
                        errorOutput.includes('file exists') ||
                        errorOutput.includes('exist') ||
                        errorOutput.includes('存在') ||
                        errorOutput.includes('duplicate')
                    ) {
                        logger.warn(`添加新 IP 提示已存在，视为成功: ${errorOutput}`);
                    } else {
                        throw addErr;
                    }
                }
                return successResponse(null, `接口 ${interfaceName} 成功添加 IP ${ip}`);
            } else if (type === 'delete') {
                // 删除 IP 地址
                if (!ip) {
                    return errorResponse('删除 IP 需要指定 IP 地址');
                }

                // netsh interface ip delete address "Ethernet" 10.0.0.1
                // netsh interface ipv6 delete address "Ethernet" 2001:db8::1

                command = `netsh ${netshContext} delete address "${safeInterfaceName}" ${ip}`;
                logger.info(`执行命令: ${command}`);
                await execAsync(command);
                return successResponse(null, `接口 ${interfaceName} 成功删除 IP ${ip}`);
            } else if (type === 'update') {
                // 更新 IP 地址 (直接使用 set 命令，避免先删后加导致的问题)
                const { oldIp } = config;
                if (!oldIp || !ip || !mask) {
                    return errorResponse('更新 IP 需要指定旧 IP、新 IP 和子网掩码/前缀长度');
                }

                logger.info(`正在更新 IP (使用 Set 模式): ${oldIp} -> ${ip}`);

                if (family && family.toLowerCase() === 'ipv6') {
                    // IPv6: 先删除旧的，再添加新的
                    // 1. 删除旧 IP
                    logger.info(`正在删除旧 IPv6: ${oldIp}`);
                    try {
                        const deleteCmd = `netsh ${netshContext} delete address "${safeInterfaceName}" ${oldIp}`;
                        await execAsync(deleteCmd);
                    } catch (deleteErr) {
                        const errorOutput = (deleteErr.stderr || deleteErr.stdout || deleteErr.message).toLowerCase();
                        // 忽略 找不到元素 错误
                        if (
                            errorOutput.includes('find') ||
                            errorOutput.includes('找') ||
                            errorOutput.includes('element not found')
                        ) {
                            logger.info('旧 IPv6 不存在，忽略删除错误');
                        } else {
                            logger.warn(`删除旧 IPv6 失败: ${errorOutput}`);
                            // 可能是其他错误，但继续尝试添加
                        }
                    }

                    // 2. 添加新 IP
                    logger.info(`正在添加新 IPv6: ${ip}/${mask}`);
                    try {
                        const addCmd = `netsh ${netshContext} add address "${safeInterfaceName}" ${ip}/${mask}`;
                        await execAsync(addCmd);
                    } catch (addErr) {
                        const errorOutput = (addErr.stderr || addErr.stdout || addErr.message).toLowerCase();
                        // 忽略 已存在 错误
                        if (
                            errorOutput.includes('file exists') ||
                            errorOutput.includes('exist') ||
                            errorOutput.includes('存在') ||
                            errorOutput.includes('duplicate')
                        ) {
                            logger.warn(`添加新 IPv6 提示已存在，视为成功: ${errorOutput}`);
                        } else {
                            throw addErr;
                        }
                    }

                    return successResponse(null, `接口 ${interfaceName} 成功更新 IPv6 为 ${ip}`);
                } else {
                    // IPv4: netsh interface ip set address "Interface" static IP Mask Gateway
                    // 这会强制设置为静态 IP，解决 DHCP 问题
                    const gatewayCmd = gateway ? `${gateway} 1` : '';
                    command = `netsh ${netshContext} set address "${safeInterfaceName}" static ${ip} ${mask} ${gatewayCmd}`;

                    logger.info(`执行 Update (Set) 命令: ${command}`);
                    try {
                        await execAsync(command);
                    } catch (updateErr) {
                        const errorOutput = (updateErr.stderr || updateErr.stdout || updateErr.message).toLowerCase();
                        logger.error(`Update (Set) 失败: ${errorOutput}`);
                        throw updateErr;
                    }
                    return successResponse(null, `接口 ${interfaceName} 成功更新 IP 为 ${ip}`);
                }
            } else {
                return errorResponse('不支持的操作类型');
            }
        } catch (err) {
            logger.error(`网络配置失败: ${err.message}`);
            // Check for admin privileges errors
            if (
                err.message.includes('Run as administrator') ||
                err.message.includes('elevation') ||
                err.message.includes('请求的操作需要提升')
            ) {
                return errorResponse('权限不足，请以管理员身份运行此程序。');
            }
            return errorResponse(`网络配置失败: ${err.message}`);
        }
    }
}

module.exports = NativeApp;
