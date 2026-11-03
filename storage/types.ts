export interface StorageDriver {
  getItem<T>(key: string, defaultValue: T): Promise<T>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SdkStorageState {
  nostrQueryLastUpdate: Record<string, number>;
  modelsFromAllProviders: Record<string, import("../core").Model[]>;
  lastUsedModel: string | null;
  baseUrlsList: string[];
  disabledProviders: string[];
  manuallyDisabledProviders: string[];
  manuallyEnabledProviders: string[];
  /** Review labels the user opted into on top of the SDK defaults (e.g. `sandbox`). */
  userEnabledReviewLabels: string[];
  mintsFromAllProviders: Record<string, string[]>;
  infoFromAllProviders: Record<string, import("../core").ProviderInfo>;
  lastModelsUpdate: Record<string, number>;
  lastBaseUrlsUpdate: number | null;
  apiKeys: Array<{
    baseUrl: string;
    key: string;
    /** Provider-reported available sats, already net of `reserved`. */
    balance: number;
    /** Last known reserved balance in sats, diagnostics only. Optional for
     *  old persisted state. */
    reserved?: number;
    lastUsed: number | null;
  }>;
  childKeys: Array<{
    parentBaseUrl: string;
    childKey: string;
    balance: number;
    balanceLimit?: number;
    validityDate?: number;
    createdAt: number;
  }>;
  xcashuTokens: Record<string, Array<{
    baseUrl: string;
    token: string;
    createdAt: number;
    tryCount: number;
  }>>;
  modelIdMappingsEvent: import("applesauce-core/helpers").NostrEvent | null;
  modelPathWhitelistEvent: import("applesauce-core/helpers").NostrEvent | null;
  modelIdMappings: import("../core/modelMappings").ModelIdMappings | null;
  modelPathWhitelist: import("../core/modelPathWhitelist").ModelPathWhitelist | null;
  lastModelIdMappingsUpdate: number | null;
  lastModelPathWhitelistUpdate: number | null;
  routstr21Models: string[];
  lastRoutstr21ModelsUpdate: number | null;
  cachedReceiveTokens: Array<{
    token: string;
    amount: number;
    unit: "sat" | "msat";
    createdAt: number;
  }>;
  clientIds: Array<{
    clientId: string;
    name: string;
    apiKey: string;
    createdAt: number;
    lastUsed?: number | null;
  }>;
  /** Set of failed provider URLs */
  failedProviders: string[];
  /** Map of provider URL -> timestamp of last failure */
  lastFailed: Record<string, number>;
  /** Providers currently on cooldown. Entries with `modelPath` cool down only
   * that upstream route on the provider; entries with `modelId` only cool down
   * that model; entries with neither cool down the whole provider. */
  /** Consecutive model/path failures, retained after cooldown expiry. */
  modelFailureStreaks: Array<{
    baseUrl: string;
    modelId?: string;
    modelPath?: string;
    failureStreak: number;
    /** Last failure for this scope; older entries are forgotten. */
    failedAt?: number;
  }>;
  providersOnCooldown: Array<{
    baseUrl: string;
    modelId?: string;
    modelPath?: string;
    timestamp: number;
    cooldownUntil?: number;
  }>;
}
