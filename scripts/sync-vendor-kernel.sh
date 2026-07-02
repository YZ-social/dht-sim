#!/usr/bin/env bash
# Sync vendor/axona-protocol/ from the local axona-protocol source, with a
# test gate.
#
# dht-sim links @axona/protocol via `file:../axona-protocol` in package.json
# for Node-side tests, but the BROWSER reads the kernel through an importmap
# that points at vendor/axona-protocol/ — that's what gets served on GitHub
# Pages. This script keeps the vendored copy in sync with the local source.
#
#   ./scripts/sync-vendor-kernel.sh
#   KERNEL_SRC=/path/to/axona-protocol ./scripts/sync-vendor-kernel.sh
#   git add vendor/ && git commit -m "Vendor resync: <kernel tag>"
#   git push                 # GitHub Pages picks it up in ~30s
#
# Gates before declaring success:
#   1. diff -r completeness (the vendored tree mirrors the source exactly —
#      hand-maintained file lists in sibling repos silently dropped connect.js)
#   2. an import-load of the vendored barrel (a partial copy fails here)
#   3. npm run test:kernel — the 4 kernel-integration smokes. NOTE: these run
#      against the `file:` LINK (the same source tree), not the vendor copy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC="${KERNEL_SRC:-../axona-protocol}"
DEST="vendor/axona-protocol"

if [ ! -d "$SRC/src" ]; then
  echo "error: $SRC/src/ does not exist — clone axona-protocol as a sibling of dht-sim" >&2
  exit 1
fi

# Vendoring copies whatever is on disk — including another session's
# uncommitted kernel work. Warn loudly when the source tree is dirty; to
# vendor a clean release state, extract it first:
#   git -C ../axona-protocol archive HEAD src | tar -x -C /tmp/kernel-head
#   KERNEL_SRC=/tmp/kernel-head ./scripts/sync-vendor-kernel.sh
if git -C "$SRC" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  if ! git -C "$SRC" diff --quiet -- src 2>/dev/null; then
    echo "⚠ WARNING: kernel working tree at $SRC has UNCOMMITTED changes under src/ —"
    echo "  you are about to vendor in-flight work:"
    git -C "$SRC" status --porcelain src | head -10
  fi
fi

rm -rf "$DEST/src"
mkdir -p "$DEST"
cp -R "$SRC/src" "$DEST/src"
cp "$SRC/LICENSE"   "$DEST/LICENSE"   2>/dev/null || true
cp "$SRC/README.md" "$DEST/README.md" 2>/dev/null || true

echo "→ Completeness check"
if ! diff -rq "$SRC/src" "$DEST/src" > /dev/null; then
  echo "✗ vendored tree differs from the source after copy:"
  diff -rq "$SRC/src" "$DEST/src" | head -20
  exit 1
fi
echo "  ✓ trees identical"

echo "→ Import-load of the vendored barrel"
node --input-type=module -e "await import('./vendor/axona-protocol/src/index.js'); console.log('  ✓ vendored kernel graph loads');"

KERNEL_VERSION="$(grep -m1 'KERNEL_VERSION' "$DEST/src/transport/handshake.js" | sed -E "s/.*'([^']+)'.*/\1/")"
echo "  ✓ vendored kernel v$KERNEL_VERSION"

echo "→ npm run test:kernel (gate — runs against the file: link)"
if ! npm run test:kernel; then
  echo ""
  echo "✗ KERNEL SMOKES FAILED — do NOT commit. Restore with: git checkout vendor/"
  exit 1
fi

echo ""
echo "✓ sync + gate green (kernel v$KERNEL_VERSION). Commit vendor/:"
git status --porcelain vendor/ | head -10
