import { describe, expect, it } from "vitest";
import {
  deriveNormalizedUsageDelta,
  readRawUsageTotals,
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "keeps a paused run without a valid cost receipt unpriced (%s)",
    (costUsd) => {
      expect(resolveLedgerCostStatus({
        costUsd,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      })).toBe("unpriced");
    },
  );

  it("preserves an explicitly reported zero-dollar receipt without token usage", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })).toBe("reported");
  });

  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
    })).toBe("reported");
  });

  it("uses an explicit cache-adjusted provider cost when available", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: 0.92,
    })).toBe(0.92);
  });

  it("attributes provider-reported billed cost as cache-adjusted by default", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: null,
    })).toBe(1.25);
  });

  it("does not attribute invalid or unavailable costs", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: Number.NaN,
    })).toBeNull();
  });

  it("prices a run that only reports a cache-adjusted cost", () => {
    const billedCostUsd = resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: 0.42,
    });
    expect(billedCostUsd).toBe(0.42);
    expect(resolveLedgerCostStatus({
      costUsd: billedCostUsd,
      inputTokens: 1_000,
      cachedInputTokens: 900_000,
      outputTokens: 5_000,
    })).toBe("reported");
  });

  it("bills the discounted amount when both nominal and cache-adjusted costs are reported", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 3.1,
      cacheAdjustedCostUsd: 1.5,
    })).toBe(1.5);
  });
});

describe("session-cumulative usage deltas", () => {
  it("subtracts the previous run's session totals field by field", () => {
    expect(deriveNormalizedUsageDelta(
      { inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 },
      { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
    )).toEqual({ inputTokens: 150, cachedInputTokens: 40, outputTokens: 20 });
  });

  it("counts the full current value when a counter went backwards (session reset)", () => {
    expect(deriveNormalizedUsageDelta(
      { inputTokens: 50, cachedInputTokens: 5, outputTokens: 40 },
      { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
    )).toEqual({ inputTokens: 50, cachedInputTokens: 5, outputTokens: 30 });
  });

  it("counts the full current value on the first run of a session", () => {
    expect(deriveNormalizedUsageDelta({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }, null))
      .toEqual({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 });
    expect(deriveNormalizedUsageDelta(null, null)).toBeNull();
  });

  it("reads the raw session totals ahead of the normalized ones and ignores empty usage", () => {
    expect(readRawUsageTotals({
      inputTokens: 150, cachedInputTokens: 40, outputTokens: 20,
      rawInputTokens: 250, rawCachedInputTokens: 60, rawOutputTokens: 30,
    })).toEqual({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 });
    expect(readRawUsageTotals({ inputTokens: 7, cachedInputTokens: 0, outputTokens: 1 }))
      .toEqual({ inputTokens: 7, cachedInputTokens: 0, outputTokens: 1 });
    expect(readRawUsageTotals({ model: "gpt-5.6-sol" })).toBeNull();
    expect(readRawUsageTotals(null)).toBeNull();
  });
});
