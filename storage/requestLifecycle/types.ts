import type { SdkLogger } from "../../core/types";

export type RequestLifecycleOutcome =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";
export type RequestLifecycleAttemptKind =
  | "initial"
  | "same_provider_retry"
  | "provider_failover"
  | "mint_retry";
export interface RequestLifecycleSummary {
  requestId: string;
  ownerInstanceId: string;
  callerRequestId?: string;
  method: string;
  path: string;
  requestedModelId?: string;
  stream?: boolean;
  mode?: "xcashu" | "apikeys";
  clientId?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  durationMs?: number;
  outcome: RequestLifecycleOutcome;
  httpStatus?: number;
  finalBaseUrl?: string;
  finalAttemptId?: string;
  attemptCount: number;
  retryCount: number;
  failoverCount: number;
  providerCount: number;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  upstreamResponseId?: string;
  usageEntryId?: string;
}
export interface RequestLifecycleAttempt {
  attemptId: string;
  requestId: string;
  ordinal: number;
  kind: RequestLifecycleAttemptKind;
  baseUrl: string;
  modelId?: string;
  modelPath?: string;
  startedAt: number;
  headersReceivedAt?: number;
  endedAt?: number;
  httpStatus?: number;
  outcome: "in_progress" | "succeeded" | "failed" | "stream_error" | "aborted";
  failurePhase?: "funding" | "network" | "response" | "stream";
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  nodeRequestId?: string;
  upstreamResponseId?: string;
  requestLogId?: string;
}
export interface RequestLifecycleEvent {
  eventId: string;
  requestId: string;
  attemptId?: string;
  sequence: number;
  timestamp: number;
  type: string;
  baseUrl?: string;
  data?: Record<string, string | number | boolean | null>;
}
export interface RequestLifecycleTrace {
  request: RequestLifecycleSummary;
  attempts: RequestLifecycleAttempt[];
  events: RequestLifecycleEvent[];
}
export interface ListRequestLifecycleOptions {
  limit?: number;
  before?: number;
  after?: number;
  outcome?: RequestLifecycleOutcome;
  modelId?: string;
  baseUrl?: string;
  clientId?: string;
}
export interface RequestLifecycleDriver {
  migrate(): Promise<void>;
  createRequest(request: RequestLifecycleSummary): Promise<void>;
  updateRequest(
    requestId: string,
    fields: Partial<RequestLifecycleSummary>,
  ): Promise<void>;
  createAttempt(attempt: RequestLifecycleAttempt): Promise<void>;
  updateAttempt(
    attemptId: string,
    fields: Partial<RequestLifecycleAttempt>,
  ): Promise<void>;
  appendEvent(event: RequestLifecycleEvent): Promise<void>;
  list(
    options?: ListRequestLifecycleOptions,
  ): Promise<RequestLifecycleSummary[]>;
  getTrace(requestId: string): Promise<RequestLifecycleTrace | undefined>;
  deleteOlderThan(timestamp: number): Promise<number>;
  clear(): Promise<void>;
  /** Reconcile only this EXACT previous owner, never all active SDK owners. */
  reconcileInterrupted(ownerInstanceId: string): Promise<number>;
}
export interface BeginRequestLifecycleOptions {
  driver?: RequestLifecycleDriver;
  ownerInstanceId?: string;
  method: string;
  path: string;
  modelId?: string;
  clientId?: string;
  callerRequestId?: string;
  stream?: boolean;
  mode?: "xcashu" | "apikeys";
  logger?: SdkLogger;
}
export interface FinishRequestLifecycleInput {
  outcome: Exclude<RequestLifecycleOutcome, "in_progress">;
  httpStatus?: number;
  finalBaseUrl?: string;
  finalAttemptId?: string;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  upstreamResponseId?: string;
  usageEntryId?: string;
}
export interface BeginRequestLifecycleAttemptInput {
  baseUrl: string;
  modelId?: string;
  modelPath?: string;
  kind?: RequestLifecycleAttemptKind;
}
export interface RequestLifecycleContext {
  readonly requestId: string;
  /** Fail-open storage diagnostics, never raw provider errors or payloads. */
  readonly trackingErrors: readonly string[];
  updateRequest(fields: {
    modelId?: string;
    clientId?: string;
    stream?: boolean;
    callerRequestId?: string;
  }): Promise<void>;
  beginAttempt(
    input: BeginRequestLifecycleAttemptInput,
  ): Promise<RequestLifecycleAttempt>;
  updateAttempt(
    attemptId: string,
    fields: Partial<RequestLifecycleAttempt>,
  ): Promise<void>;
  event(
    type: string,
    data?: Record<string, unknown>,
    scope?: { attemptId?: string; baseUrl?: string },
  ): Promise<void>;
  finish(input: FinishRequestLifecycleInput): Promise<void>;
}
