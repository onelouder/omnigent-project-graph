import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";
import type * as StorageModule from "./projectGraphStorage";
import type * as IdentityModule from "@/lib/identity";
import type * as ArchiveUndoModule from "@/shell/archiveUndoToast";
import { markConversationUnread } from "@/hooks/useUnseenConversations";
import { useProjectBoardSearchStore } from "@/projectHome/ProjectHomeHeader";
import { childSessionRow } from "./projectGraphForest";
import { MIN_READABLE_ZOOM } from "./projectGraphLayout";

// xyflow OOMs in jsdom: a stand-in renders each node through its node type and nothing else.
const flow = vi.hoisted(() => ({
  fitView: vi.fn(),
  setCenter: vi.fn(),
  setViewport: vi.fn(),
  getZoom: () => 1,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  zoomTo: vi.fn(),
}));
interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
// The latest props the stand-in canvas got, so a test can play xyflow's move callbacks.
const flowProps = vi.hoisted(() => ({
  current: null as null | { onMoveEnd?: (event: unknown, viewport: Viewport) => void },
}));
vi.mock("@xyflow/react", async () => {
  const { useEffect } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children;
  return {
    ReactFlowProvider: passthrough,
    ReactFlow: function ReactFlowStandIn(props: {
      nodes: { id: string; type: string; data: unknown }[];
      nodeTypes: Record<string, ComponentType<{ id: string; data: unknown }>>;
      children?: ReactNode;
      onInit?: () => void;
      onMoveEnd?: (event: unknown, viewport: Viewport) => void;
    }) {
      const { nodes, nodeTypes, children, onInit } = props;
      flowProps.current = props;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => onInit?.(), []);
      return (
        <div data-testid="react-flow">
          {nodes.map((node) => {
            const NodeView = nodeTypes[node.type];
            return <NodeView key={node.id} id={node.id} data={node.data} />;
          })}
          {children}
        </div>
      );
    },
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    MiniMap: () => null,
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom" },
    EdgeLabelRenderer: passthrough,
    getBezierPath: () => ["M 0 0"],
    useReactFlow: () => flow,
    useStore: () => false,
  };
});

const graphData = vi.hoisted(() => ({
  rows: [] as Conversation[],
  childRows: [] as Conversation[],
}));
vi.mock("./useProjectGraphData", () => ({
  useProjectGraphRows: () => ({
    rows: graphData.rows,
    projectId: "proj_1",
    isPending: false,
    isError: false,
    isPaging: false,
    refetch: () => {},
  }),
  useProjectGraphChildren: () => ({
    childRows: graphData.childRows,
    requested: new Set<string>(),
    loading: new Set<string>(),
  }),
}));
vi.mock("@/shell/Sidebar", () => ({ ConversationMenuItems: () => null }));

const viewer = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => viewer.id }));

// Saved view state by storage key; jsdom here has no localStorage.
const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./projectGraphStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    readProjectGraphViewState: (viewerId: string | null, projectName: string) =>
      saved.get(actual.projectGraphStorageKey(viewerId, projectName)) ??
      actual.DEFAULT_PROJECT_GRAPH_VIEW_STATE,
    writeProjectGraphViewState: vi.fn(
      (viewerId: string | null, projectName: string, state: unknown) =>
        void saved.set(actual.projectGraphStorageKey(viewerId, projectName), state),
    ),
  };
});

