class DhcpLease {
    constructor(macAddr, ip, hostname, leaseTime) {
        this.macAddr = macAddr;
        this.ip = ip;
        this.hostname = hostname || '未知';
        this.leaseTime = leaseTime;
        this.startTime = new Date();
        this.expiresAt = new Date(Date.now() + leaseTime * 1000);
        this.status = 'active';
    }

    isExpired() {
        return Date.now() > this.expiresAt.getTime();
    }

    renew(leaseTime) {
        this.leaseTime = leaseTime;
        this.startTime = new Date();
        this.expiresAt = new Date(Date.now() + leaseTime * 1000);
    }

    getInfo() {
        return {
            macAddr: this.macAddr,
            ip: this.ip,
            hostname: this.hostname,
            leaseTime: this.leaseTime,
            startTime: this.startTime.toLocaleString('zh-CN', { hour12: false }),
            expiresAt: this.expiresAt.toLocaleString('zh-CN', { hour12: false }),
            status: this.isExpired() ? 'expired' : this.status
        };
    }
}

module.exports = DhcpLease;
