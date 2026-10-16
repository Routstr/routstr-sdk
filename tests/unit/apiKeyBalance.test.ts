/**
 * Unit tests for `persistApiKeyBalance`, the only writer of API-key balances.
 * It stores whole sats and refuses reads that are unusable or that belong to a
 * key storage no longer holds.
 */

import { describe, expect, it } from "vitest";
import {
  persistApiKeyBalance,
  type BalanceRead,
} from "../../wallet/apiKeyBalance";
import type { ApiKeyEntry } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const KEY = "sk_key_123";

const read = (overrides: Partial<BalanceRead> = {}): BalanceRead => ({
  amount: 6000,
  reserved: 0,
  unit: "msat",
  apiKey: "",
  isInvalidApiKey: false,
  balanceUnknown: false,
  ...overrides,
});

const createStorage = (storedKey: string | null = KEY) => {
  const writes: Array<[string, number, number | undefined]> = [];
  const storage = {
    getApiKey: (baseUrl: string): ApiKeyEntry | null =>
      storedKey
        ? { baseUrl, key: storedKey, balance: 0, reserved: 0, lastUsed: null }
        : null,
    updateApiKeyBalance: (
      baseUrl: string,
      balance: number,
      reserved?: number
    ) => {
      writes.push([baseUrl, balance, reserved]);
    },
  };
  return { storage, writes };
};

describe("persistApiKeyBalance", () => {
  it("stores whole sats for the key the read came from", () => {
    const { storage, writes } = createStorage();

    expect(persistApiKeyBalance(storage, BASE_URL, KEY, read())).toEqual({
      balance: 6,
      reserved: 0,
    });
    // 1.5 sat is stored as 1: storage keeps whole sats.
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 1500 }))
    ).toEqual({ balance: 1, reserved: 0 });
    // A sats-denominated read is not divided.
    expect(
      persistApiKeyBalance(
        storage,
        BASE_URL,
        KEY,
        read({ amount: 12, unit: "sat", reserved: 3 })
      )
    ).toEqual({ balance: 12, reserved: 3 });
    expect(writes).toEqual([
      [BASE_URL, 6, 0],
      [BASE_URL, 1, 0],
      [BASE_URL, 12, 3],
    ]);
  });

  it("writes nothing when the read is unusable", () => {
    const { storage, writes } = createStorage();
    const unusable = [
      read({ balanceUnknown: true }),
      read({ amount: -1 }),
      read({ reserved: -1 }),
      null,
      undefined,
    ];

    for (const info of unusable) {
      expect(
        persistApiKeyBalance(storage, BASE_URL, KEY, info)
      ).toBeUndefined();
    }
    expect(writes).toEqual([]);
  });

  it.each([
    ["a replacement was stored", "sk_canonical_key_456"],
    ["no key is stored at all", null],
  ])("writes nothing when %s", (_case, storedKey) => {
    const { storage, writes } = createStorage(storedKey);

    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read())
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
