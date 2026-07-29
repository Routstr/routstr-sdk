import { Transform } from "stream";
import { StringDecoder } from "string_decoder";
import type { UsageTrackingData } from "./usage";
import {
  drainSSEEvents,
  inspectSSETail,
  SSEEventInspector,
} from "./sseShared";

/**
 * Node SSE parser transform that preserves the original byte stream while
 * inspecting complete SSE events for usage and response identifiers.
 */
export function createSSEParserTransform(
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void
): Transform {
  const decoder = new StringDecoder("utf8");
  const inspector = new SSEEventInspector(onUsage, onResponseId);
  let buffer = "";

  const drain = (): void => {
    buffer = drainSSEEvents(buffer, (event) =>
      inspector.inspectEventBlock(event)
    );
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      buffer += decoder.write(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      );
      drain();
      callback();
    },
    flush(callback) {
      buffer += decoder.end();
      drain();
      inspectSSETail(buffer, (event) => inspector.inspectEventBlock(event));
      buffer = "";
      callback();
    },
  });
}
