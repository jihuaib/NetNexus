class RpkiAspa {
    constructor(customerAsn, providerAsns, afiFlags) {
        this.customerAsn = customerAsn; // 4-byte Customer ASN
        this.providerAsns = providerAsns; // array of 4-byte Provider ASNs
        this.afiFlags = afiFlags; // bitmask: 0x01 IPv4, 0x02 IPv6
    }

    static makeKey(customerAsn) {
        return `${customerAsn}`;
    }

    static parseKey(key) {
        return { customerAsn: key };
    }
}

module.exports = RpkiAspa;
