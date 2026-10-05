// Rewrites Codex runs that recorded a resumed thread's cumulative token totals
// as if they were the run's own usage (upstream paperclipai/paperclip#14875).
// Every such run still holds the raw totals in usage_json.raw*, so this derives
// each run's delta against the previous run of the same session, exactly as the
// server now does for usageBasis "session_cumulative", and rewrites
// heartbeat_runs.usage_json, the run's cost_events row and the agent's runtime
// totals. Only CLI-lane runs (stdout carries `turn.completed`) are deltaed; the
// ACP lane reports per-run usage. Codex rows with no model are given the
// effective model (--model, else the company's managed codex-home config.toml).
//
//   pnpm db:backup
//   pnpm codex-usage:backfill --company <id> --dry-run
//   pnpm codex-usage:backfill --company <id>
//
// Idempotent: a second pass derives the same values from raw* and reports no
// changes. --before <iso> (default: now) fences out rows written mid-run. The
// before/after report prices every row from its tokens; the Costs API prefers
// a run's own reported costUsd (Claude Code), so Claude rows can differ there.
import { pathToFileURL } from "node:url";
import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  readCodexConfigModel,
  resolveManagedCodexHomeDir,
} from "@paperclipai/adapter-codex-local/server";
import { loadConfig } from "../config.js";
import { priceTokensUsd } from "../services/api-equivalent-pricing.js";
import { deriveNormalizedUsageDelta, readRawUsageTotals } from "../services/heartbeat.js";

