# shellcheck shell=bash
# Record-and-restore installation of an overlay "unit" into a git checkout.
#
# A unit is a patch and/or a source tree copied under a target directory.
# Install computes the full result in a disposable scratch area (temporary
# index + work dir; `git apply --3way` there), then records every touched
# file's pre-install content and pre/post hashes under
# <checkout git dir>/omnigent-stack/<unit>/ and only then writes the files.
# Uninstall restores the recorded pre-install content exactly. The checkout's
# own index is never modified.
#
# The same file ships in omnigent-stack and in each feature repo; keep the
# copies identical.
#
# Callers set OV_LOG_PREFIX and call ov_init <checkout-top-level> first.

OV_TMP_DIRS=()
ov_cleanup() {
  local dir
  for dir in "${OV_TMP_DIRS[@]}"; do rm -rf "$dir"; done
  OV_TMP_DIRS=()
}
trap ov_cleanup EXIT

ov_say() { echo "${OV_LOG_PREFIX:-overlay}: $*"; }
ov_err() { echo "${OV_LOG_PREFIX:-overlay}: error: $*" >&2; }
ov_warn() { echo "${OV_LOG_PREFIX:-overlay}: WARNING: $*" >&2; }
ov_list() { printf '    %s\n' "$@" >&2; }

ov_init() {
  OV_TARGET="$1"
  OV_GIT_DIR="$(git -C "$OV_TARGET" rev-parse --absolute-git-dir)"
  # Per-worktree git dir, so linked worktrees of one clone keep separate state.
  OV_STATE_ROOT="$OV_GIT_DIR/omnigent-stack"
}

# Content hash of a file, or ABSENT.
ov_hash() {
  if [[ -f "$1" ]]; then git hash-object --no-filters -- "$1"; else echo ABSENT; fi
}

# Identity of what a unit installs: the patch bytes plus each source file's path and hash.
ov_identity() {
  local patch="$1" source_dir="$2" relative
  {
    [[ -z "$patch" ]] || { echo "patch"; git hash-object --no-filters -- "$patch"; }
    if [[ -n "$source_dir" ]]; then
      while IFS= read -r -d '' relative; do
        printf '%s %s\n' "${relative#./}" "$(git hash-object --no-filters -- "$source_dir/$relative")"
      done < <(cd "$source_dir" && find . -type f -print0 | LC_ALL=C sort -z)
    fi
  } | git hash-object --stdin
}

# Run git against the scratch index and work dir of the current plan.
ov_scratch_git() {
  (cd "$OV_PLAN/wt" && GIT_DIR="$OV_GIT_DIR" GIT_WORK_TREE="$OV_PLAN/wt" \
    GIT_INDEX_FILE="$OV_PLAN/index" git "$@")
}

# Compute a unit's result without touching the checkout.
# Writes $OV_PLAN/plan.tsv (path, pre hash, post hash, post source file).
# Returns 1 on a patch conflict (details in $OV_PLAN/apply.log).
ov_plan() {
  local patch="$1" source_dir="$2" target_rel="$3" path relative rc=0 paths=()
  OV_PLAN="$(mktemp -d "${TMPDIR:-/tmp}/omnigent-overlay.XXXXXX")"
  OV_TMP_DIRS+=("$OV_PLAN")
  OV_PLAN_METHOD=none
  mkdir -p "$OV_PLAN/wt"
  : >"$OV_PLAN/plan.tsv"
  : >"$OV_PLAN/apply.log"
  if [[ -n "$patch" ]]; then
    mapfile -t paths < <(git -C "$OV_TARGET" apply --numstat -- "$patch" | cut -f3)
    GIT_INDEX_FILE="$OV_PLAN/index" git -C "$OV_TARGET" read-tree HEAD
    # Seed the scratch area with the checkout's current (possibly drifted) content.
    for path in "${paths[@]}"; do
      if [[ -f "$OV_TARGET/$path" ]]; then
        mkdir -p "$OV_PLAN/wt/$(dirname "$path")"
        cp -p "$OV_TARGET/$path" "$OV_PLAN/wt/$path"
        ov_scratch_git update-index --add -- "$path"
      else
        ov_scratch_git update-index --force-remove -- "$path"
      fi
    done
    if ov_scratch_git apply --check -- "$patch" >/dev/null 2>&1; then OV_PLAN_METHOD=plain; else OV_PLAN_METHOD=3way; fi
    ov_scratch_git apply --3way -- "$patch" >"$OV_PLAN/apply.log" 2>&1 || rc=$?
    if ((rc != 0)) || grep -qiE 'with conflicts|^error:|^fatal:' "$OV_PLAN/apply.log"; then
      return 1
    fi
    for path in "${paths[@]}"; do
      if [[ -f "$OV_PLAN/wt/$path" ]] && grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$OV_PLAN/wt/$path"; then
        echo "conflict markers in $path" >>"$OV_PLAN/apply.log"
        return 1
      fi
      printf '%s\t%s\t%s\t%s\n' "$path" "$(ov_hash "$OV_TARGET/$path")" \
        "$(ov_hash "$OV_PLAN/wt/$path")" "$OV_PLAN/wt/$path" >>"$OV_PLAN/plan.tsv"
    done
  fi
  if [[ -n "$source_dir" ]]; then
    while IFS= read -r -d '' relative; do
      relative="${relative#./}" path="$target_rel/${relative#./}"
      if printf '%s\n' "${paths[@]}" | grep -qxF -- "$path"; then
        echo "$path is both patched and copied" >>"$OV_PLAN/apply.log"
        return 1
      fi
      printf '%s\t%s\t%s\t%s\n' "$path" "$(ov_hash "$OV_TARGET/$path")" \
        "$(ov_hash "$source_dir/$relative")" "$source_dir/$relative" >>"$OV_PLAN/plan.tsv"
    done < <(cd "$source_dir" && find . -type f -print0 | LC_ALL=C sort -z)
  fi
}

