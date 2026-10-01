import { SDK_STORAGE_KEYS } from "./keys";

const CREDENTIAL_KEYS = new Set<string>([
  SDK_STORAGE_KEYS.API_KEYS,
  SDK_STORAGE_KEYS.CHILD_KEYS,
  SDK_STORAGE_KEYS.XCASHU_TOKENS,
  SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS,
]);

/** Writes protecting money must never report success after a storage failure. */
export const isCredentialStorageKey = (key: string): boolean =>
  CREDENTIAL_KEYS.has(key);
