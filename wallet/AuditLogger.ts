/**
 * AuditLogger - Transaction audit logging utility
 * Writes JSON-formatted transaction logs to audit.log
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

    if (typeof window === "undefined") {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const logPath = path.join(process.cwd(), "audit.log");
        fs.appendFileSync(logPath, logLine);
      } catch (error) {
        console.error("[AuditLogger] Failed to write to file:", error);
      }
    } else {
      console.log("[AUDIT]", logLine.trim());
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
