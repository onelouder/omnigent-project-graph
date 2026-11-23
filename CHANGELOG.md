# Changelog

## Unreleased

- Phase 3: Project Memory panel, memory provider interface and session-tag
  overlay.
- `install.sh` checks for bash 4.4+ and GNU coreutils before doing anything,
  and says what is missing.
- CI: install, verify, uninstall and drift tests against the verified Omnigent
  commit and upstream `main`.
- Contributor docs, issue and pull request templates, security policy.
- Screenshots in the README.
- `.gitattributes` keeps scripts and the patch LF on every host.

## 0.1.0 (2026-11-22)

- Phase 1: the graph view (tree, compact and radial layouts, search, focus,
  collapse, saved viewport).
- Phase 2: controls (approvals, stop and cancel, cost and context overlays,
  send and steer).
- Record-and-restore installer with dry run, 3-way merge, validated records
  and drift tests.
- Verified on Omnigent `31874a169`.
