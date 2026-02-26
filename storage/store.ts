import { createStore } from "zustand/vanilla";
import type { DiscoveryAdapter } from "../discovery/interfaces";
import type { StorageAdapter, ProviderRegistry } from "../wallet/interfaces";
import type { ProviderInfo, Model } from "../core";
import { getDecodedToken } from "@cashu/cashu-ts";
import { SDK_STORAGE_KEYS } from "./keys";
import type { StorageDriver, SdkStorageState } from "./types";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const getTokenBalance = (token: string): number => {
  try {
    const decoded = getDecodedToken(token);
    const unitDivisor = decoded.unit === "msat" ? 1000 : 1;
    let sum = 0;
    for (const proof of decoded.proofs) {
      sum += proof.amount / unitDivisor;
    }
    return sum;
  } catch {
    return 0;
  }
};

export interface SdkStoreOptions {
  driver: StorageDriver;
}

export interface SdkStorageStore extends SdkStorageState {
  setModelsFromAllProviders: (value: Record<string, Model[]>) => void;
  setLastUsedModel: (value: string | null) => void;
  setBaseUrlsList: (value: string[]) => void;
  setBaseUrlsLastUpdate: (value: number | null) => void;
  setDisabledProviders: (value: string[]) => void;
  setMintsFromAllProviders: (value: Record<string, string[]>) => void;
  setInfoFromAllProviders: (value: Record<string, ProviderInfo>) => void;
  setLastModelsUpdate: (value: Record<string, number>) => void;
  setCachedTokens: (
    value:
      | Array<{
          baseUrl: string;
          token: string;
          balance?: number;
          lastUsed?: number | null;
        }>
      | ((
          current: SdkStorageStore["cachedTokens"]
        ) => SdkStorageStore["cachedTokens"])
  ) => void;
  setApiKeys: (
    value:
      | Array<{
          baseUrl: string;
          key: string;
          balance?: number;
          lastUsed?: number | null;
        }>
      | ((current: SdkStorageStore["apiKeys"]) => SdkStorageStore["apiKeys"])
  ) => void;
  setChildKeys: (
    value: Array<{
      parentBaseUrl: string;
      childKey: string;
      balance: number;
      balanceLimit?: number;
      validityDate?: number;
      createdAt: number;
    }>
  ) => void;
}

