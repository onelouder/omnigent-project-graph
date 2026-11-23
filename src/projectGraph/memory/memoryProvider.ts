// The contract between the graph's Project Memory panel and a memory system.
// Omnigent's built-in memory is the default provider. Another system plugs in
// by implementing `MemoryProvider` and registering it (see memoryProviders.ts);
// the panel and the card overlay use only what is declared here.

/** One memory as a listing shows it. Listings may leave the content out. */
export interface MemoryEntrySummary {
  /** The provider's stable handle for the entry; opaque to the panel. */
  id: string;
  /** What the panel shows as the entry's name, e.g. "deploy/gotchas". */
  name: string;
  /** A one-line summary, or null. Session tags, where supported, live here. */
  description: string | null;
  /** Unix epoch seconds of the last write, when the provider knows it. */
  updatedAt: number | null;
}

export interface MemoryEntry extends MemoryEntrySummary {
  content: string;
}

/** What the panel sends to create or replace an entry. */
export interface MemoryDraft {
  /** The entry being replaced; absent for a new entry. */
  id?: string;
  name: string;
  content: string;
  description: string | null;
}

export interface MemoryPage {
  entries: MemoryEntrySummary[];
  /** Opaque token for the next page, or null on the last one. */
  nextPageToken: string | null;
}

/** How to switch a provider on, shown in place of the list while it is off. */
export interface MemorySetupHelp {
  /** One sentence on what is off, e.g. "Memory is off on this server." */
  summary: string;
  steps: MemorySetupStep[];
  docsUrl?: string;
}

export interface MemorySetupStep {
  text: string;
  /** A command or setting to copy, e.g. "OMNIGENT_FEATURES=memory". */
  code?: string;
}

export type MemoryStatus =
  | {
      state: "ready";
      /** Whether `search` ranks on the provider's side; otherwise the panel filters its listing. */
      search: boolean;
    }
  | { state: "off"; help: MemorySetupHelp };

export interface MemoryLimits {
  /** Longest content the provider accepts, in UTF-8 bytes. */
  contentBytes?: number;
  /** Longest description the provider accepts, in characters. */
  descriptionLength?: number;
}

export interface MemoryProvider {
  /** Stable id, e.g. "omnigent"; saved as the viewer's choice. */
  id: string;
  /** Shown in the panel, e.g. "Omnigent memory". */
  label: string;
  /**
   * Whether descriptions round-trip unchanged through `list`, so the graph can
   * read `[session:<id>]` tags from them for the best-effort Memory overlay.
   */
  sessionTags: boolean;
  limits?: MemoryLimits;
  /** Whether the provider can serve this viewer now. Rejects only on an unexpected failure. */
  status: (signal?: AbortSignal) => Promise<MemoryStatus>;
  /**
   * Project keys the provider already holds memories for, to suggest in the
   * panel. Optional; may return a partial list.
   */
  projects?: (signal?: AbortSignal) => Promise<string[]>;
  /** One page of a project's entries, in the provider's order. */
  list: (project: string, pageToken: string | null, signal?: AbortSignal) => Promise<MemoryPage>;
  /** One entry with its content, or null when it no longer exists. */
  get: (project: string, id: string, signal?: AbortSignal) => Promise<MemoryEntry | null>;
  /** Ranked matches within a project. Called only when `status` reported `search: true`. */
  search?: (project: string, query: string, signal?: AbortSignal) => Promise<MemoryEntrySummary[]>;
  /** Why `name` can't be used for a new entry, or null when it can. */
  validateName?: (name: string) => string | null;
  /** Create or replace an entry. Absent on a read-only provider. */
  write?: (project: string, draft: MemoryDraft) => Promise<MemoryEntry>;
  /** Delete an entry. Absent when the provider cannot delete. */
  remove?: (project: string, id: string) => Promise<void>;
}

/** A provider's failure with a message fit to show the viewer. */
export class MemoryProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "MemoryProviderError";
    this.status = status;
  }
}

/** Whether `value` has the shape of a provider, for modules found on disk. */
export function isMemoryProvider(value: unknown): value is MemoryProvider {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.label === "string" &&
    typeof candidate.status === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.get === "function"
  );
}
