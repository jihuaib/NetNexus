class RpkiAspa {
    constructor(customerAsn, providerAsns, afiFlags) {
        this.customerAsn = customerAsn; // 4-byte Customer ASN
        this.providerAsns = RpkiAspa.parseProviderAsns(providerAsns); // Preserve user-provided order and duplicates.
        this.afiFlags = afiFlags; // UI bitmask: 0x01 IPv4, 0x02 IPv6
    }

    static parseProviderAsns(providerAsns) {
        return (providerAsns || []).map(asn => {
            const value = Number(asn);
            if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
                throw new Error(`Invalid ASPA Provider ASN: ${asn}`);
            }
            return value;
        });
    }

    static makeKey(customerAsn) {
        return `${customerAsn}`;
    }

    static parseKey(key) {
        return { customerAsn: key };
    }
}

module.exports = RpkiAspa;
