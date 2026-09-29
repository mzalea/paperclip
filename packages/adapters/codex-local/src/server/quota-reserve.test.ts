import { describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";
import {
  createQuotaReserveGate,
  evaluateQuotaReserve,
  readQuotaReservePercent,
} from "./quota-reserve.js";

const NOW = Date.parse("2026-09-29T19:00:00.000Z");

function quota(windows: ProviderQuotaResult["windows"]): ProviderQuotaResult {
  return { provider: "openai", ok: true, windows };
}

const window = (label: string, usedPercent: number | null, resetsAt: string | null) => ({
  label,
  usedPercent,
  resetsAt,
  valueLabel: null,
});

describe("evaluateQuotaReserve", () => {
  it("allows runs below the reserve line", () => {
    expect(evaluateQuotaReserve(quota([window("5h", 79, "2026-09-29T20:00:00.000Z")]), 80, new Date(NOW))).toBeNull();
  });

  it("waits for the latest reset among windows at or over the line", () => {
    expect(evaluateQuotaReserve(quota([
      window("5h", 80, "2026-09-29T20:00:00.000Z"),
      window("7d", 95, "2026-10-03T00:00:00.000Z"),
      window("Credits", null, null),
    ]), 80, new Date(NOW))).toEqual({
      retryNotBefore: "2026-10-03T00:00:00.000Z",
      detail: "5h 80%, 7d 95%",
    });
  });

  it("falls back to a short wait when the window reports no future reset", () => {
    expect(evaluateQuotaReserve(quota([window("5h", 99, null)]), 80, new Date(NOW))?.retryNotBefore)
      .toBe("2026-09-29T19:30:00.000Z");
  });
});

describe("readQuotaReservePercent", () => {
  it("is off unless a percent strictly between 0 and 100 is configured", () => {
    expect(readQuotaReservePercent({})).toBeNull();
    expect(readQuotaReservePercent({ quotaReservePercent: 0 })).toBeNull();
    expect(readQuotaReservePercent({ quotaReservePercent: 100 })).toBeNull();
    expect(readQuotaReservePercent({ quotaReservePercent: "80" })).toBeNull();
    expect(readQuotaReservePercent({ quotaReservePercent: 80 })).toBe(80);
  });
});

describe("createQuotaReserveGate", () => {
  const onLog = () => vi.fn(async () => {});

  it("does not look up quota when no reserve is configured", async () => {
    const fetchQuota = vi.fn(async () => quota([window("5h", 99, null)]));
    const check = createQuotaReserveGate(fetchQuota, () => NOW);
    await expect(check({}, onLog())).resolves.toBeNull();
    expect(fetchQuota).not.toHaveBeenCalled();
  });

  it("defers the run as provider_quota until the window resets", async () => {
    const check = createQuotaReserveGate(
      async () => quota([window("7d", 91, "2026-10-03T00:00:00.000Z")]),
      () => NOW,
    );
    const log = onLog();
    const result = await check({ quotaReservePercent: 80 }, log);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-10-03T00:00:00.000Z",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(log).toHaveBeenCalledWith("stderr", expect.stringContaining("Codex quota reserve reached"));
  });

  it("fails open when quota cannot be read", async () => {
    const failing = createQuotaReserveGate(async () => {
      throw new Error("usage endpoint down");
    }, () => NOW);
    const log = onLog();
    await expect(failing({ quotaReservePercent: 80 }, log)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("stderr", expect.stringContaining("usage endpoint down"));

    const unavailable = createQuotaReserveGate(
      async () => ({ provider: "openai", ok: false, error: "no local codex auth token", windows: [] }),
      () => NOW,
    );
    await expect(unavailable({ quotaReservePercent: 80 }, onLog())).resolves.toBeNull();
  });

  it("reuses a successful lookup for five minutes", async () => {
    let now = NOW;
    const fetchQuota = vi.fn(async () => quota([window("5h", 10, null)]));
    const check = createQuotaReserveGate(fetchQuota, () => now);
    await check({ quotaReservePercent: 80 }, onLog());
    now += 4 * 60 * 1000;
    await check({ quotaReservePercent: 80 }, onLog());
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await check({ quotaReservePercent: 80 }, onLog());
    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });
});
