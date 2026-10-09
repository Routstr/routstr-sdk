import './additional-root-cas.js';
import { crypto } from "../crypto/index.js";
import { SUPPORTED_NAMED_CURVE_MAP, SUPPORTED_SIGNATURE_ALGS, SUPPORTED_SIGNATURE_ALGS_MAP } from "./constants.js";
import { getHash } from "./decryption-utils.js";
import { areUint8ArraysEqual, asciiToUint8Array, concatenateUint8Arrays } from "./generics.js";
import { MOZILLA_ROOT_CA_LIST } from "./mozilla-root-cas.js";
import { expectReadWithLength, packWithLength } from "./packets.js";
import { loadX509FromDer, loadX509FromPem } from "./x509.js";
const CERT_VERIFY_TXT = asciiToUint8Array('TLS 1.3, server CertificateVerify');
let ROOT_CAS;
export function parseCertificates(data, { version }) {
    // context, kina irrelevant
    const ctx = version === 'TLS1_3' ? read(1)[0] : 0;
    // the data itself
    data = readWLength(3);
    const certificates = [];
    while (data.length) {
        // the certificate data
        const cert = readWLength(3);
        const certObj = loadX509FromDer(cert);
        certificates.push(certObj);
        if (version === 'TLS1_3') {
            // extensions
            readWLength(2);
        }
    }
    return { certificates, ctx };
    function read(bytes) {
        const result = data.slice(0, bytes);
        data = data.slice(bytes);
        return result;
    }
    function readWLength(bytesLength = 2) {
        const content = expectReadWithLength(data, bytesLength);
        data = data.slice(content.length + bytesLength);
        return content;
    }
}
export function parseServerCertificateVerify(data) {
    // data = readWLength(2)
    const algorithmBytes = read(2);
    const algorithm = SUPPORTED_SIGNATURE_ALGS.find(alg => (areUint8ArraysEqual(SUPPORTED_SIGNATURE_ALGS_MAP[alg]
        .identifier, algorithmBytes)));
    if (!algorithm) {
        throw new Error(`Unsupported signature algorithm '${algorithmBytes}'`);
    }
    const signature = readWLength(2);
    return { algorithm, signature };
    function read(bytes) {
        const result = data.slice(0, bytes);
        data = data.slice(bytes);
        return result;
    }
    function readWLength(bytesLength = 2) {
        const content = expectReadWithLength(data, bytesLength);
        data = data.slice(content.length + bytesLength);
        return content;
    }
}
export async function verifyCertificateSignature({ signature, algorithm, publicKey, signatureData, publicKeyType, }) {
    let cryptoAlg = SUPPORTED_SIGNATURE_ALGS_MAP[algorithm].algorithm;
    // correct signature algorithm if needed
    if (publicKeyType === 'SECP256R1'
        && cryptoAlg.includes('SECP384R1')) {
        // @ts-expect-error
        cryptoAlg = cryptoAlg.replace('SECP384R1', 'SECP256R1');
    }
    else if (publicKeyType === 'SECP384R1'
        && cryptoAlg.includes('SECP256R1')) {
        // @ts-expect-error
        cryptoAlg = cryptoAlg.replace('SECP256R1', 'SECP384R1');
    }
    const pubKey = await crypto.importKey(cryptoAlg, publicKey.buffer, 'public');
    const verified = await crypto.verify(cryptoAlg, {
        data: signatureData,
        signature,
        publicKey: pubKey
    });
    if (!verified) {
        throw new Error(`${algorithm} signature verification failed`);
    }
}
export async function getSignatureDataTls13(hellos, cipherSuite) {
    const handshakeHash = await getHash(hellos, cipherSuite);
    return concatenateUint8Arrays([
        new Uint8Array(64).fill(0x20),
        CERT_VERIFY_TXT,
        new Uint8Array([0]),
        handshakeHash
    ]);
}
export async function getSignatureDataTls12({ clientRandom, serverRandom, curveType, publicKey, }) {
    const publicKeyBytes = await crypto.exportKey(publicKey);
    return concatenateUint8Arrays([
        clientRandom,
        serverRandom,
        concatenateUint8Arrays([
            new Uint8Array([3]),
            SUPPORTED_NAMED_CURVE_MAP[curveType].identifier,
        ]),
        packWithLength(publicKeyBytes)
            // pub key is packed with 1 byte length
            .slice(1)
    ]);
}
// FORK PATCH (TLS-02/TLS-09): RFC 5280 path validation.
// The longest path accepted (leaf + intermediates + trust anchor).
const MAX_CHAIN_DEPTH = 8;
// The most issuer candidates tried while building a path.
const MAX_PATH_BUILDING_ATTEMPTS = 64;
const EKU_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const EKU_ANY = '2.5.29.37.0';
/**
 * Verifies the server certificate chain against the root store
 * (the bundled Mozilla roots + TLS_ADDITIONAL_ROOT_CA_LIST + additionalRootCAs).
 *
 * FORK PATCH (TLS-02/TLS-04/TLS-09): RFC 5280 path validation. Every
 * certificate in the path must be within validity and carry no unprocessed
 * critical extension; every issuer must assert basicConstraints CA:TRUE,
 * honour pathLenConstraint, include keyCertSign if keyUsage is present and
 * serverAuth/anyExtendedKeyUsage if extendedKeyUsage is present; the leaf's
 * extendedKeyUsage, if present, must include serverAuth/anyExtendedKeyUsage;
 * nameConstraints (dNSName and directoryName) are enforced, and a constraint
 * of any other name type that would apply rejects the path. Path building
 * backtracks over candidate issuers. AIA issuer fetching happens only when a
 * fetchCertificateBytes function is passed explicitly (off by default).
 */