export const createSdkStore = ({ driver }: SdkStoreOptions) => {
  return createStore<SdkStorageStore>((set, get) => ({
    modelsFromAllProviders: Object.fromEntries(
      Object.entries(
        driver.getItem<Record<string, Model[]>>(
          SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
          {}
        )
      ).map(([baseUrl, models]) => [normalizeBaseUrl(baseUrl), models])
    ),
    lastUsedModel: driver.getItem<string | null>(
      SDK_STORAGE_KEYS.LAST_USED_MODEL,
      null
    ),
    baseUrlsList: driver
      .getItem<string[]>(SDK_STORAGE_KEYS.BASE_URLS_LIST, [])
      .map((url) => normalizeBaseUrl(url)),
    lastBaseUrlsUpdate: driver.getItem<number | null>(
      SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE,
      null
    ),
    disabledProviders: driver
      .getItem<string[]>(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, [])
      .map((url) => normalizeBaseUrl(url)),
    mintsFromAllProviders: Object.fromEntries(
      Object.entries(
        driver.getItem<Record<string, string[]>>(
          SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS,
          {}
        )
      ).map(([baseUrl, mints]) => [
        normalizeBaseUrl(baseUrl),
        mints.map((mint) => (mint.endsWith("/") ? mint.slice(0, -1) : mint)),
      ])
    ),
    infoFromAllProviders: Object.fromEntries(
      Object.entries(
        driver.getItem<Record<string, ProviderInfo>>(
          SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS,
          {}
        )
      ).map(([baseUrl, info]) => [normalizeBaseUrl(baseUrl), info])
    ),
    lastModelsUpdate: Object.fromEntries(
      Object.entries(
        driver.getItem<Record<string, number>>(
          SDK_STORAGE_KEYS.LAST_MODELS_UPDATE,
          {}
        )
      ).map(([baseUrl, timestamp]) => [normalizeBaseUrl(baseUrl), timestamp])
    ),
    cachedTokens: driver
      .getItem<
        Array<{
          baseUrl: string;
          token: string;
          balance?: number;
          lastUsed?: number | null;
        }>
      >(SDK_STORAGE_KEYS.LOCAL_CASHU_TOKENS, [])
      .map((entry) => ({
        ...entry,
        baseUrl: normalizeBaseUrl(entry.baseUrl),
        balance:
          typeof entry.balance === "number"
            ? entry.balance
            : getTokenBalance(entry.token),
        lastUsed: entry.lastUsed ?? null,
      })),
    apiKeys: driver
      .getItem<
        Array<{
          baseUrl: string;
          key: string;
          balance?: number;
          lastUsed?: number | null;
        }>
      >(SDK_STORAGE_KEYS.API_KEYS, [])
      .map((entry) => ({
        ...entry,
        baseUrl: normalizeBaseUrl(entry.baseUrl),
        balance: entry.balance ?? 0,
        lastUsed: entry.lastUsed ?? null,
      })),
    childKeys: driver
      .getItem<
        Array<{
          parentBaseUrl: string;
          childKey: string;
          balance?: number;
          balanceLimit?: number;
          validityDate?: number;
          createdAt?: number;
        }>
      >(SDK_STORAGE_KEYS.CHILD_KEYS, [])
      .map((entry) => ({
        parentBaseUrl: normalizeBaseUrl(entry.parentBaseUrl),
        childKey: entry.childKey,
        balance: entry.balance ?? 0,
        balanceLimit: entry.balanceLimit,
        validityDate: entry.validityDate,
        createdAt: entry.createdAt ?? Date.now(),
      })),
    setModelsFromAllProviders: (value) => {
      const normalized: Record<string, Model[]> = {};
      for (const [baseUrl, models] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = models;
      }
      driver.setItem(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS, normalized);
      set({ modelsFromAllProviders: normalized });
    },
    setLastUsedModel: (value) => {
      driver.setItem(SDK_STORAGE_KEYS.LAST_USED_MODEL, value);
      set({ lastUsedModel: value });
    },
    setBaseUrlsList: (value) => {
      const normalized = value.map((url) => normalizeBaseUrl(url));
      driver.setItem(SDK_STORAGE_KEYS.BASE_URLS_LIST, normalized);
      set({ baseUrlsList: normalized });
    },
    setBaseUrlsLastUpdate: (value) => {
      driver.setItem(SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE, value);
      set({ lastBaseUrlsUpdate: value });
    },
    setDisabledProviders: (value) => {
      const normalized = value.map((url) => normalizeBaseUrl(url));
      driver.setItem(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, normalized);
      set({ disabledProviders: normalized });
    },
    setMintsFromAllProviders: (value) => {
      const normalized: Record<string, string[]> = {};
      for (const [baseUrl, mints] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = mints.map((mint) =>
          mint.endsWith("/") ? mint.slice(0, -1) : mint
        );
      }
      driver.setItem(SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS, normalized);
      set({ mintsFromAllProviders: normalized });
    },
    setInfoFromAllProviders: (value) => {
      const normalized: Record<string, ProviderInfo> = {};
      for (const [baseUrl, info] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = info;
      }
      driver.setItem(SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS, normalized);
      set({ infoFromAllProviders: normalized });
    },
    setLastModelsUpdate: (value) => {
      const normalized: Record<string, number> = {};
      for (const [baseUrl, timestamp] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = timestamp;
      }
      driver.setItem(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE, normalized);
      set({ lastModelsUpdate: normalized });
    },
    setCachedTokens: (value) => {
      set((state) => {
        const updates =
          typeof value === "function" ? value(state.cachedTokens) : value;
        const normalized = updates.map((entry) => ({
          ...entry,
          baseUrl: normalizeBaseUrl(entry.baseUrl),
          balance:
            typeof entry.balance === "number"
              ? entry.balance
              : getTokenBalance(entry.token),
          lastUsed: entry.lastUsed ?? null,
        }));
        driver.setItem(SDK_STORAGE_KEYS.LOCAL_CASHU_TOKENS, normalized);
        return { cachedTokens: normalized };
      });
    },
    setApiKeys: (value) => {
      set((state) => {
        const updates =
          typeof value === "function" ? value(state.apiKeys) : value;
        const normalized = updates.map((entry) => ({
          ...entry,
          baseUrl: normalizeBaseUrl(entry.baseUrl),
          balance: entry.balance ?? 0,
          lastUsed: entry.lastUsed ?? null,
        }));
        driver.setItem(SDK_STORAGE_KEYS.API_KEYS, normalized);
        return { apiKeys: normalized };
      });
    },
    setChildKeys: (
      value:
        | Array<{
            parentBaseUrl: string;
            childKey: string;
            balance?: number;
            balanceLimit?: number;
            validityDate?: number;
            createdAt?: number;
          }>
        | ((
            current: SdkStorageStore["childKeys"]
          ) => SdkStorageStore["childKeys"])
    ) => {
      set((state) => {
        const updates =
          typeof value === "function" ? value(state.childKeys) : value;
        const normalized = updates.map((entry) => ({
          parentBaseUrl: normalizeBaseUrl(entry.parentBaseUrl),
          childKey: entry.childKey,
          balance: entry.balance ?? 0,
          balanceLimit: entry.balanceLimit,
          validityDate: entry.validityDate,
          createdAt: entry.createdAt ?? Date.now(),
        }));
        driver.setItem(SDK_STORAGE_KEYS.CHILD_KEYS, normalized);
        return { childKeys: normalized };
      });
    },
  }));
};

