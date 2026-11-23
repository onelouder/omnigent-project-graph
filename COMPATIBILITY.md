# Compatibility

Omnigent commits (upstream `omnigent-ai/omnigent`, `main`) this overlay has
been installed and verified against. "Verified" means `scripts/install.sh`
applied cleanly and `scripts/verify.sh --build` passed: the graph's vitest
suite, `pnpm type-check`, `pnpm lint` and `pnpm build`.

| Omnigent commit | Date       | install.sh            | verify.sh --build                         |
| --------------- | ---------- | --------------------- | ----------------------------------------- |
| `2f5296a8b`     | 2026-11    | development base      | verified during development               |
| `31874a169`     | 2026-11-22 | plain apply; `tests/drift-test.sh` passes | 124 tests passed (12 files); all green |
| `d09ca3367`     | 2026-11-22 | plain apply           | 174 tests passed (16 files); all green; with project memory |

The integration patch touches only:

- `web/src/pages/ProjectHomePage.tsx`: one import, one hook call, and the
  graph rendered in place of the board when `?view=graph`.
- `web/src/projectHome/ProjectHomeHeader.tsx`: one import and the
  Board/Graph toggle in the header actions.

`src/projectGraph` imports Omnigent web internals, among them
`@/hooks/useConversations`, `@/hooks/useChildSessions`, `@/lib/sessionsApi`,
`@/lib/routing`, `@/lib/storedChoicePreference`, `@/lib/formatCost`,
`@/lib/identity`, `@/projectHome/*` and `@/components/ui/*`, plus
`@xyflow/react`. The Project Memory panel also depends on the server's
`/v1/memory` routes (`entry`, `entries`, `search`) and their 404 answer while
memory is off. A release
that renames these breaks the type-check even when the patch applies, so run
`verify.sh` on every upgrade and add a row here when it passes.
