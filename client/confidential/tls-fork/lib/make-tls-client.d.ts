import type { TLSClientOptions, TLSHandshakeOptions, TLSKeyType, TLSPacketWithType, TLSSessionTicket } from './types/index.js';
export declare function makeTLSClient({ host, verifyServerCertificate, rootCAs, logger: _logger, cipherSuites, namedCurves, supportedProtocolVersions, signatureAlgorithms, applicationLayerProtocols, fetchCertificateBytes, write, onRead, onApplicationData, onSessionTicket, onTlsEnd, onHandshake, onRecvCertificates }: TLSClientOptions): {
    getMetadata(): {
        cipherSuite: "TLS_CHACHA20_POLY1305_SHA256" | "TLS_AES_256_GCM_SHA384" | "TLS_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256" | "TLS_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA" | "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA" | undefined;
        keyType: TLSKeyType | undefined;
        version: "TLS1_3" | "TLS1_2" | undefined;
        selectedAlpn: string | undefined;
    };
    hasEnded(): boolean;
    /**
     * Get the current traffic keys
     */
    getKeys(): {
        recordSendCount: number;
        recordRecvCount: number;
        type: "TLS1_3";
        masterSecret: Uint8Array<ArrayBufferLike>;
        clientSecret: Uint8Array<ArrayBuffer>;
        serverSecret: Uint8Array<ArrayBuffer>;
        clientEncKey: unknown;
        serverEncKey: unknown;
        clientIv: Uint8Array<ArrayBuffer>;
        serverIv: Uint8Array<ArrayBuffer>;
    } | {
        recordSendCount: number;
        recordRecvCount: number;
        type: "TLS1_2";
        masterSecret: Uint8Array<ArrayBuffer>;
        clientMacKey: unknown;
        serverMacKey: unknown;
        clientEncKey: unknown;
        serverEncKey: unknown;
        clientIv: Uint8Array<ArrayBuffer>;
        serverIv: Uint8Array<ArrayBuffer>;
        serverSecret: Uint8Array<ArrayBuffer>;
        clientSecret: Uint8Array<ArrayBuffer>;
    } | undefined;
    /**
     * Session ID used to connect to the server
     */
    getSessionId(): Uint8Array<ArrayBufferLike>;
    isHandshakeDone(): boolean;
    getPskFromTicket(ticket: TLSSessionTicket): Promise<{
        identity: Uint8Array<ArrayBufferLike>;
        ticketAge: number;
        finishKey: unknown;
        resumeMasterSecret: Uint8Array<ArrayBuffer>;
        earlySecret: Uint8Array<ArrayBufferLike>;
        cipherSuite: "TLS_CHACHA20_POLY1305_SHA256" | "TLS_AES_256_GCM_SHA384" | "TLS_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256" | "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256" | "TLS_RSA_WITH_AES_128_GCM_SHA256" | "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384" | "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA" | "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA";
    }>;
    /**
     * Start the handshake with the server
     */
    startHandshake(opts?: TLSHandshakeOptions): Promise<void>;
    /**
     * Handle bytes received from the server.
     * Could be a complete or partial TLS packet
     */
    handleReceivedBytes(data: Uint8Array): Promise<void>;
    /**
     * Handle a complete TLS packet received
     * from the server
     */
    handleReceivedPacket: (pkt: TLSPacketWithType) => Promise<unknown>;
    /**
     * Utilise the KeyUpdate handshake message to update
     * the traffic keys. Available only in TLS 1.3
     * @param requestUpdateFromServer should the server be requested to
     * update its keys as well
     */
    updateTrafficKeys(requestUpdateFromServer?: boolean): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    end: (error?: Error) => Promise<void>;
};
