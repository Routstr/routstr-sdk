export const crypto = {};
export function setCryptoImplementation(impl) {
    Object.assign(crypto, impl);
}
