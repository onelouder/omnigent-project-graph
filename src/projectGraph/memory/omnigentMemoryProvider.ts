// Omnigent's built-in long-term memory as a provider, over the server's
// existing `/v1/memory` routes. A project's memories are the entries under
// `/projects/<project>/`, the path Omnigent's own startup guidance tells agents
// to use.

import { authenticatedFetch } from "@/lib/identity";
import {
  MemoryProviderError,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryPage,
  type MemoryProvider,
  type MemoryStatus,
} from "./memoryProvider";

// The server's limits (omnigent/stores/memory_store).
const MAX_PATH_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_CONTENT_BYTES = 16_000;
const PAGE_SIZE = 100;
/** Pages of `/projects` read to suggest project keys. */
const PROJECT_SCAN_PAGES = 5;
const PROJECTS_ROOT = "/projects";
const SEGMENT = /^[\p{L}\p{N} ._-]+$/u;

export const OMNIGENT_MEMORY_DOCS_URL =
  "https://github.com/omnigent-ai/omnigent/blob/main/docs/MEMORY.md";

interface WireEntry {
  path: string;
  content: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/** Why `segment` can't be one segment of a memory path, or null when it can. */
function segmentProblem(segment: string): string | null {
  if (segment === "") return "has an empty part";
  if (segment === "." || segment === "..") return "may not use '.' or '..' as a part";
  if (!SEGMENT.test(segment)) return "may use only letters, digits, spaces, '-', '_' and '.'";
  if (segment !== segment.trim()) return "parts may not start or end with a space";
  return null;
}

/** Why `project` can't be a project key on this provider, or null when it can. */
export function omnigentProjectProblem(project: string): string | null {
  const problem = segmentProblem(project);
  return problem === null ? null : `The project name ${problem}.`;
}

/** The path prefix of a project's memories, e.g. "/projects/api". */
export function omnigentProjectPrefix(project: string): string {
  return `${PROJECTS_ROOT}/${project}`;
}

/** Why `name` can't be an entry's name under `project`, or null when it can. */
export function omnigentNameProblem(name: string, project = ""): string | null {
  if (name.trim() === "") return "Give the memory a name, e.g. deploy/gotchas.";
  if (name.startsWith("/") || name.endsWith("/")) return "The name may not start or end with '/'.";
  for (const segment of name.split("/")) {
    const problem = segmentProblem(segment);
    if (problem !== null) return `The name ${problem}.`;
  }
  if (`${omnigentProjectPrefix(project)}/${name}`.length > MAX_PATH_LENGTH)
    return `The name is too long (the whole path may be ${MAX_PATH_LENGTH} characters).`;
  return null;
}

function summary(entry: WireEntry, project: string): MemoryEntrySummary {
  const prefix = `${omnigentProjectPrefix(project)}/`;
  return {
    id: entry.path,
    name: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
    description: entry.description ?? null,
    updatedAt: typeof entry.updated_at === "number" ? entry.updated_at : null,
  };
}

function full(entry: WireEntry, project: string): MemoryEntry {
  return { ...summary(entry, project), content: entry.content };
}

function isWireEntry(value: unknown): value is WireEntry {
  return (
    !!value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string"
  );
}

async function failure(res: Response, action: string): Promise<MemoryProviderError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: unknown }; detail?: unknown };
    if (typeof body.error?.message === "string") detail = body.error.message;
    else if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Not JSON: the status line is all there is.
  }
  return new MemoryProviderError(
    `Couldn’t ${action}: ${detail || `${res.status} ${res.statusText}`.trim()}`,
    res.status,
  );
}

async function listPage(
  prefix: string,
  pageToken: string | null,
  pageSize: number,
  signal?: AbortSignal,
): Promise<Response> {
  const params = new URLSearchParams({ prefix, page_size: String(pageSize) });
  if (pageToken) params.set("page_token", pageToken);
  return authenticatedFetch(`/v1/memory/entries?${params.toString()}`, { signal });
}

const OFF: MemoryStatus = {
  state: "off",
  help: {
    summary: "Long-term memory is off on this Omnigent server.",
    steps: [
      {
        text: "Start the server with the memory feature on:",
        code: "OMNIGENT_FEATURES=memory",
      },
      {
        text: "Restart the server, then start a new session: agents get the memory tools and save project context under /projects/<repo>/.",
      },
    ],
    docsUrl: OMNIGENT_MEMORY_DOCS_URL,
  },
};