export const createDiscoveryAdapterFromStore = (
  store: ReturnType<typeof createSdkStore>
): DiscoveryAdapter => ({
  getCachedModels: () => store.getState().modelsFromAllProviders,
  setCachedModels: (models) =>
    store.getState().setModelsFromAllProviders(models),
  getCachedMints: () => store.getState().mintsFromAllProviders,
  setCachedMints: (mints) => store.getState().setMintsFromAllProviders(mints),
  getCachedProviderInfo: () => store.getState().infoFromAllProviders,
  setCachedProviderInfo: (info) =>
    store.getState().setInfoFromAllProviders(info),
  getProviderLastUpdate: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const timestamps = store.getState().lastModelsUpdate;
    return timestamps[normalized] || null;
  },
  setProviderLastUpdate: (baseUrl, timestamp) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const timestamps = { ...store.getState().lastModelsUpdate };
    timestamps[normalized] = timestamp;
    store.getState().setLastModelsUpdate(timestamps);
  },
  getLastUsedModel: () => store.getState().lastUsedModel,
  setLastUsedModel: (modelId) => store.getState().setLastUsedModel(modelId),
  getDisabledProviders: () => store.getState().disabledProviders,
  getBaseUrlsList: () => store.getState().baseUrlsList,
  setBaseUrlsList: (urls) => store.getState().setBaseUrlsList(urls),
  getBaseUrlsLastUpdate: () => store.getState().lastBaseUrlsUpdate,
  setBaseUrlsLastUpdate: (timestamp) =>
    store.getState().setBaseUrlsLastUpdate(timestamp),
});

