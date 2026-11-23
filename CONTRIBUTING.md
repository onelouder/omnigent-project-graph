# Contributing

Bug reports, compatibility reports for newer Omnigent commits, and pull
requests are welcome. For anything larger than a fix, open an issue first so
the approach can be agreed before you write it.

## Setup

You need the tools listed under "Requirements" in the [README](README.md),
and an Omnigent checkout that is not serving a running Omnigent:

```bash
git clone https://github.com/omnigent-ai/omnigent.git
git -C omnigent checkout <newest commit in COMPATIBILITY.md>
scripts/install.sh omnigent
scripts/verify.sh omnigent
```

## Changing the graph

The source of truth is `src/projectGraph` in this repo. The copy in the
checkout's `web/src/projectGraph` is what the dev server runs.

1. Edit in the checkout, with Omnigent's web dev server running.
2. Copy the result back: `cp -R omnigent/web/src/projectGraph/. src/projectGraph/`
   (delete here any file you deleted there).
3. Re-install so the record matches the new source:
   `scripts/install.sh omnigent --uninstall --force && scripts/install.sh omnigent`.
   `--force` is needed because the installed files were edited; it names each
   file it overwrites.
4. Run `scripts/verify.sh omnigent --build`. Its first step fails if the two
   copies differ.

Keep the overlay self-contained: no new dependencies, no backend changes, and
no edits to Omnigent files beyond the two in `integration.patch`. Tests live
next to the code as `*.test.ts(x)` and run under Omnigent's vitest setup.

## Changing the hook (`integration.patch`)

1. Uninstall, so the two hook files are back to upstream content.
2. Make the hook edits in `web/src/pages/ProjectHomePage.tsx` and
   `web/src/projectHome/ProjectHomeHeader.tsx`.
3. Regenerate: `git -C omnigent diff -- web/src/pages/ProjectHomePage.tsx web/src/projectHome/ProjectHomeHeader.tsx > integration.patch`
4. Restore the two files (`git -C omnigent checkout -- <files>`), install, and
   run `verify.sh` and the drift tests.

Keep the patch as small as it is now: imports, one hook call, one render
branch, one toggle. Every added line is another place upstream can drift.

## Changing the installer

`scripts/lib/overlay_state.sh` is shared byte-for-byte with the
`omnigent-stack` repo, which drives several overlays through it. A change
here has to land there too; say so in the pull request. Any change to it, to
`install.sh` or to the patch needs the drift tests:

```bash
tests/drift-test.sh /path/to/omnigent-clone <ref>
```

## Supporting a newer Omnigent commit

Install and run `verify.sh --build` and the drift tests against it. When all
pass, add a row to `COMPATIBILITY.md` and set `OMNIGENT_VERIFIED` in
`.github/workflows/ci.yml` to the same commit.

## Pull requests

- One topic per pull request; fill in the checklist in the template.
- CI installs the overlay into the verified Omnigent commit and into upstream
  `main`. The `main` job is informational and may fail for reasons unrelated
  to your change.
- Do not include session data, project names, hostnames or local paths in
  code, fixtures, logs or screenshots.
- Add a line to `CHANGELOG.md` for anything a user would notice.

## License

Contributions are accepted under the Apache License 2.0, the license of this
repository (see [LICENSE](LICENSE)). By opening a pull request you confirm
you have the right to submit the work under that license.
