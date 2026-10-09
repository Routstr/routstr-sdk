import type { CipherSuite } from '../types/index.js';
type VerifyFinishMessageOptions = {
    secret: Uint8Array;
    handshakeMessages: Uint8Array[];
    cipherSuite: CipherSuite;
};
export declare function verifyFinishMessage(verifyData: Uint8Array, opts: VerifyFinishMessageOptions): Promise<void>;
export declare function packFinishMessagePacket(opts: VerifyFinishMessageOptions): Promise<Uint8Array<ArrayBufferLike>>;
export declare function packClientFinishTls12(opts: VerifyFinishMessageOptions): Promise<Uint8Array<ArrayBufferLike>>;
export declare function generateFinishTls12(type: 'client' | 'server', { secret, handshakeMessages, cipherSuite }: VerifyFinishMessageOptions): Promise<Uint8Array<ArrayBuffer>>;
export {};
