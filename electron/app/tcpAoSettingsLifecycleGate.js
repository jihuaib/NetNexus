class TcpAoSettingsLifecycleGate {
    constructor() {
        this.queue = Promise.resolve();
    }

    runExclusive(operation) {
        if (typeof operation !== 'function') {
            return Promise.reject(new TypeError('TCP-AO生命周期互斥操作必须是函数'));
        }
        const pending = this.queue.then(() => operation());
        this.queue = pending.catch(() => {});
        return pending;
    }
}

module.exports = TcpAoSettingsLifecycleGate;
