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
COMPATIBILITY.md      Omnigent commits this has been tested against
```

## Install

```bash
git clone https://github.com/onelouder/omnigent-project-graph.git
cd omnigent-project-graph
scripts/install.sh /path/to/omnigent --check   # dry run; non-zero exit on conflict
scripts/install.sh /path/to/omnigent           # install (re-running is a no-op)
```

`install.sh` copies `src/projectGraph` into `web/src/projectGraph`, then
applies `integration.patch` with `git apply`, falling back to a 3-way merge
when upstream context has drifted. It refuses a checkout with local changes
outside the paths it manages (`install.sh --list-paths`) unless `--force` is
given, and it refuses to overwrite a `web/src/projectGraph` that upstream
tracks.

Rebuild the web app as you normally do (`cd web && pnpm build`, or restart
your dev server) to pick up the view.

To remove it:

```bash
scripts/install.sh /path/to/omnigent --uninstall
```

## Verify

```bash
scripts/verify.sh /path/to/omnigent           # tests + type-check + lint
scripts/verify.sh /path/to/omnigent --build   # ... and pnpm build
```

It confirms the installed source matches this repo, runs
`pnpm install --frozen-lockfile` (skip with `--no-install`), then
`pnpm exec vitest run src/projectGraph src/projectHome src/pages/ProjectHomePage`,
`pnpm type-check` and `pnpm lint` in the checkout's `web/`.

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
