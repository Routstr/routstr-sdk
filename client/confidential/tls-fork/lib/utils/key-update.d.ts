import { KEY_UPDATE_TYPE_MAP } from './constants.js';
export declare function packKeyUpdateRecord(type: keyof typeof KEY_UPDATE_TYPE_MAP): Uint8Array<ArrayBufferLike>;
