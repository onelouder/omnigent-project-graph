# Omnigent Project Graph

A branching-graph view of an Omnigent project's sessions, with controls to
act on them from the graph. It is an overlay for
[Omnigent](https://github.com/omnigent-ai/omnigent): a self-contained web
directory plus a two-file hook into the project home page. It adds no
dependencies and no backend changes; it reuses Omnigent's existing hooks,
endpoints and theme tokens.

## Features

**Phase 1: the graph**

- Opens from a toggle in the project header, at `/projects/<name>?view=graph`.
  The board stays the default view.
- Draws every session in the project as a card: sub-agents under their
  parent, nested family members and forks, each with a distinct edge style.
- Tree, compact and radial layouts; zoom controls; focus a path; search by
  title or id; collapse subtrees behind a `+N` pill; a legend.
- Card menus add open, quick view, focus, collapse and jump-to-fork-source to
  Omnigent's standard session menu. Viewport and layout are saved per project.

**Phase 2: controls**

- Approvals: a pending-approval count on each card, an "Awaiting you (N)"
  chip that jumps between waiting sessions, and a drawer to approve or deny
  each mirrored elicitation. Nothing is auto-approved.
- Stop and cancel: "Cancel turn", "Stop session", "Stop subtree" and a
  multi-select "Stop selected" bar, each confirmed first.
- Overlays (Cost · Context): per-branch inclusive cost and a context-window
  gauge on each card, with a hover breakdown by model. Toggled from the
  toolbar and saved per project.
- Send and steer: with one session selected, a docked composer sends a
  message (or steers a working session).
- Controls are hidden when the viewer lacks edit permission. Keyboard: `a`
  approves on the focused card, `.` cancels its turn.

### Feature gate

- Per deployment: build with `VITE_OMNIGENT_PROJECT_GRAPH=0` (or `false`) to
  hide the view and its toggle. It is on by default.
- Per user: the stored preference `omnigent:project-graph-enabled` (default on).

## Layout

```
src/projectGraph/     the overlay's web source and tests (installed as web/src/projectGraph)
integration.patch     the hook into web/src/pages/ProjectHomePage.tsx and
                      web/src/projectHome/ProjectHomeHeader.tsx
scripts/install.sh    install or uninstall into an Omnigent checkout
scripts/verify.sh     run the graph's tests, type-check and lint in that checkout
scripts/lib/overlay_state.sh   record-and-restore install engine (shared with omnigent-stack)
tests/drift-test.sh   install/uninstall drift tests against a throwaway upstream worktree
COMPATIBILITY.md      Omnigent commits this has been tested against
```

## Install

```bash
git clone https://github.com/onelouder/omnigent-project-graph.git
cd omnigent-project-graph
scripts/install.sh /path/to/omnigent --check   # dry run; non-zero exit on conflict
scripts/install.sh /path/to/omnigent           # install (re-running is a no-op)
```

`install.sh` copies `src/projectGraph` into `web/src/projectGraph` and applies
`integration.patch`, using a 3-way merge when upstream context has drifted.

- **Computed first, then written.** The whole result, merge included, is
  computed in a disposable scratch area (a temporary index and work dir). A
  conflict, or conflict markers in the result, aborts before anything in the
  checkout changes. `--check` runs exactly this and stops.
- **Recorded.** Before writing, it records each touched file's pre-install
  content and pre/post hashes, plus the list of installed files, under
  `$(git rev-parse --absolute-git-dir)/omnigent-stack/project-graph/`. That
  directory is per worktree and outside the tracked tree. The checkout's index
  is never modified.
- **Idempotent.** If the record exists and every file still matches it,
  re-running reports `already installed`.
- **Refusals.** It refuses, changing nothing, when:
  - `web/src/projectGraph` already has files it did not install (unless
    `--force`);
  - the checkout has local changes outside the paths it manages
    (`--list-paths`) (unless `--force`);
  - upstream tracks `web/src/projectGraph`.

Rebuild the web app as you normally do (`cd web && pnpm build`, or restart
your dev server) to pick up the view.

To remove it:

```bash
scripts/install.sh /path/to/omnigent --uninstall [--check]
```

Uninstall validates the whole record first. The record ends with a sha256
checksum over everything above it; that is written last and checked first.
Each field is also checked on its own:

- hashes are well-formed for the repo's object format, or `ABSENT`;
- no path appears twice, and the recorded file count matches;
- a pre-install hash of `ABSENT` means no backup exists and the file was not
  tracked at the install HEAD;
- every other pre-install hash has a backup that matches it;
- there are no stray backups;
- every path stays inside the checkout with no symlink on the way.

A record with any contradiction is refused and kept, even with `--force`.

It then restores the recorded pre-install content exactly, so a
3-way-merged install comes back byte-for-byte, and deletes only the files it
installed. The record is removed only after every restored file is verified
by hash. If a write fails, the record is kept, the output says which files
were and weren't restored, and re-running `--uninstall` finishes the job.

It refuses, changing nothing, when installed files were edited or
`web/src/projectGraph` holds files it did not install. `--force` restores
anyway, names every overwritten file in a warning, and still never deletes
files it did not install.

**Upgrading Omnigent:** uninstall *before* moving the checkout to a new
commit, then install again. The record notes the commit it was installed on.
If HEAD has moved, uninstall refuses rather than restore pre-install content
taken from the old commit. `--force` then restores only files still exactly
as installed whose installed content the new HEAD does not track, and warns
about each file it leaves alone.

Install never writes through a symlink or outside the checkout. A symlinked
`web/src/projectGraph` (or a symlinked parent) is refused, even with `--force`.

## Verify

```bash
scripts/verify.sh /path/to/omnigent           # tests + type-check + lint
scripts/verify.sh /path/to/omnigent --build   # ... and pnpm build
```

It confirms the installed source matches this repo, runs
`pnpm install --frozen-lockfile` (skip with `--no-install`), then
`pnpm exec vitest run src/projectGraph src/projectHome src/pages/ProjectHomePage`,
`pnpm type-check` and `pnpm lint` in the checkout's `web/`.

### Drift tests

```bash
tests/drift-test.sh /path/to/omnigent-clone [origin/main]
```

This creates a throwaway `git worktree` of the given ref and exercises:

- a clean round trip;
- staged context drift that merges 3-way, restored exactly by hash;
- conflicting drift, which is refused with the checkout unchanged;
- a foreign file in `web/src/projectGraph`;
- a refused uninstall, which leaves the checkout untouched.

It also covers:

- a failed restore, which keeps the record and can be re-run;
- a failed install write, which is rolled back;
- deleted and corrupted backups;
- a `../` record path;
- a symlinked target;
- HEAD moving between install and uninstall, using a fixture repo;
- no temp files left behind.

It removes the worktree afterwards.

## Compatibility

See [COMPATIBILITY.md](COMPATIBILITY.md). The overlay imports Omnigent's web
internals (hooks, API helpers, UI components), so a new Omnigent release can
break the build even when the patch applies. Run `verify.sh` after every
upgrade.

## Known limits

- Only approvals that Omnigent mirrors as elicitations appear. A harness
  prompt that never reaches the server cannot be shown.
- Steering is harness-dependent: a message sent to a working session may
  queue until the current turn ends.
- Sub-agents load lazily per root and follow Omnigent's child-session depth
  limit, so very deep trees show only their first levels.
- Cost totals are inclusive per branch and may be estimates, as reported by
  Omnigent.

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
