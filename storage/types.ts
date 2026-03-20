export interface StorageDriver {
  getItem<T>(key: string, defaultValue: T): Promise<T>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SdkStorageState {
  modelsFromAllProviders: Record<string, import("../core").Model[]>;
  lastUsedModel: string | null;
  baseUrlsList: string[];
  disabledProviders: string[];
  mintsFromAllProviders: Record<string, string[]>;
  infoFromAllProviders: Record<string, import("../core").ProviderInfo>;
  lastModelsUpdate: Record<string, number>;
  lastBaseUrlsUpdate: number | null;
  cachedTokens: Array<{
    baseUrl: string;
    token: string;
    balance: number;
    lastUsed: number | null;
  }>;
  apiKeys: Array<{
    baseUrl: string;
    key: string;
    balance: number;
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
  routstr21Models: string[];
  lastRoutstr21ModelsUpdate: number | null;
  cachedReceiveTokens: Array<{
    token: string;
    amount: number;
    unit: "sat" | "msat";
    createdAt: number;
  }>;
  usageTracking: Array<{
    id: string;
    timestamp: number;
    modelId: string;
    baseUrl: string;
    requestId: string;
    cost: number;
    satsCost: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    client?: string;
    sessionId?: string;
    tags?: string[];
  }>;
  clientIds: Array<{
    clientId: string;
    name: string;
    apiKey: string;
    baseUrl: string;
    createdAt: number;
    lastUsed?: number | null;
  }>;
}
