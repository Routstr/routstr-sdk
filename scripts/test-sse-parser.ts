import { Readable } from "stream";
import { createSSEParserTransform } from "@routstr/sdk";
import type { UsageTrackingData } from "@routstr/sdk";
import * as fs from "fs";
import * as readline from "readline";

async function main() {
  const inputPath = process.argv[2] ?? "scripts/1776631508420.jsonl";

  let capturedUsage: UsageTrackingData | undefined;
  let capturedResponseId: string | undefined;

  const sseParser = createSSEParserTransform(
    (usage) => {
      capturedUsage = usage;
      console.log("USAGE_CAPTURED", usage);
    },
    (responseId) => {
      capturedResponseId = responseId;
      console.log("RESPONSE_ID_CAPTURED", responseId);
    }
  );

  const source = new Readable({
    read() {},
  });

  const outputChunks: string[] = [];
  sseParser.on("data", (chunk) => {
    const text = chunk.toString();
    outputChunks.push(text);
    process.stdout.write(text);
  });

  const startedAt = Date.now();
  const input = fs.createReadStream(inputPath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { raw?: string };
    if (typeof parsed.raw === "string") {
      source.push(parsed.raw);
    }
  }

  source.push(null);

  await new Promise<void>((resolve, reject) => {
    source.pipe(sseParser);
    sseParser.once("end", resolve);
    sseParser.once("error", reject);
    source.once("error", reject);
  });

  const durationMs = Date.now() - startedAt;
  const totalBytes = outputChunks.reduce(
    (sum, chunk) => sum + Buffer.byteLength(chunk),
    0
  );

  console.log("\n--- SUMMARY ---");
  console.log("Input file:", inputPath);
  console.log("Response ID:", capturedResponseId ?? "<none>");
  console.log("Usage:", capturedUsage ?? "<none>");
  console.log("Usage cost USD:", capturedUsage?.cost ?? 0);
  console.log("Usage cost sats:", capturedUsage?.satsCost ?? 0);
  console.log("Output bytes:", totalBytes);
  console.log("Duration ms:", durationMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};
