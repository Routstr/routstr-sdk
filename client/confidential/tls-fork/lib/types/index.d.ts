import type { X509Certificate } from './x509.js';
export * from './x509.js';
export * from './tls.js';
export * from './crypto.js';
export * from './logger.js';
declare global {
    const TLS_ADDITIONAL_ROOT_CA_LIST: string[];
    /**
     * Store fetched intermediate certificates typically fetched via
     * the AIA extension here to avoid refetching
     */
    const TLS_INTERMEDIATE_CA_CACHE: {
        [url: string]: X509Certificate;
    };
}
