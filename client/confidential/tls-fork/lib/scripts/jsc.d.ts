import '../utils/additional-root-cas.js';
declare global {
    function readline(): string;
    function print(...args: any[]): void;
    function quit(): void;
    type JscIncomingCmd = {
        type: 'exit';
    } | {
        type: 'send';
        dataB64: string;
    } | {
        type: 'send-application-data';
        dataB64: string;
    } | {
        type: 'connect';
        host: string;
        rootCAs?: string[];
    };
    type JscOutgoingCmd = {
        type: 'send-application-data';
        dataB64: string;
    } | {
        type: 'send';
        dataB64: string;
    } | {
        type: 'handshake-done';
    };
}
