#!/usr/bin/env bash
set -euo pipefail

# stage-package-assets.sh — Stage generated assets that publishable packages
# list in `files` but that are not produced by their own build:
#   - server/ui-dist (the built UI, via prepare-server-ui-dist.sh)
#   - skills/ copied into the server and local-agent adapter packages
# Shared by release.sh and git-ref installs so both ship the same payload.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
