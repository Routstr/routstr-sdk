// CLI script that can be run via javascriptcore (jsc)
// used to test that the TLS client works in the pure jsc environment
// pls build via esbuild first
import '../utils/additional-root-cas.js';
import { setCryptoImplementation } from "../crypto/index.js";
import { pureJsCrypto } from "../crypto/pure-js.js";
import { makeTLSClient } from "../make-tls-client.js";
import { concatenateUint8Arrays } from "../utils/generics.js";
setCryptoImplementation(pureJsCrypto);
async function main() {
    print('specify the host to connect to '
        + '(e.g. {"type":"connect", "host":"localhost:443"}):"}');
    const initCmd = readCmd();
    if (initCmd.type !== 'connect') {
        throw new Error('Expected connect command');
    }
    if (initCmd.rootCAs?.length) {
        TLS_ADDITIONAL_ROOT_CA_LIST.push(...initCmd.rootCAs);
        print(`Added ${initCmd.rootCAs.length} additional root CAs`);
    }
    const tls = makeTLSClient({
        host: initCmd.host,
        logger: {
            info: (...args) => print('[INFO]', ...args),
            debug: (...args) => print('[DEBUG]', ...args),
            trace: () => { },
            warn: (...args) => print('[WARN]', ...args),
            error: (...args) => print('[ERROR]', ...args),
        },
        write({ header, content }) {
            writeCmd({
                type: 'send',
                dataB64: bytesToB64(concatenateUint8Arrays([header, content]))
            });
        },
        onApplicationData(plaintext) {
            writeCmd({ type: 'send-application-data', dataB64: bytesToB64(plaintext) });
        },
        onTlsEnd(error) {
            print('TLS ended:', error);
            if (error) {
                throw error;
            }
            quit();
        },
        onHandshake() {
            writeCmd({ type: 'handshake-done' });
        },
    });
    await tls.startHandshake();
    let cmd;
    while (cmd = readCmd(), cmd.type !== 'exit') {
        if (cmd.type === 'send') {
            const data = base64ToBytes(cmd.dataB64);
            await tls.handleReceivedBytes(data);
            continue;
        }
        if (cmd.type === 'send-application-data') {
            const data = base64ToBytes(cmd.dataB64);
            await tls.write(data);
            continue;
        }
    }
    print('done ✅');
}
function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
function bytesToB64(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
function readCmd() {
    const cmd = readline();
    return JSON.parse(cmd);
}
function writeCmd(cmd) {
    print(JSON.stringify(cmd));
}
main()
    .catch(err => {
    print('error in main fn: ', err.message, '\n', err.stack || err);
    quit();
});
