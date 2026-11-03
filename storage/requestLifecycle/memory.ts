import type {
  RequestLifecycleDriver,
  RequestLifecycleTrace,
  ListRequestLifecycleOptions,
} from "./types";
import { sanitizeFields, safeEventData, safeUrl } from "./privacy";
export interface MemoryRequestLifecycleDriverOptions {
  maxRequests?: number;
  maxEventsPerRequest?: number;
  maxAttemptsPerRequest?: number;
}
export function matchesLifecycle(
  trace: RequestLifecycleTrace,
  o: ListRequestLifecycleOptions,
): boolean {
  const r = trace.request;
  return (
    (o.before === undefined || r.startedAt < o.before) &&
    (o.after === undefined || r.startedAt > o.after) &&
    (!o.outcome || r.outcome === o.outcome) &&
    (!o.modelId || r.requestedModelId === o.modelId) &&
    (!o.clientId || r.clientId === o.clientId) &&
    (!o.baseUrl ||
      trace.attempts.some((a) => a.baseUrl === safeUrl(o.baseUrl!)))
  );
}
export function createMemoryRequestLifecycleDriver(
  options: MemoryRequestLifecycleDriverOptions = {},
): RequestLifecycleDriver {
  const traces = new Map<string, RequestLifecycleTrace>();
  const max = Math.max(1, options.maxRequests ?? 1000);
  const maxEvents = Math.max(1, options.maxEventsPerRequest ?? 1000);
  const maxAttempts = Math.max(1, options.maxAttemptsPerRequest ?? 1000);
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    async migrate() {},
    async createRequest(r) {
      if (traces.has(r.requestId))
        throw new Error("Duplicate lifecycle request");
      traces.set(r.requestId, {
        request: copy(sanitizeFields(r)),
        attempts: [],
        events: [],
      });
      while (traces.size > max) traces.delete(traces.keys().next().value!);
    },
    async updateRequest(id, fields) {
      const t = traces.get(id);
      if (t)
        Object.assign(t.request, copy(sanitizeFields(fields)), {
          requestId: id,
        });
    },
    async createAttempt(a) {
      const t = traces.get(a.requestId);
      if (!t) return;
      if (
        t.attempts.some(
          (x) => x.attemptId === a.attemptId || x.ordinal === a.ordinal,
        )
      )
        throw new Error("Duplicate lifecycle attempt");
      t.attempts.push(copy(sanitizeFields(a)));
      if (t.attempts.length > maxAttempts)
        t.attempts.splice(0, t.attempts.length - maxAttempts);
    },
    async updateAttempt(id, fields) {
      for (const t of traces.values()) {
        const a = t.attempts.find((a) => a.attemptId === id);
        if (a)
          Object.assign(a, copy(sanitizeFields(fields)), {
            attemptId: id,
            requestId: a.requestId,
            ordinal: a.ordinal,
          });
      }
    },
    async appendEvent(e) {
      const t = traces.get(e.requestId);
      if (!t) return;
      if (
        t.events.some(
          (x) => x.sequence === e.sequence || x.eventId === e.eventId,
        )
      )
        throw new Error("Duplicate lifecycle event");
      t.events.push(
        copy({ ...sanitizeFields(e), data: safeEventData(e.data) }),
      );
      if (t.events.length > maxEvents)
        t.events.splice(0, t.events.length - maxEvents);
    },
    async list(o = {}) {
      return [...traces.values()]
        .filter((t) => matchesLifecycle(t, o))
        .sort((a, b) => b.request.startedAt - a.request.startedAt)
        .slice(0, Math.max(0, o.limit ?? 100))
        .map((t) => copy(t.request));
    },
    async getTrace(id) {
      const t = traces.get(id);
      return t
        ? copy({
            ...t,
            attempts: [...t.attempts].sort((a, b) => a.ordinal - b.ordinal),
            events: [...t.events].sort((a, b) => a.sequence - b.sequence),
          })
        : undefined;
    },
    async deleteOlderThan(ts) {
      let n = 0;
      for (const [id, t] of traces)
        if (t.request.startedAt < ts) {
          traces.delete(id);
          n++;
        }
      return n;
    },
    async clear() {
      traces.clear();
    },
    async reconcileInterrupted(owner) {
      let n = 0;
      const now = Date.now();
      for (const t of traces.values())
        if (
          t.request.ownerInstanceId === owner &&
          t.request.outcome === "in_progress"
        ) {
          Object.assign(t.request, {
            outcome: "interrupted",
            updatedAt: now,
            endedAt: now,
            durationMs: now - t.request.startedAt,
          });
          for (const a of t.attempts)
            if (a.outcome === "in_progress")
              Object.assign(a, { outcome: "failed", endedAt: now });
          t.events.push({
            eventId: globalThis.crypto.randomUUID(),
            requestId: t.request.requestId,
            sequence: (t.events.at(-1)?.sequence ?? 0) + 1,
            timestamp: now,
            type: "request_interrupted",
          });
          n++;
        }
      return n;
    },
  };
}
