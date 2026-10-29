import type {
  BeginRequestLifecycleOptions,
  RequestLifecycleContext,
  RequestLifecycleSummary,
  RequestLifecycleAttempt,
  RequestLifecycleDriver,
} from "./types";
import { createMemoryRequestLifecycleDriver } from "./memory";
import { createIndexedDBRequestLifecycleDriver } from "./indexedDB";
import { safeCode, safeEventData, sanitizeFields, safeUrl } from "./privacy";
let defaultDriver: RequestLifecycleDriver | undefined;
let instanceId: string | undefined;
export function getDefaultRequestLifecycleDriver(): RequestLifecycleDriver {
  return (defaultDriver ??=
    typeof indexedDB !== "undefined"
      ? createIndexedDBRequestLifecycleDriver()
      : createMemoryRequestLifecycleDriver());
}
export function setDefaultRequestLifecycleDriver(
  driver: RequestLifecycleDriver,
): void {
  defaultDriver = driver;
}
/** Custom provider-proxied POST paths are eligible; known metadata prefixes are not. */
export function shouldTrackRequestLifecycle(
  method: string,
  path: string,
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const p = path
    .split("?")[0]
    .replace(/^\/(?:api\/)?v\d+\//, "/")
    .toLowerCase();
  return !/^\/(?:models?|discovery|wallet|admin|health|healthz|ready|ping|balance|refund|topup|keys?|usage|requests|providers?|mints?|auth)(?:\/|$)/.test(
    p,
  );
}
export async function beginRequestLifecycle(
  options: BeginRequestLifecycleOptions,
): Promise<RequestLifecycleContext> {
  const driver = options.driver ?? getDefaultRequestLifecycleDriver();
  const now = Date.now();
  const request: RequestLifecycleSummary = {
    requestId: globalThis.crypto.randomUUID(),
    ownerInstanceId:
      options.ownerInstanceId ??
      (instanceId ??= globalThis.crypto.randomUUID()),
    method: options.method,
    path: options.path.split("?")[0],
    requestedModelId: options.modelId,
    clientId: options.clientId,
    callerRequestId: options.callerRequestId,
    stream: options.stream,
    mode: options.mode,
    startedAt: now,
    updatedAt: now,
    outcome: "in_progress",
    attemptCount: 0,
    retryCount: 0,
    failoverCount: 0,
    providerCount: 0,
  };
  const errors: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  let terminal = false;
  let sequence = 0;
  let previousBaseUrl: string | undefined;
  let pendingPreflightFailover = false;
  const providers = new Set<string>();
  const attempts = new Map<string, RequestLifecycleAttempt>();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    queue = queue.then(operation).catch(() => {
      const message = "Request lifecycle persistence failed";
      if (errors.length < 100) errors.push(message);
      try {
        (options.logger ?? console).error(
          `[request:${request.requestId}] ${message}`,
        );
      } catch {
        /* logging is also fail-open */
      }
    });
    return queue;
  };
  const append = async (
    type: string,
    data?: Record<string, unknown>,
    scope?: { attemptId?: string; baseUrl?: string },
  ) => {
    await driver.appendEvent({
      eventId: globalThis.crypto.randomUUID(),
      requestId: request.requestId,
      sequence: ++sequence,
      timestamp: Date.now(),
      type: safeCode(type) ?? "event",
      attemptId: scope?.attemptId,
      baseUrl: scope?.baseUrl ? safeUrl(scope.baseUrl) : undefined,
      data: safeEventData(data),
    });
  };
  await enqueue(async () => {
    await driver.migrate();
    await driver.createRequest(sanitizeFields(request));
    await append("request_started");
  });
  return {
    requestId: request.requestId,
    trackingErrors: errors,
    updateRequest(fields) {
      if (terminal) return queue;
      const { modelId, ...rest } = fields;
      return enqueue(async () => {
        Object.assign(
          request,
          sanitizeFields({
            ...rest,
            ...(modelId !== undefined ? { requestedModelId: modelId } : {}),
            updatedAt: Date.now(),
          }),
        );
        await driver.updateRequest(request.requestId, request);
      });
    },
    async beginAttempt(input) {
      if (terminal)
        throw new Error("Cannot begin attempt after lifecycle finalization");
      // Allocate in invocation order before the first await, not DB completion order.
      const baseUrl = safeUrl(input.baseUrl);
      const changed =
        previousBaseUrl !== undefined && previousBaseUrl !== baseUrl;
      const kind =
        input.kind ??
        (request.attemptCount === 0
          ? "initial"
          : changed
            ? "provider_failover"
            : "same_provider_retry");
      const attempt: RequestLifecycleAttempt = sanitizeFields({
        ...input,
        baseUrl,
        kind,
        attemptId: globalThis.crypto.randomUUID(),
        requestId: request.requestId,
        ordinal: ++request.attemptCount,
        startedAt: Date.now(),
        outcome: "in_progress",
      });
      if (changed || kind === "provider_failover") {
        if (!pendingPreflightFailover) request.failoverCount++;
      } else if (kind === "same_provider_retry" || kind === "mint_retry")
        request.retryCount++;
      pendingPreflightFailover = false;
      providers.add(baseUrl);
      request.providerCount = providers.size;
      previousBaseUrl = baseUrl;
      request.finalBaseUrl = baseUrl;
      request.finalAttemptId = attempt.attemptId;
      attempts.set(attempt.attemptId, attempt);
      await enqueue(async () => {
        await driver.createAttempt(attempt);
        await driver.updateRequest(request.requestId, {
          ...request,
          updatedAt: Date.now(),
        });
        await append(
          "attempt_started",
          { kind, ordinal: attempt.ordinal },
          { attemptId: attempt.attemptId, baseUrl },
        );
      });
      return attempt;
    },
    updateAttempt(attemptId, fields) {
      if (terminal) return queue;
      return enqueue(async () => {
        const attempt = attempts.get(attemptId);
        if (!attempt) return;
        Object.assign(attempt, sanitizeFields(fields), {
          attemptId,
          requestId: request.requestId,
          ordinal: attempt.ordinal,
        });
        await driver.updateAttempt(attemptId, attempt);
      });
    },
    event(type, data, scope) {
      if (terminal) return queue;
      if (type === "preflight_provider_failover") {
        request.failoverCount++;
        pendingPreflightFailover = true;
      }
      return enqueue(async () => {
        await append(type, data, scope);
        await driver.updateRequest(request.requestId, {
          failoverCount: request.failoverCount,
          updatedAt: Date.now(),
        });
      });
    },
    finish(input) {
      if (terminal) return queue;
      terminal = true;
      return enqueue(async () => {
        const endedAt = Date.now();
        Object.assign(request, sanitizeFields(input), {
          endedAt,
          updatedAt: endedAt,
          durationMs: endedAt - request.startedAt,
        });
        for (const a of attempts.values())
          if (a.outcome === "in_progress") {
            a.outcome =
              input.outcome === "succeeded"
                ? "succeeded"
                : input.outcome === "aborted"
                  ? "aborted"
                  : "failed";
            a.endedAt = endedAt;
            await driver.updateAttempt(a.attemptId, a);
          }
        await driver.updateRequest(request.requestId, request);
        await append("request_finished", {
          outcome: input.outcome,
          httpStatus: input.httpStatus,
        });
      });
    },
  };
}