// The server: every request the graph's controls make, answered from `server.pending`.
interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}
const server = vi.hoisted(() => ({
  requests: [] as RecordedRequest[],
  pending: [] as Record<string, unknown>[],
  /** `agent_costs` rows by root session id. */
  agentCosts: {} as Record<string, { id: string; cost_usd: number }[]>,
  /** Answers one request itself (e.g. a failure), or leaves it to the defaults. */
  respond: null as
    | null
    | ((
        request: RecordedRequest,
      ) => { status: number; json: unknown; wait?: Promise<void> } | void),
}));
vi.mock("@/lib/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof IdentityModule>();
  return {
    ...actual,
    authenticatedFetch: vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const recorded = { method, path, body };
      server.requests.push(recorded);
      const custom = server.respond?.(recorded);
      if (custom) {
        await custom.wait;
        return new Response(JSON.stringify(custom.json), {
          status: custom.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const [route] = path.split("?");
      const sessionId = decodeURIComponent(route.split("/")[3] ?? "");
      const isSnapshot = /^\/v1\/sessions\/[^/]+$/.test(route);
      const json =
        method !== "GET"
          ? { queued: true }
          : route === "/v1/sessions/projects"
            ? []
            : !isSnapshot
              ? {
                  object: "list",
                  data: route.endsWith("/agent_costs") ? (server.agentCosts[sessionId] ?? []) : [],
                  has_more: false,
                }
              : {
                  id: sessionId,
                  object: "session",
                  status: "idle",
                  created_at: 1,
                  labels: {},
                  items: [],
                  pending_elicitations: server.pending,
                };
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  };
});

// Undo offers, by the rows they cover, without rendering the app's toaster.
const undoOffers = vi.hoisted(() => [] as string[][]);
vi.mock("@/shell/archiveUndoToast", async (importOriginal) => {
  const actual = await importOriginal<typeof ArchiveUndoModule>();
  return {
    ...actual,
    showArchiveUndoToast: (_client: unknown, rows: readonly Conversation[]) =>
      void undoOffers.push(rows.map((conversation) => conversation.id)),
  };
});

const { default: ProjectGraphView } = await import("./ProjectGraphView");
const { DEFAULT_PROJECT_GRAPH_VIEW_STATE, projectGraphStorageKey } =
  await import("./projectGraphStorage");

const nextFrame = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 40);
  });

function row(id: string, title: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title,
    created_at: 1,
    updated_at: 1,
    labels: {},
    permission_level: null,
    project_id: "proj_1",
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

interface GraphOptions {
  quickViewEnabled?: boolean;
  selectedSessionId?: string | null;
  onCloseQuickView?: () => void;
}

function renderGraph(options: GraphOptions = {}) {
  return render(graphTree(options));
}

function graphTree({
  quickViewEnabled = true,
  selectedSessionId = null,
  onCloseQuickView = () => {},
}: GraphOptions = {}) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/projects/demo?view=graph"]}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <ProjectGraphView
                    projectName="demo"
                    selectedSessionId={selectedSessionId}
                    quickViewEnabled={quickViewEnabled}
                    onCloseQuickView={onCloseQuickView}
                  />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  viewer.id = null;
  saved.clear();
  vi.clearAllMocks();
  useProjectBoardSearchStore.getState().setQuery("");
  graphData.rows = [
    row("conv_alpha", "Alpha"),
    row("conv_beta", "Beta", { parent_session_id: "conv_alpha" }),
  ];
});

afterEach(cleanup);

