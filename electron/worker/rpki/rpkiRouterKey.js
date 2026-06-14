class RpkiRouterKey {
    constructor(ski, asn, spki) {
        this.ski = ski; // Subject Key Identifier, 20 bytes hex string (40 chars)
        this.asn = asn; // 4-byte ASN
        this.spki = spki; // Subject Public Key Info, DER encoded hex string
    }

    static makeKey(ski, asn) {
        return `${ski}|${asn}`;
    }

    static parseKey(key) {
        const [ski, asn] = key.split('|');
        return { ski, asn };
    }
}

module.exports = RpkiRouterKey;
