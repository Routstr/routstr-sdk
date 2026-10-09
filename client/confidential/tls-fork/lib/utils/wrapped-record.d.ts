import type { CipherSuite, Key, TLSProtocolVersion } from '../types/index.js';
import type { PacketHeaderOptions } from './packets.js';
type WrappedRecordMacGenOptions = {
    macKey?: Key;
    recordNumber: number | undefined;
    cipherSuite: CipherSuite;
    version: TLSProtocolVersion;
} & ({
    recordHeaderOpts: PacketHeaderOptions;
} | {
    recordHeader: Uint8Array;
});
type WrappedRecordCipherOptions = {
    iv: Uint8Array;
    key: Key;
} & WrappedRecordMacGenOptions;
export declare function decryptWrappedRecord(encryptedData: Uint8Array, opts: WrappedRecordCipherOptions): Promise<{
    plaintext: Uint8Array<ArrayBufferLike>;
    iv: Uint8Array<ArrayBufferLike>;
}>;
export declare function encryptWrappedRecord(plaintext: Uint8Array, opts: WrappedRecordCipherOptions): Promise<{
    ciphertext: Uint8Array<ArrayBufferLike>;
    iv: Uint8Array<ArrayBufferLike>;
}>;
export {};
