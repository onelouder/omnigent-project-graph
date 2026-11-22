# shellcheck shell=bash
# Record-and-restore installation of an overlay "unit" into a git checkout.
#
# A unit is a patch and/or a source tree copied under a target directory.
# Install computes the full result in a disposable scratch area (temporary
# index + work dir; `git apply --3way` there), records every touched file's
# pre-install content, pre/post hashes and the install-time HEAD under
# <checkout git dir>/omnigent-stack/<unit>/, then writes the files. Uninstall
# validates that record completely, restores the recorded content and deletes
# the record only after every restored file is verified by hash. The
# checkout's own index is never modified.
#
# Every step checks its own result: these functions are often called from
# conditionals, where bash's errexit does not apply.
#
# The same file ships in omnigent-stack and in each feature repo; keep the
# copies byte-identical. Requires bash 4.4+, git, and GNU coreutils/grep.
#
# Callers set OV_LOG_PREFIX and call ov_init <checkout-top-level> first.

OV_TMP_PATHS=()
ov_cleanup() {
  local temporary
  for temporary in "${OV_TMP_PATHS[@]}"; do rm -rf -- "$temporary"; done
  OV_TMP_PATHS=()
}
trap ov_cleanup EXIT
trap 'exit 130' INT TERM HUP

ov_say() { echo "${OV_LOG_PREFIX:-overlay}: $*"; }
ov_err() { echo "${OV_LOG_PREFIX:-overlay}: error: $*" >&2; }
ov_warn() { echo "${OV_LOG_PREFIX:-overlay}: WARNING: $*" >&2; }
ov_list() { (($# == 0)) || printf '    %s\n' "$@" >&2; }

ov_init() {
  OV_TARGET="$1"
  OV_ROOT_REAL="$(realpath -e -- "$OV_TARGET")" || { ov_err "cannot resolve $OV_TARGET"; return 1; }
  OV_GIT_DIR="$(git -C "$OV_TARGET" rev-parse --absolute-git-dir)" || { ov_err "not a git checkout: $OV_TARGET"; return 1; }
  # Per-worktree git dir, so linked worktrees of one clone keep separate state.
  OV_STATE_ROOT="$OV_GIT_DIR/omnigent-stack"
}

# Content hash of a regular file, ABSENT, or NOT-A-REGULAR-FILE.
ov_hash() {
  if [[ -f "$1" && ! -L "$1" ]]; then
    git hash-object --no-filters -- "$1"
  elif [[ -e "$1" || -L "$1" ]]; then
    echo NOT-A-REGULAR-FILE
  else
    echo ABSENT
  fi
}

ov_head() { git -C "$OV_TARGET" rev-parse --verify --quiet HEAD || echo NONE; }

# Blob hash that HEAD tracks at a path, or ABSENT.
ov_head_blob() { git -C "$OV_TARGET" rev-parse --verify --quiet "HEAD:$1" 2>/dev/null || echo ABSENT; }

# Whether a checkout-relative path is normalized, stays inside the checkout and
# has no symlink in any existing component (the file itself included).
ov_safe_path() {
  local path="$1" prefix="" component real parts=()
  case "$path" in "" | /* | */ | *//*) return 1 ;; esac
  [[ "$path" != *[[:cntrl:]]* ]] || return 1
  IFS='/' read -r -a parts <<<"$path"
  for component in "${parts[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    prefix="${prefix:+$prefix/}$component"
    [[ ! -L "$OV_TARGET/$prefix" ]] || return 1
  done
  real="$(realpath -m -- "$OV_TARGET/$path")" || return 1
  [[ "$real" == "$OV_ROOT_REAL/"* ]]
}

ov_unsafe_target_message() {
  ov_err "$1 is a symlink, contains one, or leaves the checkout; refusing (even with --force)"
}

# Identity of what a unit installs: the patch bytes plus each source file's path and hash.
ov_identity() {
  local patch="$1" source_dir="$2" relative
  {
    if [[ -n "$patch" ]]; then echo patch; git hash-object --no-filters -- "$patch" || return 1; fi
    if [[ -n "$source_dir" ]]; then
      while IFS= read -r -d '' relative; do
        printf '%s %s\n' "${relative#./}" "$(git hash-object --no-filters -- "$source_dir/$relative")" || return 1
      done < <(cd "$source_dir" && find . -type f -print0 | LC_ALL=C sort -z)
    fi
  } | git hash-object --stdin
}

# Run git against the scratch index and work dir of the current plan.
ov_scratch_git() {
  (cd "$OV_PLAN/wt" && GIT_DIR="$OV_GIT_DIR" GIT_WORK_TREE="$OV_PLAN/wt" \
    GIT_INDEX_FILE="$OV_PLAN/index" git "$@")
}

# Compute a unit's result without touching the checkout. Writes
# $OV_PLAN/plan.tsv (path, pre hash, post hash, post source file).
# Returns 1 on a patch conflict, 2 on an error, 3 on an unsafe destination
# (details in $OV_PLAN/apply.log).
ov_plan() {
  local patch="$1" source_dir="$2" target_rel="$3" path relative pre post rc=0 paths=()
  OV_PLAN="$(mktemp -d "${TMPDIR:-/tmp}/omnigent-overlay.XXXXXX")" || return 2
  OV_TMP_PATHS+=("$OV_PLAN")
  OV_PLAN_METHOD=none
  { mkdir -p "$OV_PLAN/wt" && : >"$OV_PLAN/plan.tsv" && : >"$OV_PLAN/apply.log"; } || return 2
  if [[ -n "$patch" ]]; then
    mapfile -t paths < <(git -C "$OV_TARGET" apply --numstat -- "$patch" | cut -f3)
    ((${#paths[@]})) || { echo "cannot read $patch" >>"$OV_PLAN/apply.log"; return 2; }
    for path in "${paths[@]}"; do
      ov_safe_path "$path" || { echo "unsafe destination: $path" >>"$OV_PLAN/apply.log"; return 3; }
    done
    GIT_INDEX_FILE="$OV_PLAN/index" git -C "$OV_TARGET" read-tree HEAD >>"$OV_PLAN/apply.log" 2>&1 || return 2
    # Seed the scratch area with the checkout's current (possibly drifted) content.
    for path in "${paths[@]}"; do
      if [[ -f "$OV_TARGET/$path" ]]; then
        mkdir -p "$OV_PLAN/wt/$(dirname "$path")" || return 2
        cp -p -- "$OV_TARGET/$path" "$OV_PLAN/wt/$path" || return 2
        ov_scratch_git update-index --add -- "$path" >>"$OV_PLAN/apply.log" 2>&1 || return 2
      else
        ov_scratch_git update-index --force-remove -- "$path" >>"$OV_PLAN/apply.log" 2>&1 || return 2
      fi
    done
    if ov_scratch_git apply --check -- "$patch" >/dev/null 2>&1; then OV_PLAN_METHOD=plain; else OV_PLAN_METHOD=3way; fi
    ov_scratch_git apply --3way -- "$patch" >>"$OV_PLAN/apply.log" 2>&1 || rc=$?
    if ((rc != 0)) || grep -qiE 'with conflicts|^error:|^fatal:' "$OV_PLAN/apply.log"; then
      return 1
    fi
    for path in "${paths[@]}"; do
      if [[ -f "$OV_PLAN/wt/$path" ]] && grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$OV_PLAN/wt/$path"; then
        echo "conflict markers in $path" >>"$OV_PLAN/apply.log"
        return 1
      fi
      { pre="$(ov_hash "$OV_TARGET/$path")" && post="$(ov_hash "$OV_PLAN/wt/$path")"; } || return 2
      printf '%s\t%s\t%s\t%s\n' "$path" "$pre" "$post" "$OV_PLAN/wt/$path" >>"$OV_PLAN/plan.tsv" || return 2
    done
  fi
  if [[ -n "$source_dir" ]]; then
    while IFS= read -r -d '' relative; do
      relative="${relative#./}" path="$target_rel/${relative#./}"
      ov_safe_path "$path" || { echo "unsafe destination: $path" >>"$OV_PLAN/apply.log"; return 3; }
      if printf '%s\n' "${paths[@]}" | grep -qxF -- "$path"; then
        echo "$path is both patched and copied" >>"$OV_PLAN/apply.log"
        return 2
      fi
      { pre="$(ov_hash "$OV_TARGET/$path")" && post="$(ov_hash "$source_dir/$relative")"; } || return 2
      printf '%s\t%s\t%s\t%s\n' "$path" "$pre" "$post" "$source_dir/$relative" >>"$OV_PLAN/plan.tsv" || return 2
    done < <(cd "$source_dir" && find . -type f -print0 | LC_ALL=C sort -z)
  fi
  if grep -qF $'\tNOT-A-REGULAR-FILE\t' "$OV_PLAN/plan.tsv"; then
    echo "a destination exists but is not a regular file" >>"$OV_PLAN/apply.log"
    return 3
  fi
}

# Replace a checkout file with $2 (or delete it when $2 is empty) via a temp
# file + rename, refusing unsafe destinations. Returns non-zero on any failure.
ov_put_file() {
  local path="$1" from="$2" destination="$OV_TARGET/$1" temporary
  ov_safe_path "$path" || { ov_err "unsafe destination, not written: $path"; return 1; }
  if [[ -z "$from" ]]; then
    rm -f -- "$destination" || return 1
    [[ ! -e "$destination" ]] || return 1
    return 0
  fi
  mkdir -p -- "$(dirname -- "$destination")" || return 1
  ov_safe_path "$path" || { ov_err "unsafe destination, not written: $path"; return 1; }
  temporary="$destination.ov-tmp.$$"
  OV_TMP_PATHS+=("$temporary")
  cp -p -- "$from" "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -f -- "$temporary" "$destination" || { rm -f -- "$temporary"; return 1; }
}

# Load and fully validate a unit's record into OV_REC_* variables: every path
# safe, every backup present and matching its recorded hash. Returns 0 when
# valid, 1 when there is no record, 2 when it is invalid. Never modifies anything.
ov_load_record() {
  local unit="$1" state="$OV_STATE_ROOT/$1" manifest kind a b c extra backup state_real version="" problems=()
  local -A seen=()
  OV_REC_STATE="$state" OV_REC_IDENTITY="" OV_REC_HEAD="" OV_REC_PATHS=() OV_REC_PRE=() OV_REC_POST=()
  manifest="$state/manifest.tsv"
  [[ -e "$state" || -L "$state" ]] || return 1
  if [[ -L "$state" || ! -d "$state" || -L "$manifest" || ! -f "$manifest" ]]; then
    ov_err "the install record at $state is incomplete or not a plain directory; refusing to use it (even with --force)"
    return 2
  fi
  state_real="$(realpath -e -- "$state")" || return 2
  while IFS=$'\t' read -r kind a b c extra || [[ -n "$kind" ]]; do
    case "$kind" in
      version) version="$a" ;;
      identity) OV_REC_IDENTITY="$a" ;;
      head) OV_REC_HEAD="$a" ;;
      file)
        if [[ -n "$extra" ]] || ! ov_safe_path "$a"; then
          problems+=("unsafe or malformed path (absolute, '..', outside the checkout or through a symlink): ${a@Q}")
          continue
        fi
        if [[ ! "$b" =~ ^([0-9a-f]{40}|[0-9a-f]{64}|ABSENT)$ || ! "$c" =~ ^([0-9a-f]{40}|[0-9a-f]{64}|ABSENT)$ ]]; then
          problems+=("malformed hashes for $a")
          continue
        fi
        [[ -z "${seen[$a]:-}" ]] || { problems+=("duplicate path: $a"); continue; }
        seen["$a"]=1
        if [[ "$b" != ABSENT ]]; then
          backup="$state/pre/$a"
          if [[ -L "$backup" || ! -f "$backup" ]]; then
            problems+=("backup missing: $a")
          elif [[ "$(realpath -e -- "$backup")" != "$state_real/pre/"* ]]; then
            problems+=("backup outside the record: $a")
          elif [[ "$(git hash-object --no-filters -- "$backup")" != "$b" ]]; then
            problems+=("backup corrupted (hash mismatch): $a")
          fi
        fi
        OV_REC_PATHS+=("$a") OV_REC_PRE+=("$b") OV_REC_POST+=("$c")
        ;;
      *) problems+=("unknown record line: ${kind@Q}") ;;
    esac
  done <"$manifest"
  [[ "$version" == 2 ]] || problems+=("unsupported record version: ${version:-none}")
  [[ "$OV_REC_HEAD" =~ ^([0-9a-f]{40}|[0-9a-f]{64}|NONE)$ ]] || problems+=("malformed install-time HEAD")
  [[ -n "$OV_REC_IDENTITY" ]] || problems+=("missing identity")
  if ((${#problems[@]})); then
    ov_err "the install record at $state is invalid; refusing to use it (even with --force):"
    ov_list "${problems[@]}"
    return 2
  fi
}

# Files under target_rel that are not in OV_REC_PATHS (symlinks included) -> OV_EXTRAS.
ov_find_extras() {
  local target_rel="$1" file
  local -A recorded=()
  OV_EXTRAS=()
  for file in "${OV_REC_PATHS[@]}"; do recorded["$file"]=1; done
  [[ -n "$target_rel" && -d "$OV_TARGET/$target_rel" && ! -L "$OV_TARGET/$target_rel" ]] || return 0
  while IFS= read -r -d '' file; do
    file="${file#"$OV_TARGET/"}"
    [[ -n "${recorded[$file]:-}" ]] || OV_EXTRAS+=("$file")
  done < <(find "$OV_TARGET/$target_rel" ! -type d -print0 | LC_ALL=C sort -z)
}

# Build the record in a staging dir with every backup verified by hash.
ov_write_record() {
  local staging="$1" identity="$2" head path pre post from
  head="$(ov_head)" || return 1
  mkdir -- "$staging/pre" || return 1
  printf 'version\t2\nidentity\t%s\nhead\t%s\n' "$identity" "$head" >"$staging/manifest.tsv" || return 1
  while IFS=$'\t' read -r path pre post from; do
    if [[ "$pre" != ABSENT ]]; then
      mkdir -p -- "$staging/pre/$(dirname -- "$path")" || return 1
      cp -p -- "$OV_TARGET/$path" "$staging/pre/$path" || return 1
      [[ "$(git hash-object --no-filters -- "$staging/pre/$path")" == "$pre" ]] || return 1
    fi
    printf 'file\t%s\t%s\t%s\n' "$path" "$pre" "$post" >>"$staging/manifest.tsv" || return 1
  done <"$OV_PLAN/plan.tsv"
}

# Store the record, then write the planned files and verify them. On any
# write failure, roll back; the record is kept unless the rollback is verified.
ov_commit_plan() {
  local unit="$1" identity="$2" state="$OV_STATE_ROOT/$1" staging path pre post from failed=""
  if [[ -e "$state" || -L "$state" ]]; then ov_err "an install record already exists at $state"; return 1; fi
  if ! mkdir -p -- "$OV_STATE_ROOT" || ! staging="$(mktemp -d "$OV_STATE_ROOT/.$unit.staging.XXXXXX")"; then
    ov_err "cannot create the install record under $OV_STATE_ROOT; nothing was changed"
    return 1
  fi
  OV_TMP_PATHS+=("$staging")
  if ! ov_write_record "$staging" "$identity" || ! mv -T -- "$staging" "$state"; then
    ov_err "cannot write the install record (or a file changed meanwhile); nothing was changed"
    return 1
  fi
  while IFS=$'\t' read -r path pre post from; do
    [[ "$pre" != "$post" ]] || continue
    if [[ "$post" == ABSENT ]]; then ov_put_file "$path" "" || { failed="$path"; break; }
    else ov_put_file "$path" "$from" || { failed="$path"; break; }; fi
    [[ "$(ov_hash "$OV_TARGET/$path")" == "$post" ]] || { failed="$path"; break; }
  done <"$OV_PLAN/plan.tsv"
  [[ -n "$failed" ]] || return 0
  ov_err "could not write $failed; rolling back"
  if ov_restore "$unit" "" 0 1; then
    ov_err "rolled back; the checkout is as it was before install"
  else
    ov_err "rollback incomplete; the install record is kept at $state; fix the cause and run --uninstall"
  fi
  return 1
}

# Restore a unit from its record. Args: unit target_rel force rollback(0|1) [dry_run].
# Validates everything before changing anything; deletes the record only
# after every restored file is verified by hash.
ov_restore() {
  local unit="$1" target_rel="$2" force="$3" rollback="$4" dry_run="${5:-0}" rc=0
  local head_now head_changed=0 index path pre post current
  local restore=() kept=() overwritten=() modified=() failures=() restored=()
  ov_load_record "$unit" || rc=$?
  if ((rc == 1)); then ov_say "not installed (no install record)"; return 0; fi
  ((rc == 0)) || return 1
  if [[ -n "$target_rel" ]] && ! ov_safe_path "$target_rel"; then ov_unsafe_target_message "$target_rel"; return 1; fi
  head_now="$(ov_head)"
  [[ "$head_now" == "$OV_REC_HEAD" ]] || head_changed=1
  if ((head_changed && !force && !rollback)); then
    ov_err "$unit was installed on ${OV_REC_HEAD:0:12}, but HEAD is now ${head_now:0:12}; refusing to restore pre-install content taken from the old HEAD"
    ov_err "uninstall before moving HEAD (see docs/upgrade.md); --force restores only files still exactly as installed whose installed content the new HEAD does not track"
    return 1
  fi
  for index in "${!OV_REC_PATHS[@]}"; do
    path="${OV_REC_PATHS[index]}" pre="${OV_REC_PRE[index]}" post="${OV_REC_POST[index]}"
    current="$(ov_hash "$OV_TARGET/$path")"
    if [[ "$current" == "$pre" ]]; then
      continue # already as before install
    elif [[ "$current" == "$post" ]]; then
      if ((head_changed)) && [[ "$post" == "$(ov_head_blob "$path")" ]]; then
        kept+=("$path (the new HEAD tracks this content)")
      else
        restore+=("$index")
      fi
    elif ((!force)); then
      modified+=("$path")
    elif ((head_changed)); then
      kept+=("$path (changed since install)")
    else
      overwritten+=("$path")
      restore+=("$index")
    fi
  done
  OV_EXTRAS=()
  ((rollback)) || ov_find_extras "$target_rel"
  if ((${#modified[@]})) || ((${#OV_EXTRAS[@]} && !force)); then
    if ((${#modified[@]})); then
      if ((rollback)); then ov_err "cannot roll back; these files changed during install:"; else ov_err "files changed since install:"; fi
      ov_list "${modified[@]}"
    fi
    if ((${#OV_EXTRAS[@]} && !force)); then ov_err "files in $target_rel not installed by this overlay:"; ov_list "${OV_EXTRAS[@]}"; fi
    ((rollback)) || ov_err "refusing to uninstall $unit; nothing was changed (--force restores the pre-install content anyway)"
    return 1
  fi
  if ((dry_run)); then
    ov_say "would uninstall: restore ${#restore[@]} file(s), keep ${#kept[@]}"
    return 0
  fi
  for index in "${restore[@]}"; do
    path="${OV_REC_PATHS[index]}" pre="${OV_REC_PRE[index]}"
    if [[ "$pre" == ABSENT ]]; then
      ov_put_file "$path" "" || failures+=("$path")
    else
      ov_put_file "$path" "$OV_REC_STATE/pre/$path" || failures+=("$path")
    fi
  done
  for index in "${restore[@]}"; do
    path="${OV_REC_PATHS[index]}"
    if [[ "$(ov_hash "$OV_TARGET/$path")" == "${OV_REC_PRE[index]}" ]]; then
      restored+=("$path")
    elif ! printf '%s\n' "${failures[@]}" | grep -qxF -- "$path"; then
      failures+=("$path")
    fi
  done
  if ((${#failures[@]})); then
    ov_err "could not restore ${#failures[@]} file(s); the install record is kept at $OV_REC_STATE:"
    ov_list "${failures[@]}"
    if ((${#restored[@]})); then ov_err "restored and verified:"; ov_list "${restored[@]}"; fi
    ov_err "fix the cause and re-run --uninstall; files already restored are skipped"
    return 1
  fi
  if [[ -n "$target_rel" && -d "$OV_TARGET/$target_rel" ]]; then
    find "$OV_TARGET/$target_rel" -depth -type d -empty -delete || ov_warn "could not remove empty directories under $target_rel"
  fi
  if ((${#overwritten[@]})); then ov_warn "overwrote local changes (restored pre-install content or removed installed files):"; ov_list "${overwritten[@]}"; fi
  if ((${#kept[@]})); then ov_warn "HEAD moved since install; left these files as they are:"; ov_list "${kept[@]}"; fi
  if ((${#OV_EXTRAS[@]})); then ov_warn "left files that this overlay did not install:"; ov_list "${OV_EXTRAS[@]}"; fi
  rm -rf -- "$OV_REC_STATE" || { ov_err "restored, but could not remove the install record $OV_REC_STATE"; return 1; }
  ((rollback)) || ov_say "uninstalled; restored pre-install content of ${#restored[@]} file(s)"
}

# Install a unit. Args: unit patch source_dir target_rel dry_run(0|1) force(0|1).
# Returns non-zero, with the checkout unchanged, on any refusal or conflict.
ov_install() {
  local unit="$1" patch="$2" source_dir="$3" target_rel="$4" dry_run="$5" force="$6"
  local identity count index rc=0 differing=()
  if [[ -n "$target_rel" ]] && ! ov_safe_path "$target_rel"; then ov_unsafe_target_message "$target_rel"; return 1; fi
  identity="$(ov_identity "$patch" "$source_dir")" || { ov_err "cannot read the overlay's files"; return 1; }
  ov_load_record "$unit" || rc=$?
  if ((rc == 2)); then return 1; fi
  if ((rc == 0)); then
    for index in "${!OV_REC_PATHS[@]}"; do
      [[ "$(ov_hash "$OV_TARGET/${OV_REC_PATHS[index]}")" == "${OV_REC_POST[index]}" ]] || differing+=("${OV_REC_PATHS[index]}")
    done
    if ((${#differing[@]})); then
      ov_err "$unit has an install record, but these files differ from what it installed:"
      ov_list "${differing[@]}"
      ov_err "run --uninstall first (--force discards changes to installed files)"
      return 1
    fi
    if [[ "$OV_REC_IDENTITY" != "$identity" ]]; then
      ov_err "a different version of $unit is installed; uninstall it first"
      return 1
    fi
    [[ "$OV_REC_HEAD" == "$(ov_head)" ]] || ov_say "note: installed on ${OV_REC_HEAD:0:12}; HEAD has moved since"
    ov_say "already installed"
    return 0
  fi
  OV_REC_PATHS=()
  ov_find_extras "$target_rel"
  if ((${#OV_EXTRAS[@]})); then
    if ((!force)); then
      ov_err "$target_rel already contains files this overlay did not install (use --force to install over them):"
      ov_list "${OV_EXTRAS[@]}"
      return 1
    fi
    ov_warn "$target_rel already has files; same-named ones are saved and restored on uninstall, others are kept:"
    ov_list "${OV_EXTRAS[@]}"
  fi
  rc=0
  ov_plan "$patch" "$source_dir" "$target_rel" || rc=$?
  if ((rc != 0)); then
    case "$rc" in
      1) ov_err "$(basename "${patch:-$unit}") conflicts with $OV_TARGET; nothing was changed. Scratch 3-way merge output:" ;;
      3) ov_err "refusing to write outside the checkout or through a symlink (even with --force); nothing was changed:" ;;
      *) ov_err "could not prepare the install; nothing was changed:" ;;
    esac
    [[ ! -f "${OV_PLAN:-}/apply.log" ]] || sed 's/^/    /' "$OV_PLAN/apply.log" >&2
    return 1
  fi
  count="$(wc -l <"$OV_PLAN/plan.tsv" | tr -d ' ')"
  if ((dry_run)); then
    ov_say "would install: $count file(s); patch method: $OV_PLAN_METHOD"
    return 0
  fi
  ov_commit_plan "$unit" "$identity" || return 1
  ov_say "installed $count file(s); patch method: $OV_PLAN_METHOD"
}

# Uninstall a unit. Args: unit target_rel dry_run(0|1) force(0|1).
ov_uninstall() {
  local unit="$1" target_rel="$2" dry_run="$3" force="$4" rc=0
  if [[ -n "$target_rel" ]] && ! ov_safe_path "$target_rel"; then ov_unsafe_target_message "$target_rel"; return 1; fi
  ov_load_record "$unit" || rc=$?
  if ((rc == 1)); then
    ov_say "not installed (no install record)"
    if [[ -n "$target_rel" ]]; then
      OV_REC_PATHS=()
      ov_find_extras "$target_rel"
      if ((${#OV_EXTRAS[@]})); then ov_warn "$target_rel has files with no install record; leaving them:"; ov_list "${OV_EXTRAS[@]}"; fi
    fi
    return 0
  fi
  ((rc == 0)) || return 1
  ov_restore "$unit" "$target_rel" "$force" 0 "$dry_run"
}
