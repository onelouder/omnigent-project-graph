// The project branching graph: every session in the project as an xyflow
// forest. Loaded lazily (see ProjectGraph.tsx), since xyflow is heavy.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeTypes,
  type Viewport,
} from "@xyflow/react";
import { MAX_TREE_DEPTH } from "@/hooks/useChildSessions";
import { useMoveToProject, type Conversation } from "@/hooks/useConversations";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useOptionalLoadedConversations } from "@/hooks/useSidebarData";
import { markConversationRead, useUnseenTick } from "@/hooks/useUnseenConversations";
import { useViewerId } from "@/hooks/useViewerId";
import { useNavigate, useSearchParams } from "@/lib/routing";
import { formatSessionCostUsd } from "@/lib/formatCost";
import { useSessionDraftIds } from "@/lib/sessionDrafts";
import { cn } from "@/lib/utils";
import {
  useProjectBoardSearchStore,
  useProjectComposerStore,
} from "@/projectHome/ProjectHomeHeader";
import { PROJECT_PANEL_SESSION_PARAM } from "@/projectHome/projectHomeNavigation";
import { conversationDisplayLabel, type StatusBucket } from "@/shell/sidebarNav";
import {
  ProjectGraphActionsContext,
  useProjectGraphPointerStore,
  type OpenTarget,
  type ProjectGraphActions,
} from "./projectGraphContext";
import {
  openShortcutsPopover,
  ProjectGraphBreadcrumb,
  ProjectGraphBulkBar,
  ProjectGraphEmpty,
  ProjectGraphError,
  ProjectGraphFooter,
  ProjectGraphLoading,
  ProjectGraphNoMatch,
  ProjectGraphToolbar,
} from "./ProjectGraphChrome";
import { ProjectGraphApprovals } from "./ProjectGraphApprovals";
import { ProjectGraphComposer } from "./ProjectGraphComposer";
import {
  awaitingSessionIds,
  canControlSession,
  cardCost,
  hasActiveTurn,
  planStop,
  subtreeStopPicks,
  totalCost,
} from "./projectGraphControls";
import { useProjectGraphControls } from "./ProjectGraphConfirm";
import { projectGraphEdgeTypes } from "./ProjectGraphEdges";
import { projectGraphPreference } from "./projectGraphFeature";
import {
  ancestorPath,
  buildProjectGraphForest,
  withInheritedAccess,
  subtreeIds,
  type ProjectGraphForest,
} from "./projectGraphForest";
import {
  layoutProjectGraph,
  MIN_FIT_ZOOM,
  MIN_READABLE_ZOOM,
  projectGraphFlowElements,
  readableViewport,
  type LayoutInput,
  type ProjectGraphFlowEdge,
} from "./projectGraphLayout";
import { ProjectGraphMenuHost } from "./ProjectGraphMenus";
import { ProjectGraphZoomControls } from "./ProjectGraphZoomControls";
import { SessionCardNodeView, StandaloneLabelNodeView } from "./ProjectGraphNode";
import { columnOf, isWaitingOnUser, matchesGraphSearch } from "./projectGraphStatus";
import {
  STANDALONE_LABEL_NODE_ID,
  type ProjectGraphViewProps,
  type SessionCardData,
  type SessionCardNode,
  type StandaloneLabelNode,
} from "./projectGraphTypes";
import { useProjectGraphChildren, useProjectGraphRows } from "./useProjectGraphData";
import { useProjectGraphContext, useProjectGraphCosts } from "./useProjectGraphOverlays";
import { useProjectGraphViewState } from "./useProjectGraphViewState";

import "@xyflow/react/dist/style.css";

/** Sessions whose sub-agents load up front; the rest load when expanded. */
const EAGER_CHILD_FETCHES = 12;
/** Cards this deep start collapsed until expanded. */
const INITIAL_DEPTH_LIMIT = 2;
const MINIMAP_MIN_NODES = 13;
const MOTION_MS = 220;
const FIT_PADDING = 0.2;
/** Without a known viewport, overlays read for this many cards in tree order. */
const OVERLAY_FALLBACK_CARDS = 24;

function sameViewport(a: Viewport, b: Viewport | null): boolean {
  return (
    b !== null &&
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.zoom - b.zoom) < 0.001
  );
}

/** A saved viewport, unless it is zoomed out past reading (an old whole-forest fit). */
function readableSavedViewport(viewport: Viewport | null): Viewport | null {
  return viewport && viewport.zoom >= MIN_READABLE_ZOOM ? viewport : null;
}

const nodeTypes: NodeTypes = {
  session: SessionCardNodeView,
  standaloneLabel: StandaloneLabelNodeView,
};

const MINIMAP_COLOR: Record<StatusBucket, string> = {
  "Needs attention": "var(--warning)",
  Working: "var(--session-active)",
  Unread: "var(--brand-accent)",
  Draft: "var(--muted-foreground)",
  Done: "var(--border-strong)",
};

