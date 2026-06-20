import type { SdkLogger } from "../core/types";

export interface RequestResponseLoggerOptions {
  /** Directory that will contain requests/*.json and responses/*.jsonl */
  dir: string;
  logger?: SdkLogger;
}

export interface RequestLogInput {
  timestamp?: string;
  method: string;
  url: string;
  path: string;
  baseUrl: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

const isNodeLike = (): boolean => typeof window === "undefined";

const sanitizeForFilename = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

const makeId = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random}`;
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const chunkToBytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  return new TextEncoder().encode(String(chunk));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const BufferCtor = (globalThis as any).Buffer;
  if (BufferCtor) return BufferCtor.from(bytes).toString("base64");

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const bytesToUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

export class RequestResponseLogger {
  private writeChains = new Map<string, Promise<void>>();

  constructor(private options: RequestResponseLoggerOptions) {}

  private async ensureDirs(): Promise<{ requestsDir: string; responsesDir: string }> {
    if (!isNodeLike()) {
      throw new Error("request/response file logging is only available outside browsers");
    }

    const fs = await import("fs/promises");
    const path = await import("path");
    const requestsDir = path.join(this.options.dir, "requests");
    const responsesDir = path.join(this.options.dir, "responses");
    await fs.mkdir(requestsDir, { recursive: true });
    await fs.mkdir(responsesDir, { recursive: true });
    return { requestsDir, responsesDir };
  }

  private async responseFilePath(id: string): Promise<string> {
    const path = await import("path");
    const { responsesDir } = await this.ensureDirs();
    return path.join(responsesDir, `${sanitizeForFilename(id)}.jsonl`);
  }

  async logRequest(input: RequestLogInput): Promise<string | undefined> {
    if (!isNodeLike()) return undefined;

    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const { requestsDir } = await this.ensureDirs();
      const id = makeId();
      const timestamp = input.timestamp ?? new Date().toISOString();
      const filename = `${sanitizeForFilename(id)}.json`;
      const filepath = path.join(requestsDir, filename);

      await fs.writeFile(
        filepath,
        JSON.stringify(
          {
            id,
            timestamp,
            method: input.method,
            url: input.url,
            path: input.path,
            baseUrl: input.baseUrl,
            headers: input.headers,
            body: input.body,
            rawBody: input.rawBody,
          },
          null,
          2
        )
      );

      return id;
    } catch (error) {
      this.options.logger?.error?.("[RequestResponseLogger] failed to log request:", error);
      return undefined;
    }
  }

  appendResponseEvent(id: string | undefined, event: Record<string, unknown>): Promise<void> {
    if (!id || !isNodeLike()) return Promise.resolve();

    const write = async () => {
      try {
        const fs = await import("fs/promises");
        const filepath = await this.responseFilePath(id);
        await fs.appendFile(
          filepath,
          JSON.stringify({ requestLogId: id, timestamp: new Date().toISOString(), ...event }) + "\n"
        );
      } catch (error) {
        this.options.logger?.error?.("[RequestResponseLogger] failed to append response event:", error);
      }
    };

    const previous = this.writeChains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.writeChains.set(id, next);
    return next;
  }

  logResponseStart(id: string | undefined, response: Response): Promise<void> {
    return this.appendResponseEvent(id, {
      type: "response_start",
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
    });
  }

  logResponseError(id: string | undefined, error: unknown): Promise<void> {
    return this.appendResponseEvent(id, {
      type: "error",
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    });
  }

  logResponseEnd(id: string | undefined): Promise<void> {
    return this.appendResponseEvent(id, { type: "end" });
  }

  logChunk(id: string | undefined, sequence: number, chunk: unknown): Promise<void> {
    const bytes = chunkToBytes(chunk);
    return this.appendResponseEvent(id, {
      type: "chunk",
      sequence,
      byteLength: bytes.byteLength,
      base64: bytesToBase64(bytes),
      utf8: bytesToUtf8(bytes),
    });
  }

  async logResponseBody(response: Response, id: string | undefined): Promise<void> {
    if (!id || !isNodeLike()) return;
    if (!response.body) {
      await this.logResponseEnd(id);
      return;
    }

    let sequence = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.logChunk(id, sequence++, value);
      }
      await this.logResponseEnd(id);
    } catch (error) {
      await this.logResponseError(id, error);
    }
  }
}
