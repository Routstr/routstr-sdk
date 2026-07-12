import { extractUsageFromSSEJson, type UsageTrackingData } from "./usage";

function mergeUsage(
  previous: UsageTrackingData | null,
  next: UsageTrackingData
): UsageTrackingData {
  if (!previous) return next;
  const pickNum = (
    n: number | undefined,
    p: number | undefined
  ): number | undefined => (typeof n === "number" && n > 0 ? n : p ?? n);
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
    provider: next.provider ?? previous.provider,
    baseMsats: pickNum(next.baseMsats, previous.baseMsats),
    inputMsats: pickNum(next.inputMsats, previous.inputMsats),
    outputMsats: pickNum(next.outputMsats, previous.outputMsats),
    totalMsats: pickNum(next.totalMsats, previous.totalMsats),
    totalUsd: pickNum(next.totalUsd, previous.totalUsd),
    cacheReadInputTokens: pickNum(
      next.cacheReadInputTokens,
      previous.cacheReadInputTokens
    ),
    cacheCreationInputTokens: pickNum(
      next.cacheCreationInputTokens,
      previous.cacheCreationInputTokens
    ),
    cacheReadMsats: pickNum(next.cacheReadMsats, previous.cacheReadMsats),
    cacheCreationMsats: pickNum(
      next.cacheCreationMsats,
      previous.cacheCreationMsats
    ),
    remainingBalanceMsats: pickNum(
      next.remainingBalanceMsats,
      previous.remainingBalanceMsats
    ),
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
    previous.satsCost !== next.satsCost ||
    previous.provider !== next.provider ||
    previous.totalMsats !== next.totalMsats ||
    previous.remainingBalanceMsats !== next.remainingBalanceMsats
  );
}

function isInspectionComplete(
  responseIdCaptured: boolean,
  usage: UsageTrackingData | null
): boolean {
  return (
    responseIdCaptured &&
    !!usage &&
    usage.totalTokens > 0 &&
    typeof usage.totalMsats === "number" &&
    !!usage.provider
  );
}

/**
 * Inspect a Web `ReadableStream<Uint8Array>` of SSE bytes for `usage` and
 * response `id` fields without touching the bytes delivered to the client.
 * This module intentionally uses only Web Platform stream and text APIs.
 */
export async function inspectSSEWebStream(
  stream: ReadableStream<Uint8Array>,
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void,
  options?: {
    /** Called with each raw chunk read from the tee'd inspection branch. */
    onRawChunk?: (chunk: Uint8Array, sequence: number, text: string) => void | Promise<void>;
  }
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
  let rawChunkSequence = 0;

  const inspectDataPayload = (jsonText: string): void => {
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") {
      if (trimmed === "[DONE]") console.log("[routstr:sse] [DONE]");
      return;
    }
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      console.log("[routstr:sse] non-JSON payload:", trimmed.slice(0, 200));
      return;
    }

    try {
      const data = JSON.parse(trimmed) as any;
      console.log("[routstr:sse] chunk:", JSON.stringify(data));

      if (isInspectionComplete(responseIdCaptured, capturedUsage)) {
        console.log("[routstr:sse] (inspection already complete, skipping)");
        return;
      }

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
      console.log("[routstr:sse] failed to parse payload:", trimmed.slice(0, 200));
    }
  };

  const inspectEventBlock = (eventBlock: string): void => {
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
        const text = decoder.decode(value, { stream: true });
        void options?.onRawChunk?.(value, rawChunkSequence++, text);
        buffer += text;
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
    // Inspection is best-effort. The client branch is independent.
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
