class Dhcp6Lease {
    constructor(duid, ip, iaid, preferredLifetime, validLifetime) {
        this.duid = duid; // 客户端 DUID（hex 字符串）
        this.ip = ip; // 分配的 IPv6 地址
        this.iaid = iaid; // IA ID（hex 字符串）
        this.preferredLifetime = preferredLifetime;
        this.validLifetime = validLifetime;
        this.startTime = new Date();
        this.expiresAt = new Date(Date.now() + validLifetime * 1000);
        this.status = 'active';
    }

    isExpired() {
        return Date.now() > this.expiresAt.getTime();
    }

    renew(preferredLifetime, validLifetime) {
        this.preferredLifetime = preferredLifetime;
        this.validLifetime = validLifetime;
        this.startTime = new Date();
        this.expiresAt = new Date(Date.now() + validLifetime * 1000);
    }

    getInfo() {
        return {
            duid: this.duid,
            ip: this.ip,
            iaid: this.iaid,
            preferredLifetime: this.preferredLifetime,
            validLifetime: this.validLifetime,
            startTime: this.startTime.toLocaleString('zh-CN', { hour12: false }),
            expiresAt: this.expiresAt.toLocaleString('zh-CN', { hour12: false }),
            status: this.isExpired() ? 'expired' : this.status
        };
    }
}

module.exports = Dhcp6Lease;
