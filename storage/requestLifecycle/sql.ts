import type {
  RequestLifecycleDriver,
  RequestLifecycleSummary,
  RequestLifecycleAttempt,
  RequestLifecycleEvent,
} from "./types";
import { sanitizeFields, safeEventData, safeUrl } from "./privacy";
export interface LifecycleSqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: any[]): unknown;
    all(...params: any[]): any[];
    get(...params: any[]): any;
  };
}
const columns = {
  requests:
    "requestId ownerInstanceId callerRequestId method path requestedModelId stream mode clientId startedAt updatedAt endedAt durationMs outcome httpStatus finalBaseUrl finalAttemptId attemptCount retryCount failoverCount providerCount errorType errorCode errorMessage upstreamResponseId usageEntryId",
  request_attempts:
    "attemptId requestId ordinal kind baseUrl modelId modelPath startedAt headersReceivedAt endedAt httpStatus outcome failurePhase errorType errorCode errorMessage nodeRequestId upstreamResponseId requestLogId",
  request_events:
    "eventId requestId attemptId sequence timestamp type baseUrl data",
};
const numeric = new Set(
  "stream startedAt updatedAt endedAt durationMs httpStatus attemptCount retryCount failoverCount providerCount ordinal headersReceivedAt sequence timestamp".split(
    " ",
  ),
);
const snake = (s: string) => s.replace(/[A-Z]/g, (x) => `_${x.toLowerCase()}`);
const decode = (row: any) => {
  if (!row) return undefined;
  const result: any = {};
  for (const [k, v] of Object.entries(row))
    if (v !== null)
      result[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] =
        k === "data"
          ? JSON.parse(v as string)
          : k === "stream"
            ? Boolean(v)
            : v;
  return result;
};
export function createSqlLifecycleDriver(
  database: () => Promise<LifecycleSqlDatabase>,
): RequestLifecycleDriver {
  let ready: Promise<LifecycleSqlDatabase> | undefined;
  const db = () =>
    (ready ??= database().then((d) => {
      for (const [table, fields] of Object.entries(columns)) {
        const defs = fields
          .split(" ")
          .map(
            (f, i) =>
              `${snake(f)} ${numeric.has(f) ? "INTEGER" : "TEXT"}${i === 0 ? " PRIMARY KEY" : ""}`,
          );
        if (table !== "requests")
          defs.push(
            "FOREIGN KEY(request_id) REFERENCES requests(request_id) ON DELETE CASCADE",
          );
        if (table === "request_attempts")
          defs.push("UNIQUE(request_id,ordinal)");
        if (table === "request_events")
          defs.push("UNIQUE(request_id,sequence)");
        d.exec(`CREATE TABLE IF NOT EXISTS ${table} (${defs.join(",")})`);
      }
      d.exec(`CREATE INDEX IF NOT EXISTS lifecycle_requests_time ON requests(started_at);
      CREATE INDEX IF NOT EXISTS lifecycle_requests_owner ON requests(owner_instance_id,outcome);
      CREATE INDEX IF NOT EXISTS lifecycle_attempt_request ON request_attempts(request_id);
      CREATE INDEX IF NOT EXISTS lifecycle_attempt_provider ON request_attempts(base_url,started_at);
      CREATE INDEX IF NOT EXISTS lifecycle_attempt_node ON request_attempts(node_request_id);
      CREATE INDEX IF NOT EXISTS lifecycle_event_request ON request_events(request_id,sequence);`);
      return d;
    }));
  const insert = async (table: keyof typeof columns, row: object) => {
    const d = await db();
    const r = sanitizeFields(row) as any;
    if (table === "request_events") r.data = safeEventData(r.data);
    const keys = columns[table].split(" ");
    d.prepare(
      `INSERT INTO ${table} (${keys.map(snake).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(
      ...keys.map((k) =>
        r[k] === undefined
          ? null
          : k === "data"
            ? JSON.stringify(r[k])
            : typeof r[k] === "boolean"
              ? Number(r[k])
              : r[k],
      ),
    );
  };
  const update = async (
    table: keyof typeof columns,
    id: string,
    fields: object,
  ) => {
    const d = await db();
    const r = sanitizeFields(fields) as any;
    const primary = columns[table].split(" ")[0];
    const keys = columns[table]
      .split(" ")
      .filter((k) => k !== primary && Object.hasOwn(r, k));
    if (!keys.length) return;
    d.prepare(
      `UPDATE ${table} SET ${keys.map((k) => `${snake(k)}=?`).join(",")} WHERE ${snake(primary)}=?`,
    ).run(
      ...keys.map((k) =>
        r[k] === undefined
          ? null
          : typeof r[k] === "boolean"
            ? Number(r[k])
            : r[k],
      ),
      id,
    );
  };
  const deleteWhere = async (where: string, args: unknown[]) => {
    const d = await db();
    d.exec("BEGIN IMMEDIATE");
    try {
      const rows = d
        .prepare(`SELECT request_id FROM requests ${where}`)
        .all(...args);
      for (const r of rows)
        for (const table of ["request_events", "request_attempts", "requests"])
          d.prepare(`DELETE FROM ${table} WHERE request_id=?`).run(
            r.request_id,
          );
      d.exec("COMMIT");
      return rows.length;
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    async migrate() {
      await db();
    },
    createRequest: (r) => insert("requests", r),
    updateRequest: (id, f) => update("requests", id, f),
    createAttempt: (a) => insert("request_attempts", a),
    updateAttempt: (id, f) => update("request_attempts", id, f),
    appendEvent: (e) => insert("request_events", e),
    async list(o = {}) {
      const d = await db();
      const clauses: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        clauses.push(sql);
        args.push(value);
      };
      if (o.before !== undefined) add("started_at < ?", o.before);
      if (o.after !== undefined) add("started_at > ?", o.after);
      if (o.outcome) add("outcome=?", o.outcome);
      if (o.modelId) add("requested_model_id=?", o.modelId);
      if (o.clientId) add("client_id=?", o.clientId);
      if (o.baseUrl)
        add(
          "EXISTS (SELECT 1 FROM request_attempts a WHERE a.request_id=requests.request_id AND a.base_url=?)",
          safeUrl(o.baseUrl),
        );
      return d
        .prepare(
          `SELECT * FROM requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`,
        )
        .all(...args, Math.max(0, o.limit ?? 100))
        .map(decode) as RequestLifecycleSummary[];
    },
    async getTrace(id) {
      const d = await db();
      const request = decode(
        d.prepare("SELECT * FROM requests WHERE request_id=?").get(id),
      );
      return request
        ? {
            request,
            attempts: d
              .prepare(
                "SELECT * FROM request_attempts WHERE request_id=? ORDER BY ordinal",
              )
              .all(id)
              .map(decode) as RequestLifecycleAttempt[],
            events: d
              .prepare(
                "SELECT * FROM request_events WHERE request_id=? ORDER BY sequence",
              )
              .all(id)
              .map(decode) as RequestLifecycleEvent[],
          }
        : undefined;
    },
    deleteOlderThan: (ts) => deleteWhere("WHERE started_at < ?", [ts]),
    async clear() {
      await deleteWhere("", []);
    },
    async reconcileInterrupted(owner) {
      const d = await db();
      const rows = d
        .prepare(
          "SELECT * FROM requests WHERE owner_instance_id=? AND outcome='in_progress'",
        )
        .all(owner);
      const now = Date.now();
      d.exec("BEGIN IMMEDIATE");
      try {
        for (const r of rows) {
          d.prepare(
            "UPDATE requests SET outcome='interrupted',updated_at=?,ended_at=?,duration_ms=? WHERE request_id=?",
          ).run(now, now, now - r.started_at, r.request_id);
          d.prepare(
            "UPDATE request_attempts SET outcome='failed',ended_at=? WHERE request_id=? AND outcome='in_progress'",
          ).run(now, r.request_id);
          const seq = d
            .prepare(
              "SELECT COALESCE(MAX(sequence),0)+1 AS n FROM request_events WHERE request_id=?",
            )
            .get(r.request_id).n;
          d.prepare(
            "INSERT INTO request_events(event_id,request_id,sequence,timestamp,type) VALUES(?,?,?,?,?)",
          ).run(
            globalThis.crypto.randomUUID(),
            r.request_id,
            seq,
            now,
            "request_interrupted",
          );
        }
        d.exec("COMMIT");
        return rows.length;
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
