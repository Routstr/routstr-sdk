import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditLogger,
  setAuditLogSink,
  type AuditLogEntry,
} from "../../wallet/AuditLogger";

afterEach(() => {
  setAuditLogSink();
});

describe("AuditLogger runtime sink", () => {
  it("emits serialized audit entries through the configured sink", async () => {
    const sink = vi.fn(
      (_entry: AuditLogEntry, _serializedEntry: string) => undefined
    );
    setAuditLogSink(sink);

    await auditLogger.log({
      action: "balance_check",
      totalBalance: 42,
      providerBalances: { "https://provider.example/": 40 },
      mintBalances: { "https://mint.example/": 2 },
      status: "success",
    });

    expect(sink).toHaveBeenCalledTimes(1);
    const [entry, serializedEntry] = sink.mock.calls[0];
    expect(entry).toMatchObject({
      action: "balance_check",
      totalBalance: 42,
      status: "success",
    });
    expect(entry.timestamp).toEqual(expect.any(String));
    expect(JSON.parse(serializedEntry)).toEqual(entry);
  });
});
