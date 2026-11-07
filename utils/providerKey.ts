/** Coordination identity only; never rewrite the URL used for transport/storage. */
export function providerKey(baseUrl: string, token: string): string {
  return JSON.stringify([baseUrl.replace(/\/+$/, ""), token]);
}
