# Project Memory

The graph's **Memory** button opens a panel showing what agents remember
about a project, and lets you search, add, edit and delete those memories.
An optional overlay shows which sessions wrote them.

This guide is for anyone installing the graph on a stock Omnigent. Nothing
here needs a fork or a patch to Omnigent's server: the panel uses the
`/v1/memory` routes Omnigent already ships.

- [What you need](#what-you-need)
- [Set it up](#set-it-up)
- [Use the panel](#use-the-panel)
- [Which memories belong to a project](#which-memories-belong-to-a-project)
- [Session tagging and the Memory overlay](#session-tagging-and-the-memory-overlay)
- [Using another memory system](#using-another-memory-system)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Working on the code](#working-on-the-code)

## What you need

- An Omnigent checkout that has long-term memory: the `/v1/memory` routes and
  `docs/MEMORY.md`, in upstream `main` since 2026-11-17 (commit `d8d961e27`).
  See [COMPATIBILITY.md](../COMPATIBILITY.md) for the commits this overlay is
  verified on.
- This overlay installed in that checkout ([README: Install](../README.md#install)).
- Memory switched on for the server. It is off by default in Omnigent.

On an Omnigent without memory, or with it off, the graph works as before and
the panel explains how to switch memory on.

## Set it up

1. **Install the overlay and rebuild the web app.**

   ```bash
   scripts/install.sh /path/to/omnigent
   cd /path/to/omnigent/web && pnpm build      # or restart your dev server
   ```

2. **Switch memory on.** Set the feature on the server's environment and
   restart the server:

   ```bash
   OMNIGENT_FEATURES=memory
   ```

   `OMNIGENT_FEATURES` is a list; if you already set it, add `memory` to it.
   The default backend stores memories in the server's own database and
   needs no other configuration. Backends, the Hindsight option and what
   agents are told are covered in Omnigent's
   [docs/MEMORY.md](https://github.com/omnigent-ai/omnigent/blob/main/docs/MEMORY.md).

3. **Start a new session.** Sessions started after the restart get the
   `memory_*` tools and a note on what to save. Sessions already running
   don't.

4. **Open the panel.** In a project, switch to the Graph view and click
   **Memory** in the toolbar.

Nothing is written to memory by installing or opening the panel. The graph
makes no memory request at all until you open the panel or turn on the
Memory overlay.

## Use the panel

| To | Do |
| --- | --- |
| Find a memory | Type in the search box. See [Limits](#limits) for what is searched |
| Read one | Click its row |
| Add one | **Add**, then give it a name (e.g. `deploy/gotchas`), a one-line description and markdown content |
| Change one | Open it, then **Edit**. The name can't be changed |
| Delete one | Open it, then **Delete**, then confirm. It can't be undone |
| Close the panel | The ✕, or `Esc` (not while a form is open, so a draft isn't lost) |

What you add is saved at `/projects/<repo>/<name>` and is the same kind of
entry an agent writes: agents see its path and description when their next
session starts, and read the content with `memory_get`. Names may use
letters, digits, spaces, `-`, `_` and `.`, with `/` between parts.

Memory belongs to the signed-in user. You see and edit your own memories;
another user opening the same project sees theirs.

## Which memories belong to a project

Omnigent tells agents to file project memories under their **repository's**
name: `/projects/<repo>/`, taken from the `origin` remote or, without one,
the main checkout's directory name. That often
differs from the Omnigent project's name, and the graph cannot see the
remote, so it guesses:

1. the directory names of the project's session workspaces, most common
   first;
2. then the project's own name;
3. preferring, among those, a name memory already holds entries under.

The guess is shown in **Memories filed under**. If it is wrong (a worktree
directory named after a branch is the usual cause), type or pick the right
name there. The choice is saved in the browser, per project and viewer.

## Session tagging and the Memory overlay

Omnigent memory does not record which session wrote an entry. If you want
the graph to show it, ask agents to say so themselves. Add this to the
project's agent instructions (`AGENTS.md`, `CLAUDE.md` or whatever your
harness reads); the panel's **Session tagging** section has a copy button
for it:

```
When you save or update a project memory (memory_write under /projects/<repo>/),
end its description with [session:<your session id>]. Your session id is the
session_id that sys_session_get_info returns when called with no arguments.
Keep the [session:...] tags already on a description you update, newest last,
three at most. If you can't find your session id, leave the tag off.
```

Then turn on **Overlays: Memory** in the toolbar:

- each card shows how many of the project's memories carry its session's tag;
- the edges from a root down to each such session are highlighted, and the
  legend gains "Wrote to memory".

**This is best-effort, and the graph says so wherever it shows a count.**

- A session counts only for memories it tagged. An agent that ignores the
  instruction, a harness without `sys_session_get_info`, and memories you
  add by hand are not counted.
- A tag shows that a session touched a memory, not what it changed.
- The tag is part of the description, so agents see it in their startup
  index of memories. The panel hides tags when showing a description and
  keeps them when you edit one.

Skipping this section costs nothing: the panel works without tags.

## Using another memory system

The panel reaches memory through one interface with Omnigent memory as the
default. A different memory system can be added as a provider, as its own
overlay, without editing this one. With more than one provider installed, a
picker appears in the panel's header. See
[memory-providers.md](memory-providers.md).

## Troubleshooting

| You see | Cause and fix |
| --- | --- |
| "Long-term memory is off on this Omnigent server." | The server answered 404 on `/v1/memory`. Set `OMNIGENT_FEATURES=memory`, restart the server, click **Check again**. An Omnigent older than the memory feature shows the same message; upgrade it |
| "No memories for *name* yet" but agents have saved some | They are filed under another name. Fix **Memories filed under** |
| Memory is on but agents never save anything | Only sessions started after memory was switched on get the tools. Agents whose spec sets `tool_groups.memory: false`, or that already define a tool named `memory_*`, don't get them |
| An agent reports its memory tools are refused | Omnigent refuses them in a session shared with someone who can add input. That is Omnigent's rule; the panel is unaffected |
| Search finds an entry by name but not by its text | The default backend can't search content. See [Limits](#limits) |
| Memory overlay is on but no card shows a count | No memory under this project carries a tag for a session on the graph. Check the tagging instruction is in the agent's instructions, and that the tagged sessions belong to this project |
| "Couldn’t reach memory: …" | The server answered with an error other than 404 (sign-in, permissions, a backend fault). The text after the colon is the server's own message |
| No **Memory** button | The installed copy predates this feature, or the web app wasn't rebuilt. Re-run `install.sh` and rebuild |

## Limits

- **Search.** Omnigent's default (SQLAlchemy) backend has no search, so the
  panel filters by name and description. On a backend that ranks
  (Hindsight), the panel uses the server's search, which covers content.
- **Edits replace.** There are no versions. Saving replaces the entry,
  including a change an agent made after you opened it.
- **No rename.** A memory's path is fixed. To rename, add a new one and
  delete the old.
- **Size.** Content up to 16,000 bytes and descriptions up to 512
  characters, Omnigent's own limits.
- **Large projects.** The panel and overlay read the first 1,000 memories
  under a project; search still reaches the rest where the backend searches.
- **Freshness.** An open panel and an active overlay re-read every 30
  seconds, so an agent's write appears within that time.

## Working on the code

Everything is under `src/projectGraph/memory/`:

| File | Holds |
| --- | --- |
| `memoryProvider.ts` | The `MemoryProvider` interface and its types |
| `omnigentMemoryProvider.ts` | The default provider over `/v1/memory` |
| `memoryProviders.ts` | The provider registry and the add-on seam |
| `memoryLogic.ts` | Pure rules: session tags, counts, branch marking, filtering, project-name guesses |
| `useProjectMemory.ts` | Queries: status, the per-project index, the saved project name |
| `ProjectGraphMemory.tsx` | The panel |

The graph view wires it in (`ProjectGraphView.tsx`: the toolbar button,
overlay counts and edge highlighting). Tests sit beside each file, and the
"project memory" block in `ProjectGraphView.test.tsx` drives the panel and
overlay end to end against a fake server. Run them with the rest:

```bash
scripts/install.sh /path/to/omnigent
scripts/verify.sh  /path/to/omnigent --build
```

Two rules keep the overlay installable on stock Omnigent:

- use only routes Omnigent already serves; no server changes;
- keep memory code inside `src/projectGraph/`, with no new entries in
  `integration.patch` and no new dependencies.
