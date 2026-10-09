import * as peculiar from '@peculiar/x509';
import { SubjectAlternativeNameExtension } from '@peculiar/x509';
// FORK PATCH (TLS-02): name constraints are decoded with the ASN.1
// schema @peculiar/x509 itself is built on (it has no NameConstraints class).
import { AsnConvert } from '@peculiar/asn1-schema';
import { NameConstraints } from '@peculiar/asn1-x509';
import { crypto } from "../crypto/index.js";
const AIA_EXT_TYPE = '1.3.6.1.5.5.7.1.1';
// FORK PATCH (TLS-02): extensions the path validator processes. Any
// other extension marked critical makes the certificate unusable.
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const KEY_USAGE_OID = '2.5.29.15';
const EXT_KEY_USAGE_OID = '2.5.29.37';
const SAN_OID = '2.5.29.17';
const NAME_CONSTRAINTS_OID = '2.5.29.30';
const HANDLED_CRITICAL_EXTENSIONS = new Set([
    BASIC_CONSTRAINTS_OID,
    KEY_USAGE_OID,
    EXT_KEY_USAGE_OID,
    SAN_OID,
    NAME_CONSTRAINTS_OID,
]);
const EMAIL_ADDRESS_OID = '1.2.840.113549.1.9.1';
export function loadX509FromPem(pem) {
    let cert;
    try {
        cert = new peculiar.X509Certificate(pem);
    }
    catch (e) {
        throw new Error(`Unsupported certificate: ${e}`);
    }
    return {
        internal: cert,
        isWithinValidity() {
            const now = new Date();
            return now > cert.notBefore && now < cert.notAfter;
        },
        getAIAExtension() {
            const aiaExt = cert
                .getExtension(AIA_EXT_TYPE);
            return aiaExt?.caIssuers?.find(obj => obj.type === 'url')?.value;
        },
        getSubjectField(name) {
            return cert.subjectName.getField(name);
        },
        getAlternativeDNSNames() {
            // search for names in SubjectAlternativeNameExtension
            const ext = cert.extensions
                .find(e => e.type === '2.5.29.17'); //subjectAltName
            if (ext instanceof SubjectAlternativeNameExtension) {
                return ext.names.items
                    .filter(n => n.type === 'dns')
                    .map(n => n.value);
            }
            return [];
        },
        // FORK PATCH (TLS-02): accessors for RFC 5280 path validation.
        /** all SAN entries as { type, value } (types as named by @peculiar/x509) */
        getAlternativeNames() {
            const ext = cert.extensions.find(e => e.type === SAN_OID);
            if (!ext) {
                return [];
            }
            if (!(ext instanceof SubjectAlternativeNameExtension)) {
                throw new Error('Malformed subjectAltName extension');
            }
            return ext.names.items.map(n => ({ type: n.type, value: n.value }));
        },
        hasSubjectEmailAddress() {
            return cert.subjectName.getField(EMAIL_ADDRESS_OID).length > 0;
        },
        /** { ca, pathLength } or undefined when the extension is absent */
        getBasicConstraints() {
            const ext = cert.extensions.find(e => e.type === BASIC_CONSTRAINTS_OID);
            if (!ext) {
                return undefined;
            }
            if (!(ext instanceof peculiar.BasicConstraintsExtension)) {
                throw new Error('Malformed basicConstraints extension');
            }
            return { ca: !!ext.ca, pathLength: ext.pathLength };
        },
        /** names of the asserted key usages, or undefined when absent */
        getKeyUsages() {
            const ext = cert.extensions.find(e => e.type === KEY_USAGE_OID);
            if (!ext) {
                return undefined;
            }
            if (!(ext instanceof peculiar.KeyUsagesExtension)) {
                throw new Error('Malformed keyUsage extension');
            }
            return Object.entries(peculiar.KeyUsageFlags)
                .filter(([name, flag]) => (typeof flag === 'number'
                    && isNaN(Number(name))
                    && (ext.usages & flag) === flag))
                .map(([name]) => name);
        },
        /** extended key usage OIDs, or undefined when absent */
        getExtendedKeyUsages() {
            const ext = cert.extensions.find(e => e.type === EXT_KEY_USAGE_OID);
            if (!ext) {
                return undefined;
            }
            if (!(ext instanceof peculiar.ExtendedKeyUsageExtension)) {
                throw new Error('Malformed extendedKeyUsage extension');
            }
            return ext.usages.map(u => String(u));
        },
        /**
         * { permitted, excluded } lists of { type, value } subtrees, or
         * undefined when absent. dNSName values are strings, directoryName
         * values are normalised RDN lists; other types carry no value.
         */
        getNameConstraints() {
            const ext = cert.extensions.find(e => e.type === NAME_CONSTRAINTS_OID);
            if (!ext) {
                return undefined;
            }
            const nc = AsnConvert.parse(ext.value, NameConstraints);
            return {
                permitted: Array.from(nc.permittedSubtrees || []).map(parseGeneralSubtree),
                excluded: Array.from(nc.excludedSubtrees || []).map(parseGeneralSubtree),
            };
        },
        /** OIDs of critical extensions the validator does not process */
        getUnhandledCriticalExtensions() {
            return cert.extensions
                .filter(e => e.critical && !HANDLED_CRITICAL_EXTENSIONS.has(e.type))
                .map(e => e.type);
        },
        /** subject DN as normalised RDNs (for directoryName constraints) */
        getSubjectRdns() {
            return normalizeRdns(cert.subjectName);
        },
        isSelfIssued() {
            return normalizeDistinguishedName(cert.issuerName)
                === normalizeDistinguishedName(cert.subjectName);
        },
        isIssuer({ internal: ofCert }) {
            const issuerName = normalizeDistinguishedName(ofCert.issuerName);
            const subjectName = normalizeDistinguishedName(cert.subjectName);
            if (issuerName !== subjectName) {
                return false;
            }
            const authorityKeyId = ofCert
                .getExtension(peculiar.AuthorityKeyIdentifierExtension)
                ?.keyId;
            const subjectKeyId = cert
                .getExtension(peculiar.SubjectKeyIdentifierExtension)
                ?.keyId;
            return !authorityKeyId
                || !subjectKeyId
                || authorityKeyId.toLowerCase() === subjectKeyId.toLowerCase();
        },
        getPublicKey() {
            return {
                buffer: new Uint8Array(cert.publicKey.rawData),
                algorithm: cert.publicKey.algorithm.name,
            };
        },
        async verifyIssued(otherCert) {
            const sigAlg = getSigAlgorithm(cert.publicKey, otherCert.internal);
            const impPublicKey = await crypto
                .importKey(sigAlg, new Uint8Array(cert.publicKey.rawData), 'public');
            const signature = new Uint8Array(otherCert.internal.signature);
            const verified = await crypto.verify(sigAlg, {
                publicKey: impPublicKey,
                signature,
                data: new Uint8Array(otherCert.internal['tbs'])
            });
            return verified;
        },
        serialiseToPem() {
            return cert.toString('pem');
        },
    };
}
// FORK PATCH (TLS-02): decode one GeneralSubtree of a nameConstraints
// extension. A non-default minimum/maximum is not supported (RFC 5280 forbids it).
function parseGeneralSubtree(subtree) {
    if ((subtree.minimum || 0) !== 0 || subtree.maximum !== undefined) {
        throw new Error('Unsupported nameConstraints subtree minimum/maximum');
    }
    const base = subtree.base;
    if (base.dNSName !== undefined) {
        return { type: 'dns', value: base.dNSName };
    }
    if (base.directoryName !== undefined) {
        const name = new peculiar.Name(AsnConvert.serialize(base.directoryName));
        return { type: 'dn', value: normalizeRdns(name) };
    }
    if (base.iPAddress !== undefined) {
        return { type: 'ip' };
    }
    if (base.rfc822Name !== undefined) {
        return { type: 'email' };
    }
    if (base.uniformResourceIdentifier !== undefined) {
        return { type: 'url' };
    }
    if (base.registeredID !== undefined) {
        return { type: 'id' };
    }
    if (base.otherName !== undefined) {
        return { type: 'other' };
    }
    return { type: 'unknown' };
}
function normalizeRdns(name) {
    return normalizeDistinguishedNameParts(name).map(rdn => JSON.stringify(rdn));
}
function normalizeDistinguishedName(name) {
    return JSON.stringify(normalizeDistinguishedNameParts(name));
}
function normalizeDistinguishedNameParts(name) {
    return name.toJSON().map(rdn => (Object.entries(rdn)
        .flatMap(([type, values]) => values.map(value => [
        type.toLowerCase(),
        normalizeNameValue(value),
    ]))
        .sort(([typeA, valueA], [typeB, valueB]) => {
        if (typeA !== typeB) {
            return typeA < typeB ? -1 : 1;
        }
        return valueA === valueB ? 0 : valueA < valueB ? -1 : 1;
    })));
}
function normalizeNameValue(value) {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .trim()
        .replace(/\s+/gu, ' ');
}
function getSigAlgorithm(key, { signatureAlgorithm }) {
    if (!('name' in signatureAlgorithm)) {
        throw new Error('Missing signature algorithm name');
    }
    const { name, hash } = signatureAlgorithm;
    const { algorithm: keyAlg } = key;
    if (keyAlg.name !== name) {
        throw new Error(`Signature algorithm ${name} does not match`
            + ` public key algorithm ${keyAlg.name}`);
    }
    let hashName;
    switch (hash.name) {
        case 'SHA-256':
            hashName = 'SHA256';
            break;
        case 'SHA-384':
            hashName = 'SHA384';
            break;
        case 'SHA-512':
            hashName = 'SHA512';
            break;
        case 'SHA-1':
            hashName = 'SHA1';
            break;
        default:
            throw new Error(`Unsupported hash algorithm: ${hash.name}`);
    }
    switch (name) {
        case 'RSASSA-PKCS1-v1_5':
        case 'RSA-PKCS1-SHA1':
            return `RSA-PKCS1-${hashName}`;
        case 'ECDSA':
            if (hashName === 'SHA512' || hashName === 'SHA1') {
                throw new Error(`Unsupported hash algorithm for ECDSA: ${hashName}`);
            }
            switch (keyAlg.namedCurve) {
                case 'P-256':
                    return `ECDSA-SECP256R1-${hashName}`;
                case 'P-384':
                    return `ECDSA-SECP384R1-${hashName}`;
                default:
                    throw new Error(`Unsupported named curve: ${keyAlg.namedCurve}`);
            }
        default:
            throw new Error(`Unsupported signature algorithm: ${name}`);
    }
}
export function loadX509FromDer(der) {
    // peculiar handles both
    return loadX509FromPem(der);
}
export async function defaultFetchCertificateBytes(url) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch certificate from ${url}: ${res.statusText}`);
    }
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
}
