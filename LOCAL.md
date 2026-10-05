# Local fork notes

This fork runs a self-hosted, local trusted Paperclip instance from source.
Branch `local/main` is upstream `canary/v2026.929.0-canary.7` plus the commits
below. It tracks upstream tags, not raw `master`: move it to the stable
`v2026.929.0` tag once that is released, and to later release tags after that.

Moving to a newer upstream tag applies that release's database migrations
(`v2026.916.1` → `v2026.929.0-canary.7` adds 0280–0288). Those are one-way:
back up the database first (`paperclipai db:backup`), and restore it if you
ever roll back to a build from before the migrations. The pre-canary build is
kept on branch `local/main-916`.

## Install and update

    paperclipai install --repo mzalea/paperclip --ref local/main -y
    paperclipai service restart

`paperclipai update` then rebuilds from the latest `local/main` commit, and
`paperclipai update --rollback` returns to the previous managed payload (see
the migration note above). The build needs Node 24, pnpm (via corepack), and
a Rust toolchain (`cargo`) for the runner binary.

The first install from this fork has to use this branch's own CLI (the
packaging fixes below live in the installer): from a checkout of
`local/main`, `pnpm install`, then
`node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts install --repo mzalea/paperclip --ref local/main -y`.

**Do not run `cli/src/__tests__/install-command.test.ts` on a machine with a
live service.** Its uninstall cases override `HOME` but still drive the real
`systemctl --user`, and can stop and remove an installed `paperclipai.service`.

## Commits on top of the upstream tag

Runtime fixes (ours, with regression tests):

- `fix(recovery)`: dispatch a pending review participant that never ran.
- `fix(heartbeat)`: isolate queued-run recovery failures per agent.
- `fix(diagnostics)`: name the policy that skipped or deferred a wake.
- `feat(codex-local)`: optional `quotaReservePercent` — defer runs as
  `provider_quota` until the window resets once any Codex quota window reaches
  the reserve line. Off unless set in the agent's adapter config.
- `feat(costs)`: report what usage would have cost at API rates
  (`apiEquivalentCents`) beside billed spend, so subscription runs no longer
  read as $0. Read-side only (no migration, budgets unchanged). Reference
  prices live in `server/src/services/api-equivalent-pricing.ts`; update them
  by hand (gpt-5.6-sol is at its promo rate until 2026-11-21). Overlaps
  upstream #339 / #6843; drop if upstream ships a shadow cost.
  Settings → General → "Show costs at API rates" (`showApiEquivalentCosts`,
  off by default) makes that figure the headline on the dashboard and Costs
  page, with billed spend as the footnote.
- `fix(costs)`: Codex `turn.completed.usage` is the thread's cumulative total,
  and the CLI lane recorded it per run, so resumed sessions were overcounted
  about 4x (upstream #14875). CLI-lane results now declare
  `usageBasis: "session_cumulative"` and the server stores the per-run delta
  (raw totals stay in `usage_json.raw*`, which session compaction reads),
  walking back past runs that recorded no usage. The ACP lane reports per-run
  usage and is unchanged. Codex runs without `adapterConfig.model` now report
  the managed `config.toml` model (alias-normalized) instead of `unknown`, and
  `subscription_overage` runs no longer count their cost twice at API rates.
  `pnpm codex-usage:backfill [--company ID] [--model ID] [--dry-run]` rewrites
  existing `heartbeat_runs.usage_json`, `cost_events` tokens/model and
  `agent_runtime_state` totals from the raw totals (idempotent; run
  `pnpm db:backup` first). Applied to the October 2026 data on 2026-10-05.

Unmerged upstream PRs, cherry-picked with their authors credited. Drop each
commit once the PR lands in an upstream tag `local/main` is based on:

- paperclipai/paperclip#14510 — start card-answer interrupts instead of
  stalling the agent queue.
- paperclipai/paperclip#14596 — hold assigned work during an agent pause
  instead of blocking it. Note: it also removes the narrower native-runtime
  passive-wait check (`hasCurrentNativePassiveWait`), which the general pause
  hold subsumes.

Git-ref install packaging (upstream `install --ref` could not complete; see
also upstream #13928, which fixes the same thing):

- `fix(install)`: stage release package assets (server `ui-dist`, `skills/`)
  before packing, via a shared `scripts/stage-package-assets.sh`.
- `fix(install)`: pack staged bundled packages with `--ignore-scripts`.
- `fix(packaging)`: materialize bundled `workspace:*` dependencies at each
  dependency's own version, not the bundling package's.

Branch `local/ts-port` holds our runtime fixes on upstream `master`, for
proposing upstream. `local/v2026.916.1` is the archived record of the earlier
dist-level patches and their upstream verdicts.
