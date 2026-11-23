# Security

Report a vulnerability privately through GitHub: the repository's **Security**
tab, then **Report a vulnerability**. Please do not open a public issue for
it. Include the Omnigent commit, this repo's commit, and steps to reproduce.

In scope:

- `scripts/install.sh` and `scripts/lib/overlay_state.sh` writing, restoring
  or deleting anything outside the paths they manage, or following a symlink
  out of the checkout.
- The graph's controls (approve, deny, stop, cancel, send) acting on a session
  the viewer has no edit permission for, or acting without the confirmation
  the UI promises.
- The graph showing session content to a viewer Omnigent would not show it to.

Vulnerabilities in Omnigent itself belong with the
[Omnigent project](https://github.com/omnigent-ai/omnigent).

Only the latest commit on `main` is supported.
