import { SUPPORTED_EXTENSION_MAP, SUPPORTED_EXTENSIONS, SUPPORTED_NAMED_CURVE_MAP, SUPPORTED_NAMED_CURVES } from "./constants.js";
import { areUint8ArraysEqual, getTlsVersionFromBytes, uint8ArrayToBinaryStr } from "./generics.js";
import { expectReadWithLength } from "./packets.js";
/**
 * Parse a length-encoded list of extensions
 * sent by the server
 */
export function parseServerExtensions(data) {
    return parseExtensions(data, {
        'ALPN': (extData) => {
            const data = expectReadWithLength(extData);
            const alpnBytes = expectReadWithLength(data, 1);
            return uint8ArrayToBinaryStr(alpnBytes);
        },
        'SUPPORTED_VERSIONS': getTlsVersionFromBytes,
        'PRE_SHARED_KEY': () => ({ supported: true }),
        'KEY_SHARE': (extData) => {
            const typeBytes = extData.slice(0, 2);
            const type = SUPPORTED_NAMED_CURVES
                .find(k => areUint8ArraysEqual(SUPPORTED_NAMED_CURVE_MAP[k].identifier, typeBytes));
            if (!type) {
                throw new Error(`Unsupported key type '${typeBytes}'`);
            }
            const publicKey = expectReadWithLength(extData.slice(2));
            return { type, publicKey };
        }
    });
}
/**
 * Parse a length-encoded list of extensions
 * sent by the client
 */
export function parseClientExtensions(data) {
    return parseExtensions(data, {
        'SERVER_NAME': (extData) => {
            extData = expectReadWithLength(extData);
            const byte = extData[0];
            extData = extData.slice(1);
            const serverNameBytes = expectReadWithLength(extData);
            return {
                type: byte,
                serverName: uint8ArrayToBinaryStr(serverNameBytes)
            };
        }
    });
}
function parseExtensions(data, parsers) {
    data = readWLength(2);
    const map = {};
    const seenExtensions = new Set();
    while (data.length) {
        // FORK PATCH (TLS-07): the full 16-bit extension type is used
        // (known types all have a zero high byte) and duplicates abort
        // (RFC 8446 4.2). Unknown extension types are still skipped.
        if (data.length < 4) {
            throw new Error('Truncated extension');
        }
        const typeBytes = read(2);
        const typeNum = (typeBytes[0] << 8) | typeBytes[1];
        const extData = readWLength(2);
        const type = SUPPORTED_EXTENSIONS
            .find(k => SUPPORTED_EXTENSION_MAP[k] === typeNum);
        if (seenExtensions.has(typeNum)) {
            throw new Error(`Duplicate extension '${type}' (${typeNum})`);
        }
        seenExtensions.add(typeNum);
        if (type && type in parsers) {
            map[type] = parsers[type](extData);
        }
    }
    return map;
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
