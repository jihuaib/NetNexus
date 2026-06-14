class RpkiRoa {
    constructor(ip, mask, asn, maxLength, ipType) {
        this.ip = ip;
        this.mask = mask;
        this.asn = asn;
        this.maxLength = maxLength;
        this.ipType = ipType;
    }

    static makeKey(ip, mask, asn, maxLength) {
        return `${ip}|${mask}|${asn}|${maxLength}`;
    }

    static parseKey(key) {
        const [ip, mask, asn, maxLength] = key.split('|');
        return { ip, mask, asn, maxLength };
    }
}

module.exports = RpkiRoa;
