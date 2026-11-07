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


describe("serialized model-path budget", () => {
  it("omits overflowing slash identifiers whole and remains idempotent", () => {
    const id = "a/".repeat(59) + "aa";
    const input = new URLSearchParams({
      url: "https://provider.test/v1", "model-id": id, endpoint: id,
    }).toString();
    expect(input.length).toBe(532);
    const expected = new URLSearchParams({
      url: "https://provider.test/v1", "model-id": id,
    }).toString();
    expect(safeModelPath(input)).toBe(expected);
    expect(safeModelPath(expected)).toBe(expected);
  });

  it.each([512, 513])("budgets encoded fields at %i characters", (length) => {
    const fields = { url: "https://provider.test/", "model-id": "a/b", endpoint: "v/f" };
    const padding = length - new URLSearchParams(fields).toString().length;
    fields.url += "x".repeat(padding);
    const input = new URLSearchParams(fields).toString();
    expect(input.length).toBe(length);
    const expected = new URLSearchParams(fields);
    if (length > 512) expected.delete("endpoint");
    const result = safeModelPath(input);
    expect(result).toBe(expected.toString());
    expect(result.length).toBeLessThanOrEqual(512);
    expect(safeModelPath(result)).toBe(result);
  });

  it("can retain an endpoint after omitting an over-budget model ID", () => {
    const fields = {
      url: "https://provider.test/" + "x".repeat(300),
      "model-id": "a/".repeat(59) + "aa",
      endpoint: "v/f",
    };
    const expected = new URLSearchParams({ url: fields.url, endpoint: fields.endpoint }).toString();
    const result = safeModelPath(new URLSearchParams(fields).toString());
    expect(result).toBe(expected);
    expect(safeModelPath(result)).toBe(result);
  });

  it("omits oversized URLs whole, retaining other safe fields", () => {
    const url = `https://user:SECRET@provider.test/${"x".repeat(600)}?key=SECRET#SECRET`;
    const expected = new URLSearchParams({ "model-id": "a/b", endpoint: "v/f" }).toString();
    const result = safeModelPath(new URLSearchParams({ url, "model-id": "a/b", endpoint: "v/f" }).toString());
    expect(result).toBe(expected);
    expect(safeModelPath(result)).toBe(result);
    expect(safeModelPath(new URLSearchParams({ url }).toString())).toBe("[redacted-model-path]");
    expect(safeModelPath("[redacted-model-path]")).toBe("[redacted-model-path]");
  });
});
