#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
run="${1:?用法：bash scripts/run-all.sh RUN_DIR [--resume]}"
shift
mkdir -p "$run"
export CRAWLER_CODE_COMMIT="$(git rev-parse HEAD)"
if [[ ! -f "$run/git-commit.txt" ]]; then echo "$CRAWLER_CODE_COMMIT" > "$run/git-commit.txt"; fi
exec bun scripts/vehicle-crawler/run-all.ts "$run" "$@"
