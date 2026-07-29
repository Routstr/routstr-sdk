import type { UsageTrackingData } from "./usage";
import {
  drainSSEEvents,
  inspectSSETail,
  SSEEventInspector,
  type SSEInspectionResult,
} from "./sseShared";

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
    onRawChunk?: (
      chunk: Uint8Array,
      sequence: number,
      text: string
    ) => void | Promise<void>;
  }
): Promise<SSEInspectionResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const inspector = new SSEEventInspector(onUsage, onResponseId);
  let buffer = "";
  let rawChunkSequence = 0;

  const drain = (): void => {
    buffer = drainSSEEvents(buffer, (event) =>
      inspector.inspectEventBlock(event)
    );
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const text = decoder.decode(value, { stream: true });
        void options?.onRawChunk?.(value, rawChunkSequence++, text);
        buffer += text;
        drain();
      }
    }

    buffer += decoder.decode();
    drain();
    inspectSSETail(buffer, (event) => inspector.inspectEventBlock(event));
  } catch {
    // Inspection is best-effort. The client branch is independent.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return inspector.result();
}
