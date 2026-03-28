export const SDK_STORAGE_KEYS = {
  MODELS_FROM_ALL_PROVIDERS: "modelsFromAllProviders",
  LAST_USED_MODEL: "lastUsedModel",
  BASE_URLS_LIST: "base_urls_list",
  DISABLED_PROVIDERS: "disabled_providers",
  MINTS_FROM_ALL_PROVIDERS: "mints_from_all_providers",
  INFO_FROM_ALL_PROVIDERS: "info_from_all_providers",
  LAST_MODELS_UPDATE: "lastModelsUpdate",
  LAST_BASE_URLS_UPDATE: "lastBaseUrlsUpdate",
  API_KEYS: "api_keys",
  CHILD_KEYS: "child_keys",
  XCASHU_TOKENS: "xcashu_tokens",
  ROUTSTR21_MODELS: "routstr21Models",
  LAST_ROUTSTR21_MODELS_UPDATE: "lastRoutstr21ModelsUpdate",
  CACHED_RECEIVE_TOKENS: "cached_receive_tokens",
  USAGE_TRACKING: "usage_tracking",
  CLIENT_IDS: "client_ids",
} as const;

export type SdkStorageKey =
  (typeof SDK_STORAGE_KEYS)[keyof typeof SDK_STORAGE_KEYS];
