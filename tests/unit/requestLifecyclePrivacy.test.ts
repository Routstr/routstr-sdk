import { describe, expect, it } from "vitest";
import { safeCode, safeModelPath } from "../../storage/requestLifecycle/privacy";

const modelPath = (endpoint: string, modelId = "deepseek-v4.1-flash") =>
  new URLSearchParams({
    url: "https://openrouter.ai/api/v1",
    "model-id": modelId,
    endpoint,
  }).toString();

describe("model-path route identifiers", () => {
  it.each(["venice/fp8", "deepinfra/fp8", "fireworks", "wafer"])(
    "preserves endpoint %s with canonical query encoding",
    (endpoint) => {
      const path = modelPath(endpoint);
      expect(safeModelPath(path)).toBe(path);
      expect(safeModelPath(safeModelPath(path))).toBe(path);
    },
  );

  it("preserves slash-qualified model IDs", () => {
    const path = modelPath("venice/fp8", "deepseek/deepseek-v4.1-flash");
    expect(safeModelPath(path)).toBe(path);
  });

  it.each([
    "", "/venice", "venice/", "venice//fp8", "https://secret.test",
    "user:secret@host", "venice?key=SECRET", "venice#SECRET",
    "venice&token=SECRET", "private prompt", "venice\nSECRET",
    "venice%2Ffp8", "venice\\fp8", "🔥", "x".repeat(121),
  ])("drops invalid route identifier %j", (identifier) => {
    const result = new URLSearchParams(safeModelPath(modelPath(identifier, identifier)));
    expect(result.has("endpoint")).toBe(false);
    expect(result.has("model-id")).toBe(false);
  });

  it("keeps the identifier length bound and shared code validation unchanged", () => {
    const endpoint = `v/${"x".repeat(118)}`;
    expect(new URLSearchParams(safeModelPath(modelPath(endpoint))).get("endpoint"))
      .toBe(endpoint);
    expect(safeCode("venice/fp8")).toBeUndefined();
    expect(safeCode("fireworks")).toBe("fireworks");
    expect(safeModelPath("venice/fp8")).toBe("[redacted-model-path]");
  });
});
