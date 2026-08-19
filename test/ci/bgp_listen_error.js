const assert = require('node:assert/strict');
const { formatBgpListenError } = require('../../electron/worker/bgp/bgpWorker');

assert.equal(
    formatBgpListenError({ code: 'EACCES', message: 'permission denied' }, 179, 'linux'),
    'BGP监听端口179权限不足；请安装正式Linux .deb，或为当前Electron可执行文件配置CAP_NET_BIND_SERVICE'
);
assert.equal(
    formatBgpListenError({ code: 'EPERM', message: 'operation not permitted' }, 179, 'linux'),
    'BGP监听端口179权限不足；请安装正式Linux .deb，或为当前Electron可执行文件配置CAP_NET_BIND_SERVICE'
);
assert.equal(
    formatBgpListenError({ code: 'EADDRINUSE', message: 'address in use' }, 179, 'linux'),
    'BGP监听端口179已被其他进程占用'
);
assert.equal(
    formatBgpListenError({ code: 'EACCES', message: 'permission denied' }, 179, 'win32'),
    'BGP协议启动失败: permission denied'
);

console.log('BGP listen error tests passed');
