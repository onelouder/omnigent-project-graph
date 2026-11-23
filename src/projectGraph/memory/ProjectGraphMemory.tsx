// The Project Memory panel: the memories a provider holds for this project,
// listed, searched, read, added, edited and deleted. While the provider is off
// the panel shows how to switch it on instead.

import { useDeferredValue, useId, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BrainIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { showToast } from "@/components/ui/toast";
import {
  filterEntries,
  formatMemoryDate,
  parseSessionTags,
  projectKeyCandidates,
  SESSION_TAG_NOTE,
  SESSION_TAG_SNIPPET,
  stripSessionTags,
  utf8Length,
  withSessionTags,
} from "./memoryLogic";
import type {
  MemoryEntry,
  MemoryEntrySummary,
  MemoryProvider,
  MemorySetupHelp,
} from "./memoryProvider";
import {
  useInvalidateMemory,
  useKnownMemoryProjects,
  useMemoryIndex,
  useMemoryProvider,
  useMemoryStatus,
  useStoredMemoryProject,
} from "./useProjectMemory";

export interface ProjectGraphMemoryProps {
  projectName: string;
  viewerId: string | null;
  /** Workspace paths of the project's sessions, to guess its memory project from. */
  workspaces: readonly (string | null | undefined)[];
  /** The title of a tagged session that is on the graph; null when it isn't. */
  sessionTitle: (sessionId: string) => string | null;
  onJumpToSession: (sessionId: string) => void;
  onClose: () => void;
}

type Mode = { kind: "list" } | { kind: "view"; id: string } | { kind: "edit"; id: string | null };

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(done);
  } catch {
    showToast("Couldn’t copy. Select the text and copy it by hand.");
  }
}

/** The project a graph project's memories are read from: the viewer's pick, else the best guess. */
export function useMemoryProject(
  provider: MemoryProvider,
  viewerId: string | null,
  projectName: string,
  workspaces: readonly (string | null | undefined)[],
  enabled: boolean,
) {
  const [stored, setStored] = useStoredMemoryProject(viewerId, projectName, provider.id);
  const known = useKnownMemoryProjects(provider, enabled);
  const candidates = useMemo(
    () => projectKeyCandidates(projectName, workspaces, known),
    [projectName, workspaces, known],
  );
  return { project: stored ?? candidates[0] ?? null, candidates, setProject: setStored };
}

