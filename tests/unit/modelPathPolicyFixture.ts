import type { ModelPathWhitelist } from "../../core/modelPathWhitelist";

/** Explicit policy installed by routing tests, never a runtime default. */
export const TEST_MODEL_PATH_POLICY: ModelPathWhitelist = {
  "deepseek-v4.1-flash": {
    routes: [
      { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
      { url: "https://openrouter.ai/api/v1", endpoint: "fireworks" },
      { url: "https://api.ppq.ai" },
      { url: "https://openrouter.ai/api/v1", endpoint: "venice/fp8" },
      { url: "https://openrouter.ai/api/v1", endpoint: "wafer" },
      { url: "https://api.venice.ai/api/v1" },
      { url: "https://api.fireworks.ai/inference/v1" },
    ],
    nodes: [
      "https://ai.redsh1ft.com",
      "https://routstr.otrta.me",
      "https://api.nonkycai.com",
    ],
  },
};
