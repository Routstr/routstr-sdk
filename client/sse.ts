import { Transform } from "stream";
import { StringDecoder } from "string_decoder";
import { extractUsageFromSSEJson, type UsageTrackingData } from "./usage";

/**
 * Merge previously captured usage with a newly seen usage payload, preferring
 * non-zero fields from the new payload.
 */
function mergeUsage(
  previous: UsageTrackingData | null,
  next: UsageTrackingData
): UsageTrackingData {
  if (!previous) return next;
  return {
    promptTokens:
      next.promptTokens > 0 ? next.promptTokens : previous.promptTokens,
    completionTokens:
      next.completionTokens > 0
        ? next.completionTokens
        : previous.completionTokens,
    totalTokens:
      next.totalTokens > 0 ? next.totalTokens : previous.totalTokens,
    cost: next.cost > 0 ? next.cost : previous.cost,
    satsCost: next.satsCost > 0 ? next.satsCost : previous.satsCost,
  };
}

function hasUsageChanged(
  previous: UsageTrackingData | null,
  next: UsageTrackingData
): boolean {
  if (!previous) return true;
  return (
    previous.promptTokens !== next.promptTokens ||
    previous.completionTokens !== next.completionTokens ||
    previous.totalTokens !== next.totalTokens ||
    previous.cost !== next.cost ||
    previous.satsCost !== next.satsCost
  );
}

/**
 * Inspect a Web `ReadableStream<Uint8Array>` of SSE bytes for `usage` and
 * response `id` fields without touching the bytes that are delivered to the
 * real client. This is meant to be called on one branch of a `body.tee()`.
 *
 * The inspector reads the stream to completion (or errors out), decoding
 * UTF-8 across chunk boundaries, splitting on SSE event terminators
 * (`\r?\n\r?\n`), parsing each `data:` payload as JSON, and invoking the
 * provided callbacks when usage / response id become known.
 *
 * The returned Promise resolves with the final captured values once the
 * stream ends (or is cancelled / errors out).
 */
export async function inspectSSEWebStream(
  stream: ReadableStream<Uint8Array>,
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void
): Promise<{
  capturedUsage?: UsageTrackingData;
  capturedResponseId?: string;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let capturedUsage: UsageTrackingData | null = null;
  let capturedResponseId: string | undefined;
  let responseIdCaptured = false;

  const inspectDataPayload = (jsonText: string): void => {
    if (
      responseIdCaptured &&
      capturedUsage &&
      capturedUsage.totalTokens > 0
    ) {
      return;
    }
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

    try {
      const data = JSON.parse(trimmed) as any;

      if (!responseIdCaptured) {
        const responseId = data?.id;
        if (typeof responseId === "string" && responseId.trim().length > 0) {
          capturedResponseId = responseId.trim();
          onResponseId?.(capturedResponseId);
          responseIdCaptured = true;
        }
      }

      const usage = extractUsageFromSSEJson(data);
      if (usage) {
        const merged = mergeUsage(capturedUsage, usage);
        if (hasUsageChanged(capturedUsage, merged)) {
          capturedUsage = merged;
          onUsage(merged);
        }
      }
    } catch {
      // Ignore non-JSON payloads.
    }
  };

  const inspectEventBlock = (eventBlock: string): void => {
    if (
      responseIdCaptured &&
      capturedUsage &&
      capturedUsage.totalTokens > 0
    ) {
      return;
    }

    const lines = eventBlock.split(/\r?\n/);
    const dataParts: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        dataParts.push(value);
      }
    }

    if (dataParts.length === 0) return;
    inspectDataPayload(dataParts.join("\n"));
  };

  const drainBufferedEvents = (): void => {
    const terminator = /\r?\n\r?\n/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = terminator.exec(buffer)) !== null) {
      const block = buffer.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
      if (block.length > 0) inspectEventBlock(block);
    }
    if (lastIndex > 0) buffer = buffer.slice(lastIndex);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        buffer += decoder.decode(value, { stream: true });
        drainBufferedEvents();
      }
    }
    buffer += decoder.decode();
    drainBufferedEvents();
    if (buffer.length > 0) {
      const tail = buffer.replace(/\r?\n+$/, "");
      if (tail.length > 0) inspectEventBlock(tail);
      buffer = "";
    }
  } catch {
    // Swallow — inspection is best-effort. The client branch is independent.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return {
    capturedUsage: capturedUsage ?? undefined,
    capturedResponseId,
  };
}

