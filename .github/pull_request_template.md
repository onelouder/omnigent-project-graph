## What and why

## Checked

- [ ] `scripts/install.sh <omnigent> --check` and a real install on Omnigent commit: `_______`
- [ ] `scripts/verify.sh <omnigent> --build` passes
- [ ] `tests/drift-test.sh <omnigent-clone> <ref>` passes (if `install.sh`, `overlay_state.sh` or `integration.patch` changed)
- [ ] `COMPATIBILITY.md` and `CHANGELOG.md` updated (if behaviour or the supported Omnigent commit changed)
- [ ] No session data, project names or host paths in code, fixtures or screenshots