# Replace a checkout file with $2 (or delete it when $2 is empty), via a temp file + rename.
ov_put_file() {
  local path="$1" from="$2" destination="$OV_TARGET/$1"
  if [[ -z "$from" ]]; then
    rm -f -- "$destination"
    return 0
  fi
  mkdir -p "$(dirname "$destination")"
  cp -p -- "$from" "$destination.ov-tmp.$$"
  mv -f -- "$destination.ov-tmp.$$" "$destination"
}

# Record pre-install content, then write the planned files.
ov_commit_plan() {
  local unit="$1" identity="$2" state="$OV_STATE_ROOT/$1" staging path pre post from
  staging="$OV_STATE_ROOT/.$unit.staging.$$"
  rm -rf -- "$state" "$staging" # a state dir without a manifest is an aborted record
  mkdir -p "$staging/pre"
  printf 'version\t1\nidentity\t%s\n' "$identity" >"$staging/manifest.tsv"
  while IFS=$'\t' read -r path pre post from; do
    if [[ "$pre" != ABSENT ]]; then
      mkdir -p "$staging/pre/$(dirname "$path")"
      cp -p -- "$OV_TARGET/$path" "$staging/pre/$path"
    fi
    printf 'file\t%s\t%s\t%s\n' "$path" "$pre" "$post" >>"$staging/manifest.tsv"
  done <"$OV_PLAN/plan.tsv"
  mv -- "$staging" "$state"
  while IFS=$'\t' read -r path pre post from; do
    [[ "$pre" == "$post" ]] && continue
    if [[ "$post" == ABSENT ]]; then ov_put_file "$path" ""; else ov_put_file "$path" "$from"; fi
  done <"$OV_PLAN/plan.tsv"
}

