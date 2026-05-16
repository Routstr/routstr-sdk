import { createWriteStream } from "fs";
import { mkdir, readFile, readdir } from "fs/promises";
import { join } from "path";
import http from "http";
import https from "https";

const REQUESTS_DIR = join(__dirname, "requests");
const RESPONSES_DIR = join(__dirname, "responses");
const DAEMON_URL = "https://routstr.otrta.me";
// const DAEMON_URL = "http://localhost:8009";

type SavedRequest = {
  method?: string;
  path?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: object;
};

function normalizeHeaders(
  headers: http.OutgoingHttpHeaders | undefined,
  bodyStr: string
): http.OutgoingHttpHeaders {
  const normalized: http.OutgoingHttpHeaders = {};
  const incoming = headers || {};

  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length"
    ) {
      continue;
    }
    normalized[key] = value;
  }

  if (!normalized["Content-Type"] && !normalized["content-type"]) {
    normalized["Content-Type"] = "application/json";
  }

  normalized["Content-Length"] = Buffer.byteLength(bodyStr);
  normalized["Authorization"] =
    "Bearer sk-511f8bdba2b44c2f45683fcd1b5276f49509f6181596b08c7a252ec99b3fba85";
  return normalized;
}

async function ensureResponsesDir(): Promise<void> {
  await mkdir(RESPONSES_DIR, { recursive: true });
}

async function sendRequest(
  saved: SavedRequest,
  responseFilename: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = saved.body || {};
    const bodyStr = JSON.stringify(body);
    const url = new URL(saved.path || "/v1/chat/completions", DAEMON_URL);
    const method = saved.method || "POST";
    const headers = normalizeHeaders(saved.headers, bodyStr);
    const protocolClient = url.protocol === "https:" ? https : http;

    const req = protocolClient.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        const responsePath = join(RESPONSES_DIR, responseFilename);
        const writer = createWriteStream(responsePath, {
          flags: "w",
          encoding: "utf-8",
        });
        let chunkCount = 0;
        let settled = false;

        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          try {
            writer.destroy();
          } catch {
            // ignore cleanup errors
          }
          reject(error);
        };

        const writeEvent = (event: Record<string, unknown>): void => {
          writer.write(`${JSON.stringify(event)}\n`);
        };

        writer.on("error", fail);

        writeEvent({
          type: "meta",
          status: res.statusCode,
          headers: res.headers,
          startedAt: new Date().toISOString(),
        });

        res.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk));

          writeEvent({
            type: "chunk",
            index: chunkCount,
            timestamp: new Date().toISOString(),
            data: buffer.toString("utf-8"),
          });
          chunkCount += 1;
        });

        res.on("end", () => {
          writeEvent({
            type: "end",
            chunkCount,
            endedAt: new Date().toISOString(),
          });

          writer.end(() => {
            if (settled) return;
            settled = true;
            console.log(`[response] Status: ${res.statusCode}`);
            console.log(`[response] Chunks saved to: ${responseFilename}`);
            resolve();
          });
        });

        res.on("error", fail);
      }
    );

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function main(): Promise<void> {
  await ensureResponsesDir();

  const files = await readdir(REQUESTS_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  console.log(`Found ${jsonFiles.length} request files`);

  for (const file of jsonFiles) {
    const filepath = join(REQUESTS_DIR, file);
    console.log(`\n[processing] ${file}`);

    const content = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(content) as
      | SavedRequest
      | Record<string, unknown>;

    const isEnvelope =
      Boolean(parsed) &&
      typeof parsed === "object" &&
      ("body" in parsed || "headers" in parsed || "path" in parsed);

    const saved: SavedRequest = isEnvelope
      ? (parsed as SavedRequest)
      : {
          body: parsed as object,
          method: "POST",
          path: "/v1/chat/completions",
        };

    const body = saved.body as Record<string, unknown> | undefined;
    console.log(
      `[sending] ${saved.method || "POST"} ${saved.path || "/v1/chat/completions"} model: ${
        typeof body?.model === "string" ? body.model : "(unknown)"
      }`
    );

    const responseFilename = file
      .replace(/^req-/, "resp-")
      .replace(/\.json$/, ".ndjson");
    await sendRequest(saved, responseFilename);
  }

  console.log("\nDone processing all requests.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
