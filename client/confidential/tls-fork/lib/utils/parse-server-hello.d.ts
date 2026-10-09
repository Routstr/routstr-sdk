export declare function parseServerHello(data: Uint8Array): Promise<{
    publicKey?: unknown;
    publicKeyType?: "X25519" | "SECP256R1" | "SECP384R1" | undefined;
    serverTlsVersion: "TLS1_3" | "TLS1_2";
    serverRandom: Uint8Array<ArrayBuffer>;
    sessionId: Uint8Array<ArrayBuffer>;
    cipherSuite: "TLS_CHACHA20_POLY1305_SHA256" | "TLS_AES_256_GCM_SHA384" | "TLS_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256" | "TLS_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA" | "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA";
    supportsPsk: boolean;
    extensions: Partial<import("../index.js").SupportedExtensionServerData>;
}>;
