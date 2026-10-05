import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

// Codex reports a resumed thread's running token totals on every run. With
// usageBasis "session_cumulative" the server must store each run's delta
// against the previous run of the same session, keep the raw totals for
// session compaction, and bill cost_events and the agent's runtime totals
// from the delta — otherwise a long-lived session is counted once per run.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const SESSION_USAGE_TEST_ADAPTER = "session_usage_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session-usage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

function codexResult(usage: Usage | null, usageBasis: "per_run" | "session_cumulative"): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionId: "thread-1",
    sessionParams: { sessionId: "thread-1" },
    sessionDisplayId: "thread-1",
    ...(usage ? { usage, usageBasis } : {}),
    provider: "openai",
    biller: "chatgpt",
    billingType: "subscription",
    model: "gpt-5.6-sol",
    costUsd: null,
    summary: "done",
    resultJson: {},
  };
}

describeEmbeddedPostgres("session-cumulative usage accounting", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-session-usage-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: SESSION_USAGE_TEST_ADAPTER,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: SESSION_USAGE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.clearAllMocks();
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "cost_events",
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(SESSION_USAGE_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: SESSION_USAGE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function runOnce(agentId: string, result: AdapterExecutionResult) {
    execute.mockResolvedValueOnce(result);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(queued!.id);
      if (run && !["queued", "running"].includes(run.status)) {
        expect(run.status).toBe("succeeded");
        // The cost event and runtime totals are written by the run's
        // finalization, which can land after the status flip.
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run ${queued!.id} did not finish`);
  }

  async function costEventFor(runId: string) {
    const rows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    return rows[0] ?? null;
  }

  async function runtimeTotals(agentId: string) {
    const [row] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    return {
      inputTokens: row?.totalInputTokens ?? 0,
      cachedInputTokens: row?.totalCachedInputTokens ?? 0,
      outputTokens: row?.totalOutputTokens ?? 0,
    };
  }

  it("stores per-run deltas of a session's running totals and bills from the delta", async () => {
    const { agentId } = await seedAgent();

    // First run of the session: the totals are the run's own usage.
    const first = await runOnce(agentId, codexResult({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }, "session_cumulative"));
    expect(first.sessionIdAfter).toBe("thread-1");
    expect(first.usageJson).toMatchObject({
      inputTokens: 100, cachedInputTokens: 20, outputTokens: 10,
      rawInputTokens: 100, rawCachedInputTokens: 20, rawOutputTokens: 10,
      model: "gpt-5.6-sol",
    });
    expect((first.usageJson as Record<string, unknown>).usageSource).toBeUndefined();
    expect(await costEventFor(first.id)).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, model: "gpt-5.6-sol", costCents: 0 });

    // Resumed run: Codex reports the thread total; only the increase is billed.
    const second = await runOnce(agentId, codexResult({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 }, "session_cumulative"));
    expect(second.usageJson).toMatchObject({
      inputTokens: 150, cachedInputTokens: 40, outputTokens: 20,
      rawInputTokens: 250, rawCachedInputTokens: 60, rawOutputTokens: 30,
      usageSource: "session_delta",
    });
    expect(await costEventFor(second.id)).toMatchObject({ inputTokens: 150, cachedInputTokens: 40, outputTokens: 20 });
    expect(await runtimeTotals(agentId)).toEqual({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 });

    // A run that reports no usage must not make the next run re-count the thread.
    const third = await runOnce(agentId, codexResult(null, "session_cumulative"));
    expect(await costEventFor(third.id)).toBeNull();
    const fourth = await runOnce(agentId, codexResult({ inputTokens: 400, cachedInputTokens: 80, outputTokens: 50 }, "session_cumulative"));
    expect(fourth.usageJson).toMatchObject({ inputTokens: 150, cachedInputTokens: 20, outputTokens: 20, usageSource: "session_delta" });
    expect(await costEventFor(fourth.id)).toMatchObject({ inputTokens: 150, cachedInputTokens: 20, outputTokens: 20 });

    // A counter that went backwards (thread reset) counts its full value.
    const fifth = await runOnce(agentId, codexResult({ inputTokens: 50, cachedInputTokens: 5, outputTokens: 5 }, "session_cumulative"));
    expect(fifth.usageJson).toMatchObject({ inputTokens: 50, cachedInputTokens: 5, outputTokens: 5, rawInputTokens: 50 });
    expect(await runtimeTotals(agentId)).toEqual({ inputTokens: 450, cachedInputTokens: 85, outputTokens: 55 });
  });

  it("stores per-run usage unchanged", async () => {
    const { agentId } = await seedAgent();
    const first = await runOnce(agentId, codexResult({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }, "per_run"));
    const second = await runOnce(agentId, codexResult({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 }, "per_run"));
    expect(first.usageJson).toMatchObject({ inputTokens: 100, usageSource: "per_run" });
    expect(second.usageJson).toMatchObject({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30, usageSource: "per_run" });
    expect(await costEventFor(second.id)).toMatchObject({ inputTokens: 250, cachedInputTokens: 60, outputTokens: 30 });
    expect(await runtimeTotals(agentId)).toEqual({ inputTokens: 350, cachedInputTokens: 80, outputTokens: 40 });
  });
});