export const omnigentMemoryProvider: MemoryProvider = {
  id: "omnigent",
  label: "Omnigent memory",
  sessionTags: true,
  limits: { contentBytes: MAX_CONTENT_BYTES, descriptionLength: MAX_DESCRIPTION_LENGTH },

  async status(signal) {
    // The memory flag isn't published to the web UI; the routes answer 404 while it is off.
    const res = await listPage(PROJECTS_ROOT, null, 1, signal);
    if (res.status === 404) return OFF;
    if (!res.ok) throw await failure(res, "reach memory");
    const body = (await res.json().catch(() => null)) as { entries?: unknown } | null;
    // Anything but the listing shape means these routes aren't the memory API.
    if (!body || !Array.isArray(body.entries)) return OFF;
    // Search exists only on backends that rank; the default one answers 404.
    const probe = await authenticatedFetch("/v1/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "memory", path_prefix: PROJECTS_ROOT, limit: 1 }),
      signal,
    });
    return { state: "ready", search: probe.ok };
  },

  async projects(signal) {
    const keys = new Set<string>();
    // Each page's token comes from the one before, so the pages are read in turn.
    const scan = async (token: string | null, pagesLeft: number): Promise<void> => {
      const res = await listPage(PROJECTS_ROOT, token, PAGE_SIZE, signal);
      if (!res.ok) return;
      const body = (await res.json()) as { entries?: unknown[]; next_page_token?: string | null };
      for (const entry of body.entries ?? []) {
        if (!isWireEntry(entry)) continue;
        const [, root, key, ...rest] = entry.path.split("/");
        if (`/${root}` === PROJECTS_ROOT && key && rest.length > 0) keys.add(key);
      }
      const next = body.next_page_token ?? null;
      if (next !== null && pagesLeft > 1) await scan(next, pagesLeft - 1);
    };
    await scan(null, PROJECT_SCAN_PAGES);
    return [...keys];
  },

  async list(project, pageToken, signal): Promise<MemoryPage> {
    const problem = omnigentProjectProblem(project);
    if (problem !== null) throw new MemoryProviderError(problem);
    const res = await listPage(omnigentProjectPrefix(project), pageToken, PAGE_SIZE, signal);
    if (!res.ok) throw await failure(res, "list memories");
    const body = (await res.json()) as { entries?: unknown[]; next_page_token?: string | null };
    return {
      entries: (body.entries ?? []).filter(isWireEntry).map((entry) => summary(entry, project)),
      nextPageToken: body.next_page_token ?? null,
    };
  },

  async get(project, id, signal) {
    const params = new URLSearchParams({ path: id });
    const res = await authenticatedFetch(`/v1/memory/entry?${params.toString()}`, { signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, "read the memory");
    return full((await res.json()) as WireEntry, project);
  },

  async search(project, query, signal) {
    const res = await authenticatedFetch("/v1/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 1000),
        path_prefix: omnigentProjectPrefix(project),
        limit: 50,
      }),
      signal,
    });
    if (!res.ok) throw await failure(res, "search memories");
    const body = (await res.json()) as { hits?: { entry?: unknown }[] };
    return (body.hits ?? [])
      .map((hit) => hit.entry)
      .filter(isWireEntry)
      .map((entry) => summary(entry, project));
  },

  validateName: (name) => omnigentNameProblem(name),

  async write(project, draft: MemoryDraft) {
    const projectProblem = omnigentProjectProblem(project);
    if (projectProblem !== null) throw new MemoryProviderError(projectProblem);
    if (draft.id === undefined) {
      const problem = omnigentNameProblem(draft.name, project);
      if (problem !== null) throw new MemoryProviderError(problem);
    }
    // A path can't be renamed: an edit writes back to the path it read.
    const path = draft.id ?? `${omnigentProjectPrefix(project)}/${draft.name}`;
    const res = await authenticatedFetch("/v1/memory/entry", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: draft.content, description: draft.description }),
    });
    if (!res.ok) throw await failure(res, "save the memory");
    return full((await res.json()) as WireEntry, project);
  },

  async remove(_project, id) {
    const params = new URLSearchParams({ path: id });
    const res = await authenticatedFetch(`/v1/memory/entry?${params.toString()}`, {
      method: "DELETE",
    });
    if (!res.ok) throw await failure(res, "delete the memory");
  },
};
