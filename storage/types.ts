export interface StorageDriver {
  getItem<T>(key: string, defaultValue: T): T;
  setItem<T>(key: string, value: T): void;
  removeItem(key: string): void;
}

export interface SdkStorageState {
  modelsFromAllProviders: Record<string, import("../core").Model[]>;
  modelProviderMap: Record<string, string>;
  lastUsedModel: string | null;
  baseUrlsList: string[];
  disabledProviders: string[];
  mintsFromAllProviders: Record<string, string[]>;
  infoFromAllProviders: Record<string, import("../core").ProviderInfo>;
  lastModelsUpdate: Record<string, number>;
  localCashuTokens: Array<{ baseUrl: string; token: string }>;
}
