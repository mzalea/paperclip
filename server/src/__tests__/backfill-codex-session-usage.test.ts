import { describe, expect, it } from "vitest";
import { planCodexUsageRewrites, type CodexUsageRun } from "../scripts/backfill-codex-session-usage.js";

const now = () => new Date("2026-10-05T18:00:00.000Z");

function cliRun(id: string, session: string | null, totals: [number, number, number], extra: Record<string, unknown> = {}): CodexUsageRun {
  const [inputTokens, cachedInputTokens, outputTokens] = totals;
  return {
    id,
    sessionIdAfter: session,
    cliLane: true,
    usageJson: {
      inputTokens, cachedInputTokens, outputTokens,
      rawInputTokens: inputTokens, rawCachedInputTokens: cachedInputTokens, rawOutputTokens: outputTokens,
      usageSource: "per_run", model: "gpt-5.6-sol", ...extra,
    },
  };
}

describe("planCodexUsageRewrites", () => {
  it("replaces a session's recorded running totals with per-run deltas", () => {
    const { rewrites } = planCodexUsageRewrites([
      cliRun("r1", "thread-1", [100, 20, 10]),
      cliRun("r2", "thread-1", [250, 60, 30]),
      cliRun("r3", "thread-1", [400, 80, 50]),
    ], "gpt-5.6-sol", now);

    // r1 keeps its tokens but loses the wrong "per_run" source; r2 and r3 get deltas.
    expect(rewrites.map((r) => [r.runId, r.tokens])).toEqual([
      ["r1", null],
      ["r2", { inputTokens: 150, cachedInputTokens: 40, outputTokens: 20 }],
      ["r3", { inputTokens: 150, cachedInputTokens: 20, outputTokens: 20 }],
    ]);
    expect(rewrites[0].usageJson.usageSource).toBeUndefined();
    expect(rewrites[1].usageJson).toMatchObject({
      inputTokens: 150, rawInputTokens: 250, usageSource: "session_delta", usageBackfilledAt: "2026-10-05T18:00:00.000Z",
    });
    expect(rewrites.every((r) => r.model === null)).toBe(true);
  });

  it("drops the per_run source on a session's first run without touching its tokens", () => {
    const { rewrites } = planCodexUsageRewrites([cliRun("r1", "thread-1", [100, 20, 10])], null, now);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0].tokens).toBeNull();
    expect(rewrites[0].usageJson.usageSource).toBeUndefined();
  });

  it("walks back past a run that recorded no usage and counts a reset counter in full", () => {
    const { rewrites } = planCodexUsageRewrites([
      cliRun("r1", "thread-1", [100, 20, 10]),
      { id: "r2", sessionIdAfter: "thread-1", cliLane: true, usageJson: { model: "gpt-5.6-sol" } },
      cliRun("r3", "thread-1", [400, 80, 50]),
      cliRun("r4", "thread-1", [50, 5, 5]),
    ], "gpt-5.6-sol", now);
    const byRun = new Map(rewrites.map((r) => [r.runId, r]));
    expect(byRun.get("r3")?.tokens).toEqual({ inputTokens: 300, cachedInputTokens: 60, outputTokens: 40 });
    // 50/5/5 is already what the row holds; only its source is corrected.
    expect(byRun.get("r4")?.tokens).toBeNull();
    expect(byRun.get("r4")?.usageJson.usageSource).toBe("session_delta");
  });

  it("leaves ACP-lane, sessionless and cost-reporting runs alone but fills a missing model", () => {
    const { rewrites, unresolvedUnknownModels } = planCodexUsageRewrites([
      { ...cliRun("acp1", "thread-a", [100, 20, 10]), cliLane: false },
      { ...cliRun("acp2", "thread-a", [90, 30, 5], { model: "unknown" }), cliLane: false },
      cliRun("loose", null, [100, 20, 10]),
      cliRun("claude", "thread-c", [100, 20, 10], { costUsd: 1.5, model: "" }),
    ], "gpt-5.6-sol", now);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({ runId: "acp2", tokens: null, model: "gpt-5.6-sol" });
    expect(rewrites[0].usageJson).toMatchObject({ inputTokens: 90, model: "gpt-5.6-sol" });
    expect(unresolvedUnknownModels).toBe(0);
  });

  it("counts unknown models it cannot fill", () => {
    const { rewrites, unresolvedUnknownModels } = planCodexUsageRewrites(
      [cliRun("r1", null, [1, 0, 1], { model: "" })], null, now,
    );
    expect(rewrites).toHaveLength(0);
    expect(unresolvedUnknownModels).toBe(1);
  });

  it("plans nothing on a second pass over rewritten rows", () => {
    const first = planCodexUsageRewrites([
      cliRun("r1", "thread-1", [100, 20, 10]),
      cliRun("r2", "thread-1", [250, 60, 30]),
    ], "gpt-5.6-sol", now);
    const rewritten: CodexUsageRun[] = [
      { id: "r1", sessionIdAfter: "thread-1", cliLane: true, usageJson: first.rewrites[0].usageJson },
      { id: "r2", sessionIdAfter: "thread-1", cliLane: true, usageJson: first.rewrites[1].usageJson },
    ];
    expect(planCodexUsageRewrites(rewritten, "gpt-5.6-sol", now).rewrites).toEqual([]);
  });
});
