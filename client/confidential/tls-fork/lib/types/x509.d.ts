export type PrivateKey = string;
export type CertificatePublicKey = {
    /**
     * public key in DER format
     * DER => Uint8Array
     */
    buffer: Uint8Array;
    algorithm: string;
};
export type X509Certificate<T = any> = {
    internal: T;
    /**
     * Checks new Date() is in the validity period
     * of the certificate, basically outside notBefore and notAfter
     */
    isWithinValidity(): boolean;
    getSubjectField(key: string): string[];
    getAlternativeDNSNames(): string[];
    isIssuer(ofCert: X509Certificate<T>): boolean;
    getPublicKey(): CertificatePublicKey;
    /**
     * Get the Authority Information Access extension value,
     * tells us where to get issuer certificate from
     */
    getAIAExtension(): string | undefined;
    /**
     * verify this certificate issued the certificate passed
     * @param otherCert the supposedly issued certificate to verify
     * */
    verifyIssued(otherCert: X509Certificate<T>): boolean | Promise<boolean>;
    serialiseToPem(): string;
    /** FORK PATCH (TLS-02): accessors used by RFC 5280 path validation */
    getAlternativeNames(): {
        type: string;
        value: string;
    }[];
    hasSubjectEmailAddress(): boolean;
    getBasicConstraints(): {
        ca: boolean;
        pathLength?: number;
    } | undefined;
    getKeyUsages(): string[] | undefined;
    getExtendedKeyUsages(): string[] | undefined;
    getNameConstraints(): {
        permitted: X509NameConstraintSubtree[];
        excluded: X509NameConstraintSubtree[];
    } | undefined;
    getUnhandledCriticalExtensions(): string[];
    getSubjectRdns(): string[];
    isSelfIssued(): boolean;
};
export type X509NameConstraintSubtree = {
    type: 'dns';
    value: string;
} | {
    type: 'dn';
    value: string[];
} | {
    type: 'ip' | 'email' | 'url' | 'id' | 'other' | 'unknown';
    value?: undefined;
};
