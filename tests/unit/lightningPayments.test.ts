import { describe, expect, it, vi } from "vitest";
import { LightningPayments, LightningPaymentError } from "../../wallet/LightningPayments";
import type { StorageAdapter } from "../../wallet/interfaces";

const baseUrl = "https://provider.example/";
const invoice = { invoice_id: "invoice-1", bolt11: "lnbc-test", amount_sats: 100, payment_hash: "quote-1", expires_at: 1234 };
const paid = { status: "paid", api_key: "sk-test", amount_sats: 100, created_at: 10, expires_at: 1234 };
function client(...responses: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  return { payments: new LightningPayments(fetcher as typeof fetch), fetcher };
}
function storage(key?: string) {
  let current = key;
  return {
    getApiKey: vi.fn(() => current ? { key: current } : null),
    setApiKey: vi.fn((_base: string, key: string) => { current = key; }),
    updateApiKeyBalance: vi.fn(),
    removeApiKey: vi.fn(),
  } as unknown as StorageAdapter;
}

describe("explicit Lightning payments", () => {
  it("creates without authentication and never pays the invoice", async () => {
    const { payments, fetcher } = client(invoice);
    expect(await payments.createInvoice({ baseUrl, amountSats: 100, purpose: "create", apiKey: "sk-ignored" })).toEqual(invoice);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}v2/lightning/invoice`);
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(options.body as string)).toEqual({ amount_sats: 100, purpose: "create" });
    expect(options.redirect).toBe("error");
  });

  it("authenticates top-up using the existing canonical key", async () => {
    const { payments, fetcher } = client(invoice);
    await payments.createInvoice({ baseUrl, amountSats: 100, purpose: "topup", apiKey: "sk-test" });
    const options = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(options.headers).toHaveProperty("Authorization", "Bearer sk-test");
    expect(JSON.parse(options.body as string).purpose).toBe("topup");
  });

  it("rejects invalid amounts, bootstrap keys and unsafe URLs before fetching", async () => {
    const { payments, fetcher } = client();
    for (const amountSats of [0, -1, 1.5, NaN, 1000001]) {
      await expect(payments.createInvoice({ baseUrl, amountSats, purpose: "create" })).rejects.toThrow("amountSats");
    }
    await expect(payments.createInvoice({ baseUrl, amountSats: 100, purpose: "topup", apiKey: "cashuB-token" })).rejects.toThrow("canonical");
    await expect(payments.createInvoice({ baseUrl: "https://user:password@example.org", amountSats: 100, purpose: "create" })).rejects.toThrow("URL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("encodes status identifiers and recovers by BOLT11", async () => {
    const { payments, fetcher } = client(paid, paid);
    await payments.getInvoiceStatus(baseUrl, "a/b");
    await payments.recoverInvoice(baseUrl, invoice.bolt11);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toContain("a%2Fb/status");
    const [, options] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ bolt11: invoice.bolt11 });
  });

  it("stores only settled keys and fetches actual balance in msats", async () => {
    const { payments, fetcher } = client({ balance: 98250, reserved: 1250 });
    const store = storage();
    await expect(payments.acceptPaidInvoice(baseUrl, { ...paid, status: "pending", api_key: null }, store)).rejects.toThrow("not settled");
    expect(fetcher).not.toHaveBeenCalled();
    await payments.acceptPaidInvoice(baseUrl, paid, store);
    expect(store.setApiKey).toHaveBeenCalledWith(baseUrl, "sk-test");
    expect(store.updateApiKeyBalance).toHaveBeenCalledWith(baseUrl, 98.25, 1.25);
    // No double-credit: acceptance refreshes the provider balance instead of adding invoice value.
    expect(store.removeApiKey).not.toHaveBeenCalled();
  });

  it("does not overwrite a different stored key", async () => {
    const { payments, fetcher } = client();
    await expect(payments.acceptPaidInvoice(baseUrl, paid, storage("sk-other"))).rejects.toThrow("different provider key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not overwrite a key replaced during the balance fetch", async () => {
    const store = storage();
    const fetcher = vi.fn(async () => {
      store.setApiKey(baseUrl, "sk-replacement");
      return new Response(JSON.stringify({ balance: 100000 }));
    });
    await expect(new LightningPayments(fetcher as typeof fetch).acceptPaidInvoice(baseUrl, paid, store)).rejects.toThrow("changed");
    expect(store.updateApiKeyBalance).not.toHaveBeenCalled();
  });

  it("refunds with an explicit destination and preserves refund metadata", async () => {
    const result = { refund_id: "refund-1", status: "paid", recipient: "alice@example.com", sats: "100" };
    const { payments, fetcher } = client(result);
    expect(await payments.refundToLightning(baseUrl, "sk-test", "alice@example.com")).toEqual(result);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}v1/wallet/refund`);
    expect(JSON.parse(options.body as string)).toEqual({ lightning_address: "alice@example.com" });
  });

  it("surfaces unresolved refunds without retrying the payout", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ detail: { error: { code: "refund_in_progress" } } }), { status: 409 }));
    const payments = new LightningPayments(fetcher as typeof fetch);
    await expect(payments.refundToLightning(baseUrl, "sk-test", "alice@example.com")).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out a request without retrying", async () => {
    const fetcher = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    await expect(new LightningPayments(fetcher as typeof fetch, 5).createInvoice({ baseUrl, amountSats: 100, purpose: "create" })).rejects.toThrow("Aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success responses and preserves HTTP error status", async () => {
    const { payments } = client({ token: "unexpected-cashu-token" });
    await expect(payments.refundToLightning(baseUrl, "sk-test", "alice@example.com")).rejects.toThrow("Invalid provider");
    const fetcher = vi.fn(async () => new Response("<html>unavailable</html>", { status: 503 }));
    await expect(new LightningPayments(fetcher as typeof fetch).getInvoiceStatus(baseUrl, "1")).rejects.toBeInstanceOf(LightningPaymentError);
  });
});
