import { Transform } from "stream";
import { extractUsageFromSSEJson, type UsageTrackingData } from "./usage";

export function createSSEParserTransform(
  onUsage: (usage: UsageTrackingData) => void,
  onResponseId?: (responseId: string) => void
): Transform {
  let buffer = "";
  let usageCaptured = false;
  let responseIdCaptured = false;

  const maybeCaptureUsageFromJson = (jsonText: string): void => {
    try {
      const data = JSON.parse(jsonText) as any;
      const responseId = data.id;
      if (typeof responseId === "string" && responseId.trim().length > 0) {
        onResponseId?.(responseId.trim());
        responseIdCaptured = true;
      }

      const usage = extractUsageFromSSEJson(data);
      if (usage) {
        onUsage(usage);
        usageCaptured = true;
      }
    } catch {
      // Ignore non-JSON lines/events.
    }
  };

  const processLine = (self: Transform, line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed === "data: [DONE]" || trimmed === "[DONE]") {
      self.push("data: [DONE]\n\n");
      return;
    }

    if (trimmed.startsWith("data:")) {
      const dataStr = trimmed.startsWith("data: ")
        ? trimmed.slice(6)
        : trimmed.slice(5).trimStart();
      if (dataStr === "[DONE]") {
        self.push("data: [DONE]\n\n");
        return;
      }
      maybeCaptureUsageFromJson(dataStr);
      self.push(`data: ${dataStr}\n\n`);
      return;
    }

    if (trimmed.startsWith("{")) {
      maybeCaptureUsageFromJson(trimmed);
      self.push(`data: ${trimmed}\n\n`);
      return;
    }

    self.push(line + "\n");
  };

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(this, line);
      }

      callback();
    },
    flush(callback) {
      if (buffer.trim()) {
        processLine(this, buffer);
      }
      buffer = "";
      callback();
    },
  });
}
