#!/usr/bin/env bash
# Install (or remove) the Project Graph overlay in an Omnigent checkout.
#
# usage: install.sh <omnigent-dir> [--uninstall] [--check] [--force] [--no-dirty-check] [--list-paths]
#
#   (default)     copy src/projectGraph into web/src/projectGraph and apply
#                 integration.patch (3-way merge when upstream context drifted).
#                 Records the pre-install content; re-running is a no-op.
#   --uninstall   restore the recorded pre-install content and remove the
#                 installed files.
#   --check       dry run of install (or of --uninstall); changes nothing and
#                 exits non-zero on a conflict or refusal.
#   --force       install over existing files in web/src/projectGraph, ignore
#                 unrelated local changes, and uninstall even when installed
#                 files were edited (their edits are overwritten, with a warning).
#   --no-dirty-check  skip the unrelated-changes check (for callers that ran their own).
#   --list-paths  print the checkout paths this overlay manages, then exit.
set -euo pipefail

FEATURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$FEATURE_ROOT/src/projectGraph"
PATCH_FILE="$FEATURE_ROOT/integration.patch"
UNIT=project-graph
TARGET_REL="web/src/projectGraph"
INTEGRATION_FILES=(web/src/pages/ProjectHomePage.tsx web/src/projectHome/ProjectHomeHeader.tsx)
OV_LOG_PREFIX=project-graph

# Fail early, with one clear message, on a host the scripts cannot run on
# (stock macOS: bash 3.2 and BSD userland). See "Requirements" in README.md.
preflight() {
  local missing=() tool
  if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
    missing+=("bash 4.4 or newer (this is $BASH_VERSION)")
  fi
  for tool in git sha256sum realpath mktemp find sort cp; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if command -v realpath >/dev/null 2>&1 && ! realpath -m -- /nonexistent/path >/dev/null 2>&1; then
    missing+=("GNU realpath (this one has no -m)")
  fi
  if ! printf 'a\nb\n' | head -n -1 >/dev/null 2>&1; then
    missing+=("GNU head (this one has no 'head -n -1')")
  fi
  ((${#missing[@]} == 0)) && return 0
  {
    echo "project-graph: error: this host is missing what the installer needs:"
    printf '  - %s\n' "${missing[@]}"
    echo "On macOS: brew install bash coreutils, put \$(brew --prefix)/opt/coreutils/libexec/gnubin"
    echo "first on PATH, and run the script with the Homebrew bash. Nothing was changed."
  } >&2
  exit 1
}
preflight
# shellcheck source=lib/overlay_state.sh
source "$FEATURE_ROOT/scripts/lib/overlay_state.sh"

die() { ov_err "$*"; exit 1; }
usage() { sed -n '4,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
list_paths() { echo "$TARGET_REL/"; printf '%s\n' "${INTEGRATION_FILES[@]}"; }

uninstall=0 dry_run=0 force=0 dirty_check=1 omnigent_dir=""
for arg in "$@"; do
  case "$arg" in
    --uninstall) uninstall=1 ;;
    --check) dry_run=1 ;;
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
[[ -f "$omnigent_dir/web/package.json" ]] || die "$omnigent_dir does not look like an Omnigent checkout (no web/package.json)"
ov_init "$omnigent_dir"

if [[ -n "$(git -C "$omnigent_dir" ls-files -- "$TARGET_REL")" ]]; then
  die "$TARGET_REL is tracked by this Omnigent checkout; the overlay would overwrite upstream files"
fi

# Local changes outside the paths this overlay manages.
unrelated_changes() {
  local managed=() line path prefix owned
  mapfile -t managed < <(list_paths)
  while IFS= read -r line; do
    path="${line:3}"; path="${path##* -> }"; owned=0
    for prefix in "${managed[@]}"; do
      if [[ "$prefix" == */ ]]; then [[ "$path" == "$prefix"* ]] && owned=1
      else [[ "$path" == "$prefix" ]] && owned=1; fi
    done
    ((owned)) || echo "$line"
  done < <(git -C "$omnigent_dir" status --porcelain=v1 --untracked-files=all)
}
if ((!dry_run && dirty_check)); then
  dirt="$(unrelated_changes)"
  if [[ -n "$dirt" ]]; then
    ((force)) || die "checkout has local changes outside the overlay's paths (use --force to proceed):"$'\n'"$dirt"
    ov_warn "checkout has unrelated local changes; continuing (--force)"
  fi
fi

ov_say "checkout $omnigent_dir ($(git -C "$omnigent_dir" rev-parse --short HEAD))"
if ((uninstall)); then
  ov_uninstall "$UNIT" "$TARGET_REL" "$dry_run" "$force"
else
  ov_install "$UNIT" "$PATCH_FILE" "$SOURCE_DIR" "$TARGET_REL" "$dry_run" "$force"
fi