export async function verifyCertificateChain(chain, host, logger, fetchCertificateBytes, additionalRootCAs) {
    const rootCAs = [
        ...loadRootCAs(),
        ...filterTrustAnchors(additionalRootCAs || [])
    ];
    const leaf = chain[0];
    if (!leaf) {
        throw new Error('No certificates received');
    }
    // RFC 6125 6.4.4: CN is consulted only when there is no SAN dNSName
    const sanNames = leaf.getAlternativeDNSNames();
    const referenceNames = sanNames.length
        ? sanNames
        : leaf.getSubjectField('CN');
    if (!referenceNames.some(cn => matchHostname(host, cn))) {
        throw new Error(`Certificate is not for host ${host}`);
    }
    checkCertificateCommon(leaf, 'leaf');
    const leafEku = leaf.getExtendedKeyUsages();
    if (leafEku && !leafEku.includes(EKU_SERVER_AUTH) && !leafEku.includes(EKU_ANY)) {
        throw new Error('Leaf certificate extendedKeyUsage does not allow serverAuth');
    }
    const ctx = {
        host,
        logger,
        fetchCertificateBytes,
        rootCAs,
        intermediates: chain.slice(1),
        attempts: 0,
        errors: [],
    };
    const path = await buildPath([leaf], ctx);
    if (!path) {
        throw new Error(`Certificate chain verification failed for ${host}: ${ctx.errors.join('; ') || 'no valid path'}`);
    }
    logger?.debug?.({ depth: path.length }, 'certificate path validated');
}
/**
 * Depth-first path building from path[path.length - 1] towards a trust
 * anchor. Returns the validated path (leaf ... anchor) or undefined.
 */
