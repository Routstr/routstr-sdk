/**
 * AuditLogger - Transaction audit logging utility
 * Emits JSON-formatted transaction logs through a runtime-configurable sink.
 */

export interface AuditLogEntry {
  timestamp: string;
  action: "spend" | "topup" | "refund" | "receive" | "balance_check";
  totalBalance: number;
  providerBalances: Record<string, number>;
  mintBalances: Record<string, number>;
  amount?: number;
  mintUrl?: string;
  baseUrl?: string;
  status: "success" | "failed";
  details?: string;
}

export type AuditLogSink = (
  entry: AuditLogEntry,
  serializedEntry: string
) => void | Promise<void>;

const consoleAuditLogSink: AuditLogSink = (_entry, serializedEntry) => {
  console.log("[AUDIT]", serializedEntry.trim());
};

let auditLogSink: AuditLogSink = consoleAuditLogSink;

/** Configure audit persistence for the active runtime. */
export function setAuditLogSink(sink?: AuditLogSink): void {
  auditLogSink = sink ?? consoleAuditLogSink;
}

export class AuditLogger {
  private static instance: AuditLogger | null = null;

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  async log(entry: Omit<AuditLogEntry, "timestamp">): Promise<void> {
    const fullEntry: AuditLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    const logLine = JSON.stringify(fullEntry) + "\n";

    try {
      await auditLogSink(fullEntry, logLine);
    } catch (error) {
      console.error("[AuditLogger] Failed to write audit entry:", error);
    }
  }

  async logBalanceSnapshot(
    action: AuditLogEntry["action"],
    amounts: {
      totalBalance: number;
      providerBalances: Record<string, number>;
      mintBalances: Record<string, number>;
    },
    options?: {
      amount?: number;
      mintUrl?: string;
      baseUrl?: string;
      status?: "success" | "failed";
      details?: string;
    }
  ): Promise<void> {
    await this.log({
      action,
      totalBalance: amounts.totalBalance,
      providerBalances: amounts.providerBalances,
      mintBalances: amounts.mintBalances,
      amount: options?.amount,
      mintUrl: options?.mintUrl,
      baseUrl: options?.baseUrl,
      status: options?.status ?? "success",
      details: options?.details,
    });
  }
}

export const auditLogger = AuditLogger.getInstance();
