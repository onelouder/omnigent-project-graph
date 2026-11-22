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
RECORD="$STATE_DIR/project-graph"
# Scripts under test put their scratch dirs here, so leftovers are detectable.
export TMPDIR="$WORK/tmp"
mkdir -p "$TMPDIR"

passed=0 failed=0
ok() { echo "  PASS: $*"; passed=$((passed + 1)); }
bad() { echo "  FAIL: $*"; failed=$((failed + 1)); sed 's/^/      | /' "$WORK/out.log" 2>/dev/null | tail -15; }
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
  chmod -R u+w "$CHECKOUT/web/src" 2>/dev/null || true
  git -C "$CHECKOUT" reset --quiet --hard HEAD
  git -C "$CHECKOUT" clean -fdq -- web/src
  rm -rf "$STATE_DIR"
  [[ ! -L "$CHECKOUT/$TARGET_REL" ]] || rm -f "$CHECKOUT/$TARGET_REL"
}
# No scratch dirs, staging dirs or destination temp files left behind.
no_leftovers() {
  [[ -z "$(ls -A "$TMPDIR")" ]] \
    && [[ -z "$(find "$CHECKOUT/web" -name '*.ov-tmp.*' -print -quit)" ]] \
    && [[ -z "$(find "$STATE_DIR" -maxdepth 1 -name '.*staging*' -print -quit 2>/dev/null)" ]]
}
outside_listing() { (cd "$1" && find . -print0 | LC_ALL=C sort -z | xargs -0 -r ls -ld --time-style=+ | awk '{print $1, $5, $NF}'; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha1sum); }
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

echo "== (f) a restore failure keeps the record and reports what was restored"
reset_checkout
pristine="$(snapshot)"
run
pre_page="$(git -C "$CHECKOUT" rev-parse "HEAD:$PAGE")"
chmod a-w "$CHECKOUT/web/src/projectHome"
check "uninstall exits non-zero" '! run --uninstall'
check "it reports the failed file, the restored ones, and keeps the record" 'output_has "could not restore 1 file" && output_has "ProjectHomeHeader.tsx" && output_has "restored and verified" && output_has "record is kept" && [[ -f "$RECORD/manifest.tsv" ]]'
check "files that could be restored were restored (verified by hash)" '[[ "$(git -C "$CHECKOUT" hash-object --no-filters -- "$PAGE")" == "$pre_page" && -z "$(find "$CHECKOUT/$TARGET_REL" -type f 2>/dev/null)" ]]'
check "no temp files or dirs left behind" 'no_leftovers'
chmod u+w "$CHECKOUT/web/src/projectHome"
check "re-running uninstall finishes and removes the record" 'run --uninstall && [[ ! -e "$RECORD" && "$(snapshot)" == "$pristine" ]]'

echo "== (g) an injected write failure during install rolls back and leaves no temp files"
reset_checkout
pristine="$(snapshot)"
chmod a-w "$CHECKOUT/web/src/projectHome"
check "install exits non-zero and rolls back" '! run && output_has "rolling back" && output_has "rolled back"'
check "checkout unchanged, no record" '[[ "$(snapshot)" == "$pristine" && ! -e "$RECORD" ]]'
check "no temp files, staging dirs or scratch dirs left behind" 'no_leftovers'
chmod u+w "$CHECKOUT/web/src/projectHome"

echo "== (h) a deleted backup: uninstall refuses, keeps the record, changes nothing"
reset_checkout
run
rm -f "$RECORD/pre/$PAGE"
before="$(snapshot)"
check "uninstall refuses" '! run --uninstall && output_has "backup missing: $PAGE"'
check "uninstall --force refuses too" '! run --uninstall --force && output_has "even with --force"'
check "checkout unchanged and record kept" '[[ "$(snapshot)" == "$before" && -f "$RECORD/manifest.tsv" ]]'

echo "== (i) a corrupted backup: uninstall refuses even with --force"
reset_checkout
run
echo "corrupted" >>"$RECORD/pre/$HEADER"
before="$(snapshot)"
check "uninstall --force refuses" '! run --uninstall --force && output_has "backup corrupted \(hash mismatch\): $HEADER"'
check "checkout unchanged and record kept" '[[ "$(snapshot)" == "$before" && -f "$RECORD/manifest.tsv" ]]'