async function buildPath(path, ctx) {
    const cert = path[path.length - 1];
    const cn = cert.getSubjectField('CN');
    const candidates = [
        ...ctx.rootCAs
            .filter(ca => ca.isIssuer(cert))
            .map(ca => ({ issuer: ca, anchor: true })),
        ...ctx.intermediates
            .filter(ca => !path.includes(ca) && ca.isIssuer(cert))
            .map(ca => ({ issuer: ca, anchor: false })),
    ];
    if (!candidates.length && ctx.fetchCertificateBytes) {
        const aiaExt = cert.getAIAExtension();
        if (aiaExt) {
            try {
                let fetched = TLS_INTERMEDIATE_CA_CACHE?.[aiaExt];
                if (!fetched) {
                    ctx.logger?.debug?.({ aiaExt, cn }, 'fetching issuer certificate via AIA extension');
                    const bytes = await ctx.fetchCertificateBytes(aiaExt);
                    fetched = loadX509FromPem(bytes);
                    TLS_INTERMEDIATE_CA_CACHE[aiaExt] = fetched;
                }
                if (fetched.isIssuer(cert)) {
                    candidates.push({ issuer: fetched, anchor: false });
                }
            }
            catch (err) {
                ctx.errors.push(`AIA fetch for ${cn} failed: ${err?.message || err}`);
            }
        }
    }
    if (!candidates.length) {
        ctx.errors.push(`Missing issuer for certificate ${cn} (i: ${path.length - 1})`);
        return undefined;
    }
    for (const { issuer, anchor } of candidates) {
        ctx.attempts += 1;
        if (ctx.attempts > MAX_PATH_BUILDING_ATTEMPTS) {
            ctx.errors.push('too many path-building attempts');
            return undefined;
        }
        const icn = issuer.getSubjectField('CN');
        if (!anchor && path.length + 2 > MAX_CHAIN_DEPTH) {
            ctx.errors.push(`chain longer than ${MAX_CHAIN_DEPTH} certificates`);
            continue;
        }
        try {
            await checkIssuer(issuer, path, ctx.host);
        }
        catch (err) {
            ctx.errors.push(`issuer ${icn} of ${cn} (i: ${path.length - 1}) rejected: ${err?.message || err}`);
            continue;
        }
        if (anchor) {
            return [...path, issuer];
        }
        const result = await buildPath([...path, issuer], ctx);
        if (result) {
            return result;
        }
    }
    return undefined;
}
/** checks every certificate in a path must pass */
function checkCertificateCommon(cert, label) {
    if (!cert.isWithinValidity()) {
        throw new Error(`Certificate ${label} is outside validity`);
    }
    const unhandled = cert.getUnhandledCriticalExtensions();
    if (unhandled.length) {
        throw new Error(`Certificate ${label} has unhandled critical extension(s) ${unhandled.join(', ')}`);
    }
}
/**
 * Checks that `issuer` may issue path[path.length - 1], given the
 * certificates below it (path[0] is the leaf).
 */
async function checkIssuer(issuer, path, host) {
    checkCertificateCommon(issuer, 'issuer');
    const bc = issuer.getBasicConstraints();
    if (!bc?.ca) {
        throw new Error('not a CA (basicConstraints CA:TRUE missing)');
    }
    if (typeof bc.pathLength === 'number') {
        // non-self-issued intermediates between this issuer and the leaf
        const intermediatesBelow = path
            .slice(1)
            .filter(c => !c.isSelfIssued())
            .length;
        if (intermediatesBelow > bc.pathLength) {
            throw new Error(`pathLenConstraint ${bc.pathLength} exceeded`);
        }
    }
    const ku = issuer.getKeyUsages();
    if (ku && !ku.includes('keyCertSign')) {
        throw new Error('keyUsage does not include keyCertSign');
    }
    const eku = issuer.getExtendedKeyUsages();
    if (eku && !eku.includes(EKU_SERVER_AUTH) && !eku.includes(EKU_ANY)) {
        throw new Error('extendedKeyUsage does not allow serverAuth');
    }
    checkNameConstraints(issuer, path, host);
    const subject = path[path.length - 1];
    let verified = false;
    try {
        verified = await issuer.verifyIssued(subject);
    }
    catch (err) {
        throw new Error(`signature verification error: ${err?.message || err}`);
    }
    if (!verified) {
        throw new Error('signature verification failed');
    }
}
/**
 * RFC 5280 4.2.1.10, applied to every certificate below the constraining CA
 * (self-issued intermediates excepted) and to the hostname being verified.
 */
