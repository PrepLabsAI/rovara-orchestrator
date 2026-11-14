#!/usr/bin/env bash
# Sparse-check-out Rovara's contracts package at the pinned commit into .cache/rovara.
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT=$(sed -n 's/.*PINNED_ROVARA_COMMIT = "\([0-9a-f]*\)".*/\1/p' packages/rovara/src/contract/pinned.ts)
DIR=.cache/rovara
if [ -d "$DIR/.git" ] && [ "$(git -C "$DIR" rev-parse HEAD 2>/dev/null)" = "$COMMIT" ]; then
  exit 0
fi
rm -rf "$DIR"
git clone --quiet --filter=blob:none --no-checkout https://github.com/PrepLabsAI/Rovara.git "$DIR"
git -C "$DIR" sparse-checkout set --no-cone /packages/contracts/src/
git -C "$DIR" checkout --quiet "$COMMIT"
echo "Rovara contracts at $COMMIT in $DIR"
