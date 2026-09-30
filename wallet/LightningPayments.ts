import type { StorageAdapter } from "./interfaces";

export interface LightningInvoice {
  invoice_id: string;
  bolt11: string;
  amount_sats: number;
  expires_at: number;
  payment_hash: string;
}

export interface LightningInvoiceStatus {
  status: string;
  api_key?: string | null;
  amount_sats: number;
  paid_at?: number | null;
  created_at: number;
  expires_at: number;
}

export interface LightningRefund {
  refund_id: string;
  status: string;
  recipient: string;
  /** Gross balance debited by the provider, not necessarily net Lightning payout. */
  sats?: string;
  msats?: string;
}

export class LightningPaymentError extends Error {
  constructor(message: string, public readonly status: number, public readonly detail?: unknown) {
    super(message);
    this.name = "LightningPaymentError";
  }
}

/** Explicit provider operations. Never pays invoices, auto-retries a POST, or logs credentials. */
export class LightningPayments {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 30_000) {}

  private async request<T>(baseUrl: string, path: string, body?: unknown, apiKey?: string): Promise<T> {
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error("Invalid provider URL");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${base.href.replace(/\/$/, "")}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) {
        // Retain structured detail for recovery decisions without echoing HTML or credentials.
        throw new LightningPaymentError(`Provider Lightning operation failed (HTTP ${response.status})`, response.status, data?.detail);
      }
      if (!data || typeof data !== "object") throw new Error("Invalid provider Lightning response");
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private validateKey(apiKey: string): void {
    if (!apiKey.startsWith("sk-") || apiKey.length <= 3) throw new Error("Lightning operations require a canonical sk- API key");
  }

  async createInvoice(options: {
    baseUrl: string;
    amountSats: number;
    purpose: "create" | "topup";
    apiKey?: string;
  }): Promise<LightningInvoice> {
    if (!Number.isSafeInteger(options.amountSats) || options.amountSats <= 0 || options.amountSats > 1_000_000) {
      throw new Error("amountSats must be an integer between 1 and 1000000");
    }
    if (!["create", "topup"].includes(options.purpose)) throw new Error("Invalid invoice purpose");
    if (options.purpose === "topup") this.validateKey(options.apiKey ?? "");
    const invoice = await this.request<LightningInvoice>(options.baseUrl, "v2/lightning/invoice", {
      amount_sats: options.amountSats,
      purpose: options.purpose,
    }, options.purpose === "topup" ? options.apiKey : undefined);
    if (typeof invoice.invoice_id !== "string" || !invoice.invoice_id || typeof invoice.bolt11 !== "string" || !invoice.bolt11 ||
        invoice.amount_sats !== options.amountSats || !Number.isFinite(invoice.expires_at) || typeof invoice.payment_hash !== "string") {
      throw new Error("Invalid provider invoice response");
    }
    return invoice;
  }

  async getInvoiceStatus(baseUrl: string, invoiceId: string): Promise<LightningInvoiceStatus> {
    if (!invoiceId) throw new Error("invoiceId is required");
    return this.validateStatus(await this.request<LightningInvoiceStatus>(baseUrl, `v2/lightning/invoice/${encodeURIComponent(invoiceId)}/status`));
  }

  async recoverInvoice(baseUrl: string, bolt11: string): Promise<LightningInvoiceStatus> {
    if (!bolt11) throw new Error("bolt11 is required");
    return this.validateStatus(await this.request<LightningInvoiceStatus>(baseUrl, "v2/lightning/recover", { bolt11 }));
  }

  private validateStatus(status: LightningInvoiceStatus): LightningInvoiceStatus {
    if (typeof status.status !== "string" || !Number.isSafeInteger(status.amount_sats) || status.amount_sats <= 0 ||
        !Number.isFinite(status.created_at) || !Number.isFinite(status.expires_at)) throw new Error("Invalid provider invoice status");
    if (status.status === "paid") this.validateKey(status.api_key ?? "");
    return status;
  }

  /** Accept a settled invoice explicitly. Never replace a different stored provider key. */
  async acceptPaidInvoice(baseUrl: string, status: LightningInvoiceStatus, storage: StorageAdapter): Promise<void> {
    this.validateStatus(status);
    if (status.status !== "paid") throw new Error("Invoice is not settled");
    const key = status.api_key!;
    const existing = storage.getApiKey(baseUrl);
    if (existing && existing.key !== key) throw new Error("A different provider key is already stored; keep the paid invoice for recovery");
    if (!storage.getApiKey(baseUrl)) storage.setApiKey(baseUrl, key);
    await this.refreshKeyBalance(baseUrl, key, storage);
  }

  async refreshKeyBalance(baseUrl: string, key: string, storage: StorageAdapter): Promise<void> {
    this.validateKey(key);
    const info = await this.request<{ balance: number; reserved?: number }>(baseUrl, "v1/wallet/info", undefined, key);
    if (!Number.isSafeInteger(info.balance) || info.balance < 0 ||
        (info.reserved !== undefined && (!Number.isSafeInteger(info.reserved) || info.reserved < 0))) {
      throw new Error("Invalid provider balance response");
    }
    if (storage.getApiKey(baseUrl)?.key !== key) throw new Error("Provider key changed during invoice settlement");
    storage.updateApiKeyBalance(baseUrl, info.balance / 1000, (info.reserved ?? 0) / 1000);
  }

  /** Refund all available balance to an explicit Lightning address/LNURL. Keep the key for reconciliation. */
  async refundToLightning(baseUrl: string, apiKey: string, lightningAddress: string): Promise<LightningRefund> {
    this.validateKey(apiKey);
    if (!lightningAddress.trim()) throw new Error("lightningAddress is required");
    const refund = await this.request<LightningRefund>(baseUrl, "v1/wallet/refund", {
      lightning_address: lightningAddress,
    }, apiKey);
    if (typeof refund.refund_id !== "string" || !refund.refund_id || typeof refund.status !== "string" ||
        typeof refund.recipient !== "string") throw new Error("Invalid provider Lightning refund response");
    return refund;
  }
}