/**
 * SSE parser transform that preserves the original byte stream.
 *
 * Incoming chunks are forwarded downstream unchanged so chunk boundaries and
 * timing remain identical to the upstream source. In parallel, a streaming text
 * decoder buffers just enough data to detect complete SSE event blocks for
 * usage/responseId inspection.
 *
 * This means:
 *   - The client sees the original stream bytes without parser-induced
 *     re-chunking.
 *   - Multi-line events (multiple `data:` lines, plus `event:`/`id:`/`retry:`
 *     fields) are still parsed correctly for inspection.
 *   - Chunks that contain multiple events, or events split across chunks, are
 *     handled correctly without merging or losing packets.
 *   - UTF-8 split across chunk boundaries is decoded safely.
 */
export function createSSEParserTransform(
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void
): Transform {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let capturedUsage: UsageTrackingData | null = null;
  let responseIdCaptured = false;

  const inspectDataPayload = (jsonText: string): void => {
    if (responseIdCaptured && capturedUsage && capturedUsage.totalTokens > 0) {
      return;
    }
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

    try {
      const data = JSON.parse(trimmed) as any;

      if (!responseIdCaptured) {
        const responseId = data?.id;
        if (typeof responseId === "string" && responseId.trim().length > 0) {
          onResponseId?.(responseId.trim());
          responseIdCaptured = true;
        }
      }

      const usage = extractUsageFromSSEJson(data);
      if (usage) {
        const mergedUsage = mergeUsage(capturedUsage, usage);
        if (hasUsageChanged(capturedUsage, mergedUsage)) {
          capturedUsage = mergedUsage;
          onUsage(mergedUsage);
        }
      }
    } catch {
      // Ignore non-JSON data payloads.
    }
  };

  /**
   * Parse a single SSE event block and invoke usage/id inspection on any
   * `data:` fields. Per the SSE spec, multiple `data:` lines within one
   * event are concatenated with `\n` to form the payload.
   */
  const inspectEventBlock = (eventBlock: string): void => {
    if (responseIdCaptured && capturedUsage && capturedUsage.totalTokens > 0) {
      return;
    }

    const lines = eventBlock.split(/\r?\n/);
    const dataParts: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      // SSE fields are of the form `field: value` or `field:value`.
      // We only care about `data:` for inspection purposes.
      if (line.startsWith("data:")) {
        const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        dataParts.push(value);
      }
    }

    if (dataParts.length === 0) return;
    const payload = dataParts.join("\n");
    inspectDataPayload(payload);
  };

  const processBufferedEvents = (): void => {
    // Events are terminated by a blank line: either \n\n or \r\n\r\n.
    // Scan the decoded text buffer for complete events and inspect them.
    const terminator = /\r?\n\r?\n/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = terminator.exec(buffer)) !== null) {
      const block = buffer.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
      if (block.length > 0) {
        inspectEventBlock(block);
      }
    }

    if (lastIndex > 0) {
      buffer = buffer.slice(lastIndex);
    }
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      processBufferedEvents();
      callback();
    },
    flush(callback) {
      buffer += decoder.end();
      processBufferedEvents();

      // Inspect any remaining buffered content as a final event block. Upstreams
      // that close without a trailing blank line can still contain a final event.
      if (buffer.length > 0) {
        const tail = buffer.replace(/\r?\n+$/, "");
        if (tail.length > 0) {
          inspectEventBlock(tail);
        }
        buffer = "";
      }
      callback();
    },
  });
}
