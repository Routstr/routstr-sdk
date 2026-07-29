import { extractUsageFromSSEJson, type UsageTrackingData } from "./usage";

export interface SSEInspectionResult {
  capturedUsage?: UsageTrackingData;
  capturedResponseId?: string;
}

function mergeUsage(
  previous: UsageTrackingData | null,
  next: UsageTrackingData
): UsageTrackingData {
  if (!previous) return next;

  const pickNum = (
    nextValue: number | undefined,
    previousValue: number | undefined
  ): number | undefined =>
    typeof nextValue === "number" && nextValue > 0
      ? nextValue
      : previousValue ?? nextValue;

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

/** Runtime-neutral SSE event inspector shared by Web and Node stream adapters. */
export class SSEEventInspector {
  private capturedUsage: UsageTrackingData | null = null;
  private capturedResponseId: string | undefined;

  constructor(
    private readonly onUsage: (usage: UsageTrackingData) => void,
    private readonly onResponseId?: (responseId: string) => void
  ) {}

  inspectEventBlock(eventBlock: string): void {
    const dataParts: string[] = [];

    for (const line of eventBlock.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataParts.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
    }

    if (dataParts.length === 0) return;
    this.inspectDataPayload(dataParts.join("\n"));
  }

  result(): SSEInspectionResult {
    return {
      capturedUsage: this.capturedUsage ?? undefined,
      capturedResponseId: this.capturedResponseId,
    };
  }

  private inspectDataPayload(jsonText: string): void {
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    if (isInspectionComplete(!!this.capturedResponseId, this.capturedUsage)) {
      return;
    }

    try {
      const data = JSON.parse(trimmed) as { id?: unknown };

      if (!this.capturedResponseId && typeof data.id === "string") {
        const responseId = data.id.trim();
        if (responseId) {
          this.capturedResponseId = responseId;
          this.onResponseId?.(responseId);
        }
      }

      const usage = extractUsageFromSSEJson(data);
      if (usage) {
        const merged = mergeUsage(this.capturedUsage, usage);
        if (hasUsageChanged(this.capturedUsage, merged)) {
          this.capturedUsage = merged;
          this.onUsage(merged);
        }
      }
    } catch {
      // Inspection is best-effort; malformed/non-JSON events pass through.
    }
  }
}

/** Inspect complete SSE events and return the unconsumed partial tail. */
export function drainSSEEvents(
  buffer: string,
  inspectEventBlock: (eventBlock: string) => void
): string {
  const terminator = /\r?\n\r?\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = terminator.exec(buffer)) !== null) {
    const block = buffer.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    if (block.length > 0) inspectEventBlock(block);
  }

  return lastIndex > 0 ? buffer.slice(lastIndex) : buffer;
}

export function inspectSSETail(
  buffer: string,
  inspectEventBlock: (eventBlock: string) => void
): void {
  const tail = buffer.replace(/\r?\n+$/, "");
  if (tail.length > 0) inspectEventBlock(tail);
}
