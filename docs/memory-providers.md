# Memory providers

The graph's Project Memory panel and Memory overlay reach memory through one
interface, `MemoryProvider`, in
[`src/projectGraph/memory/memoryProvider.ts`](../src/projectGraph/memory/memoryProvider.ts).
Omnigent's built-in memory is the default provider
([`omnigentMemoryProvider.ts`](../src/projectGraph/memory/omnigentMemoryProvider.ts))
and a working example. Any other memory system can be added the same way,
without editing this overlay.

For setting up and using the panel itself, see
[project-memory.md](project-memory.md).

A provider runs in the browser. It needs an HTTP endpoint the browser can
call: one served from the Omnigent origin, or one that allows that origin
with CORS and has its own authentication. A memory system with only a CLI or
a stdio interface needs a small HTTP bridge in front of it.

## What a provider implements

| Member | Required | Purpose |
| --- | --- | --- |
| `id`, `label` | yes | Stable id (saved as the viewer's choice) and the name shown in the panel |
| `sessionTags` | yes | `true` only if descriptions come back from `list` unchanged, so `[session:<id>]` tags can be read for the Memory overlay |
| `status()` | yes | `{ state: "ready", search }`, or `{ state: "off", help }` with the steps to switch the provider on. Reject only on an unexpected failure |
| `list(project, pageToken)` | yes | One page of a project's entries: `id`, `name`, `description`, `updatedAt`. Content may be left out |
| `get(project, id)` | yes | One entry with its content, or `null` when it is gone |
| `projects()` | no | Project keys that already hold memories, to suggest in the panel |
| `search(project, query)` | no | Ranked matches. Called only when `status` reported `search: true`; otherwise the panel filters names and descriptions itself |
| `validateName(name)` | no | Why a name can't be used for a new entry, or `null` |
| `write(project, draft)` | no | Create an entry, or replace the one named by `draft.id`. Leave it out for a read-only provider and the panel hides Add and Edit |
| `remove(project, id)` | no | Delete an entry. Leave it out and the panel hides Delete |
| `limits` | no | `contentBytes` and `descriptionLength`, checked before a save |

`project` is the provider's own key for a project. For Omnigent memory it is
the `<repo>` in `/projects/<repo>/`. The panel suggests keys from the
sessions' workspace directory names and from `projects()`, and the viewer
can type another.

Throw `MemoryProviderError` with a message fit to show the viewer; the panel
displays it as written.

## Adding a provider

Either way works; neither touches `web/src/projectGraph/`.

1. **A module the build picks up.** Put the provider at
   `web/src/projectGraphProviders/<name>/index.ts` with the provider as its
   default export:

   ```ts
   import type { MemoryProvider } from "@/projectGraph/memory/memoryProvider";

   const provider: MemoryProvider = {
     id: "acme",
     label: "Acme memory",
     sessionTags: false,
     status: async () => ({ state: "ready", search: true }),
     list: async (project, pageToken, signal) => {
       /* ... */
       return { entries: [], nextPageToken: null };
     },
     get: async (project, id, signal) => null,
     search: async (project, query, signal) => [],
   };

   export default provider;
   ```

   Ship it as its own overlay that owns `web/src/projectGraphProviders/<name>/`,
   so it installs and uninstalls independently of the graph. A module without
   a valid default export is skipped with a console warning.

2. **At runtime.** Call `registerMemoryProvider(provider)` from
   `@/projectGraph/memory/memoryProviders` in code that loads with the app.

With more than one provider installed, the panel's header gets a provider
picker; the choice is saved in the browser under
`omnigent:project-graph-memory-provider`. With only the built-in provider,
no picker shows. If the chosen provider is later removed, the panel falls
back to Omnigent memory.

## Testing a provider

`src/projectGraph/memory/omnigentMemoryProvider.test.ts` shows the pattern:
mock the fetch, then assert the requests the provider makes and the entries
it returns. The view tests in `ProjectGraphView.test.tsx` ("project memory")
drive the panel end to end against a fake server.
