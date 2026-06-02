class RpkiAspa {
    constructor(customerAsn, providerAsns, afiFlags) {
        this.customerAsn = customerAsn; // 4-byte Customer ASN
        this.providerAsns = RpkiAspa.normalizeProviderAsns(providerAsns); // array of 4-byte Provider ASNs
        this.afiFlags = afiFlags; // UI bitmask: 0x01 IPv4, 0x02 IPv6
    }

    static normalizeProviderAsns(providerAsns) {
        const normalized = [...new Set((providerAsns || []).map(asn => {
            const value = Number(asn);
            if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
                throw new Error(`Invalid ASPA Provider ASN: ${asn}`);
            }
            return value;
        }))].sort((a, b) => a - b);

        if (normalized.length === 0) {
            throw new Error('ASPA Provider ASN list cannot be empty');
        }
        if (normalized.length > 1 && normalized.includes(0)) {
            throw new Error('ASPA Provider ASN list cannot contain AS0 with other providers');
        }

        return normalized;
    }

    static makeKey(customerAsn) {
        return `${customerAsn}`;
    }

    static parseKey(key) {
        return { customerAsn: key };
    }
}

module.exports = RpkiAspa;
