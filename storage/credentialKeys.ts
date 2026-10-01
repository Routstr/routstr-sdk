import { SDK_STORAGE_KEYS } from "./keys";

/** Money-bearing storage keys and their in-memory state fields. */
export const CREDENTIAL_KEYS = {
  [SDK_STORAGE_KEYS.API_KEYS]: "apiKeys",
  [SDK_STORAGE_KEYS.CHILD_KEYS]: "childKeys",
  [SDK_STORAGE_KEYS.XCASHU_TOKENS]: "xcashuTokens",
  [SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS]: "cachedReceiveTokens",
} as const;

export const isCredentialStorageKey = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(CREDENTIAL_KEYS, key);