echo "== (j) a ../ path in the record is refused; nothing outside is touched"
reset_checkout
run
echo "keep me" >"$WORK/outside.txt"
printf 'file\t../outside.txt\tABSENT\t%s\n' "$(git hash-object --no-filters -- "$WORK/outside.txt")" >>"$RECORD/manifest.tsv"
before="$(snapshot)"
check "uninstall --force refuses the record" '! run --uninstall --force && output_has "unsafe or malformed path"'
check "the outside file is intact" '[[ "$(cat "$WORK/outside.txt")" == "keep me" ]]'
check "checkout unchanged and record kept" '[[ "$(snapshot)" == "$before" && -f "$RECORD/manifest.tsv" ]]'
check "install also refuses the record" '! run && output_has "unsafe or malformed path"'

echo "== (k) a symlinked $TARGET_REL is refused, outside dir untouched"
reset_checkout
mkdir -p "$WORK/outside-dir"
echo "outside" >"$WORK/outside-dir/keep.txt"
outside_before="$(outside_listing "$WORK/outside-dir")"
ln -s "$WORK/outside-dir" "$CHECKOUT/$TARGET_REL"
check "install --force refuses" '! run --force && output_has "symlink"'
check "install --check --force refuses" '! run --check --force'
check "outside dir untouched, no record" '[[ "$(outside_listing "$WORK/outside-dir")" == "$outside_before" && ! -e "$RECORD" ]]'
rm -f "$CHECKOUT/$TARGET_REL"
run
mv "$CHECKOUT/$TARGET_REL" "$WORK/moved-graph"
ln -s "$WORK/moved-graph" "$CHECKOUT/$TARGET_REL"
moved_before="$(outside_listing "$WORK/moved-graph")"
before="$(snapshot)"
check "uninstall --force refuses through a symlinked $TARGET_REL" '! run --uninstall --force && output_has "symlink"'
check "the symlink target is untouched, record kept, checkout unchanged" '[[ "$(outside_listing "$WORK/moved-graph")" == "$moved_before" && -f "$RECORD/manifest.tsv" && "$(snapshot)" == "$before" ]]'
rm -f "$CHECKOUT/$TARGET_REL"

echo "== (l) HEAD moved between install and uninstall (fixture repo)"
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init --quiet
for file in "$PAGE" "$HEADER" web/package.json; do
  mkdir -p "$FIXTURE/$(dirname "$file")"
  git -C "$REPO" show "$REF:$file" >"$FIXTURE/$file"
done
fixture_git() { git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture@example.com "$@"; }
fixture_git add -A && fixture_git commit --quiet -m "upstream base"
"$INSTALL" "$FIXTURE" >"$WORK/out.log" 2>&1
pre_header="$(git -C "$FIXTURE" rev-parse "HEAD:$HEADER")"
post_page="$(git -C "$FIXTURE" hash-object --no-filters -- "$PAGE")"
# Upstream adopts the page hook: the new HEAD tracks the installed page content.
fixture_git add -- "$PAGE" && fixture_git commit --quiet -m "upstream adopts the page hook"
fixture_snapshot() { git -C "$FIXTURE" status --porcelain=v1 --untracked-files=all; git -C "$FIXTURE" hash-object --no-filters -- "$PAGE" "$HEADER"; }
before="$(fixture_snapshot)"
check "uninstall refuses after HEAD moved" '! "$INSTALL" "$FIXTURE" --uninstall >"$WORK/out.log" 2>&1 && output_has "installed on .*HEAD is now"'
check "fixture unchanged, record kept" '[[ "$(fixture_snapshot)" == "$before" && -f "$(git -C "$FIXTURE" rev-parse --absolute-git-dir)/omnigent-stack/project-graph/manifest.tsv" ]]'
check "uninstall --force succeeds with a warning for the kept file" '"$INSTALL" "$FIXTURE" --uninstall --force >"$WORK/out.log" 2>&1 && output_has "HEAD moved since install" && output_has "new HEAD tracks this content"'
check "content tracked by the new HEAD is not reverted" '[[ "$(git -C "$FIXTURE" hash-object --no-filters -- "$PAGE")" == "$post_page" ]]'
check "other files restored and removed" '[[ "$(git -C "$FIXTURE" hash-object --no-filters -- "$HEADER")" == "$pre_header" && ! -e "$FIXTURE/$TARGET_REL" ]]'
check "fixture clean, record removed" '[[ -z "$(git -C "$FIXTURE" status --porcelain)" && ! -e "$(git -C "$FIXTURE" rev-parse --absolute-git-dir)/omnigent-stack/project-graph" ]]'
check "no temp files or dirs left behind" '[[ -z "$(ls -A "$TMPDIR")" ]]'

reset_checkout
echo
echo "drift-test: $passed passed, $failed failed"
((failed == 0))