describe("ProjectGraphView", () => {
  it("renders a card per session", () => {
    renderGraph();
    expect(
      screen.getAllByTestId("project-graph-node").map((node) => node.dataset.sessionId),
    ).toEqual(["conv_alpha", "conv_beta"]);
  });

  it("opens a clicked card in the quick view, keeping the graph view", () => {
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    const location = screen.getByTestId("location").textContent!;
    expect(location.startsWith("/projects/demo?")).toBe(true);
    const params = new URLSearchParams(location.split("?")[1]);
    expect(params.get("view")).toBe("graph");
    expect(params.get("session")).toBe("conv_beta");
  });

  it("opens the full session page on a Cmd/Ctrl-click", () => {
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { metaKey: true });
    expect(screen.getByTestId("location").textContent).toBe("/c/conv_alpha");
  });

  it("opens the full session page when the quick view is unavailable", () => {
    renderGraph({ quickViewEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByTestId("location").textContent).toBe("/c/conv_alpha");
  });

  it("opens the keyboard-focused card with Enter and Cmd+Enter", () => {
    renderGraph();
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "Enter", metaKey: true });
    expect(screen.getByTestId("location").textContent).toBe("/c/conv_beta");
  });

  it("shows unread over background work, as the board's badge does", () => {
    graphData.rows = [
      row("conv_bg", "Background", {
        status: "idle",
        background_work_running: true,
        updated_at: 50,
      }),
    ];
    markConversationUnread("conv_bg", 50);
    renderGraph();
    const card = screen.getByRole("button", { name: "Background" });
    const pill = card.querySelector('[data-testid="project-graph-status"]');
    expect(pill?.getAttribute("data-state")).toBe("unseen");
    expect(pill).toHaveTextContent("Unread");
    expect(card.querySelector('[role="status"][aria-label="Working"]')).toBeNull();
  });

  it("opens at a readable zoom instead of restoring a zoomed-out viewport", async () => {
    saved.set(projectGraphStorageKey(null, "demo"), {
      ...DEFAULT_PROJECT_GRAPH_VIEW_STATE,
      viewport: { x: 0, y: 0, zoom: 0.3 },
    });
    renderGraph();
    await act(nextFrame);

    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    const [opened] = flow.setViewport.mock.calls[0] as [{ zoom: number }];
    expect(opened.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it("restores a hydrated viewport and layout without fitting over them", async () => {
    const savedViewport = { x: 120, y: -40, zoom: 1.1 };
    const userKey = projectGraphStorageKey("user_1", "demo");
    saved.set(userKey, {
      ...DEFAULT_PROJECT_GRAPH_VIEW_STATE,
      layout: "radial",
      viewport: savedViewport,
    });
    const { rerender } = renderGraph();
    viewer.id = "user_1";
    rerender(graphTree());
    await act(nextFrame);

    expect(flow.setViewport).toHaveBeenCalledWith(savedViewport);
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Radial" })).toHaveAttribute("aria-checked", "true");
    expect(saved.get(userKey)).toMatchObject({ layout: "radial", viewport: savedViewport });

    // The viewer's own layout change re-places the view, at a readable zoom.
    flow.setViewport.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    await act(nextFrame);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    const [placed] = flow.setViewport.mock.calls[0] as [{ zoom: number }];
    expect(placed.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it("clears the header search, then exits focus, then lets Escape close the quick view", () => {
    renderGraph();
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "f" });
    expect(screen.getByRole("navigation", { name: "Focus path" })).toBeInTheDocument();

    const search = document.createElement("input");
    search.dataset.testid = "project-board-search";
    document.body.append(search);
    act(() => useProjectBoardSearchStore.getState().setQuery("alpha"));
    search.focus();
    const pressEscape = () => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      act(() => void search.dispatchEvent(event));
      return event.defaultPrevented;
    };

    expect(pressEscape()).toBe(true);
    expect(useProjectBoardSearchStore.getState().query).toBe("");
    expect(screen.getByRole("navigation", { name: "Focus path" })).toBeInTheDocument();

    expect(pressEscape()).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Focus path" })).toBeNull();

    // Nothing left for the graph: the page's handler closes the quick view.
    expect(pressEscape()).toBe(false);
    search.remove();
  });

  it("saves the placed viewport after a focus change, so a reload doesn't restore a stale one", async () => {
    const key = projectGraphStorageKey(null, "demo");
    renderGraph();
    await act(nextFrame);
    // The viewer pans far across the full graph.
    const stale = { x: -5000, y: -3000, zoom: 1 };
    act(() => flowProps.current!.onMoveEnd!({ type: "mouseup" }, stale));
    expect(saved.get(key)).toMatchObject({ viewport: stale });

    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "f" });
    await act(nextFrame);
    const afterFocus = saved.get(key) as { focusRoot: string | null; viewport: Viewport | null };
    expect(afterFocus.focusRoot).toBe("conv_alpha");
    expect(afterFocus.viewport).not.toEqual(stale);
    expect(afterFocus.viewport!.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);

    // Reload: the focus comes back with the viewport placed for it.
    cleanup();
    flow.setViewport.mockClear();
    renderGraph();
    await act(nextFrame);
    expect(screen.getByRole("navigation", { name: "Focus path" })).toBeInTheDocument();
    expect(flow.setViewport).toHaveBeenCalledWith(afterFocus.viewport);
    expect(flow.setViewport).not.toHaveBeenCalledWith(stale);
  });

  it("keeps saving the placement as sub-agents arrive after a focus change", async () => {
    const key = projectGraphStorageKey(null, "demo");
    const { rerender } = renderGraph();
    await act(nextFrame);

    // Focus the tree the graph already opened on, so the placement doesn't move.
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "f" });
    await act(nextFrame);
    expect(saved.get(key)).toMatchObject({ focusRoot: "conv_alpha" });

    // More sub-agents load and the focused tree re-anchors.
    flow.setViewport.mockClear();
    graphData.rows = [
      ...graphData.rows,
      ...["Gamma", "Delta", "Epsilon"].map((title) =>
        row(`conv_${title.toLowerCase()}`, title, { parent_session_id: "conv_alpha" }),
      ),
    ];
    rerender(graphTree());
    await act(nextFrame);
    expect(flow.setViewport).toHaveBeenCalled();
    const [placed] = flow.setViewport.mock.lastCall as [Viewport];
    expect((saved.get(key) as { viewport: Viewport }).viewport).toEqual(placed);
  });

  it("closes a card's hover card on Escape and still closes the quick view", async () => {
    const onCloseQuickView = vi.fn();
    renderGraph({ selectedSessionId: "conv_alpha", onCloseQuickView });
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Beta" }), { pointerType: "mouse" });
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 450);
        }),
    );
    expect(screen.getByTestId("project-graph-hover-card")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(nextFrame);
    expect(screen.queryByTestId("project-graph-hover-card")).toBeNull();
    expect(onCloseQuickView).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectGraphView controls", () => {
  const posted = (suffix: string) =>
    server.requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix));
  const settle = () => act(nextFrame);
  // A host-backed session, so the graph may stop it.
  const hosted = (id: string, title: string, overrides: Partial<Conversation> = {}) =>
    row(id, title, { host_id: "host_1", runner_id: `runner_${id}`, ...overrides });
  const prompt = (id: string, extra: Record<string, unknown> = {}) => ({
    elicitation_id: id,
    params: { message: `Run ${id}?`, phase: "tool_call", requestedSchema: {}, ...extra },
  });
  const toasts: string[] = [];
  const onToast = (event: Event) =>
    toasts.push(String((event as CustomEvent<{ content: unknown }>).detail.content));
  const openMenu = async (title: string) => {
    fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for ${title}` }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole("menuitem", { name: "Open session" });
  };
  const openDrawer = async (title: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Review approvals for ${title}` }));
    return screen.findByRole("complementary", { name: `Approvals for ${title}` });
  };

  beforeEach(() => {
    server.requests = [];
    server.respond = null;
    server.pending = [prompt("elic_1")];
    graphData.childRows = [];
    toasts.length = 0;
    undoOffers.length = 0;
    window.addEventListener("omnigent:toast", onToast);
  });
  afterEach(() => window.removeEventListener("omnigent:toast", onToast));

  it("approves and denies a waiting session's prompt from the drawer", async () => {
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    expect(screen.getByRole("button", { name: "Awaiting you (1)" })).toBeInTheDocument();
    const drawer = await openDrawer("Alpha");
    fireEvent.click(await within(drawer).findByRole("button", { name: /Approve/ }));
    // Hidden at once, before the server answers.
    expect(within(drawer).queryByRole("button", { name: /Approve/ })).toBeNull();
    server.pending = [];
    await settle();
    expect(posted("/v1/sessions/conv_alpha/elicitations/elic_1/resolve")).toEqual([
      expect.objectContaining({ body: { action: "accept" } }),
    ]);
    expect(within(drawer).queryByRole("button", { name: /Approve/ })).toBeNull();

    server.requests = [];
    server.pending = [prompt("elic_2")];
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1, updated_at: 2 })];
    cleanup();
    renderGraph();
    const next = await openDrawer("Alpha");
    fireEvent.click(await within(next).findByRole("button", { name: /Reject/ }));
    await settle();
    expect(posted("/elicitations/elic_2/resolve")).toEqual([
      expect.objectContaining({ body: { action: "decline" } }),
    ]);
  });

  it("answers one of several simultaneous prompts and keeps the rest", async () => {
    server.pending = [prompt("elic_1"), prompt("elic_2")];
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 2 })];
    renderGraph();
    const drawer = await openDrawer("Alpha");
    const cards = await within(drawer).findAllByTestId("approval-card");
    expect(cards).toHaveLength(2);
    server.pending = [prompt("elic_2")];
    fireEvent.click(within(cards[0]).getByRole("button", { name: /Approve/ }));
    await settle();
    expect(posted("/resolve").map((request) => request.path)).toEqual([
      "/v1/sessions/conv_alpha/elicitations/elic_1/resolve",
    ]);
    expect(within(drawer).getAllByTestId("approval-card")).toHaveLength(1);
    expect(within(drawer).getByText("Run elic_2?")).toBeInTheDocument();
  });

  it("brings an answered prompt back with its retry control when delivery is unconfirmed", async () => {
    server.pending = [prompt("elic_1", { native_delivery: { state: "ready", attempt: "a1" } })];
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    const drawer = await openDrawer("Alpha");
    server.respond = (request) => {
      if (request.path.endsWith("/resolve")) {
        server.pending = [
          prompt("elic_1", {
            native_delivery: { state: "unconfirmed", attempt: "a1", action: "accept" },
          }),
        ];
      }
    };
    fireEvent.click(await within(drawer).findByRole("button", { name: /Approve/ }));
    expect(
      await within(drawer).findByRole("button", { name: "Retry sending approval" }),
    ).toBeInTheDocument();
  });

  it("brings a re-parked prompt back for a new delivery attempt", async () => {
    server.pending = [prompt("elic_1", { native_delivery: { state: "ready", attempt: "a1" } })];
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    const drawer = await openDrawer("Alpha");
    server.respond = (request) => {
      if (request.path.endsWith("/resolve")) {
        server.pending = [prompt("elic_1", { native_delivery: { state: "ready", attempt: "a2" } })];
      }
    };
    fireEvent.click(await within(drawer).findByRole("button", { name: /Approve/ }));
    await settle();
    expect(await within(drawer).findByRole("button", { name: /Approve/ })).toBeInTheDocument();
  });

  it("clears a prompt quietly when it was already answered elsewhere", async () => {
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    const drawer = await openDrawer("Alpha");
    server.respond = (request) => {
      if (!request.path.endsWith("/resolve")) return;
      server.pending = [];
      return { status: 409, json: { error: { code: "conflict", message: "Already resolved" } } };
    };
    fireEvent.click(await within(drawer).findByRole("button", { name: /Approve/ }));
    await settle();
    await settle();
    expect(within(drawer).queryByText(/Couldn't send that answer/)).toBeNull();
    expect(within(drawer).queryByTestId("approval-card")).toBeNull();
  });

  it("brings a prompt back with an error when the answer fails", async () => {
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    const drawer = await openDrawer("Alpha");
    server.respond = (request) =>
      request.path.endsWith("/resolve")
        ? { status: 500, json: { error: { code: "internal", message: "Runner gone" } } }
        : undefined;
    fireEvent.click(await within(drawer).findByRole("button", { name: /Approve/ }));
    expect(
      await within(drawer).findByText(/Couldn't send that answer: .*Runner gone/),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Approve/ })).toBeInTheDocument();
  });

  it("opens the drawer with A on the focused waiting card", async () => {
    graphData.rows = [row("conv_alpha", "Alpha", { pending_elicitations_count: 1 })];
    renderGraph();
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "a" });
    expect(
      await screen.findByRole("complementary", { name: "Approvals for Alpha" }),
    ).toBeInTheDocument();
    expect(posted("/resolve")).toEqual([]);
  });

  it("ignores A and . while typing in the composer or the search box", async () => {
    graphData.rows = [
      row("conv_alpha", "Alpha", { status: "running", pending_elicitations_count: 1 }),
    ];
    renderGraph({ selectedSessionId: "conv_alpha" });
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    const textbox = within(screen.getByTestId("project-graph-composer")).getByRole("textbox");
    fireEvent.keyDown(textbox, { key: "a" });
    fireEvent.keyDown(textbox, { key: "." });
    const search = document.createElement("input");
    search.dataset.testid = "project-board-search";
    document.body.append(search);
    fireEvent.keyDown(search, { key: "a" });
    fireEvent.keyDown(search, { key: "." });
    search.remove();
    await settle();
    expect(screen.queryByTestId("project-graph-approvals")).toBeNull();
    expect(screen.queryByTestId("project-graph-confirm")).toBeNull();
  });

  it("cancels a running turn only after confirming, with an interrupt event", async () => {
    graphData.rows = [row("conv_alpha", "Alpha", { status: "running" })];
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Cancel turn in Alpha" }));
    expect(posted("/events")).toEqual([]);
    fireEvent.click(await screen.findByTestId("project-graph-confirm-action"));
    await settle();
    expect(posted("/v1/sessions/conv_alpha/events")).toEqual([
      expect.objectContaining({ body: { type: "interrupt", data: {} } }),
    ]);

    server.requests = [];
    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "." });
    expect(await screen.findByText("Cancel this turn?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    await settle();
    expect(posted("/events")).toEqual([]);
  });

  it("sends one stop per runner, saying what a runner stop takes down", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha"),
      // Beta rides Alpha's runner; Gamma's runner is unknown.
      hosted("conv_beta", "Beta", {
        parent_session_id: "conv_alpha",
        runner_id: "runner_conv_alpha",
      }),
      row("conv_gamma", "Gamma", { parent_session_id: "conv_alpha" }),
    ];
    renderGraph();
    for (const name of ["Alpha", "Beta", "Gamma"])
      fireEvent.click(screen.getByRole("button", { name }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    const dialog = await screen.findByTestId("project-graph-confirm");
    expect(within(dialog).getByText("Stop 2 sessions?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "If a session owns its runner, stopping it shuts the runner down, and other sessions on that runner (sub-agents, side chats) stop too, even ones not shown here.",
    );
    expect(dialog).not.toHaveTextContent("ends only that sub-agent");
    fireEvent.click(screen.getByTestId("project-graph-confirm-action"));
    await settle();
    expect(posted("/events").map((request) => [request.path, request.body])).toEqual([
      ["/v1/sessions/conv_alpha/events", { type: "stop_session", data: {} }],
      ["/v1/sessions/conv_gamma/events", { type: "stop_session", data: {} }],
    ]);
  });

  it("stops a sub-agent on its own runner with its subtree", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha"),
      hosted("conv_beta", "Beta", { parent_session_id: "conv_alpha" }),
    ];
    renderGraph();
    await openMenu("Alpha");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop subtree…" }));
    expect(await screen.findByText("Stop 2 sessions?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("project-graph-confirm-action"));
    await settle();
    expect(posted("/events").map((request) => request.path)).toEqual([
      "/v1/sessions/conv_alpha/events",
      "/v1/sessions/conv_beta/events",
    ]);
  });

  it("reports a side chat whose stop got a 409 as not stopped, with the server's reason", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha"),
      hosted("conv_beta", "Beta", { labels: { "omnigent.side_chat": "true" } }),
    ];
    server.respond = (request) =>
      request.path === "/v1/sessions/conv_beta/events"
        ? {
            status: 409,
            json: { error: { code: "conflict", message: "The side chat's turn isn't known yet" } },
          }
        : undefined;
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    fireEvent.click(await screen.findByTestId("project-graph-confirm-action"));
    await settle();
    expect(posted("/events")).toHaveLength(2);
    expect(toasts).toEqual([
      expect.stringMatching(
        /^Stopped 1 of 2 sessions\. Beta couldn't stop: .*The side chat's turn isn't known yet/,
      ),
    ]);
  });

  it("reports a partial stop failure", async () => {
    graphData.rows = [hosted("conv_alpha", "Alpha"), hosted("conv_beta", "Beta")];
    server.respond = (request) =>
      request.path === "/v1/sessions/conv_beta/events"
        ? { status: 500, json: { error: { code: "internal", message: "nope" } } }
        : undefined;
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    expect(await screen.findByText("Stop 2 sessions?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("project-graph-confirm-action"));
    await settle();
    expect(posted("/events")).toHaveLength(2);
    expect(toasts).toEqual([
      expect.stringMatching(/^Stopped 1 of 2 sessions\. Beta couldn't stop: .*nope/),
    ]);
  });

  it("asks separately before stopping a working orchestrator", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha", { status: "running" }),
      row("conv_beta", "Beta", { parent_session_id: "conv_alpha" }),
    ];
    renderGraph();
    await openMenu("Alpha");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop subtree…" }));
    const dialog = await screen.findByTestId("project-graph-confirm");
    expect(within(dialog).getByTestId("project-graph-confirm-orchestrators")).toHaveTextContent(
      "Alpha is an orchestrator working right now",
    );
    const action = screen.getByTestId("project-graph-confirm-action");
    // Only the sub-agent until the viewer opts in.
    expect(action).toHaveTextContent("Stop session");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /working orchestrators/ }));
    expect(action).toHaveTextContent("Stop 2 sessions");
    fireEvent.click(action);
    await settle();
    expect(posted("/events").map((request) => request.path)).toEqual([
      "/v1/sessions/conv_beta/events",
      "/v1/sessions/conv_alpha/events",
    ]);
  });

  it("disables Stop while a working orchestrator is the only pick", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha", { status: "running" }),
      row("conv_beta", "Beta", { parent_session_id: "conv_alpha" }),
    ];
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    const action = await screen.findByTestId("project-graph-confirm-action");
    expect(action).toBeDisabled();
    expect(action).toHaveTextContent("Stop");
  });

  it("archives the selected sessions only after confirming", async () => {
    graphData.rows = [hosted("conv_alpha", "Alpha"), hosted("conv_beta", "Beta")];
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByTestId("project-graph-confirm");
    expect(within(dialog).getByText("Archive 2 sessions?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Archiving stops any of them that are running");
    const patches = () => server.requests.filter((request) => request.method === "PATCH");
    expect(patches()).toEqual([]);
    fireEvent.click(screen.getByTestId("project-graph-confirm-action"));
    await settle();
    expect(patches().map((request) => request.path)).toEqual([
      "/v1/sessions/conv_alpha",
      "/v1/sessions/conv_beta",
    ]);
    expect(patches().every((request) => (request.body as { archived?: boolean }).archived)).toBe(
      true,
    );
    expect(undoOffers).toEqual([["conv_alpha", "conv_beta"]]);
    expect(toasts.some((toast) => toast.includes("failed"))).toBe(false);
  });

  it("offers Undo at once, without waiting for a slow archive", async () => {
    graphData.rows = [hosted("conv_alpha", "Alpha"), hosted("conv_beta", "Beta")];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.respond = (request) =>
      request.method === "PATCH" && request.path === "/v1/sessions/conv_beta"
        ? { status: 200, json: { id: "conv_beta", object: "conversation" }, wait: held }
        : undefined;
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(await screen.findByTestId("project-graph-confirm-action"));
    // Beta's archive is still in flight, and Undo already covers both.
    expect(undoOffers).toEqual([["conv_alpha", "conv_beta"]]);
    await settle();
    release();
    await settle();
    expect(toasts.some((toast) => toast.includes("failed"))).toBe(false);
  });

  it("reports a partial archive failure", async () => {
    graphData.rows = [hosted("conv_alpha", "Alpha"), hosted("conv_beta", "Beta")];
    server.respond = (request) =>
      request.method === "PATCH" && request.path === "/v1/sessions/conv_beta"
        ? { status: 500, json: { error: { code: "internal", message: "nope" } } }
        : undefined;
    renderGraph();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(await screen.findByTestId("project-graph-confirm-action"));
    await settle();
    expect(toasts).toContain("Archived 1 of 2 sessions; 1 failed.");
    // Undo went out at once, so it covers the session that did archive.
    expect(undoOffers).toEqual([["conv_alpha", "conv_beta"]]);
  });

  it("sends one message to the single selected session", async () => {
    renderGraph({ selectedSessionId: "conv_beta" });
    const composer = screen.getByRole("form", { name: "Send to Beta" });
    fireEvent.change(within(composer).getByRole("textbox"), { target: { value: "  ship it " } });
    fireEvent.keyDown(within(composer).getByRole("textbox"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(posted("/events")).toEqual([
      {
        method: "POST",
        path: "/v1/sessions/conv_beta/events",
        body: {
          type: "message",
          data: { role: "user", content: [{ type: "input_text", text: "ship it" }] },
        },
      },
    ]);

    // Two picked sessions: no composer, so nothing can go to several at once.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }), { shiftKey: true });
    expect(screen.queryByTestId("project-graph-composer")).toBeNull();
  });

  it("labels the composer Steer on a working session", () => {
    graphData.rows = [row("conv_alpha", "Alpha", { status: "running" })];
    renderGraph({ selectedSessionId: "conv_alpha" });
    expect(screen.getByRole("button", { name: /Steer/ })).toBeInTheDocument();
  });

  it("hides every control from a viewer without edit access", async () => {
    graphData.rows = [
      hosted("conv_alpha", "Alpha", {
        permission_level: 1,
        status: "running",
        pending_elicitations_count: 1,
      }),
      row("conv_beta", "Beta", { permission_level: 1, parent_session_id: "conv_alpha" }),
    ];
    renderGraph({ selectedSessionId: "conv_alpha" });
    expect(screen.queryByTestId("project-graph-review")).toBeNull();
    expect(screen.queryByTestId("project-graph-awaiting")).toBeNull();
    expect(screen.queryByTestId("project-graph-cancel-turn")).toBeNull();
    expect(screen.queryByTestId("project-graph-composer")).toBeNull();

    const canvas = screen.getByTestId("project-graph");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "a" });
    fireEvent.keyDown(canvas, { key: "." });
    expect(screen.queryByTestId("project-graph-approvals")).toBeNull();
    expect(screen.queryByTestId("project-graph-confirm")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }), { shiftKey: true });
    expect(screen.queryByRole("button", { name: "Stop selected" })).toBeNull();
    await openMenu("Alpha");
    expect(screen.queryByRole("menuitem", { name: /Cancel turn|Stop subtree|Review/ })).toBeNull();
    expect(server.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("shows no controls on the fetched sub-agents of a read-only parent", async () => {
    graphData.rows = [hosted("conv_alpha", "Alpha", { permission_level: 1, owner: "user_else" })];
    graphData.childRows = [
      childSessionRow(
        {
          id: "conv_kid",
          title: "Kid",
          task_summary: null,
          tool: "worker",
          session_name: "kid",
          current_task_status: "running",
          busy: true,
          last_message_preview: null,
          pending_elicitations_count: 1,
        },
        "conv_alpha",
      ),
    ];
    renderGraph({ selectedSessionId: "conv_kid" });
    expect(screen.getAllByTestId("project-graph-node")).toHaveLength(2);
    expect(screen.queryByTestId("project-graph-review")).toBeNull();
    expect(screen.queryByTestId("project-graph-awaiting")).toBeNull();
    expect(screen.queryByTestId("project-graph-cancel-turn")).toBeNull();
    expect(screen.queryByTestId("project-graph-composer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Kid" }), { shiftKey: true });
    expect(screen.queryByRole("button", { name: "Stop selected" })).toBeNull();
    await openMenu("Kid");
    expect(screen.queryByRole("menuitem", { name: /Cancel turn|Stop subtree|Review/ })).toBeNull();
  });

  it("reads cost once per tree and shows each card's inclusive total", async () => {
    server.agentCosts = {
      conv_alpha: [
        { id: "conv_alpha", cost_usd: 1.5 },
        { id: "conv_beta", cost_usd: 0.25 },
      ],
    };
    renderGraph();
    expect(screen.queryByTestId("project-graph-cost")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    await settle();
    const costReads = server.requests.filter((request) => request.path.includes("/agent_costs"));
    expect(costReads.map((request) => request.path.split("?")[0])).toEqual([
      "/v1/sessions/conv_alpha/agent_costs",
    ]);
    const costs = screen.getAllByTestId("project-graph-cost").map((label) => label.textContent);
    expect(costs).toEqual(["$1.50", "$0.25"]);
    expect(screen.getByTestId("project-graph-cost-total")).toHaveTextContent("$1.50 shown");
    expect(saved.get(projectGraphStorageKey(null, "demo"))).toMatchObject({
      overlays: { cost: true, context: false },
    });
  });
});
