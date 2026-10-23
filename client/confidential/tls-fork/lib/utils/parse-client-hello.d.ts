/**
 * Parse a full client hello message
 */
export declare function parseClientHello(data: Uint8Array): {
    version: "TLS1_3" | "TLS1_2";
    serverRandom: Uint8Array<ArrayBuffer>;
    sessionId: Uint8Array<ArrayBuffer>;
    cipherSuitesBytes: Uint8Array<ArrayBuffer>;
    compressionMethodByte: number;
    extensions: Partial<import("../index.js").SupportedExtensionClientData>;
};
