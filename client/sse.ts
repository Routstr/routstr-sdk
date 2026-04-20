import { Transform } from "stream";
import { extractUsageFromSSEJson, type UsageTrackingData } from "./usage";

/**
 * SSE parser transform that preserves event boundaries verbatim.
 *
 * Unlike a naive line-splitter, this buffers until a full SSE event is
 * received (terminated by a blank line, per the SSE spec), then forwards the
 * entire event unchanged downstream. This means:
 *   - Multi-line events (multiple `data:` lines, plus `event:`/`id:`/`retry:`
 *     fields) are preserved.
 *   - Comments / keepalives (lines beginning with `:`) are preserved.
 *   - Chunks that contain multiple events, or events split across chunks, are
 *     handled correctly without merging or losing packets.
 *
 * As a side-effect, it inspects `data:` payloads for usage/responseId and
 * invokes the provided callbacks the first time each is seen.
 */
export function createSSEParserTransform(
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void
): Transform {
  let buffer = "";
  let capturedUsage: UsageTrackingData | null = null;
  let responseIdCaptured = false;

  const mergeUsage = (
    previous: UsageTrackingData | null,
    next: UsageTrackingData
  ): UsageTrackingData => {
    if (!previous) return next;

    return {
      promptTokens:
        next.promptTokens > 0 ? next.promptTokens : previous.promptTokens,
      completionTokens:
        next.completionTokens > 0
          ? next.completionTokens
          : previous.completionTokens,
      totalTokens: next.totalTokens > 0 ? next.totalTokens : previous.totalTokens,
      cost: next.cost > 0 ? next.cost : previous.cost,
      satsCost: next.satsCost > 0 ? next.satsCost : previous.satsCost,
    };
  };

  const hasUsageChanged = (
    previous: UsageTrackingData | null,
    next: UsageTrackingData
  ): boolean => {
    if (!previous) return true;
    return (
      previous.promptTokens !== next.promptTokens ||
      previous.completionTokens !== next.completionTokens ||
      previous.totalTokens !== next.totalTokens ||
      previous.cost !== next.cost ||
      previous.satsCost !== next.satsCost
    );
  };

  const inspectDataPayload = (jsonText: string): void => {
    if (responseIdCaptured && capturedUsage?.satsCost && capturedUsage.totalTokens) {
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
    if (responseIdCaptured && capturedUsage?.satsCost && capturedUsage.totalTokens) {
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

  /**
   * Emit an event block verbatim downstream, re-appending the blank-line
   * terminator the SSE spec requires.
   */
  const emitEventBlock = (self: Transform, eventBlock: string): void => {
    // Skip purely empty blocks (can arise from leading blank lines).
    if (eventBlock.length === 0) return;
    inspectEventBlock(eventBlock);
    self.push(eventBlock + "\n\n");
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();

      // Events are terminated by a blank line: either \n\n or \r\n\r\n.
      // Scan the buffer for the next terminator and emit complete events.
      const terminator = /\r?\n\r?\n/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = terminator.exec(buffer)) !== null) {
        const block = buffer.slice(lastIndex, match.index);
        lastIndex = match.index + match[0].length;
        emitEventBlock(this, block);
      }

      if (lastIndex > 0) {
        buffer = buffer.slice(lastIndex);
      }

      callback();
    },
    flush(callback) {
      // Emit any remaining buffered content as a final event block. Upstreams
      // that close without a trailing blank line still deliver a final event.
      if (buffer.length > 0) {
        const tail = buffer.replace(/\r?\n+$/, "");
        if (tail.length > 0) {
          emitEventBlock(this, tail);
        }
        buffer = "";
      }
      callback();
    },
  });
}
