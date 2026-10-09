/** Max size of an encrypted packet */
export declare const MAX_ENC_PACKET_SIZE = 16380;
export declare const TLS_PROTOCOL_VERSION_MAP: {
    TLS1_3: Uint8Array<ArrayBuffer>;
    TLS1_2: Uint8Array<ArrayBuffer>;
};
export declare const SUPPORTED_NAMED_CURVE_MAP: {
    SECP256R1: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "P-256";
    };
    SECP384R1: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "P-384";
    };
    X25519: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "X25519";
    };
};
export declare const SUPPORTED_RECORD_TYPE_MAP: {
    CLIENT_HELLO: number;
    SERVER_HELLO: number;
    HELLO_RETRY_REQUEST: number;
    SESSION_TICKET: number;
    ENCRYPTED_EXTENSIONS: number;
    CERTIFICATE: number;
    SERVER_KEY_SHARE: number;
    CERTIFICATE_REQUEST: number;
    SERVER_HELLO_DONE: number;
    CERTIFICATE_VERIFY: number;
    CLIENT_KEY_SHARE: number;
    FINISHED: number;
    KEY_UPDATE: number;
};
export declare const CONTENT_TYPE_MAP: {
    CHANGE_CIPHER_SPEC: number;
    ALERT: number;
    HANDSHAKE: number;
    APPLICATION_DATA: number;
};
export declare const AUTH_TAG_BYTE_LENGTH = 16;
export declare const SUPPORTED_NAMED_CURVES: (keyof typeof SUPPORTED_NAMED_CURVE_MAP)[];
/**
 * Supported cipher suites.
 * In a client hello, these are sent in order of preference
 * as listed below
 */
export declare const SUPPORTED_CIPHER_SUITE_MAP: {
    readonly TLS_CHACHA20_POLY1305_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 32;
        readonly ivLength: 12;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "CHACHA20-POLY1305";
    };
    readonly TLS_AES_256_GCM_SHA384: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 48;
        readonly ivLength: 12;
        readonly hashAlgorithm: "SHA-384";
        readonly cipher: "AES-256-GCM";
    };
    readonly TLS_AES_128_GCM_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 32;
        readonly ivLength: 12;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-GCM";
    };
    readonly TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 32;
        readonly ivLength: 12;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "CHACHA20-POLY1305";
    };
    readonly TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 32;
        readonly ivLength: 12;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "CHACHA20-POLY1305";
    };
    readonly TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 32;
        readonly ivLength: 4;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-GCM";
    };
    readonly TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 32;
        readonly ivLength: 4;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-GCM";
    };
    readonly TLS_RSA_WITH_AES_128_GCM_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 32;
        readonly ivLength: 4;
        readonly hashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-GCM";
        readonly isRsaEcdh: true;
    };
    readonly TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 48;
        readonly ivLength: 4;
        readonly hashAlgorithm: "SHA-384";
        readonly cipher: "AES-256-GCM";
    };
    readonly TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 32;
        readonly hashLength: 48;
        readonly ivLength: 4;
        readonly hashAlgorithm: "SHA-384";
        readonly cipher: "AES-256-GCM";
    };
    readonly TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 20;
        readonly ivLength: 16;
        readonly hashAlgorithm: "SHA-1";
        readonly prfHashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-CBC";
    };
    readonly TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly keyLength: 16;
        readonly hashLength: 20;
        readonly ivLength: 16;
        readonly hashAlgorithm: "SHA-1";
        readonly prfHashAlgorithm: "SHA-256";
        readonly cipher: "AES-128-CBC";
    };
};
export declare const ALERT_LEVEL: {
    WARNING: number;
    FATAL: number;
};
export declare const ALERT_DESCRIPTION: {
    CLOSE_NOTIFY: number;
    UNEXPECTED_MESSAGE: number;
    BAD_RECORD_MAC: number;
    RECORD_OVERFLOW: number;
    HANDSHAKE_FAILURE: number;
    BAD_CERTIFICATE: number;
    UNSUPPORTED_CERTIFICATE: number;
    CERTIFICATE_REVOKED: number;
    CERTIFICATE_EXPIRED: number;
    CERTIFICATE_UNKNOWN: number;
    ILLEGAL_PARAMETER: number;
    UNKNOWN_CA: number;
    ACCESS_DENIED: number;
    DECODE_ERROR: number;
    DECRYPT_ERROR: number;
    PROTOCOL_VERSION: number;
    INSUFFICIENT_SECURITY: number;
    INTERNAL_ERROR: number;
    INAPPROPRIATE_FALLBACK: number;
    USER_CANCELED: number;
    MISSING_EXTENSION: number;
    UNSUPPORTED_EXTENSION: number;
    UNRECOGNIZED_NAME: number;
    BAD_CERTIFICATE_STATUS_RESPONSE: number;
    UNKNOWN_PSK_IDENTITY: number;
    CERTIFICATE_REQUIRED: number;
    NO_APPLICATION_PROTOCOL: number;
    DECRYPTION_FAILED_RESERVED: number;
    DECOMPRESSION_FAILURE: number;
    NO_CERTIFICATE_RESERVED: number;
    EXPORT_RESTRICTION_RESERVED: number;
    NO_RENEGOTIATION: number;
};
export declare const SUPPORTED_CIPHER_SUITES: (keyof typeof SUPPORTED_CIPHER_SUITE_MAP)[];
export declare const SUPPORTED_SIGNATURE_ALGS_MAP: {
    readonly ECDSA_SECP256R1_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "ECDSA-SECP256R1-SHA256";
    };
    readonly ECDSA_SECP384R1_SHA384: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "ECDSA-SECP384R1-SHA384";
    };
    readonly RSA_PSS_RSAE_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "RSA-PSS-SHA256";
    };
    readonly RSA_PKCS1_SHA256: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "RSA-PKCS1-SHA256";
    };
    readonly RSA_PKCS1_SHA384: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "RSA-PKCS1-SHA384";
    };
    readonly RSA_PKCS1_SHA512: {
        readonly identifier: Uint8Array<ArrayBuffer>;
        readonly algorithm: "RSA-PKCS1-SHA512";
    };
};
export declare const SUPPORTED_SIGNATURE_ALGS: (keyof typeof SUPPORTED_SIGNATURE_ALGS_MAP)[];
export declare const SUPPORTED_EXTENSION_MAP: {
    SERVER_NAME: number;
    MAX_FRAGMENT_LENGTH: number;
    KEY_SHARE: number;
    SUPPORTED_GROUPS: number;
    SIGNATURE_ALGS: number;
    SUPPORTED_VERSIONS: number;
    SESSION_TICKET: number;
    EARLY_DATA: number;
    PRE_SHARED_KEY: number;
    PRE_SHARED_KEY_MODE: number;
    ALPN: number;
};
export declare const SUPPORTED_EXTENSIONS: (keyof typeof SUPPORTED_EXTENSION_MAP)[];
export declare const PACKET_TYPE: {
    HELLO: number;
    WRAPPED_RECORD: number;
    CHANGE_CIPHER_SPEC: number;
    ALERT: number;
};
export declare const KEY_UPDATE_TYPE_MAP: {
    UPDATE_NOT_REQUESTED: number;
    UPDATE_REQUESTED: number;
};
