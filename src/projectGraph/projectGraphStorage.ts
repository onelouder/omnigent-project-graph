// The project graph's per-project view state: collapsed and expanded nodes,
// layout, viewport, focus root and overlays. Keyed by server identity, viewer and
// project, like the canvas layout. Reads never throw; writes swallow quota errors.

import { getOmnigentServerIdentity } from "@/lib/host";
import { PROJECT_GRAPH_LAYOUTS, type ProjectGraphLayoutMode } from "./projectGraphLayout";

const STORAGE_KEY_PREFIX = "omnigent:project-graph";
const STORAGE_VERSION = 1;
const MAX_SAVED_IDS = 2_000;

export interface ProjectGraphViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Which card overlays show: inclusive cost, the context-window gauge, and the
 * best-effort count of project memories a session tagged.
 */
export interface ProjectGraphOverlays {
  cost: boolean;
  context: boolean;
  memory: boolean;
}

export interface ProjectGraphViewState {
  collapsed: string[];
  /** Nodes whose sub-agents the viewer asked to load. */
  expanded: string[];
  layout: ProjectGraphLayoutMode;
  viewport: ProjectGraphViewport | null;
  focusRoot: string | null;
  overlays: ProjectGraphOverlays;
}

export const DEFAULT_PROJECT_GRAPH_VIEW_STATE: ProjectGraphViewState = {
  collapsed: [],
  expanded: [],
  layout: "tree",
  viewport: null,
  focusRoot: null,
  overlays: { cost: false, context: false, memory: false },
};

export function projectGraphStorageKey(viewerId: string | null, projectName: string): string {
  return `${STORAGE_KEY_PREFIX}:${getOmnigentServerIdentity() ?? "default"}:${viewerId ?? "anonymous"}:${projectName}`;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string").slice(-MAX_SAVED_IDS);
}

function viewport(value: unknown): ProjectGraphViewport | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return finite(x) && finite(y) && finite(zoom) && zoom > 0 ? { x, y, zoom } : null;
}

function overlays(value: unknown): ProjectGraphOverlays {
  if (!value || typeof value !== "object") return DEFAULT_PROJECT_GRAPH_VIEW_STATE.overlays;
  const { cost, context, memory } = value as Record<string, unknown>;
  return { cost: cost === true, context: context === true, memory: memory === true };
}

export function readProjectGraphViewState(
  viewerId: string | null,
  projectName: string,
): ProjectGraphViewState {
  if (typeof window === "undefined") return DEFAULT_PROJECT_GRAPH_VIEW_STATE;
  try {
    const raw = window.localStorage.getItem(projectGraphStorageKey(viewerId, projectName));
    if (!raw) return DEFAULT_PROJECT_GRAPH_VIEW_STATE;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || parsed.version !== STORAGE_VERSION) return DEFAULT_PROJECT_GRAPH_VIEW_STATE;
    const layout = PROJECT_GRAPH_LAYOUTS.find((mode) => mode === parsed.layout) ?? "tree";
    return {
      collapsed: idList(parsed.collapsed),
      expanded: idList(parsed.expanded),
      layout,
      viewport: viewport(parsed.viewport),
      focusRoot: typeof parsed.focusRoot === "string" ? parsed.focusRoot : null,
      overlays: overlays(parsed.overlays),
    };
  } catch {
    return DEFAULT_PROJECT_GRAPH_VIEW_STATE;
  }
}

export function writeProjectGraphViewState(
  viewerId: string | null,
  projectName: string,
  state: ProjectGraphViewState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      projectGraphStorageKey(viewerId, projectName),
      JSON.stringify({
        version: STORAGE_VERSION,
        ...state,
        collapsed: state.collapsed.slice(-MAX_SAVED_IDS),
        expanded: state.expanded.slice(-MAX_SAVED_IDS),
      }),
    );
  } catch {
    // Quota or disabled storage: the view still works, it just isn't remembered.
  }
}