type Totals = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
const EMPTY: Totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
const UNKNOWN_MODELS = new Set(["", "unknown"]);

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseDateFlag(name: string, fallback: Date): Date {
  const raw = parseFlag(name);
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is not a valid ISO date: ${raw}`);
  return parsed;
}

function add(target: Totals, source: Totals): Totals {
  return {
    inputTokens: target.inputTokens + source.inputTokens,
    cachedInputTokens: target.cachedInputTokens + source.cachedInputTokens,
    outputTokens: target.outputTokens + source.outputTokens,
  };
}

function sameTotals(a: Totals, b: Totals): boolean {
  return a.inputTokens === b.inputTokens && a.cachedInputTokens === b.cachedInputTokens && a.outputTokens === b.outputTokens;
}

function isUnknownModel(model: unknown): boolean {
  return typeof model !== "string" || UNKNOWN_MODELS.has(model.trim().toLowerCase());
}

type CostRow = { agentId: string; model: string; occurredAt: Date; tokens: Totals };

export type CodexUsageRun = {
  id: string;
  sessionIdAfter: string | null;
  usageJson: Record<string, unknown> | null;
  /** stdout carried `turn.completed`: the CLI lane, whose totals are cumulative */
  cliLane: boolean;
};

export type CodexUsageRewrite = {
  runId: string;
  usageJson: Record<string, unknown>;
  /** corrected tokens for the run's cost_events row; null when only metadata changed */
  tokens: Totals | null;
  /** model to write where the row had none; null when it already had one */
  model: string | null;
};

/**
 * What the backfill would write for one agent's runs, ordered by session then
 * creation. CLI-lane runs with a session get their delta against the previous
 * run of that session that recorded totals (the same walk the server does for
 * usageBasis "session_cumulative"); everything derives from raw*, so a second
 * pass over rewritten rows plans nothing. Rows with no model get
 * `effectiveModel`. Runs whose usage carries a costUsd are not Codex-shaped
 * and are left alone.
 */
export function planCodexUsageRewrites(
  runs: CodexUsageRun[],
  effectiveModel: string | null,
  now: () => Date = () => new Date(),
): { rewrites: CodexUsageRewrite[]; unresolvedUnknownModels: number } {
  const rewrites: CodexUsageRewrite[] = [];
  let unresolvedUnknownModels = 0;
  let prevSession: string | null | undefined;
  let prevRaw: Totals | null = null;
  for (const run of runs) {
    const usage = run.usageJson ?? {};
    if (typeof usage.costUsd === "number") continue;
    if (run.sessionIdAfter !== prevSession) {
      prevSession = run.sessionIdAfter;
      prevRaw = null;
    }
    const raw = readRawUsageTotals(usage);
    const fillModel = isUnknownModel(usage.model) ? effectiveModel : null;
    if (isUnknownModel(usage.model) && !effectiveModel) unresolvedUnknownModels += 1;

    let nextUsage: Record<string, unknown> = { ...usage };
    let tokens: Totals | null = null;
    if (raw && run.cliLane && run.sessionIdAfter) {
      const normalized = deriveNormalizedUsageDelta(raw, prevRaw) ?? raw;
      tokens = normalized;
      nextUsage = {
        ...nextUsage,
        inputTokens: normalized.inputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        outputTokens: normalized.outputTokens,
        rawInputTokens: raw.inputTokens,
        rawCachedInputTokens: raw.cachedInputTokens,
        rawOutputTokens: raw.outputTokens,
      };
      if (prevRaw) nextUsage.usageSource = "session_delta";
      else delete nextUsage.usageSource;
      prevRaw = raw;
    }
    if (fillModel) nextUsage.model = fillModel;

    const current: Totals = {
      inputTokens: Number(usage.inputTokens ?? 0),
      cachedInputTokens: Number(usage.cachedInputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
    };
    const tokensChanged = tokens !== null && !sameTotals(tokens, current);
    const sourceChanged = nextUsage.usageSource !== usage.usageSource;
    const rawChanged = usage.rawInputTokens !== nextUsage.rawInputTokens
      || usage.rawCachedInputTokens !== nextUsage.rawCachedInputTokens
      || usage.rawOutputTokens !== nextUsage.rawOutputTokens;
    if (!tokensChanged && !sourceChanged && !rawChanged && !fillModel) continue;
    nextUsage.usageBackfilledAt = now().toISOString();
    rewrites.push({ runId: run.id, usageJson: nextUsage, tokens: tokensChanged ? tokens : null, model: fillModel });
  }
  return { rewrites, unresolvedUnknownModels };
}

// Priced per (agent, model) like the Costs API's apiEquivalentGroups, so the
// totals here match the API: pricing clamps uncached input per group, which
// matters for ACP-lane rows whose cached tokens are not part of input.
function report(label: string, rows: Iterable<CostRow>, from: Date) {
  const byAgentModel = new Map<string, Totals>();
  const byModel = new Map<string, { tokens: Totals; usd: number | null }>();
  let unknownRows = 0;
  for (const row of rows) {
    if (row.occurredAt < from) continue;
    if (isUnknownModel(row.model)) unknownRows += 1;
    const key = `${row.agentId}\u0000${row.model}`;
    byAgentModel.set(key, add(byAgentModel.get(key) ?? EMPTY, row.tokens));
  }
  for (const [key, tokens] of byAgentModel) {
    const model = key.slice(key.indexOf("\u0000") + 1);
    const usd = priceTokensUsd(model, tokens);
    const entry = byModel.get(model) ?? { tokens: EMPTY, usd: null };
    byModel.set(model, { tokens: add(entry.tokens, tokens), usd: usd === null ? entry.usd : (entry.usd ?? 0) + usd });
  }
  let totalUsd = 0;
  let unpriced = 0;
  console.log(`  ${label} (cost events since ${from.toISOString()}):`);
  for (const [model, { tokens, usd }] of [...byModel.entries()].sort()) {
    if (usd === null) unpriced += tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens;
    else totalUsd += usd;
    console.log(
      `    ${model.padEnd(20)} in ${tokens.inputTokens.toLocaleString("en-US").padStart(15)}  cached ${tokens.cachedInputTokens.toLocaleString("en-US").padStart(15)}  out ${tokens.outputTokens.toLocaleString("en-US").padStart(12)}  ${usd === null ? "unpriced" : `$${usd.toFixed(2)}`}`,
    );
  }
  console.log(`    API-equivalent total $${totalUsd.toFixed(2)}; unpriced tokens ${unpriced.toLocaleString("en-US")}; rows with unknown model ${unknownRows}`);
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const dryRun = hasFlag("--dry-run");
  const before = parseDateFlag("--before", new Date());
  const from = parseDateFlag("--from", new Date("2026-10-01T00:00:00.000Z"));
  const modelFlag = parseFlag("--model");
  const companyFlag = parseFlag("--company");
  const companyRows = companyFlag
    ? [{ id: companyFlag }]
    : await db.select({ id: companies.id }).from(companies);

  console.log(`${dryRun ? "Dry run" : "Backfill"} of Codex session usage for ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}; rows created before ${before.toISOString()}.`);

  for (const company of companyRows) {
    console.log(`\n- company ${company.id}`);
    const codexAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.adapterType, "codex_local")));
    if (codexAgents.length === 0) {
      console.log("  no codex_local agents; skipping");
      continue;
    }

    const effectiveModel =
      modelFlag ?? (await readCodexConfigModel(resolveManagedCodexHomeDir(process.env, company.id)));
    console.log(`  effective model for unknown-model rows: ${effectiveModel ?? "(none resolved)"}`);

    // Every cost event of the company, keyed by run, for the before/after report.
    const eventRows = await db
      .select({
        id: costEvents.id,
        heartbeatRunId: costEvents.heartbeatRunId,
        agentId: costEvents.agentId,
        model: costEvents.model,
        occurredAt: costEvents.occurredAt,
        inputTokens: costEvents.inputTokens,
        cachedInputTokens: costEvents.cachedInputTokens,
        outputTokens: costEvents.outputTokens,
      })
      .from(costEvents)
      .where(eq(costEvents.companyId, company.id));
    const eventsByRun = new Map<string, CostRow & { id: string }>();
    const allEvents: CostRow[] = [];
    for (const row of eventRows) {
      const entry = {
        id: row.id,
        agentId: row.agentId,
        model: row.model,
        occurredAt: row.occurredAt,
        tokens: { inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens },
      };
      allEvents.push(entry);
      if (row.heartbeatRunId) eventsByRun.set(row.heartbeatRunId, entry);
    }
    report("before", allEvents, from);

    let runsChanged = 0;
    let modelsFilled = 0;
    let unresolvedUnknown = 0;

    for (const agent of codexAgents) {
      const runs = await db
        .select({
          id: heartbeatRuns.id,
          sessionIdAfter: heartbeatRuns.sessionIdAfter,
          usageJson: heartbeatRuns.usageJson,
          cliLane: sql<boolean>`coalesce(${heartbeatRuns.resultJson}->>'stdout', '') like '%"turn.completed"%'`,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, agent.id),
          isNotNull(heartbeatRuns.usageJson),
          lt(heartbeatRuns.createdAt, before),
        ))
        .orderBy(asc(heartbeatRuns.sessionIdAfter), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));

      const { rewrites: updates, unresolvedUnknownModels } = planCodexUsageRewrites(
        runs.map((run) => ({ ...run, usageJson: run.usageJson as Record<string, unknown> | null })),
        effectiveModel,
      );
      unresolvedUnknown += unresolvedUnknownModels;

      if (updates.length === 0) continue;
      runsChanged += updates.length;
      modelsFilled += updates.filter((update) => update.model).length;

      // Apply to the in-memory events so the "after" report is exact in dry runs.
      for (const update of updates) {
        const event = eventsByRun.get(update.runId);
        if (!event) continue;
        if (update.tokens) event.tokens = update.tokens;
        if (update.model) event.model = update.model;
      }

      if (dryRun) continue;
      await db.transaction(async (tx) => {
        for (const update of updates) {
          await tx.update(heartbeatRuns).set({ usageJson: update.usageJson }).where(eq(heartbeatRuns.id, update.runId));
          const patch: Record<string, unknown> = {};
          if (update.tokens) {
            patch.inputTokens = update.tokens.inputTokens;
            patch.cachedInputTokens = update.tokens.cachedInputTokens;
            patch.outputTokens = update.tokens.outputTokens;
          }
          if (update.model) patch.model = update.model;
          // A run whose only change is usage metadata has nothing for its cost row.
          if (Object.keys(patch).length === 0) continue;
          await tx.update(costEvents).set(patch).where(eq(costEvents.heartbeatRunId, update.runId));
        }
        await tx.execute(sql`
          update agent_runtime_state s set
            total_input_tokens = coalesce((select sum(input_tokens) from cost_events e where e.agent_id = s.agent_id and e.heartbeat_run_id is not null), 0),
            total_cached_input_tokens = coalesce((select sum(cached_input_tokens) from cost_events e where e.agent_id = s.agent_id and e.heartbeat_run_id is not null), 0),
            total_output_tokens = coalesce((select sum(output_tokens) from cost_events e where e.agent_id = s.agent_id and e.heartbeat_run_id is not null), 0),
            total_cost_cents = coalesce((select sum(cost_cents) from cost_events e where e.agent_id = s.agent_id and e.heartbeat_run_id is not null), 0),
            updated_at = now()
          where s.agent_id = ${agent.id}
        `);
      });
      console.log(`  ${agent.name}: rewrote ${updates.length} run(s)`);
    }

    if (unresolvedUnknown > 0 && !effectiveModel) {
      throw new Error(`${unresolvedUnknown} run(s) have no model and none could be resolved; pass --model <id>.`);
    }
    report(dryRun ? "after (projected)" : "after", allEvents, from);
    console.log(`  runs ${dryRun ? "to rewrite" : "rewritten"}: ${runsChanged}; models filled: ${modelsFilled}`);
  }
  console.log(`\n${dryRun ? "Dry run" : "Backfill"} complete.`);
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex usage backfill failed: ${message}`);
    process.exitCode = 1;
  });
}
