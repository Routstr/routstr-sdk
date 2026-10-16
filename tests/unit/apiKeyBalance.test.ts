/**
 * Unit tests for the API-key balance helpers.
 *
 * `apiKeyBalanceSats` converts a provider read for arithmetic (keeps the msat
 * fraction); `persistApiKeyBalance` is the only writer and stores whole sats,
 * refusing reads that are unusable or that belong to a key storage no longer
 * holds.
 */

import { describe, expect, it } from "vitest";
import {
  apiKeyBalanceSats,
  persistApiKeyBalance,
  type ApiKeyBalanceStorage,
} from "../../wallet/apiKeyBalance";
import type { ApiKeyEntry } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const KEY = "sk_key_123";

const createStorage = (storedKey: string | null = KEY) => {
  const writes: Array<[string, number, number | undefined]> = [];
  const storage: ApiKeyBalanceStorage = {
    getApiKey: (baseUrl: string): ApiKeyEntry | null =>
      storedKey
        ? {
            baseUrl,
            key: storedKey,
            balance: 0,
            reserved: 0,
            lastUsed: null,
          }
        : null,
    updateApiKeyBalance: (baseUrl, balance, reserved) => {
      writes.push([baseUrl, balance, reserved]);
    },
  };
  return { storage, writes };
};

const read = (overrides: Record<string, unknown> = {}) => ({
  amount: 6000,
  reserved: 0,
  unit: "msat" as string,
  balanceUnknown: false,
  ...overrides,
});

describe("apiKeyBalanceSats", () => {
  it("converts msat to sats without rounding", () => {
    expect(apiKeyBalanceSats(read({ amount: 1500, reserved: 250 }))).toEqual({
      balance: 1.5,
      reserved: 0.25,
    });
  });

  it("passes sats through unchanged and defaults reserved to 0", () => {
    expect(apiKeyBalanceSats({ amount: 12, unit: "sat" })).toEqual({
      balance: 12,
      reserved: 0,
    });
  });

  it("returns undefined for a failed read, a missing read, or a negative amount", () => {
    expect(apiKeyBalanceSats(read({ balanceUnknown: true }))).toBeUndefined();
    expect(apiKeyBalanceSats(null)).toBeUndefined();
    expect(apiKeyBalanceSats(undefined)).toBeUndefined();
    expect(apiKeyBalanceSats(read({ amount: -1 }))).toBeUndefined();
    expect(apiKeyBalanceSats(read({ reserved: -1 }))).toBeUndefined();
  });
});

describe("persistApiKeyBalance", () => {
  it("stores whole sats for the key the read came from", () => {
    const { storage, writes } = createStorage();

    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 6000 }))
    ).toEqual({ balance: 6, reserved: 0 });
    expect(
      persistApiKeyBalance(
        storage,
        BASE_URL,
        KEY,
        read({ amount: 1500, reserved: 900 })
      )
    ).toEqual({ balance: 1, reserved: 0 });
    expect(writes).toEqual([
      [BASE_URL, 6, 0],
      [BASE_URL, 1, 0],
    ]);
  });

  it("writes nothing and returns undefined when the read is unusable", () => {
    const { storage, writes } = createStorage();

    expect(
      persistApiKeyBalance(
        storage,
        BASE_URL,
        KEY,
        read({ balanceUnknown: true })
      )
    ).toBeUndefined();
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: -1 }))
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("writes nothing when storage no longer holds the key that was read", () => {
    const { storage, writes } = createStorage("sk_canonical_key_456");

    expect(persistApiKeyBalance(storage, BASE_URL, KEY, read())).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("writes nothing when no key is stored at all", () => {
    const { storage, writes } = createStorage(null);

    expect(persistApiKeyBalance(storage, BASE_URL, KEY, read())).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