export default function ProjectGraphView(props: ProjectGraphViewProps) {
  return (
    <ReactFlowProvider key={props.projectName}>
      <ProjectGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

const HEADER_SEARCH_SELECTOR = '[data-testid="project-board-search"]';

/**
 * While the graph is mounted, Escape in the header's search box follows the
 * canvas's order: clear the search, then exit focus. Once neither applies the
 * key passes on, so the page closes the quick view.
 */
function useHeaderSearchEscape(exitFocus: () => boolean) {
  const exitFocusRef = useRef(exitFocus);
  exitFocusRef.current = exitFocus;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || !event.target.matches(HEADER_SEARCH_SELECTOR))
        return;
      const search = useProjectBoardSearchStore.getState();
      if (search.query !== "") {
        event.preventDefault();
        search.setQuery("");
      } else if (exitFocusRef.current()) {
        event.preventDefault();
      }
    }
    // Capture, so it runs before the page's window-level Escape handler.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** How many sub-agent links sit above a session: the Agents rail's depth. */
function subagentDepth(forest: ProjectGraphForest, id: string): number {
  let depth = 0;
  let parent = forest.parentById.get(id);
  while (parent?.kind === "subagent" && depth <= MAX_TREE_DEPTH) {
    depth++;
    parent = forest.parentById.get(parent.id);
  }
  return depth;
}

/** The kind of edge to a session's first known child. */
function firstChildKind(forest: ProjectGraphForest, id: string): "subagent" | "nested" | null {
  const first = forest.childrenById.get(id)?.[0];
  return first ? (forest.parentById.get(first)?.kind ?? null) : null;
}

/** Every session in tree order: roots first-to-last, each followed by its subtree. */
function treeOrder(forest: ProjectGraphForest): string[] {
  return forest.roots.flatMap((root) => [root, ...subtreeIds(forest, root)]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function ProjectGraphCanvas({
  projectName,
  selectedSessionId,
  quickViewEnabled,
  onCloseQuickView,
}: ProjectGraphViewProps) {
  const viewerId = useViewerId();
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();
  const duration = reducedMotion ? 0 : MOTION_MS;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const flow = useReactFlow();
  const searchQuery = useProjectBoardSearchStore((state) => state.query);
  const setSearchQuery = useProjectBoardSearchStore((state) => state.setQuery);
  const setComposerOpen = useProjectComposerStore((state) => state.setOpen);
  const setInteracting = useProjectGraphPointerStore((state) => state.setInteracting);
  const hoveredFork = useProjectGraphPointerStore((state) => state.hoveredFork);
  const moveToProject = useMoveToProject();
  const loaded = useOptionalLoadedConversations();
  // Read marks and drafts live outside the query cache; re-render when they change.
  const unseenTick = useUnseenTick();
  const draftIds = useSessionDraftIds();

  const {
    view,
    storageKey,
    update: persist,
    saveViewport,
  } = useProjectGraphViewState(viewerId, projectName);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<StatusBucket>>(() => new Set());
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);
  const [minimapOn, setMinimapOn] = useState(true);
  const [matchIndex, setMatchIndex] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [approvalsId, setApprovalsId] = useState<string | null>(null);
  // Where the view last settled, so overlays read only on-screen cards.
  const [shownViewport, setShownViewport] = useState<Viewport | null>(null);
  const controls = useProjectGraphControls();
  const animateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingCenter = useRef<string | null>(null);
  // Set by the viewer's layout and focus changes; the next layout fits the view.
  const fitRequested = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const startMotion = useCallback(() => {
    if (reducedMotion) return;
    setAnimating(true);
    clearTimeout(animateTimer.current);
    animateTimer.current = setTimeout(() => setAnimating(false), MOTION_MS + 40);
  }, [reducedMotion]);
  useEffect(() => () => clearTimeout(animateTimer.current), []);

  // --- Data ---
  const graphRows = useProjectGraphRows(projectName, includeArchived);
  const { rows } = graphRows;
  const listForest = useMemo(
    () => buildProjectGraphForest(rows, { bucketOf: columnOf, includeArchived }),
    // The tick and draft ids stand for the read and draft stores `columnOf` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, includeArchived, unseenTick, draftIds],
  );
  // A bounded number of sessions load their sub-agents up front; the rest wait for expand.
  const eagerIds = useMemo(() => treeOrder(listForest).slice(0, EAGER_CHILD_FETCHES), [listForest]);
  const expandedIds = useMemo(
    () => (view.focusRoot ? [...view.expanded, view.focusRoot] : view.expanded),
    [view.expanded, view.focusRoot],
  );
  const listIds = useMemo(() => new Set(listForest.nodesById.keys()), [listForest]);
  // Child lists poll only while their session is on screen and expanded.
  const pollableRef = useRef<ReadonlySet<string>>(new Set());
  const shouldPoll = useCallback((id: string) => pollableRef.current.has(id), []);
  const children = useProjectGraphChildren({ eagerIds, expandedIds, listIds, shouldPoll });
  // Sub-agents act with their parent's access and ride its runner.
  const childRows = useMemo(
    () => withInheritedAccess(rows, children.childRows),
    [rows, children.childRows],
  );
  const forest = useMemo(
    () =>
      buildProjectGraphForest([...rows, ...childRows], {
        bucketOf: columnOf,
        includeArchived,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, childRows, includeArchived, unseenTick, draftIds],
  );

  // --- Structure ---
  const depthOf = useCallback((id: string) => ancestorPath(forest, id).length - 1, [forest]);
  const collapsed = useMemo(() => {
    const result = new Set(view.collapsed);
    const opened = new Set(view.expanded);
    for (const [id, kids] of forest.childrenById) {
      if (kids.length > 0 && !opened.has(id) && depthOf(id) >= INITIAL_DEPTH_LIMIT) result.add(id);
    }
    return result;
  }, [view.collapsed, view.expanded, forest, depthOf]);
  const focusRoot = view.focusRoot && forest.nodesById.has(view.focusRoot) ? view.focusRoot : null;
  const layoutInput = useMemo<LayoutInput>(() => {
    if (focusRoot === null)
      return { roots: forest.roots, childrenById: forest.childrenById, collapsed };
    // A focused subtree keeps the forks taken from it, as extra roots beside it.
    const inSubtree = new Set([focusRoot, ...subtreeIds(forest, focusRoot)]);
    const forkTargets = forest.edges
      .filter(
        (edge) => edge.kind === "fork" && inSubtree.has(edge.source) && !inSubtree.has(edge.target),
      )
      .map((edge) => edge.target);
    return {
      roots: [focusRoot, ...new Set(forkTargets)],
      childrenById: forest.childrenById,
      collapsed,
    };
  }, [forest, focusRoot, collapsed]);
  const layout = useMemo(
    () => layoutProjectGraph(layoutInput, view.layout),
    [layoutInput, view.layout],
  );
  // Written during render, so TanStack's refetchInterval (evaluated when the
  // child queries re-subscribe after this render) sees the current collapse and focus.
  pollableRef.current = useMemo(
    () => new Set([...layout.positions.keys()].filter((id) => !collapsed.has(id))),
    [layout, collapsed],
  );
  const elements = useMemo(
    () => projectGraphFlowElements(layout, forest.edges, view.layout),
    [layout, forest.edges, view.layout],
  );

  // --- Search and status filter ---
  const searchActive = searchQuery.trim().length > 0;
  const filterActive = statusFilter.size > 0;
  const order = useMemo(() => treeOrder(forest), [forest]);
  const highlighted = useMemo(() => {
    if (!searchActive && !filterActive) return null;
    return new Set(
      order.filter((id) => {
        const row = forest.nodesById.get(id)!;
        const bucket = forest.bucketById.get(id)!;
        return (
          (!searchActive || matchesGraphSearch(row, bucket, searchQuery)) &&
          (!filterActive || statusFilter.has(bucket))
        );
      }),
    );
  }, [order, forest, searchActive, filterActive, searchQuery, statusFilter]);
  const matchList = useMemo(
    () => (highlighted ? order.filter((id) => highlighted.has(id)) : []),
    [order, highlighted],
  );
  const highlightAncestors = useMemo(() => {
    const result = new Set<string>();
    for (const id of matchList)
      for (const ancestor of ancestorPath(forest, id).slice(1)) result.add(ancestor);
    return result;
  }, [matchList, forest]);
  useEffect(() => setMatchIndex(0), [searchQuery, statusFilter]);

  // --- Opening and navigation ---
  const centerOn = useCallback(
    (id: string) => {
      const position = layout.positions.get(id);
      if (!position) return false;
      void flow.setCenter(position.x + layout.box.width / 2, position.y + layout.box.height / 2, {
        zoom: flow.getZoom(),
        duration,
      });
      return true;
    },
    [layout, flow, duration],
  );
  useEffect(() => {
    const id = pendingCenter.current;
    if (id !== null && centerOn(id)) pendingCenter.current = null;
  }, [centerOn]);

  const openSession = useCallback(
    (id: string, target: OpenTarget) => {
      if (target === "full" || !quickViewEnabled) {
        void navigate(`/c/${encodeURIComponent(id)}`);
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.set(PROJECT_PANEL_SESSION_PARAM, id);
      void navigate({ search: `?${next.toString()}` });
    },
    [quickViewEnabled, navigate, searchParams],
  );

  const toggleCollapse = useCallback(
    (id: string) => {
      startMotion();
      const isCollapsed = collapsed.has(id);
      persist((previous) =>
        isCollapsed
          ? {
              ...previous,
              collapsed: previous.collapsed.filter((other) => other !== id),
              expanded: previous.expanded.includes(id)
                ? previous.expanded
                : [...previous.expanded, id],
            }
          : { ...previous, collapsed: [...previous.collapsed, id] },
      );
    },
    [collapsed, persist, startMotion],
  );

  const loadChildren = useCallback(
    (id: string) => {
      persist((previous) =>
        previous.expanded.includes(id)
          ? previous
          : { ...previous, expanded: [...previous.expanded, id] },
      );
    },
    [persist],
  );

  const setFocusRoot = useCallback(
    (id: string | null) => {
      startMotion();
      fitRequested.current = true;
      persist((previous) => ({ ...previous, focusRoot: id }));
      if (id !== null) setKeyboardFocusId(id);
    },
    [persist, startMotion],
  );

  useHeaderSearchEscape(() => {
    if (focusRoot === null) return false;
    setFocusRoot(null);
    return true;
  });

  const jumpToSession = useCallback(
    (id: string) => {
      if (!forest.nodesById.has(id)) return;
      setKeyboardFocusId(id);
      if (centerOn(id)) return;
      // Hidden: open its collapsed ancestors (and leave a focus that excludes it), then center.
      const ancestors = ancestorPath(forest, id).slice(1);
      pendingCenter.current = id;
      startMotion();
      persist((previous) => ({
        ...previous,
        collapsed: previous.collapsed.filter((other) => !ancestors.includes(other)),
        expanded: [...new Set([...previous.expanded, ...ancestors])],
        focusRoot:
          previous.focusRoot && !ancestors.includes(previous.focusRoot) && previous.focusRoot !== id
            ? null
            : previous.focusRoot,
      }));
    },
    [forest, centerOn, persist, startMotion],
  );

  const clickCard = useCallback<ProjectGraphActions["clickCard"]>(
    (id, event) => {
      setKeyboardFocusId(id);
      if (event.shiftKey) {
        setMultiSelected((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      setMultiSelected(new Set());
      openSession(id, event.metaKey || event.ctrlKey ? "full" : "auto");
    },
    [openSession],
  );

  // --- Control plane ---
  const awaitingIds = useMemo(
    () => awaitingSessionIds(forest, order, viewerId),
    [forest, order, viewerId],
  );
  const openApprovals = useCallback((id: string) => {
    setKeyboardFocusId(id);
    setApprovalsId(id);
  }, []);
  const stepAwaiting = (step: 1 | -1) => {
    if (awaitingIds.length === 0) return;
    const index = approvalsId === null ? -1 : awaitingIds.indexOf(approvalsId);
    const next =
      index === -1
        ? step === 1
          ? 0
          : awaitingIds.length - 1
        : (index + step + awaitingIds.length) % awaitingIds.length;
    const id = awaitingIds[next];
    setApprovalsId(id);
    jumpToSession(id);
  };
  const titleOf = useCallback(
    (id: string) => {
      const row = forest.nodesById.get(id);
      return row ? conversationDisplayLabel(row) : id;
    },
    [forest],
  );
  const cancelTurn = useCallback(
    (id: string) => {
      const row = forest.nodesById.get(id);
      if (!row || !canControlSession(row, viewerId) || !hasActiveTurn(row)) return;
      controls.request({ kind: "cancel", sessionId: id, title: titleOf(id) });
    },
    [forest, controls, titleOf, viewerId],
  );
  const requestStop = useCallback(
    (scope: "selected" | "subtree", picks: Iterable<string>) => {
      const plan = planStop(forest, picks, viewerId);
      if (plan.targets.length + plan.orchestrators.length === 0) return;
      const titles = new Map(
        [...plan.targets, ...plan.orchestrators].map((id) => [id, titleOf(id)]),
      );
      controls.request({ kind: "stop", scope, plan, titles });
    },
    [forest, viewerId, controls, titleOf],
  );
  const stopSubtree = useCallback(
    (id: string) => requestStop("subtree", subtreeStopPicks(forest, id)),
    [forest, requestStop],
  );

  // Set with the keyboard handlers below; a hover card's Escape continues the sequence here.
  const latestEscape = useRef(() => {});
  // Cards and menus read actions through one stable object.
  const latest = useRef({
    openSession,
    clickCard,
    toggleCollapse,
    loadChildren,
    setFocusRoot,
    jumpToSession,
    openApprovals,
    cancelTurn,
    stopSubtree,
  });
  latest.current = {
    openSession,
    clickCard,
    toggleCollapse,
    loadChildren,
    setFocusRoot,
    jumpToSession,
    openApprovals,
    cancelTurn,
    stopSubtree,
  };
  const actions = useMemo<ProjectGraphActions>(
    () => ({
      projectName,
      openSession: (id, target) => latest.current.openSession(id, target),
      clickCard: (id, event) => latest.current.clickCard(id, event),
      toggleCollapse: (id) => latest.current.toggleCollapse(id),
      loadChildren: (id) => latest.current.loadChildren(id),
      focusSubtree: (id) => latest.current.setFocusRoot(id),
      jumpToSession: (id) => latest.current.jumpToSession(id),
      openApprovals: (id) => latest.current.openApprovals(id),
      cancelTurn: (id) => latest.current.cancelTurn(id),
      stopSubtree: (id) => latest.current.stopSubtree(id),
      escape: () => latestEscape.current(),
    }),
    [projectName],
  );

  // The most relevant place to open: the focused subtree, else the most urgent
  // root (roots rank by their subtree's most urgent status), else the first tree.
  const anchorId = useMemo(() => {
    if (focusRoot !== null) return focusRoot;
    const roots = layoutInput.roots.filter((id) => layout.positions.has(id));
    const urgent = roots.find((id) => {
      const bucket = forest.bucketById.get(id);
      const below = forest.descendants.get(id);
      return (
        bucket === "Needs attention" ||
        bucket === "Working" ||
        (below !== undefined && below.needsAttention + below.working > 0)
      );
    });
    return urgent ?? roots.find((id) => layout.treeBounds.has(id)) ?? roots[0] ?? null;
  }, [focusRoot, layoutInput.roots, layout, forest]);
  // Whether the view still sits where the graph put it, and where that was.
  const autoPlaced = useRef(false);
  const autoViewport = useRef<Viewport | null>(null);
  // Placement after the viewer's layout or focus change replaces the saved viewport,
  // including re-anchoring as that subtree's sub-agents load.
  const persistPlacement = useRef(false);
  const openReadable = useCallback(
    (ms: number, { save = false, always = false }: { save?: boolean; always?: boolean } = {}) => {
      const canvas = canvasRef.current;
      const size = { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 };
      const next = readableViewport(layout, anchorId, size);
      const unmoved = autoPlaced.current && sameViewport(next, autoViewport.current);
      // The viewer's own change always replaces the saved viewport; re-anchoring only when it moves.
      if (save && (always || !unmoved)) saveViewport(next);
      // Set even when unmoved: a saved placement keeps saving as sub-agents re-anchor it.
      persistPlacement.current = save;
      if (unmoved) return;
      autoPlaced.current = true;
      autoViewport.current = next;
      void flow.setViewport(next, { duration: ms });
    },
    [flow, layout, anchorId, saveViewport],
  );

  // First paint restores the saved viewport when it is readable, else opens on the anchor.
  // xyflow ignores viewport calls until its pan-zoom is up, which `onInit` reports.
  const [flowReady, setFlowReady] = useState(false);
  const opened = useRef(false);
  const hasLayout = layout.positions.size > 0;
  useEffect(() => {
    if (!flowReady || opened.current || !hasLayout) return;
    opened.current = true;
    const saved = readableSavedViewport(view.viewport);
    autoPlaced.current = false;
    if (saved) void flow.setViewport(saved);
    else openReadable(0);
    // Only the first layout opens; later viewport saves must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowReady, hasLayout, flow]);

  // Sub-agents load after first paint and reshape the trees. Until the viewer
  // moves the view, keep the auto-placed opening on its anchor.
  const placedWith = useRef(openReadable);
  useEffect(() => {
    if (placedWith.current === openReadable) return;
    placedWith.current = openReadable;
    if (autoPlaced.current) openReadable(0, { save: persistPlacement.current });
  }, [openReadable]);

  // A re-hydrated state (another viewer's key) restores its own viewport.
  const lastStorageKey = useRef(storageKey);
  useEffect(() => {
    if (lastStorageKey.current === storageKey) return;
    lastStorageKey.current = storageKey;
    const saved = readableSavedViewport(view.viewport);
    autoPlaced.current = false;
    if (saved) void flow.setViewport(saved);
    else openReadable(0);
    // Only a key change restores; later viewport saves must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, flow]);

  // Re-open readably after the viewer changes the layout or focus. Hydration
  // and first paint restore their own viewport, so their changes don't move it.
  const fitKey = `${view.layout}:${focusRoot ?? ""}`;
  useEffect(() => {
    if (!fitRequested.current) return;
    fitRequested.current = false;
    const frame = requestAnimationFrame(() => openReadable(duration, { save: true, always: true }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, duration]);

  // --- Overlays ---
  const overlays = view.overlays;
  const overlaysOn = overlays.cost || overlays.context;
  const overlayIds = useMemo(() => {
    if (!overlaysOn) return [];
    const placed = order.filter((id) => layout.positions.has(id));
    const canvas = canvasRef.current;
    if (!shownViewport || !canvas || canvas.clientWidth === 0)
      return placed.slice(0, OVERLAY_FALLBACK_CARDS);
    // The flow-space rectangle on screen.
    const { x, y, zoom } = shownViewport;
    const left = -x / zoom;
    const top = -y / zoom;
    const right = left + canvas.clientWidth / zoom;
    const bottom = top + canvas.clientHeight / zoom;
    return placed.filter((id) => {
      const position = layout.positions.get(id)!;
      return (
        position.x + layout.box.width >= left &&
        position.x <= right &&
        position.y + layout.box.height >= top &&
        position.y <= bottom
      );
    });
  }, [overlaysOn, order, layout, shownViewport]);
  const costs = useProjectGraphCosts(forest, overlayIds, overlays.cost);
  const contextRows = useMemo(
    () => overlayIds.map((id) => forest.nodesById.get(id)!),
    [overlayIds, forest],
  );
  const contexts = useProjectGraphContext(contextRows, overlays.context);
  const costTotal = overlays.cost ? totalCost(forest, overlayIds, costs) : null;
  const subtreeStopCounts = useMemo(() => {
    const result = new Map<string, number>();
    for (const id of forest.nodesById.keys()) {
      if ((forest.childrenById.get(id)?.length ?? 0) === 0) continue;
      const plan = planStop(forest, subtreeStopPicks(forest, id), viewerId);
      result.set(id, plan.targets.length + plan.orchestrators.length);
    }
    return result;
  }, [forest, viewerId]);

  // --- Cards ---
  const externalLabel = useCallback(
    (sourceId: string) => {
      const known = loaded?.pages.flatMap((page) => page.data).find((row) => row.id === sourceId);
      return known ? conversationDisplayLabel(known) : sourceId.slice(0, 14);
    },
    [loaded],
  );
  const forkSourceOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const edge of forest.edges) if (edge.kind === "fork") map.set(edge.target, edge.source);
    return map;
  }, [forest.edges]);
  const nodes = useMemo<SessionCardNode[]>(
    () =>
      elements.nodes.map((node) => {
        const id = node.id;
        const conversation = forest.nodesById.get(id)!;
        const external = forest.externalForkSources.get(id);
        const onGraphSource = forkSourceOf.get(id) ?? null;
        const data: SessionCardData = {
          ...node.data,
          conversation,
          bucket: forest.bucketById.get(id)!,
          treeKind: forest.parentById.get(id)?.kind ?? null,
          childCount: forest.childrenById.get(id)?.length ?? 0,
          childKind: firstChildKind(forest, id),
          collapsed: collapsed.has(id),
          descendants: forest.descendants.get(id)!,
          canLoadChildren:
            !children.requested.has(id) && subagentDepth(forest, id) < MAX_TREE_DEPTH,
          loadingChildren: children.loading.has(id),
          search:
            highlighted === null
              ? null
              : highlighted.has(id)
                ? "match"
                : highlightAncestors.has(id)
                  ? "ancestor"
                  : "dim",
          searchQuery,
          selected: id === selectedSessionId || multiSelected.has(id),
          keyboardFocused: id === keyboardFocusId,
          forkSourceOnGraph: onGraphSource,
          externalForkLabel: external ? externalLabel(external) : null,
          forkSourceLabel: external
            ? externalLabel(external)
            : onGraphSource
              ? conversationDisplayLabel(forest.nodesById.get(onGraphSource)!)
              : null,
          forkHighlighted:
            hoveredFork !== null && (hoveredFork.source === id || hoveredFork.target === id),
          canControl: canControlSession(conversation, viewerId),
          subtreeStopCount: subtreeStopCounts.get(id) ?? 0,
          showCost: overlays.cost,
          cost: overlays.cost ? cardCost(forest, id, costs) : null,
          context: overlays.context ? (contexts.get(id) ?? null) : null,
        };
        return { ...node, data };
      }),
    [
      elements.nodes,
      forest,
      collapsed,
      children.requested,
      children.loading,
      highlighted,
      highlightAncestors,
      searchQuery,
      selectedSessionId,
      multiSelected,
      keyboardFocusId,
      forkSourceOf,
      externalLabel,
      hoveredFork,
      subtreeStopCounts,
      overlays.cost,
      overlays.context,
      costs,
      contexts,
      viewerId,
    ],
  );
  const flowNodes = useMemo<Node[]>(() => {
    const standalone = layout.standalone;
    // The heading only separates the grid from trees above it.
    if (!standalone || layout.treeBounds.size === 0) return nodes;
    const label: StandaloneLabelNode = {
      id: STANDALONE_LABEL_NODE_ID,
      type: "standaloneLabel",
      position: standalone.label,
      data: { count: standalone.ids.length },
      selectable: false,
      draggable: false,
    };
    return [...nodes, label];
  }, [nodes, layout]);
  const selectedPath = useMemo(() => {
    const anchor = selectedSessionId ?? keyboardFocusId;
    return anchor && forest.nodesById.has(anchor)
      ? new Set(ancestorPath(forest, anchor))
      : new Set<string>();
  }, [forest, selectedSessionId, keyboardFocusId]);
  const edges = useMemo<ProjectGraphFlowEdge[]>(
    () =>
      elements.edges.map((edge) => ({
        ...edge,
        data: {
          kind: edge.data!.kind,
          route: edge.data!.route,
          attention:
            edge.type === "tree" && forest.bucketById.get(edge.target) === "Needs attention",
          highlighted:
            edge.type === "tree" && selectedPath.has(edge.source) && selectedPath.has(edge.target),
          dimmed:
            highlighted !== null &&
            !highlighted.has(edge.target) &&
            !highlightAncestors.has(edge.target),
        },
      })),
    [elements.edges, forest.bucketById, selectedPath, highlighted, highlightAncestors],
  );

  // --- Keyboard ---
  /** One Escape step: search, then the status filter and selection, then focus. */
  const escapeStep = (): boolean => {
    if (approvalsId !== null) setApprovalsId(null);
    else if (searchActive) setSearchQuery("");
    else if (filterActive) setStatusFilter(new Set());
    else if (multiSelected.size > 0) setMultiSelected(new Set());
    else if (focusRoot !== null) setFocusRoot(null);
    else return false;
    return true;
  };
  latestEscape.current = () => {
    if (!escapeStep() && selectedSessionId !== null) onCloseQuickView();
  };
  const visibleSiblings = useCallback(
    (id: string): readonly string[] => {
      const parent = forest.parentById.get(id)?.id;
      if (parent && layout.visibleChildren.has(parent)) return layout.visibleChildren.get(parent)!;
      return layoutInput.roots.filter((root) => layout.positions.has(root));
    },
    [forest, layout, layoutInput.roots],
  );
  const moveFocus = (id: string | undefined) => {
    if (!id || !layout.positions.has(id)) return;
    setKeyboardFocusId(id);
    centerOn(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const target = event.target as HTMLElement;
    if (target.closest('[role="menu"],[role="dialog"]')) return;
    // A card's own buttons and links (menu, PR, collapse pill) keep their keys.
    if (target !== event.currentTarget && target.closest("button,a")) return;
    const current =
      keyboardFocusId && layout.positions.has(keyboardFocusId) ? keyboardFocusId : null;
    const first = layoutInput.roots.find((root) => layout.positions.has(root));
    const handled = () => event.preventDefault();
    const modifier = event.metaKey || event.ctrlKey;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        handled();
        if (current === null) return moveFocus(first);
        if (event.key === "ArrowUp") return moveFocus(forest.parentById.get(current)?.id);
        if (event.key === "ArrowDown") return moveFocus(layout.visibleChildren.get(current)?.[0]);
        const siblings = visibleSiblings(current);
        const index = siblings.indexOf(current) + (event.key === "ArrowLeft" ? -1 : 1);
        return moveFocus(siblings[index]);
      }
      case "Enter":
        if (current === null) return;
        handled();
        return openSession(current, modifier ? "full" : "quick");
      case " ":
        if (current === null) return;
        handled();
        return toggleCollapse(current);
      case "f":
        if (current === null || modifier) return;
        handled();
        return setFocusRoot(focusRoot === current ? null : current);
      case "a": {
        if (current === null || modifier) return;
        const row = forest.nodesById.get(current)!;
        if (!canControlSession(row, viewerId) || !isWaitingOnUser(row)) return;
        handled();
        return openApprovals(current);
      }
      case ".":
        if (current === null || modifier) return;
        handled();
        return cancelTurn(current);
      case "/":
        handled();
        document.querySelector<HTMLInputElement>(HEADER_SEARCH_SELECTOR)?.focus();
        return;
      case "0":
        handled();
        void flow.fitView({ padding: FIT_PADDING, duration, minZoom: MIN_FIT_ZOOM });
        return;
      case "+":
      case "=":
        handled();
        void flow.zoomIn({ duration });
        return;
      case "-":
        handled();
        void flow.zoomOut({ duration });
        return;
      case "m":
        if (modifier) return;
        handled();
        setMinimapOn((on) => !on);
        return;
      case "?":
        handled();
        openShortcutsPopover();
        return;
      case "Escape":
        // The page closes the quick view once the canvas has nothing left to undo.
        if (escapeStep()) handled();
        return;
      default:
        return;
    }
  };

  // --- Toolbar data ---
  const counts = useMemo(() => {
    const result = new Map<StatusBucket, number>();
    for (const bucket of forest.bucketById.values())
      result.set(bucket, (result.get(bucket) ?? 0) + 1);
    return result;
  }, [forest]);
  const rootsWithChildren = forest.roots.filter(
    (id) => (forest.childrenById.get(id)?.length ?? 0) > 0,
  );
  const allCollapsed =
    rootsWithChildren.length > 0 && rootsWithChildren.every((id) => collapsed.has(id));
  const toggleCollapseAll = () => {
    startMotion();
    persist((previous) =>
      allCollapsed
        ? {
            ...previous,
            collapsed: [],
            expanded: [...new Set([...previous.expanded, ...forest.childrenById.keys()])],
          }
        : { ...previous, collapsed: rootsWithChildren },
    );
  };
  const stepMatch = (step: 1 | -1) => {
    if (matchList.length === 0) return;
    const next = (matchIndex + step + matchList.length) % matchList.length;
    setMatchIndex(next);
    jumpToSession(matchList[next]);
  };

  const bulkRows = (): Conversation[] =>
    [...multiSelected]
      .map((id) => forest.nodesById.get(id))
      .filter((row): row is Conversation => !!row);
  const bulkArchive = () => {
    const toArchive = bulkRows().filter((row) => row.archived !== true);
    if (toArchive.length === 0) return;
    controls.request({
      kind: "archive",
      rows: toArchive,
      onArchive: (ids) => {
        if (selectedSessionId !== null && ids.includes(selectedSessionId)) onCloseQuickView();
        setMultiSelected(new Set());
      },
    });
  };
  const bulkMove = (target: string) => {
    for (const row of bulkRows()) moveToProject.mutate({ id: row.id, project: target });
    setMultiSelected(new Set());
  };
  const bulkStopPlan = planStop(forest, multiSelected, viewerId);
  const bulkStoppable = bulkStopPlan.targets.length + bulkStopPlan.orchestrators.length;
  const bulkStop = () => requestStop("selected", multiSelected);
  const bulkMarkRead = () => {
    for (const row of bulkRows()) markConversationRead(row.id, row.updated_at);
    setMultiSelected(new Set());
  };

  // --- Render ---
  if (graphRows.isPending) return <ProjectGraphLoading />;
  if (graphRows.isError) return <ProjectGraphError onRetry={graphRows.refetch} />;
  if (rows.length === 0 && !graphRows.isPaging) {
    return (
      <ProjectGraphEmpty
        onNewSession={() =>
          isMobile
            ? void navigate(`/?project=${encodeURIComponent(projectName)}`)
            : setComposerOpen(true)
        }
      />
    );
  }

  const focusPath = focusRoot
    ? ancestorPath(forest, focusRoot)
        .reverse()
        .map((id) => ({ id, title: conversationDisplayLabel(forest.nodesById.get(id)!) }))
    : [];
  const needsAttention = counts.get("Needs attention") ?? 0;
  const working = counts.get("Working") ?? 0;
  const approvalRow = approvalsId ? (forest.nodesById.get(approvalsId) ?? null) : null;
  // The composer docks only while exactly one session is selected, and never for several.
  const singleSelectedId =
    multiSelected.size === 1
      ? [...multiSelected][0]
      : multiSelected.size === 0
        ? selectedSessionId
        : null;
  const singleRow = singleSelectedId ? forest.nodesById.get(singleSelectedId) : undefined;
  const composerRow =
    singleRow && canControlSession(singleRow, viewerId) && singleRow.archived !== true
      ? singleRow
      : null;
  const showMinimap = minimapOn && !isMobile && nodes.length >= MINIMAP_MIN_NODES;

  return (
    <ProjectGraphActionsContext.Provider value={actions}>
      <ProjectGraphMenuHost
        projectName={projectName}
        onLeave={(id) => {
          if (id === selectedSessionId) onCloseQuickView();
        }}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-1 pb-4">
          {focusRoot !== null && (
            <ProjectGraphBreadcrumb
              path={focusPath}
              onFocus={setFocusRoot}
              onExit={() => setFocusRoot(null)}
            />
          )}
          <ProjectGraphToolbar
            counts={counts}
            statusFilter={statusFilter}
            onToggleStatus={(bucket) =>
              setStatusFilter((previous) => {
                const next = new Set(previous);
                if (next.has(bucket)) next.delete(bucket);
                else next.add(bucket);
                return next;
              })
            }
            includeArchived={includeArchived}
            onIncludeArchived={setIncludeArchived}
            onTurnOff={() => {
              projectGraphPreference.write(false);
              const next = new URLSearchParams(searchParams);
              next.delete("view");
              void navigate({ search: next.size > 0 ? `?${next.toString()}` : "" });
            }}
            matchCount={highlighted === null ? null : matchList.length}
            matchIndex={matchIndex}
            onStepMatch={stepMatch}
            layout={view.layout}
            onLayout={(mode) => {
              startMotion();
              fitRequested.current = mode !== view.layout;
              persist((previous) => ({ ...previous, layout: mode }));
            }}
            allCollapsed={allCollapsed}
            onToggleCollapseAll={toggleCollapseAll}
            awaitingCount={awaitingIds.length}
            onNextAwaiting={() => stepAwaiting(1)}
            overlays={overlays}
            onOverlays={(next) => persist((previous) => ({ ...previous, overlays: next }))}
          />
          <div
            ref={canvasRef}
            role="region"
            aria-label={`${projectName} session graph`}
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space F A . / 0 + - M ? Escape"
            tabIndex={0}
            data-testid="project-graph"
            onKeyDown={onKeyDown}
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
              animating &&
                "[&_.react-flow\\_\\_node]:[transition:transform_220ms_cubic-bezier(0.22,1,0.36,1)]",
            )}
          >
            <ReactFlow<Node, ProjectGraphFlowEdge>
              nodes={flowNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={projectGraphEdgeTypes}
              defaultViewport={readableSavedViewport(view.viewport) ?? undefined}
              onlyRenderVisibleElements
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              disableKeyboardA11y
              panOnScroll
              zoomOnDoubleClick={false}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
              onInit={() => setFlowReady(true)}
              onMoveStart={() => setInteracting(true)}
              onMoveEnd={(_event, viewport) => {
                setInteracting(false);
                setShownViewport(viewport);
                // The graph's own placement doesn't persist; any other move is the viewer's.
                if (sameViewport(viewport, autoViewport.current)) return;
                autoPlaced.current = false;
                saveViewport(viewport);
              }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--border)"
              />
              {showMinimap && (
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  ariaLabel="Graph overview"
                  nodeColor={(node) =>
                    node.type === "standaloneLabel"
                      ? "transparent"
                      : (MINIMAP_COLOR[(node.data as SessionCardData).bucket] ??
                        "var(--muted-foreground)")
                  }
                  nodeBorderRadius={6}
                  maskColor="color-mix(in oklch, var(--muted) 55%, transparent)"
                  className="!mr-12 !mb-3 overflow-hidden rounded-xl border border-border !bg-card-solid/95 shadow-card"
                  style={{ width: 168, height: 112 }}
                />
              )}
              <ProjectGraphZoomControls duration={duration} />
            </ReactFlow>
            <ProjectGraphFooter
              total={forest.nodesById.size}
              needsAttention={needsAttention}
              working={working}
              costLabel={
                costTotal
                  ? `${costTotal.estimated ? "~" : ""}${formatSessionCostUsd(costTotal.costUsd)} shown`
                  : null
              }
            />
            {searchActive && matchList.length === 0 && (
              <ProjectGraphNoMatch query={searchQuery.trim()} onClear={() => setSearchQuery("")} />
            )}
            {approvalRow && (
              <ProjectGraphApprovals
                key={approvalRow.id}
                conversation={approvalRow}
                waitingCount={awaitingIds.length}
                onStep={stepAwaiting}
                onOpenSession={() => openSession(approvalRow.id, "full")}
                onClose={() => setApprovalsId(null)}
              />
            )}
            {composerRow && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
                <ProjectGraphComposer key={composerRow.id} conversation={composerRow} />
              </div>
            )}
            {multiSelected.size > 0 && (
              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 z-20 flex justify-center",
                  composerRow ? "bottom-36" : "bottom-14",
                )}
              >
                <ProjectGraphBulkBar
                  count={multiSelected.size}
                  currentProject={projectName}
                  onArchive={bulkArchive}
                  onMove={bulkMove}
                  onMarkRead={bulkMarkRead}
                  stoppableCount={bulkStoppable}
                  onStop={bulkStop}
                  onClear={() => setMultiSelected(new Set())}
                />
              </div>
            )}
          </div>
        </div>
        {controls.dialog}
      </ProjectGraphMenuHost>
    </ProjectGraphActionsContext.Provider>
  );
}