function checkNameConstraints(issuer, path, host) {
    const nc = issuer.getNameConstraints();
    if (!nc) {
        return;
    }
    const subjects = path.filter((c, i) => i === 0 || !c.isSelfIssued());
    const all = [...nc.permitted, ...nc.excluded];
    // constraint types not evaluated here: reject if they could apply
    for (const { type } of all) {
        if (type === 'dns' || type === 'dn') {
            continue;
        }
        const applies = type === 'unknown'
            || subjects.some(c => {
                const sanTypes = c.getAlternativeNames().map(n => n.type);
                switch (type) {
                    case 'email':
                        return sanTypes.includes('email') || c.hasSubjectEmailAddress();
                    case 'other':
                        return sanTypes.some(t => t === 'guid' || t === 'upn');
                    default:
                        return sanTypes.includes(type);
                }
            });
        if (applies) {
            throw new Error(`unsupported nameConstraints type '${type}' applies to the path`);
        }
    }
    const permittedDns = nc.permitted.filter(t => t.type === 'dns').map(t => t.value);
    const excludedDns = nc.excluded.filter(t => t.type === 'dns').map(t => t.value);
    const dnsNames = [
        host,
        ...subjects.flatMap(c => c.getAlternativeNames()
            .filter(n => n.type === 'dns')
            .map(n => n.value)),
    ];
    for (const name of dnsNames) {
        if (permittedDns.length && !permittedDns.some(c => dnsNameWithinSubtree(name, c))) {
            throw new Error(`name '${name}' is outside the permitted dNSName subtrees`);
        }
        if (excludedDns.some(c => dnsNameWithinSubtree(name, c))) {
            throw new Error(`name '${name}' is within an excluded dNSName subtree`);
        }
    }
    const permittedDn = nc.permitted.filter(t => t.type === 'dn').map(t => t.value);
    const excludedDn = nc.excluded.filter(t => t.type === 'dn').map(t => t.value);
    if (permittedDn.length || excludedDn.length) {
        for (const c of subjects) {
            const rdns = c.getSubjectRdns();
            if (!rdns.length) {
                continue;
            }
            if (permittedDn.length && !permittedDn.some(base => isRdnPrefix(base, rdns))) {
                throw new Error('subject is outside the permitted directoryName subtrees');
            }
            if (excludedDn.some(base => isRdnPrefix(base, rdns))) {
                throw new Error('subject is within an excluded directoryName subtree');
            }
        }
    }
}
function isRdnPrefix(base, rdns) {
    return base.length <= rdns.length
        && base.every((rdn, i) => rdn === rdns[i]);
}
/**
 * dNSName subtree match: the name equals the constraint or extends it with
 * labels on the left. A leading '.' (common practice) permits subdomains only.
 */
function dnsNameWithinSubtree(name, constraint) {
    const n = normalizeDnsName(name);
    const c = normalizeDnsName(constraint);
    if (!c) {
        return true;
    }
    if (c.startsWith('.')) {
        return n.endsWith(c);
    }
    return n === c || n.endsWith(`.${c}`);
}
function normalizeDnsName(name) {
    let n = String(name).toLowerCase();
    if (n.endsWith('.')) {
        n = n.slice(0, -1);
    }
    return n;
}
/**
 * Checks if a hostname matches a reference identifier from the certificate.
 * FORK PATCH (TLS-04): RFC 6125 6.4.3: case-insensitive, one trailing
 * dot stripped, '*' only as the entire leftmost label, matching exactly one
 * label, and only with at least two labels after it ('*.x.y' does not match
 * 'x.y', '*.com' matches nothing).
 * @param host the hostname, eg. "google.com"
 * @param commonName the name from the certificate,
 * 	eg. "*.google.com", "google.com"
 */
function matchHostname(host, commonName) {
    const h = normalizeDnsName(host);
    const p = normalizeDnsName(commonName);
    if (!h || !p || h.includes('*')) {
        return false;
    }
    const hostComps = h.split('.');
    const cnComps = p.split('.');
    if (cnComps.length !== hostComps.length
        || hostComps.some(comp => !comp)) {
        return false;
    }
    if (cnComps[0] === '*') {
        if (cnComps.length < 3) {
            return false;
        }
        cnComps.shift();
        hostComps.shift();
    }
    return cnComps.every((comp, i) => (!comp.includes('*')
        && comp === hostComps[i]));
}
function loadRootCAs() {
    if (ROOT_CAS) {
        return ROOT_CAS;
    }
    ROOT_CAS = filterTrustAnchors(MOZILLA_ROOT_CA_LIST.map(loadX509FromPem));
    if (typeof TLS_ADDITIONAL_ROOT_CA_LIST !== 'undefined') {
        ROOT_CAS.push(...filterTrustAnchors(TLS_ADDITIONAL_ROOT_CA_LIST.map(loadX509FromPem)));
    }
    return ROOT_CAS;
}
// FORK PATCH (TLS-02): only CA certificates (basicConstraints CA:TRUE)
// may act as trust anchors; anything else in a root list is ignored.
function filterTrustAnchors(certs) {
    return certs.filter(cert => {
        try {
            return !!cert.getBasicConstraints()?.ca;
        }
        catch {
            return false;
        }
    });
}
