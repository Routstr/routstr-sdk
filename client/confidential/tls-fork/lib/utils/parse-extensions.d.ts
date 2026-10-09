import type { SupportedExtensionClientData, SupportedExtensionServerData } from '../types/index.js';
/**
 * Parse a length-encoded list of extensions
 * sent by the server
 */
export declare function parseServerExtensions(data: Uint8Array): Partial<SupportedExtensionServerData>;
/**
 * Parse a length-encoded list of extensions
 * sent by the client
 */
export declare function parseClientExtensions(data: Uint8Array): Partial<SupportedExtensionClientData>;
