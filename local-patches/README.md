# Local patches

Changes carried on top of upstream Paperclip for a self-hosted, local trusted
instance. Branch `local/v2026.916.1` is cut from upstream tag `v2026.916.1`,
the version the instance runs.

## How they are deployed

The instance runs the npm build, so the edits live in compiled `dist/*.js`,
not in this repo's TypeScript. Each is recorded as a diff against the
pristine npm tarball of the same version:

- `server-2026.916.1.diff` — `@paperclipai/server@2026.916.1`
- `adapter-codex-local-2026.916.1.diff` — `@paperclipai/adapter-codex-local@2026.916.1`

A `paperclipai update` replaces the managed install and drops these edits. To
re-apply against a fresh 2026.916.1 install, then restart with
`paperclipai service restart`:

    cd "$PAPERCLIP_HOME/cli/current/node_modules/@paperclipai/server"
    patch -p1 < <this repo>/local-patches/server-2026.916.1.diff
    cd ../adapter-codex-local
    patch -p1 < <this repo>/local-patches/adapter-codex-local-2026.916.1.diff

`PAPERCLIP_HOME` defaults to `~/.paperclip`. The diffs are version-specific; a
newer release needs them ported (ideally to `server/src`, see below) rather
than force-applied.

## What the patches change

Changes 2–5 target work that silently stalls: a wake that never runs, or a
startup that dies. Change 6 replaces fixed daily run caps with a provider
quota reserve.

1. **Removed — `services/heartbeat.js` revive stranded deferred wakes.**
   Re-enqueued plain handoff wakes stuck in `deferred_issue_execution`
   directly, bypassing the release admission that applies recovery holds and
   operator Stops. Taken out of the install and out of
   `server-2026.916.1.diff`; see verdict #1. Change 4 covers the review-stall
   case it was written for.
2. **`services/heartbeat.js` — per-agent isolation in `resumeQueuedRuns`.**
   One queued run with invalid interrupt authority threw and blocked queued-run
   recovery for every other agent and company. Each agent is now wrapped and
   logged. Source: `server/src/services/heartbeat.ts` (~L19116).
3. **`index.js` — startup survives queued-run recovery failure.**
   The same throw at boot killed the server. It is now logged and startup
   continues; periodic recovery retries later.
   Source: `server/src/index.ts` (~L1507).
4. **`services/recovery/service.js` — recover a review stage with no
   participant run.** If the first review-stage wake was skipped while the
   submitting run still held an execution-reconciliation lock, the reviewer
   never had a run, so recovery ignored the issue and it stayed pending. It is
   now re-queued for the reviewer, or escalated if the reviewer is not
   invokable. Source: `server/src/services/recovery/service.ts` (~L4714).
5. **`routes/issues.js` — wake diagnostics show real skip reasons.** Known
   skip reasons such as `heartbeat.daily_run_limit` and `agent.not_invokable`
   were collapsed to `other` in board-facing wake diagnostics. They now pass
   through, which is what made a daily-cap stall diagnosable.
   Source: `server/src/routes/issues.ts` (~L1396).
6. **`adapter-codex-local` `dist/server/execute.js` — quota reserve gate.**
   Before starting Codex, read the provider quota windows (cached 5 minutes).
   If any window is at or above the reserve line, return a `provider_quota`
   failure with `retryNotBefore` at the latest such window's reset, so the
   server's durable scheduled-retry path resumes the work instead of dropping
   it. Lookup failures fail open. In the dist patch the reserve defaults to
   80% (override per agent with `adapterConfig.quotaReservePercent`); with it
   in place, `maxDailyRuns` can be raised to a high runaway-loop backstop
   instead of acting as the throttle.

## Verdicts for upstream (2026-09-29)

Checked against upstream `master` at `81a52eb74` (210 commits past
`v2026.916.1`); none of the six were already fixed there. Ported changes live
on branch `local/ts-port` (off upstream `master`), one commit each, with
regression tests.

| # | Change | Verdict | Reason |
|---|---|---|---|
| 1 | Revive stranded deferred wakes | Not ported | Plain handoff wakes are excluded from the stranded sweep, but this fix is a workaround: it re-enqueues directly, bypassing the release admission upstream deliberately routes these through so recovery holds and operator Stops apply. Removed from the install. Deferred wakes queued for a manually paused agent are not this gap; they release when the agent is resumed. |
| 2 | Per-agent isolation in `resumeQueuedRuns` | Ported | Real bug: one agent's failed claim rejected the whole sweep, stranding queued work for every agent behind it. Reproduced red on `master`. |
| 3 | Startup survives queued-run recovery failure | Not ported | Redundant once #2 isolates per-agent failures; what can still throw is the sweep's own DB reads, where failing startup is reasonable. |
| 4 | Recover a review stage with no participant run | Ported | Real bug: recovery re-queues a reviewer whose last run ended but skipped one that never ran, so a dropped first review wake stalled forever. Reproduced red on `master`. The port uses upstream's own guards (active execution path, queued wake, budget) instead of the dist patch's execution-blocker check. |
| 5 | Wake diagnostics show real skip reasons | Ported, narrowed | Useful: a daily-cap stall read as `skipped: other`. Upstream keeps an explicit allowlist, so the port only adds the 14 reasons the server emits and drops the dist patch's regex pass-through, which bypassed the allowlist. |
| 6 | Codex quota reserve gate | Ported as opt-in | Useful for shared subscriptions and reuses the existing `provider_quota` retry contract. Upstream it is off unless `quotaReservePercent` is set; the dist patch defaults to 80%. Overlaps open upstream PR #13379 (subscription-window budgets), which is the broader fix. |

## Known upstream issues not yet patched

- **A daily-cap skip drops the wake.** When `maxDailyRuns` is reached, an
  assignment or review wake is recorded as `skipped`, not deferred, so the
  issue stalls past the UTC-midnight reset. Related: upstream #9208.
- **Cancelled handoff runs count toward the cap.** A reviewer run that
  requests changes is cancelled `issue_reassigned` but still counts, so
  review ping-pong exhausts the cap quickly.
- **Plain handoff wakes may strand in `deferred_issue_execution`** (see
  verdict #1). Unconfirmed: no reproduction yet outside the paused-agent case.

## Bubbling up

Branch `local/ts-port` holds the TypeScript ports, based on upstream
`master`. To propose one upstream, cherry-pick its commit onto a fresh branch
off current upstream `master`, re-run its tests, and fill in the PR template
per upstream `AGENTS.md`. Nothing has been proposed upstream yet.