export function ProjectGraphMemory({
  projectName,
  viewerId,
  workspaces,
  sessionTitle,
  onJumpToSession,
  onClose,
}: ProjectGraphMemoryProps) {
  const { providers, provider, choose } = useMemoryProvider();
  const status = useMemoryStatus(provider, true);
  const ready = status.data?.state === "ready";
  const { project, candidates, setProject } = useMemoryProject(
    provider,
    viewerId,
    projectName,
    workspaces,
    ready,
  );
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [query, setQuery] = useState("");
  const providerSelectId = useId();

  return (
    <aside
      aria-label="Project memory"
      data-testid="project-graph-memory"
      // Keys typed in the panel's fields stay in the panel. Escape closes it,
      // except over a form, where it would throw away what was typed.
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && mode.kind !== "edit") onClose();
      }}
      className="menu-surface pointer-events-auto absolute top-3 right-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl shadow-card"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <BrainIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Project memory</p>
          {providers.length > 1 ? (
            <label htmlFor={providerSelectId} className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">Provider</span>
              <select
                id={providerSelectId}
                value={provider.id}
                onChange={(event) => {
                  choose(event.target.value);
                  setMode({ kind: "list" });
                  setQuery("");
                }}
                className="min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs"
              >
                {providers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="truncate text-xs text-muted-foreground">{provider.label}</p>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close project memory" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm">
        {status.isPending && <p className="text-muted-foreground">Checking memory…</p>}
        {status.isError && (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-destructive">{errorText(status.error)}</p>
            <Button variant="outline" size="xs" onClick={() => void status.refetch()}>
              <RefreshCwIcon />
              Try again
            </Button>
          </div>
        )}
        {status.data?.state === "off" && (
          <MemoryOff
            help={status.data.help}
            checking={status.isFetching}
            onRecheck={() => void status.refetch()}
          />
        )}
        {status.data?.state === "ready" && (
          <MemoryBrowser
            // A new provider or project starts from its own list.
            key={`${provider.id}:${project ?? ""}`}
            provider={provider}
            search={status.data.search}
            project={project}
            candidates={candidates}
            onProject={(next) => {
              setProject(next);
              setMode({ kind: "list" });
            }}
            mode={mode}
            onMode={setMode}
            query={query}
            onQuery={setQuery}
            sessionTitle={sessionTitle}
            onJumpToSession={onJumpToSession}
          />
        )}
      </div>
    </aside>
  );
}

/** Shown while the provider is off: what is off and how to switch it on. */
function MemoryOff({
  help,
  checking,
  onRecheck,
}: {
  help: MemorySetupHelp;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div data-testid="project-graph-memory-off" className="flex flex-col gap-3">
      <p className="font-medium">{help.summary}</p>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
        {help.steps.map((step) => (
          <li key={step.text}>
            {step.text}
            {step.code && (
              <span className="mt-1 flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-xs text-foreground">
                  {step.code}
                </code>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Copy ${step.code}`}
                  onClick={() => void copyText(step.code!, "Copied")}
                >
                  <CopyIcon />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="xs" disabled={checking} onClick={onRecheck}>
          <RefreshCwIcon />
          {checking ? "Checking…" : "Check again"}
        </Button>
        {help.docsUrl && (
          <a
            href={help.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Memory documentation
          </a>
        )}
      </div>
    </div>
  );
}

function MemoryBrowser({
  provider,
  search,
  project,
  candidates,
  onProject,
  mode,
  onMode,
  query,
  onQuery,
  sessionTitle,
  onJumpToSession,
}: {
  provider: MemoryProvider;
  search: boolean;
  project: string | null;
  candidates: readonly string[];
  onProject: (project: string | null) => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
  query: string;
  onQuery: (query: string) => void;
  sessionTitle: (sessionId: string) => string | null;
  onJumpToSession: (sessionId: string) => void;
}) {
  const index = useMemoryIndex(provider, project, true);
  const invalidate = useInvalidateMemory(provider);
  const deferredQuery = useDeferredValue(query.trim());
  const ranked = useQuery({
    queryKey: ["project-graph-memory-search", provider.id, project, deferredQuery],
    queryFn: ({ signal }) => provider.search!(project!, deferredQuery, signal),
    enabled: search && provider.search !== undefined && project !== null && deferredQuery !== "",
    staleTime: 15_000,
    retry: false,
  });
  const entries = index.data?.entries;
  const shown = useMemo(() => {
    if (!entries) return [];
    if (deferredQuery === "") return entries;
    // The provider's ranking when it has one; otherwise names and descriptions are filtered here.
    return ranked.data ?? filterEntries(entries, deferredQuery);
  }, [entries, deferredQuery, ranked.data]);

  if (mode.kind === "edit") {
    return (
      <MemoryEditor
        key={mode.id ?? "new"}
        provider={provider}
        project={project}
        entryId={mode.id}
        onDone={async (saved) => {
          await invalidate();
          onMode(saved ? { kind: "view", id: saved.id } : { kind: "list" });
        }}
        onCancel={() => onMode(mode.id ? { kind: "view", id: mode.id } : { kind: "list" })}
      />
    );
  }
  if (mode.kind === "view") {
    return (
      <MemoryDetail
        key={mode.id}
        provider={provider}
        project={project!}
        entryId={mode.id}
        sessionTitle={sessionTitle}
        onJumpToSession={onJumpToSession}
        onBack={() => onMode({ kind: "list" })}
        onEdit={() => onMode({ kind: "edit", id: mode.id })}
        onDeleted={async () => {
          await invalidate();
          onMode({ kind: "list" });
        }}
      />
    );
  }
  return (
    <>
      <ProjectKeyField
        // Re-seed the field when the project changes underneath it.
        key={project ?? ""}
        project={project}
        candidates={candidates}
        onProject={onProject}
      />
      <div className="flex items-center gap-1.5">
        <Input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={search ? "Search memories" : "Filter by name or description"}
          aria-label="Search project memories"
          className="h-7 min-w-0 flex-1 text-sm"
        />
        {provider.write && (
          <Button
            variant="outline"
            size="xs"
            disabled={project === null}
            onClick={() => onMode({ kind: "edit", id: null })}
          >
            <PlusIcon />
            Add
          </Button>
        )}
      </div>
      {index.isPending && project !== null && (
        <p className="text-muted-foreground">Loading memories…</p>
      )}
      {index.isError && (
        <p role="alert" className="text-destructive">
          {errorText(index.error)}
        </p>
      )}
      {ranked.isError && (
        <p role="alert" className="text-destructive">
          {errorText(ranked.error)} Showing matches by name and description instead.
        </p>
      )}
      {index.isSuccess && entries!.length === 0 && (
        <p data-testid="project-graph-memory-empty" className="text-muted-foreground">
          No memories for <span className="font-medium text-foreground">{project}</span> yet. Agents
          save project context here as they work, and you can add one yourself. If this project’s
          memories are filed under another name, change it above.
        </p>
      )}
      {index.isSuccess && entries!.length > 0 && shown.length === 0 && (
        <p className="text-muted-foreground">No memory matches “{deferredQuery}”.</p>
      )}
      {shown.length > 0 && (
        <ul aria-label="Memories" className="flex flex-col gap-1">
          {shown.map((entry) => (
            <MemoryRow
              key={entry.id}
              entry={entry}
              onOpen={() => onMode({ kind: "view", id: entry.id })}
            />
          ))}
        </ul>
      )}
      {index.data?.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the first {index.data.entries.length} memories. Search to find the rest.
        </p>
      )}
      {provider.sessionTags && <SessionTagHelp />}
    </>
  );
}

/** Which project's memories the panel reads, with the graph's guesses to pick from. */
function ProjectKeyField({
  project,
  candidates,
  onProject,
}: {
  project: string | null;
  candidates: readonly string[];
  onProject: (project: string | null) => void;
}) {
  const [draft, setDraft] = useState(project ?? "");
  const listId = useId();
  const fieldId = useId();
  const commit = () => {
    const next = draft.trim();
    if (next === (project ?? "")) return;
    onProject(next === "" ? null : next);
  };
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={fieldId} className="shrink-0 text-xs text-muted-foreground">
        Memories filed under
      </label>
      <Input
        id={fieldId}
        list={listId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        placeholder="repository name"
        title="Agents file project memories under their repository’s name. Pick the one this project uses."
        className="h-7 min-w-0 flex-1 text-sm"
      />
      <datalist id={listId}>
        {candidates.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>
    </div>
  );
}

function MemoryRow({ entry, onOpen }: { entry: MemoryEntrySummary; onOpen: () => void }) {
  const description = stripSessionTags(entry.description);
  const tagged = parseSessionTags(entry.description).length;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="project-graph-memory-row"
        className="flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatMemoryDate(entry.updatedAt)}
          </span>
        </span>
        {description && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
        )}
        {tagged > 0 && (
          <span className="text-xs text-muted-foreground">
            Tagged by {tagged} {tagged === 1 ? "session" : "sessions"}
          </span>
        )}
      </button>
    </li>
  );
}

function MemoryDetail({
  provider,
  project,
  entryId,
  sessionTitle,
  onJumpToSession,
  onBack,
  onEdit,
  onDeleted,
}: {
  provider: MemoryProvider;
  project: string;
  entryId: string;
  sessionTitle: (sessionId: string) => string | null;
  onJumpToSession: (sessionId: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => Promise<void>;
}) {
  const entry = useQuery({
    queryKey: ["project-graph-memory-entry", provider.id, project, entryId],
    queryFn: ({ signal }) => provider.get(project, entryId, signal),
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => provider.remove!(project, entryId),
    onSuccess: async () => {
      showToast("Memory deleted");
      await onDeleted();
    },
  });
  const data = entry.data;
  const sessions = parseSessionTags(data?.description);
  return (
    <div data-testid="project-graph-memory-detail" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeftIcon />
          All memories
        </Button>
        <span className="flex-1" />
        {data && provider.write && (
          <Button variant="ghost" size="xs" onClick={onEdit}>
            <PencilIcon />
            Edit
          </Button>
        )}
        {data && provider.remove && !confirming && (
          <Button variant="ghost" size="xs" onClick={() => setConfirming(true)}>
            <Trash2Icon />
            Delete
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Delete this memory?"
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-2"
        >
          <p>Delete this memory? Agents in every session lose it, and it can’t be brought back.</p>
          <div className="flex gap-1.5">
            <Button
              variant="destructive"
              size="xs"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Deleting…" : "Delete memory"}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
          {remove.isError && (
            <p role="alert" className="text-destructive">
              {errorText(remove.error)}
            </p>
          )}
        </div>
      )}
      {entry.isPending && <p className="text-muted-foreground">Loading…</p>}
      {entry.isError && (
        <p role="alert" className="text-destructive">
          {errorText(entry.error)}
        </p>
      )}
      {entry.isSuccess && data === null && (
        <p className="text-muted-foreground">This memory no longer exists.</p>
      )}
      {data && (
        <>
          <div>
            <p className="font-medium break-words">{data.name}</p>
            <p className="text-xs text-muted-foreground">
              {[stripSessionTags(data.description), formatMemoryDate(data.updatedAt)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {sessions.length > 0 && (
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Tagged by
              {sessions.map((id) => {
                const title = sessionTitle(id);
                return title === null ? (
                  <span key={id} title={id} className="rounded bg-muted px-1.5 py-0.5">
                    a session not on this graph
                  </span>
                ) : (
                  <button
                    key={id}
                    type="button"
                    title="Show this session on the graph"
                    onClick={() => onJumpToSession(id)}
                    className="max-w-48 truncate rounded bg-muted px-1.5 py-0.5 text-foreground hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {title}
                  </button>
                );
              })}
            </p>
          )}
          <pre className="rounded-lg bg-muted/60 p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {data.content}
          </pre>
        </>
      )}
    </div>
  );
}

function MemoryEditor({
  provider,
  project,
  entryId,
  onDone,
  onCancel,
}: {
  provider: MemoryProvider;
  project: string | null;
  /** The entry to edit, or null to add one. */
  entryId: string | null;
  onDone: (saved: MemoryEntry | null) => Promise<void>;
  onCancel: () => void;
}) {
  const existing = useQuery({
    queryKey: ["project-graph-memory-entry", provider.id, project, entryId],
    queryFn: ({ signal }) => provider.get(project!, entryId!, signal),
    enabled: entryId !== null && project !== null,
    retry: false,
  });
  if (entryId !== null && existing.isPending)
    return <p className="text-muted-foreground">Loading…</p>;
  if (entryId !== null && !existing.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-destructive">
          {existing.isError ? errorText(existing.error) : "This memory no longer exists."}
        </p>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <ArrowLeftIcon />
          Back
        </Button>
      </div>
    );
  }
  return (
    <MemoryForm
      provider={provider}
      project={project!}
      existing={existing.data ?? null}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

function MemoryForm({
  provider,
  project,
  existing,
  onDone,
  onCancel,
}: {
  provider: MemoryProvider;
  project: string;
  existing: MemoryEntry | null;
  onDone: (saved: MemoryEntry | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(stripSessionTags(existing?.description));
  const [content, setContent] = useState(existing?.content ?? "");
  const nameId = useId();
  const descriptionId = useId();
  const contentId = useId();
  const { contentBytes, descriptionLength } = provider.limits ?? {};
  const taggedDescription = withSessionTags(description, existing?.description, descriptionLength);
  const nameProblem =
    existing === null && name !== "" ? (provider.validateName?.(name.trim()) ?? null) : null;
  const size = utf8Length(content);
  const problem =
    nameProblem ??
    (contentBytes !== undefined && size > contentBytes
      ? `The content is ${size.toLocaleString()} bytes; the limit is ${contentBytes.toLocaleString()}.`
      : descriptionLength !== undefined && (taggedDescription?.length ?? 0) > descriptionLength
        ? `The description may be ${descriptionLength} characters at most.`
        : null);
  const save = useMutation({
    mutationFn: () =>
      provider.write!(project, {
        ...(existing ? { id: existing.id } : {}),
        name: name.trim(),
        content,
        description: taggedDescription,
      }),
    onSuccess: async (saved) => {
      showToast(existing ? "Memory saved" : "Memory added");
      await onDone(saved);
    },
  });
  const incomplete = name.trim() === "" || content.trim() === "";
  return (
    <form
      data-testid="project-graph-memory-form"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!incomplete && problem === null && !save.isPending) save.mutate();
      }}
    >
      <p className="font-medium">{existing ? "Edit memory" : `Add a memory to ${project}`}</p>
      <label htmlFor={nameId} className="text-xs text-muted-foreground">
        Name
      </label>
      <Input
        id={nameId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        // A memory's path can't change once written.
        disabled={existing !== null}
        placeholder="e.g. deploy/gotchas"
        autoFocus={existing === null}
        className="h-7 text-sm"
      />
      <label htmlFor={descriptionId} className="text-xs text-muted-foreground">
        One-line description (agents see it when a session starts)
      </label>
      <Input
        id={descriptionId}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        className="h-7 text-sm"
      />
      <label htmlFor={contentId} className="text-xs text-muted-foreground">
        Content (markdown)
      </label>
      <Textarea
        id={contentId}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={10}
        autoFocus={existing !== null}
        className="max-h-[40vh] font-mono text-xs"
      />
      {existing && (
        <p className="text-xs text-muted-foreground">
          Saving replaces the memory. If an agent changed it since you opened it, that change is
          overwritten.
        </p>
      )}
      {(problem ?? (save.isError ? errorText(save.error) : null)) && (
        <p role="alert" className="text-destructive">
          {problem ?? errorText(save.error)}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={incomplete || problem !== null || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The optional session-tagging instruction, with what it does and doesn't promise. */
function SessionTagHelp() {
  return (
    <details className="rounded-lg border border-border px-2 py-1.5 text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">
        Session tagging (optional, best-effort)
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
        <p>
          Memory doesn’t record which session wrote an entry. Add this to your project’s agent
          instructions (AGENTS.md, CLAUDE.md or similar) and agents will tag what they write. The
          Memory overlay then shows a count on each card and highlights the branches that wrote to
          project memory.
        </p>
        <pre
          data-testid="project-graph-memory-snippet"
          className="rounded bg-muted p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-foreground"
        >
          {SESSION_TAG_SNIPPET}
        </pre>
        <div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void copyText(SESSION_TAG_SNIPPET, "Instruction copied")}
          >
            <CopyIcon />
            Copy instruction
          </Button>
        </div>
        <p>{SESSION_TAG_NOTE}</p>
      </div>
    </details>
  );
}