export const createStorageAdapterFromStore = (
  store: ReturnType<typeof createSdkStore>
): StorageAdapter => ({
  getToken: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const entry = store
      .getState()
      .cachedTokens.find((token) => token.baseUrl === normalized);
    if (!entry) return null;
    const next = store
      .getState()
      .cachedTokens.map((token) =>
        token.baseUrl === normalized
          ? { ...token, lastUsed: Date.now() }
          : token
      );
    store.getState().setCachedTokens(next);
    return entry.token;
  },
  setToken: (baseUrl, token) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const tokens = store.getState().cachedTokens;
    const balance = getTokenBalance(token);
    const existingIndex = tokens.findIndex(
      (entry) => entry.baseUrl === normalized
    );
    if (existingIndex !== -1) {
      throw new Error(`Token already exists for baseUrl: ${normalized}`);
    }
    const next = [...tokens];
    next.push({
      baseUrl: normalized,
      token,
      balance,
      lastUsed: Date.now(),
    });
    store.getState().setCachedTokens(next);
  },
  removeToken: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const next = store
      .getState()
      .cachedTokens.filter((entry) => entry.baseUrl !== normalized);
    store.getState().setCachedTokens(next);
  },
  updateTokenBalance: (baseUrl, balance) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const tokens = store.getState().cachedTokens;
    const next = tokens.map((entry) =>
      entry.baseUrl === normalized ? { ...entry, balance } : entry
    );
    store.getState().setCachedTokens(next);
  },
  getCachedTokenDistribution: () => {
    const cachedTokens = store.getState().cachedTokens;
    const distributionMap: Record<string, number> = {};

    for (const entry of cachedTokens) {
      const sum = entry.balance || 0;
      if (sum > 0) {
        distributionMap[entry.baseUrl] =
          (distributionMap[entry.baseUrl] || 0) + sum;
      }
    }

    return Object.entries(distributionMap)
      .map(([baseUrl, amt]) => ({ baseUrl, amount: amt }))
      .sort((a, b) => b.amount - a.amount);
  },
  getApiKeyDistribution: () => {
    const apiKeys = store.getState().apiKeys;
    const distributionMap: Record<string, number> = {};

    for (const entry of apiKeys) {
      const sum = entry.balance || 0;
      if (sum > 0) {
        distributionMap[entry.baseUrl] =
          (distributionMap[entry.baseUrl] || 0) + sum;
      }
    }

    return Object.entries(distributionMap)
      .map(([baseUrl, amt]) => ({ baseUrl, amount: amt }))
      .sort((a, b) => b.amount - a.amount);
  },
  saveProviderInfo: (baseUrl, info) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const next = { ...store.getState().infoFromAllProviders };
    next[normalized] = info;
    store.getState().setInfoFromAllProviders(next);
  },
  getProviderInfo: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    return store.getState().infoFromAllProviders[normalized] || null;
  },

  // ========== API Keys (for apikeys mode) ==========

  getApiKey: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const entry = store
      .getState()
      .apiKeys.find((key) => key.baseUrl === normalized);
    if (!entry) return null;
    // Update lastUsed timestamp
    const next = store
      .getState()
      .apiKeys.map((key) =>
        key.baseUrl === normalized ? { ...key, lastUsed: Date.now() } : key
      );
    store.getState().setApiKeys(next);
    return entry;
  },

  setApiKey: (baseUrl, key) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const keys = store.getState().apiKeys;
    const existingIndex = keys.findIndex(
      (entry) => entry.baseUrl === normalized
    );
    if (existingIndex !== -1) {
      throw new Error(`ApiKey already exists for baseUrl: ${normalized}`);
    }
    const next = [...keys];
    next.push({
      baseUrl: normalized,
      key,
      balance: 0,
      lastUsed: Date.now(),
    });
    store.getState().setApiKeys(next);
  },

  updateApiKeyBalance: (baseUrl, balance) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const keys = store.getState().apiKeys;
    const next = keys.map((entry) =>
      entry.baseUrl === normalized ? { ...entry, balance } : entry
    );
    store.getState().setApiKeys(next);
  },

  removeApiKey: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const next = store
      .getState()
      .apiKeys.filter((entry) => entry.baseUrl !== normalized);
    store.getState().setApiKeys(next);
  },

  getAllApiKeys: () => {
    return store.getState().apiKeys.map((entry) => ({
      baseUrl: entry.baseUrl,
      key: entry.key,
      balance: entry.balance,
      lastUsed: entry.lastUsed,
    }));
  },

  // ========== Child Keys ==========

  getChildKey: (parentBaseUrl) => {
    const normalized = normalizeBaseUrl(parentBaseUrl);
    const entry = store
      .getState()
      .childKeys.find((key) => key.parentBaseUrl === normalized);
    if (!entry) return null;
    return {
      parentBaseUrl: entry.parentBaseUrl,
      childKey: entry.childKey,
      balance: entry.balance,
      balanceLimit: entry.balanceLimit,
      validityDate: entry.validityDate,
      createdAt: entry.createdAt,
    };
  },

  setChildKey: (
    parentBaseUrl,
    childKey,
    balance,
    validityDate,
    balanceLimit
  ) => {
    const normalized = normalizeBaseUrl(parentBaseUrl);
    const keys = store.getState().childKeys;
    const existingIndex = keys.findIndex(
      (entry) => entry.parentBaseUrl === normalized
    );
    if (existingIndex !== -1) {
      // Update existing child key
      const next = keys.map((entry) =>
        entry.parentBaseUrl === normalized
          ? {
              ...entry,
              childKey,
              balance: balance ?? 0,
              validityDate,
              balanceLimit,
              createdAt: Date.now(),
            }
          : entry
      );
      store.getState().setChildKeys(next);
    } else {
      // Add new child key
      const next = [...keys];
      next.push({
        parentBaseUrl: normalized,
        childKey,
        balance: balance ?? 0,
        validityDate,
        balanceLimit,
        createdAt: Date.now(),
      });
      store.getState().setChildKeys(next);
    }
  },

  updateChildKeyBalance: (parentBaseUrl, balance) => {
    const normalized = normalizeBaseUrl(parentBaseUrl);
    const keys = store.getState().childKeys;
    const next = keys.map((entry) =>
      entry.parentBaseUrl === normalized ? { ...entry, balance } : entry
    );
    store.getState().setChildKeys(next);
  },

  removeChildKey: (parentBaseUrl) => {
    const normalized = normalizeBaseUrl(parentBaseUrl);
    const next = store
      .getState()
      .childKeys.filter((entry) => entry.parentBaseUrl !== normalized);
    store.getState().setChildKeys(next);
  },

  getAllChildKeys: () => {
    return store.getState().childKeys.map((entry) => ({
      parentBaseUrl: entry.parentBaseUrl,
      childKey: entry.childKey,
      balance: entry.balance,
      balanceLimit: entry.balanceLimit,
      validityDate: entry.validityDate,
      createdAt: entry.createdAt,
    }));
  },
});

export const createProviderRegistryFromStore = (
  store: ReturnType<typeof createSdkStore>
): ProviderRegistry => ({
  getModelsForProvider: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    return store.getState().modelsFromAllProviders[normalized] || [];
  },
  getDisabledProviders: () => store.getState().disabledProviders,
  getProviderMints: (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    return store.getState().mintsFromAllProviders[normalized] || [];
  },
  getProviderInfo: async (baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    const cached = store.getState().infoFromAllProviders[normalized];
    if (cached) return cached;
    try {
      const response = await fetch(`${normalized}v1/info`);
      if (!response.ok) {
        throw new Error(`Failed ${response.status}`);
      }
      const info = (await response.json()) as ProviderInfo;
      const next = { ...store.getState().infoFromAllProviders };
      next[normalized] = info;
      store.getState().setInfoFromAllProviders(next);
      return info;
    } catch (error) {
      console.warn(`Failed to fetch provider info from ${normalized}:`, error);
      return null;
    }
  },
  getAllProvidersModels: () => store.getState().modelsFromAllProviders,
});
