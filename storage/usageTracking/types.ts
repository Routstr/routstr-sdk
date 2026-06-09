export interface UsageTrackingEntry {
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
  /** Upstream provider/route that handled the request (e.g. "openrouter:openrouter:Anthropic"). */
  provider?: string;
  /** Detailed cost breakdown from the upstream `cost` object. */
  baseMsats?: number;
  inputMsats?: number;
  outputMsats?: number;
  totalMsats?: number;
  totalUsd?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadMsats?: number;
  cacheCreationMsats?: number;
  remainingBalanceMsats?: number;
}
