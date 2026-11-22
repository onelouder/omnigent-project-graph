#!/usr/bin/env bash
# Drift tests for scripts/install.sh against a throwaway upstream worktree.
#
# usage: tests/drift-test.sh <omnigent-repo> [ref]   (ref defaults to origin/main)
#
# Creates `git worktree add --detach` of <ref> in a temp dir, runs the cases
# below with uncommitted or staged edits only, and removes the worktree.
set -euo pipefail

FEATURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$FEATURE_ROOT/scripts/install.sh"
REPO="${1:?usage: tests/drift-test.sh <omnigent-repo> [ref]}"
REF="${2:-origin/main}"
PAGE=web/src/pages/ProjectHomePage.tsx
HEADER=web/src/projectHome/ProjectHomeHeader.tsx
TARGET_REL=web/src/projectGraph

WORK="$(mktemp -d "${TMPDIR:-/tmp}/project-graph-drift.XXXXXX")"
CHECKOUT="$WORK/omnigent"
cleanup() {
  git -C "$REPO" worktree remove --force "$CHECKOUT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
git -C "$REPO" worktree add --quiet --detach "$CHECKOUT" "$REF"
STATE_DIR="$(git -C "$CHECKOUT" rev-parse --absolute-git-dir)/omnigent-stack"

passed=0 failed=0
ok() { echo "  PASS: $*"; passed=$((passed + 1)); }
bad() { echo "  FAIL: $*"; failed=$((failed + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Status, index entries and content hashes of everything the overlay can touch.
snapshot() {
  git -C "$CHECKOUT" status --porcelain=v1 --untracked-files=all
  git -C "$CHECKOUT" ls-files -s -- "$PAGE" "$HEADER"
  git -C "$CHECKOUT" hash-object --no-filters -- "$PAGE" "$HEADER"
  if [[ -d "$CHECKOUT/$TARGET_REL" ]]; then
    (cd "$CHECKOUT" && find "$TARGET_REL" -type f -print0 | LC_ALL=C sort -z | xargs -0 -r git hash-object --no-filters --)
  fi
}
reset_checkout() {
  git -C "$CHECKOUT" reset --quiet --hard HEAD
  git -C "$CHECKOUT" clean -fdq -- web/src
  rm -rf "$STATE_DIR"
}
run() { "$INSTALL" "$CHECKOUT" "$@" >"$WORK/out.log" 2>&1; }
output_has() { grep -qiE -- "$1" "$WORK/out.log"; }
installed_matches_source() { diff -rq "$FEATURE_ROOT/src/projectGraph" "$CHECKOUT/$TARGET_REL" >/dev/null 2>&1; }
hooked() { grep -q 'useShowsProjectGraph' "$CHECKOUT/$PAGE" && grep -q '<ProjectGraphViewToggle />' "$CHECKOUT/$HEADER"; }

echo "== (a) clean round trip"
reset_checkout
before="$(snapshot)"
check "install succeeds" 'run'
check "source and hook installed" 'installed_matches_source && hooked'
after_install="$(snapshot)"
check "repeat install is a no-op" 'run && output_has "already installed" && [[ "$(snapshot)" == "$after_install" ]]'
check "uninstall succeeds" 'run --uninstall'
check "checkout back to its pre-install state" '[[ "$(snapshot)" == "$before" ]]'
check "git status clean" '[[ -z "$(git -C "$CHECKOUT" status --porcelain)" ]]'
check "install record removed" '[[ ! -e "$STATE_DIR/project-graph" ]]'

echo "== (b) staged context drift near each hook (3-way merges cleanly)"
reset_checkout
sed -i 's/^const SESSION_PANEL_MIN_WIDTH_PX = 360;/const SESSION_PANEL_MIN_WIDTH_PX = 361;/' "$CHECKOUT/$PAGE"
sed -i 's#^import { Input } from "@/components/ui/input";#import { Input } from "@/components/ui/input"; // drift#' "$CHECKOUT/$HEADER"
sed -i 's#{isMobile \&\& <ProjectHomeActions projectName={projectName} />}#{isMobile \&\& <ProjectHomeActions projectName={projectName} /* drift */ />}#' "$CHECKOUT/$HEADER"
git -C "$CHECKOUT" add -- "$PAGE" "$HEADER"
check "drift is staged in both files" '[[ "$(git -C "$CHECKOUT" diff --cached --name-only | sort | tr "\n" " ")" == "$PAGE $HEADER " ]]'
check "plain git apply would fail" '! git -C "$CHECKOUT" apply --check "$FEATURE_ROOT/integration.patch" 2>/dev/null'
before="$(snapshot)"
check "check passes via 3-way" 'run --check && output_has "patch method: 3way"'
check "check changed nothing" '[[ "$(snapshot)" == "$before" ]]'
check "install succeeds via 3-way" 'run && output_has "patch method: 3way"'
check "hook installed and drift kept" 'hooked && grep -q "= 361;" "$CHECKOUT/$PAGE" && grep -q "// drift" "$CHECKOUT/$HEADER" && grep -q "/\* drift \*/" "$CHECKOUT/$HEADER"'
check "no conflict markers" '! grep -qE "^(<<<<<<<|>>>>>>>)" "$CHECKOUT/$PAGE" "$CHECKOUT/$HEADER"'
check "index untouched (drift still staged, hook unstaged)" '[[ "$(git -C "$CHECKOUT" ls-files -s -- "$PAGE" "$HEADER")" == "$(printf "%s\n" "$before" | grep -E "^[0-9]{6} ")" ]]'
after_install="$(snapshot)"
check "repeat install is a no-op" 'run && output_has "already installed" && [[ "$(snapshot)" == "$after_install" ]]'
check "uninstall succeeds" 'run --uninstall'
check "exact pre-install content, index and status restored (by hash)" '[[ "$(snapshot)" == "$before" ]]'

echo "== (c) conflicting drift"
reset_checkout
sed -i 's/searchQuery={searchQuery}/searchQuery={searchQuery.trim()}/' "$CHECKOUT/$PAGE"
before="$(snapshot)"
check "check reports the conflict and exits non-zero" '! run --check && output_has "conflict"'
check "apply refuses" '! run && output_has "nothing was changed"'
check "checkout unchanged (status, index, hashes)" '[[ "$(snapshot)" == "$before" ]]'
check "no source copied, no install record" '[[ ! -e "$CHECKOUT/$TARGET_REL" && ! -e "$STATE_DIR/project-graph" ]]'

echo "== (d) untracked extra file in $TARGET_REL"
reset_checkout
mkdir -p "$CHECKOUT/$TARGET_REL"
echo "local notes" >"$CHECKOUT/$TARGET_REL/local-notes.txt"
before="$(snapshot)"
check "install refuses without --force" '! run && output_has "did not install"'
check "checkout unchanged and the file survives" '[[ "$(snapshot)" == "$before" && "$(cat "$CHECKOUT/$TARGET_REL/local-notes.txt")" == "local notes" ]]'
check "install --force succeeds and keeps the file" 'run --force && diff -rq --exclude=local-notes.txt "$FEATURE_ROOT/src/projectGraph" "$CHECKOUT/$TARGET_REL" >/dev/null && [[ -f "$CHECKOUT/$TARGET_REL/local-notes.txt" ]]'
check "uninstall refuses (file not installed by the overlay)" '! run --uninstall'
check "uninstall --force removes only installed files" 'run --uninstall --force && [[ "$(ls -A "$CHECKOUT/$TARGET_REL")" == "local-notes.txt" ]]'
check "back to the pre-install state" '[[ "$(snapshot)" == "$before" ]]'

echo "== (e) refused uninstall leaves the checkout untouched"
reset_checkout
pristine="$(snapshot)"
run
echo "// local edit" >>"$CHECKOUT/$TARGET_REL/ProjectGraph.tsx"
echo "extra" >"$CHECKOUT/$TARGET_REL/extra.txt"
sed -i 's/const showsGraph = useShowsProjectGraph();/const showsGraph = useShowsProjectGraph(); \/\/ edited/' "$CHECKOUT/$PAGE"
before="$(snapshot)"
check "uninstall refuses and lists the edited and extra files" '! run --uninstall && output_has "ProjectGraph.tsx" && output_has "extra.txt" && output_has "ProjectHomePage.tsx"'
check "checkout untouched (status, index, hashes)" '[[ "$(snapshot)" == "$before" ]]'
check "uninstall --check also refuses" '! run --uninstall --check && [[ "$(snapshot)" == "$before" ]]'
check "uninstall --force restores and warns" 'run --uninstall --force && output_has "WARNING: overwrote" && output_has "WARNING: left files"'
check "integration files restored exactly" '[[ "$(git -C "$CHECKOUT" status --porcelain -- "$PAGE" "$HEADER")" == "" ]]'
check "the unrecorded file is kept, installed files removed" '[[ "$(ls -A "$CHECKOUT/$TARGET_REL")" == "extra.txt" ]]'
rm -f "$CHECKOUT/$TARGET_REL/extra.txt"; rmdir "$CHECKOUT/$TARGET_REL"
check "otherwise back to pristine" '[[ "$(snapshot)" == "$pristine" ]]'

reset_checkout
echo
echo "drift-test: $passed passed, $failed failed"
((failed == 0))
