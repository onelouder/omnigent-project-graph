#!/usr/bin/env bash
# Install (or remove) the Project Graph overlay in an Omnigent checkout.
#
# usage: install.sh <omnigent-dir> [--uninstall] [--check] [--force] [--no-dirty-check] [--list-paths]
#
#   (default)     copy src/projectGraph into web/src/projectGraph and apply
#                 integration.patch (3-way fallback). Re-running is a no-op.
#   --uninstall   reverse the patch and remove web/src/projectGraph.
#   --check       dry run: report what would happen; non-zero exit on conflict.
#   --force       proceed even if the checkout has unrelated local changes,
#                 and on --uninstall remove a locally edited web/src/projectGraph.
#   --no-dirty-check  skip the unrelated-changes check (for callers that ran their own).
#   --list-paths  print the checkout paths this overlay manages, then exit.
set -euo pipefail

FEATURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$FEATURE_ROOT/src/projectGraph"
PATCH_FILE="$FEATURE_ROOT/integration.patch"
TARGET_REL="web/src/projectGraph"
INTEGRATION_FILES=(web/src/pages/ProjectHomePage.tsx web/src/projectHome/ProjectHomeHeader.tsx)

die() { echo "project-graph: error: $*" >&2; exit 1; }
say() { echo "project-graph: $*"; }

usage() { sed -n '4,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

list_paths() {
  echo "$TARGET_REL/"
  printf '%s\n' "${INTEGRATION_FILES[@]}"
}

mode=install force=0 dirty_check=1 omnigent_dir=""
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --check) mode=check ;;
    --force) force=1 ;;
    --no-dirty-check) dirty_check=0 ;;
    --list-paths) list_paths; exit 0 ;;
    -h|--help) usage 0 ;;
    -*) echo "project-graph: unknown option: $arg" >&2; usage 2 ;;
    *) [[ -z "$omnigent_dir" ]] || die "only one omnigent directory may be given"; omnigent_dir="$arg" ;;
  esac
done
[[ -n "$omnigent_dir" ]] || usage 2
[[ -d "$SOURCE_DIR" && -f "$PATCH_FILE" ]] || die "feature repo incomplete: need $SOURCE_DIR and $PATCH_FILE"
[[ -d "$omnigent_dir" ]] || die "not a directory: $omnigent_dir"
omnigent_dir="$(cd "$omnigent_dir" && pwd)"
git -C "$omnigent_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout: $omnigent_dir"
[[ "$(git -C "$omnigent_dir" rev-parse --show-toplevel)" == "$omnigent_dir" ]] \
  || die "give the checkout's top-level directory, not a subdirectory: $omnigent_dir"
for file in "${INTEGRATION_FILES[@]}" web/package.json; do
  [[ -f "$omnigent_dir/$file" ]] || die "$omnigent_dir does not look like an Omnigent checkout (missing $file)"
done
target="$omnigent_dir/$TARGET_REL"
in_checkout() { git -C "$omnigent_dir" "$@"; }

# Upstream owning web/src/projectGraph would collide with this overlay.
if [[ -n "$(in_checkout ls-files -- "$TARGET_REL")" ]]; then
  die "$TARGET_REL is tracked by this Omnigent checkout; the overlay would overwrite upstream files"
fi

# Changes outside the paths this overlay manages make the checkout dirty.
unrelated_changes() {
  local managed=() path
  mapfile -t managed < <(list_paths)
  in_checkout status --porcelain=v1 --untracked-files=all | while IFS= read -r line; do
    path="${line:3}"; path="${path##* -> }"
    local owned=0 prefix
    for prefix in "${managed[@]}"; do
      if [[ "$prefix" == */ ]]; then [[ "$path" == "$prefix"* ]] && owned=1
      else [[ "$path" == "$prefix" ]] && owned=1; fi
    done
    (( owned )) || echo "$line"
  done
}
if [[ "$mode" != check ]] && (( dirty_check )); then
  dirt="$(unrelated_changes)"
  if [[ -n "$dirt" ]]; then
    if (( force )); then say "warning: checkout has unrelated changes; continuing (--force)"
    else die "checkout has local changes outside the overlay's paths (use --force to proceed):"$'\n'"$dirt"; fi
  fi
fi

# Source copy state: absent | installed | different.
source_state() {
  if [[ ! -e "$target" ]]; then echo absent
  elif diff -rq "$SOURCE_DIR" "$target" >/dev/null 2>&1; then echo installed
  else echo different; fi
}

# Integration patch state: unapplied | applied | unapplied-3way | conflict.
patch_state() {
  if in_checkout apply --check "$PATCH_FILE" 2>/dev/null; then echo unapplied
  elif in_checkout apply --check -R "$PATCH_FILE" 2>/dev/null; then echo applied
  elif in_checkout apply --check --3way "$PATCH_FILE" >/dev/null 2>&1; then echo unapplied-3way
  else echo conflict; fi
}

apply_patch() {  # $@: extra git-apply flags (e.g. -R)
  if in_checkout apply "$@" "$PATCH_FILE" 2>/dev/null; then return 0; fi
  say "plain git apply $* failed; trying a 3-way merge"
  if ! in_checkout apply --3way "$@" "$PATCH_FILE"; then
    die "integration.patch does not apply to $omnigent_dir; resolve the conflict markers in: ${INTEGRATION_FILES[*]}"
  fi
  # --3way stages its result; keep the index matching HEAD so the change stays a plain edit.
  in_checkout reset -q -- "${INTEGRATION_FILES[@]}"
  say "applied with a 3-way merge; review the integration files"
}

src_state="$(source_state)" ptc_state="$(patch_state)"

case "$mode" in
  check)
    say "checkout:          $omnigent_dir ($(in_checkout rev-parse --short HEAD))"
    say "source copy:       $src_state"
    say "integration.patch: $ptc_state"
    [[ "$ptc_state" != conflict ]] || die "integration.patch conflicts with this checkout"
    if [[ "$src_state" == different ]]; then say "note: $TARGET_REL differs from this overlay's source and would be replaced"; fi
    say "check passed"
    ;;
  install)
    case "$src_state" in
      installed) say "source already installed at $TARGET_REL" ;;
      *)
        [[ "$src_state" == different ]] && say "replacing the existing $TARGET_REL with this overlay's source"
        rm -rf "$target"
        cp -R "$SOURCE_DIR" "$target"
        say "copied source to $TARGET_REL" ;;
    esac
    case "$ptc_state" in
      applied) say "integration.patch already applied" ;;
      conflict) die "integration.patch conflicts with $omnigent_dir; see COMPATIBILITY.md" ;;
      *) apply_patch; say "applied integration.patch" ;;
    esac
    say "installed"
    ;;
  uninstall)
    case "$ptc_state" in
      applied) apply_patch -R; say "reversed integration.patch" ;;
      unapplied|unapplied-3way) say "integration.patch not applied; nothing to reverse" ;;
      conflict) die "cannot reverse integration.patch: the integration files changed since install" ;;
    esac
    case "$src_state" in
      absent) say "$TARGET_REL not present" ;;
      installed) rm -rf "$target"; say "removed $TARGET_REL" ;;
      different)
        (( force )) || die "$TARGET_REL has local edits; re-run with --force to remove it anyway"
        rm -rf "$target"; say "removed $TARGET_REL (had local edits; --force)" ;;
    esac
    say "uninstalled"
    ;;
esac
