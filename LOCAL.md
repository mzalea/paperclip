# Local fork notes

This fork runs a self-hosted, local trusted Paperclip instance from source.
Branch `local/main` is upstream tag `v2026.916.1` plus the commits below; it
deliberately stays on a release tag so the database schema matches that
release and rollback to the npm build stays possible.

## Install and update

    paperclipai install --repo mzalea/paperclip --ref local/main -y
    paperclipai service restart

`paperclipai update` then rebuilds from the latest `local/main` commit, and
`paperclipai update --rollback` returns to the previous managed payload. The
build needs Node 24, pnpm (via corepack), and a Rust toolchain (`cargo`) for
the runner binary.

The first install from this fork has to use this branch's own CLI (the
packaging fixes below live in the installer): from a checkout of
`local/main`, `pnpm install`, then
`node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts install --repo mzalea/paperclip --ref local/main -y`.

**Do not run `cli/src/__tests__/install-command.test.ts` on a machine with a
live service.** Its uninstall cases override `HOME` but still drive the real
`systemctl --user`, and can stop and remove an installed `paperclipai.service`.

## Commits on top of v2026.916.1

Runtime fixes (ported from earlier dist patches, with regression tests):

- `fix(recovery)`: dispatch a pending review participant that never ran.
- `fix(heartbeat)`: isolate queued-run recovery failures per agent.
- `fix(diagnostics)`: name the policy that skipped or deferred a wake.
- `feat(codex-local)`: optional `quotaReservePercent` — defer runs as
  `provider_quota` until the window resets once any Codex quota window reaches
  the reserve line. Off unless set in the agent's adapter config.

Git-ref install packaging (upstream `install --ref` could not complete):

- `fix(install)`: stage release package assets (server `ui-dist`, `skills/`)
  before packing, via a shared `scripts/stage-package-assets.sh`.
- `fix(install)`: pack staged bundled packages with `--ignore-scripts`.
- `fix(packaging)`: materialize bundled `workspace:*` dependencies at each
  dependency's own version, not the bundling package's.

Branch `local/ts-port` holds the runtime fixes rebased on upstream `master`,
for proposing upstream. `local/v2026.916.1` is the archived record of the
earlier dist-level patches and their upstream verdicts.
