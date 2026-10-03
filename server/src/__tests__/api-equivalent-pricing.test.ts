import { describe, expect, it } from "vitest";
import { priceTokensUsd } from "../services/api-equivalent-pricing.ts";

describe("priceTokensUsd", () => {
  it("prices Codex usage with cached tokens counted inside inputTokens", () => {
    // 1M uncached at $4 + 9M cached at $0.40 + 1M output at $20
    expect(
      priceTokensUsd("gpt-5.6-sol", { inputTokens: 10_000_000, cachedInputTokens: 9_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(4 + 3.6 + 20, 6);
  });

  it("prices Claude usage with cached tokens reported separately from inputTokens", () => {
    // 1M uncached at $2 + 9M cached at $0.20 + 1M output at $10
    expect(
      priceTokensUsd("claude-sonnet-5", { inputTokens: 1_000_000, cachedInputTokens: 9_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(2 + 1.8 + 10, 6);
  });

  it("returns null for a model without a reference price", () => {
    expect(priceTokensUsd("unknown", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBeNull();
  });
});