# Inspect a unit's recorded state. Sets OV_STATUS (absent|installed|modified),
# OV_RECORDED_IDENTITY, OV_MODIFIED (recorded files whose content changed since
# install) and OV_EXTRAS (files under target_rel that the unit did not install).
ov_unit_status() {
  local unit="$1" target_rel="$2" manifest="$OV_STATE_ROOT/$1/manifest.tsv" kind path pre post file
  local -A recorded=()
  OV_STATUS=absent OV_RECORDED_IDENTITY="" OV_MODIFIED=() OV_EXTRAS=()
  if [[ -f "$manifest" ]]; then
    OV_STATUS=installed
    while IFS=$'\t' read -r kind path pre post; do
      case "$kind" in
        identity) OV_RECORDED_IDENTITY="$path" ;;
        file)
          recorded["$path"]=1
          [[ "$(ov_hash "$OV_TARGET/$path")" == "$post" ]] || OV_MODIFIED+=("$path")
          ;;
      esac
    done <"$manifest"
    ((${#OV_MODIFIED[@]} == 0)) || OV_STATUS=modified
  fi
  if [[ -n "$target_rel" && -d "$OV_TARGET/$target_rel" ]]; then
    while IFS= read -r -d '' file; do
      file="${file#"$OV_TARGET/"}"
      [[ -n "${recorded[$file]:-}" ]] || OV_EXTRAS+=("$file")
    done < <(find "$OV_TARGET/$target_rel" -type f -print0 | LC_ALL=C sort -z)
  fi
}

# Install a unit. Args: unit patch source_dir target_rel dry_run(0|1) force(0|1).
# Returns non-zero, with the checkout unchanged, on any refusal or conflict.
ov_install() {
  local unit="$1" patch="$2" source_dir="$3" target_rel="$4" dry_run="$5" force="$6" identity count
  identity="$(ov_identity "$patch" "$source_dir")"
  ov_unit_status "$unit" "$target_rel"
  case "$OV_STATUS" in
    installed)
      if [[ "$OV_RECORDED_IDENTITY" == "$identity" ]]; then
        ov_say "already installed"
        return 0
      fi
      ov_err "a different version of $unit is installed; uninstall it first"
      return 1
      ;;
    modified)
      ov_err "$unit is installed, but these files changed since install:"
      ov_list "${OV_MODIFIED[@]}"
      ov_err "uninstall it first (--force discards those changes)"
      return 1
      ;;
  esac
  if ((${#OV_EXTRAS[@]})); then
    if ((!force)); then
      ov_err "$target_rel already contains files this overlay did not install (use --force to install over them):"
      ov_list "${OV_EXTRAS[@]}"
      return 1
    fi
    ov_warn "$target_rel already has files; same-named ones are saved and restored on uninstall, others are kept:"
    ov_list "${OV_EXTRAS[@]}"
  fi
  if ! ov_plan "$patch" "$source_dir" "$target_rel"; then
    ov_err "$(basename "${patch:-$unit}") conflicts with $OV_TARGET; nothing was changed. Scratch 3-way merge output:"
    sed 's/^/    /' "$OV_PLAN/apply.log" >&2
    return 1
  fi
  count="$(wc -l <"$OV_PLAN/plan.tsv" | tr -d ' ')"
  if ((dry_run)); then
    ov_say "would install: $count file(s); patch method: $OV_PLAN_METHOD"
    return 0
  fi
  ov_commit_plan "$unit" "$identity"
  ov_say "installed $count file(s); patch method: $OV_PLAN_METHOD"
}

# Uninstall a unit. Args: unit target_rel dry_run(0|1) force(0|1).
# Verifies everything first; a refusal leaves the checkout untouched.
ov_uninstall() {
  local unit="$1" target_rel="$2" dry_run="$3" force="$4" state="$OV_STATE_ROOT/$1" kind path pre post
  ov_unit_status "$unit" "$target_rel"
  if [[ "$OV_STATUS" == absent ]]; then
    ov_say "not installed (no install record)"
    if ((${#OV_EXTRAS[@]})); then
      ov_warn "$target_rel has files with no install record; leaving them:"
      ov_list "${OV_EXTRAS[@]}"
    fi
    return 0
  fi
  if ((${#OV_MODIFIED[@]} + ${#OV_EXTRAS[@]})) && ((!force)); then
    ((${#OV_MODIFIED[@]} == 0)) || { ov_err "files changed since install:"; ov_list "${OV_MODIFIED[@]}"; }
    ((${#OV_EXTRAS[@]} == 0)) || { ov_err "files in $target_rel not installed by this overlay:"; ov_list "${OV_EXTRAS[@]}"; }
    ov_err "refusing to uninstall $unit; nothing was changed (--force restores the pre-install content anyway)"
    return 1
  fi
  if ((dry_run)); then
    ov_say "would uninstall"
    return 0
  fi
  while IFS=$'\t' read -r kind path pre post; do
    [[ "$kind" == file ]] || continue
    if [[ "$pre" == ABSENT ]]; then ov_put_file "$path" ""; else ov_put_file "$path" "$state/pre/$path"; fi
  done <"$state/manifest.tsv"
  if [[ -n "$target_rel" && -d "$OV_TARGET/$target_rel" ]]; then
    find "$OV_TARGET/$target_rel" -depth -type d -empty -delete
  fi
  if ((${#OV_MODIFIED[@]})); then
    ov_warn "overwrote local changes (restored pre-install content or removed installed files):"
    ov_list "${OV_MODIFIED[@]}"
  fi
  if ((${#OV_EXTRAS[@]})); then
    ov_warn "left files that this overlay did not install:"
    ov_list "${OV_EXTRAS[@]}"
  fi
  rm -rf -- "$state"
  ov_say "uninstalled; restored pre-install content"
}
