// Positions for the project graph. Tree and compact modes draw each session
// with sub-agents as a top-to-bottom tidy tree (Reingold-Tilford contours),
// pack those trees into rows, and wrap childless top-level sessions into a
// grid below. Radial wraps one tidy forest around a circle.
// Types only from xyflow: @xyflow/react is too heavy to load in jsdom tests.

import type { Edge, Node, Viewport, XYPosition } from "@xyflow/react";
import type { ProjectGraphEdge, ProjectGraphEdgeKind } from "./projectGraphForest";

export const PROJECT_GRAPH_LAYOUTS = ["tree", "compact", "radial"] as const;
export type ProjectGraphLayoutMode = (typeof PROJECT_GRAPH_LAYOUTS)[number];

export interface NodeBox {
  width: number;
  height: number;
}

export interface Rect extends NodeBox {
  x: number;
  y: number;
}

interface Spacing extends NodeBox {
  /** Between siblings' cards. */
  siblingGap: number;
  /** Between neighboring trees, and between the trees and the standalone grid. */
  rootGap: number;
  /** Between a card's row and its children's. */
  levelGap: number;
  /** Between standalone cards in the grid. */
  gridGap: number;
  /** Trees wrap to a new row past this width, unless one tree is wider. */
  rowWidth: number;
}

export const TREE_CARD: NodeBox = { width: 270, height: 116 };
export const COMPACT_CARD: NodeBox = { width: 220, height: 56 };

const SPACING: Record<ProjectGraphLayoutMode, Spacing> = {
  tree: { ...TREE_CARD, siblingGap: 40, rootGap: 96, levelGap: 88, gridGap: 24, rowWidth: 2800 },
  compact: {
    ...COMPACT_CARD,
    siblingGap: 20,
    rootGap: 64,
    levelGap: 48,
    gridGap: 16,
    rowWidth: 1800,
  },
  radial: {
    ...COMPACT_CARD,
    siblingGap: 20,
    rootGap: 20,
    levelGap: 48,
    gridGap: 16,
    rowWidth: 0,
  },
};

/** A parent with more children than this wraps their subtrees into bands. */
const WRAP_THRESHOLD = 8;
/** A band holds up to this many cards' width (or one wider subtree). */
const WRAP_COLUMNS = 6;
/** At most this many standalone cards per grid row. */
const MAX_GRID_COLUMNS = 6;
/** Room above the standalone grid for its heading. */
export const STANDALONE_LABEL_HEIGHT = 36;

/** The card size each layout draws. */
export function cardBox(mode: ProjectGraphLayoutMode): NodeBox {
  return { width: SPACING[mode].width, height: SPACING[mode].height };
}

export interface LayoutInput {
  roots: readonly string[];
  childrenById: ReadonlyMap<string, readonly string[]>;
  /** Nodes whose subtrees are hidden. */
  collapsed?: ReadonlySet<string>;
}

export interface StandaloneGroup {
  /** Top-level sessions without sub-agents or nested agents, in root order. */
  ids: readonly string[];
  /** The grid's cards, below its heading. */
  bounds: Rect;
  /** Where the heading sits. */
  label: XYPosition;
}

export interface ProjectGraphLayout {
  /** Top-left corner of each visible card. */
  positions: ReadonlyMap<string, XYPosition>;
  /** Tree depth of each visible card (roots are 0). */
  depthById: ReadonlyMap<string, number>;
  /** Visible tree children, in left-to-right order. */
  visibleChildren: ReadonlyMap<string, readonly string[]>;
  box: NodeBox;
  /** Each tree root's tree, as drawn. Standalone roots have none. */
  treeBounds: ReadonlyMap<string, Rect>;
  /** The grid of childless top-level sessions, when there is one. */
  standalone: StandaloneGroup | null;
  /** Everything drawn. */
  bounds: Rect;
  /**
   * Bends for edges into a wrapped fan-out, from the parent's bottom to the
   * child's top: down to the channel over the first band, along it, down the
   * trunk left of the block, and along the channel over the child's band.
   */
  routes: ReadonlyMap<string, readonly XYPosition[]>;
}

// One contour row: a subtree's leftmost and rightmost card edges at one depth,
// relative to the subtree root's center.
type Contour = [left: number, right: number][];

interface Slot {
  id: string;
  /** Center offset from the parent's center. */
  dx: number;
  /** Rows below the parent (1 for a plain child, more in a lower band). */
  rows: number;
}

interface Placed {
  contour: Contour;
  slots: Slot[];
}
/** Smallest shift that keeps `next` clear of `merged` by `gap` at every shared depth. */
function separation(merged: Contour, next: Contour, gap: number): number {
  let shift = Number.NEGATIVE_INFINITY;
  for (let depth = 0; depth < Math.min(merged.length, next.length); depth++) {
    shift = Math.max(shift, merged[depth][1] - next[depth][0] + gap);
  }
  return shift;
}

function mergeContour(merged: Contour, next: Contour, shift: number): Contour {
  const result: Contour = merged.map((row) => [row[0], row[1]]);
  next.forEach(([left, right], depth) => {
    if (depth < result.length) result[depth][1] = right + shift;
    else result.push([left + shift, right + shift]);
  });
  return result;
}

/** Pack subtrees left to right; returns their center offsets (first at 0) and the merged contour. */
function packRow(contours: Contour[], gap: number): { offsets: number[]; contour: Contour } {
  if (contours.length === 0) return { offsets: [], contour: [] };
  const offsets = [0];
  let merged = contours[0];
  for (let index = 1; index < contours.length; index++) {
    const shift = separation(merged, contours[index], gap);
    offsets.push(shift);
    merged = mergeContour(merged, contours[index], shift);
  }
  return { offsets, contour: merged };
}

interface TidyForest {
  /** Roots in input order, each with its tree's contour. */
  roots: { id: string; contour: Contour }[];
  /** Center x of each card, relative to its own root's center. */
  centerX: Map<string, number>;
  depthById: Map<string, number>;
  visibleChildren: Map<string, string[]>;
  /** Parents whose children wrap into bands, with the block's left edge from the parent's center. */
  wraps: Map<string, { children: string[]; left: number }>;
}

/**
 * A wide fan-out as stacked bands: children's subtrees pack left to right in
 * child order, starting a new band past `columns` cards' width (or the widest
 * subtree). Bands are left-aligned, so a trunk down the block's left edge
 * reaches every band's channel without crossing a card. Offsets are from the
 * parent's center, which sits over the block's center.
 */
function wrapBlock(
  children: readonly string[],
  contours: readonly Contour[],
  nodeWidth: number,
  siblingGap: number,
  columns: number,
): { slots: Slot[]; width: number; depth: number } {
  const extent = (contour: Contour) => ({
    left: Math.min(...contour.map(([left]) => left)),
    right: Math.max(...contour.map(([, right]) => right)),
  });
  const widest = Math.max(
    ...contours.map((contour) => extent(contour).right - extent(contour).left),
  );
  const maxWidth = Math.max(columns * (nodeWidth + siblingGap) - siblingGap, widest);

  const bands: number[][] = [];
  for (let index = 0; index < children.length; index++) {
    const current = bands.at(-1);
    if (current) {
      const packed = packRow(
        [...current, index].map((member) => contours[member]),
        siblingGap,
      );
      const { left, right } = extent(packed.contour);
      if (right - left <= maxWidth) {
        current.push(index);
        continue;
      }
    }
    bands.push([index]);
  }

  const placedBands = bands.map((members) => {
    const packed = packRow(
      members.map((member) => contours[member]),
      siblingGap,
    );
    const { left, right } = extent(packed.contour);
    return { members, packed, left, width: right - left, depth: packed.contour.length };
  });
  const width = Math.max(...placedBands.map((band) => band.width));
  const slots: Slot[] = [];
  let rows = 1;
  for (const band of placedBands) {
    band.members.forEach((member, index) => {
      slots.push({
        id: children[member],
        dx: band.packed.offsets[index] - band.left - width / 2,
        rows,
      });
    });
    rows += band.depth;
  }
  return { slots, width, depth: rows - 1 };
}

/**
 * Tidy-tree centers, one tree per root: each subtree packs as close to its
 * left neighbor as its contours allow, and a parent sits centered over its
 * first and last child (so a single-child chain runs straight down). Past
 * the wrap threshold, the children's subtrees wrap into stacked bands.
 */
function tidyForest(
  input: LayoutInput,
  nodeWidth: number,
  siblingGap: number,
  wrap: { threshold: number; columns: number } | null,
): TidyForest {
  const placed = new Map<string, Placed>();
  const visibleChildren = new Map<string, string[]>();
  const wraps = new Map<string, { children: string[]; left: number }>();
  const visited = new Set<string>();
  const half = nodeWidth / 2;

  const place = (id: string): Contour => {
    visited.add(id);
    const children = input.collapsed?.has(id)
      ? []
      : (input.childrenById.get(id) ?? []).filter((child) => !visited.has(child));
    visibleChildren.set(id, children);
    if (children.length === 0) {
      placed.set(id, { contour: [[-half, half]], slots: [] });
      return [[-half, half]];
    }
    const contours = children.map(place);
    const block =
      wrap !== null && children.length > wrap.threshold
        ? wrapBlock(children, contours, nodeWidth, siblingGap, wrap.columns)
        : null;
    let slots: Slot[];
    let contour: Contour;
    if (block) {
      wraps.set(id, { children, left: -block.width / 2 });
      slots = block.slots;
      contour = [
        [-half, half],
        ...Array.from({ length: block.depth }, (): [number, number] => [
          -block.width / 2,
          block.width / 2,
        ]),
      ];
    } else {
      const row = packRow(contours, siblingGap);
      const center = (row.offsets[0] + row.offsets[row.offsets.length - 1]) / 2;
      slots = children.map((child, index) => ({
        id: child,
        dx: row.offsets[index] - center,
        rows: 1,
      }));
      contour = [
        [-half, half],
        ...row.contour.map(([left, right]): [number, number] => [left - center, right - center]),
      ];
    }
    placed.set(id, { contour, slots });
    return contour;
  };

  const roots: TidyForest["roots"] = [];
  for (const id of input.roots) {
    if (visited.has(id)) continue;
    roots.push({ id, contour: place(id) });
  }

  const centerX = new Map<string, number>();
  const depthById = new Map<string, number>();
  const assign = (id: string, x: number, depth: number) => {
    centerX.set(id, x);
    depthById.set(id, depth);
    for (const slot of placed.get(id)!.slots) assign(slot.id, x + slot.dx, depth + slot.rows);
  };
  for (const root of roots) assign(root.id, 0, 0);
  return { roots, centerX, depthById, visibleChildren, wraps };
}

/** The cards' bounding box, or an empty box at the origin. */
function boundsOf(positions: ReadonlyMap<string, XYPosition>, box: NodeBox): Rect {
  if (positions.size === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of positions.values()) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + box.width);
    maxY = Math.max(maxY, y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function union(a: Rect, b: Rect): Rect {
  if (a.width === 0 && a.height === 0) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Tree and compact: trees in rows (wrapping past the row width, each row
 * centered), then the childless roots in a wrapped grid under a heading.
 */
function layoutRows(input: LayoutInput, mode: "tree" | "compact"): ProjectGraphLayout {
  const spacing = SPACING[mode];
  const box = cardBox(mode);
  const tidy = tidyForest(input, spacing.width, spacing.siblingGap, {
    threshold: WRAP_THRESHOLD,
    columns: WRAP_COLUMNS,
  });
  const rowHeight = spacing.height + spacing.levelGap;
  const positions = new Map<string, XYPosition>();
  const treeBounds = new Map<string, Rect>();

  const trees = tidy.roots
    .filter((root) => (input.childrenById.get(root.id)?.length ?? 0) > 0)
    .map(({ id, contour }) => {
      const left = Math.min(...contour.map(([edge]) => edge));
      const right = Math.max(...contour.map(([, edge]) => edge));
      return {
        id,
        left,
        width: right - left,
        height: contour.length * rowHeight - spacing.levelGap,
      };
    });
  const standaloneIds = tidy.roots
    .filter((root) => (input.childrenById.get(root.id)?.length ?? 0) === 0)
    .map((root) => root.id);

  // Shelf-pack the trees: a row takes trees until the next would pass the row width.
  const rowLimit = Math.max(spacing.rowWidth, ...trees.map((tree) => tree.width));
  const shelves: (typeof trees)[] = [];
  let shelfWidth = 0;
  for (const tree of trees) {
    const current = shelves.at(-1);
    if (current && shelfWidth + spacing.rootGap + tree.width <= rowLimit) {
      current.push(tree);
      shelfWidth += spacing.rootGap + tree.width;
    } else {
      shelves.push([tree]);
      shelfWidth = tree.width;
    }
  }
  const shelfWidths = shelves.map(
    (shelf) =>
      shelf.reduce((sum, tree) => sum + tree.width, 0) + (shelf.length - 1) * spacing.rootGap,
  );
  const contentWidth = Math.max(0, ...shelfWidths);
  let top = 0;
  shelves.forEach((shelf, index) => {
    let left = (contentWidth - shelfWidths[index]) / 2;
    for (const tree of shelf) {
      const originX = left - tree.left;
      const ids = [tree.id, ...collectTree(tidy.visibleChildren, tree.id)];
      for (const id of ids) {
        positions.set(id, {
          x: originX + tidy.centerX.get(id)! - spacing.width / 2,
          y: top + tidy.depthById.get(id)! * rowHeight,
        });
      }
      treeBounds.set(tree.id, { x: left, y: top, width: tree.width, height: tree.height });
      left += tree.width + spacing.rootGap;
    }
    top += Math.max(...shelf.map((tree) => tree.height)) + spacing.rootGap;
  });

  const routes = new Map<string, XYPosition[]>();
  for (const [parent, wrap] of tidy.wraps) {
    const from = positions.get(parent);
    if (!from) continue;
    const parentX = from.x + spacing.width / 2;
    const trunkX = parentX + wrap.left - spacing.siblingGap / 2;
    const topChannel = from.y + spacing.height + spacing.levelGap / 2;
    const firstBandTop = from.y + rowHeight;
    for (const child of wrap.children) {
      const to = positions.get(child)!;
      const childX = to.x + spacing.width / 2;
      if (to.y === firstBandTop) {
        routes.set(child, [
          { x: parentX, y: topChannel },
          { x: childX, y: topChannel },
        ]);
      } else {
        const channel = to.y - spacing.levelGap / 2;
        routes.set(child, [
          { x: parentX, y: topChannel },
          { x: trunkX, y: topChannel },
          { x: trunkX, y: channel },
          { x: childX, y: channel },
        ]);
      }
    }
  }

  let standalone: StandaloneGroup | null = null;
  if (standaloneIds.length > 0) {
    // As many columns as fit under the trees, within the column cap.
    const available = trees.length > 0 ? contentWidth : spacing.rowWidth;
    const columns = Math.max(
      1,
      Math.min(
        MAX_GRID_COLUMNS,
        standaloneIds.length,
        Math.floor((available + spacing.gridGap) / (spacing.width + spacing.gridGap)),
      ),
    );
    const gridWidth = columns * spacing.width + (columns - 1) * spacing.gridGap;
    const gridLeft = trees.length > 0 ? Math.max(0, (contentWidth - gridWidth) / 2) : 0;
    const label = { x: gridLeft, y: top };
    const gridTop = top + STANDALONE_LABEL_HEIGHT;
    standaloneIds.forEach((id, index) => {
      positions.set(id, {
        x: gridLeft + (index % columns) * (spacing.width + spacing.gridGap),
        y: gridTop + Math.floor(index / columns) * (spacing.height + spacing.gridGap),
      });
    });
    const rows = Math.ceil(standaloneIds.length / columns);
    standalone = {
      ids: standaloneIds,
      label,
      bounds: {
        x: gridLeft,
        y: gridTop,
        width: gridWidth,
        height: rows * spacing.height + (rows - 1) * spacing.gridGap,
      },
    };
  }

  let bounds = boundsOf(positions, box);
  if (standalone)
    bounds = union(bounds, { ...standalone.label, width: 1, height: STANDALONE_LABEL_HEIGHT });
  return {
    positions,
    depthById: tidy.depthById,
    visibleChildren: tidy.visibleChildren,
    box,
    treeBounds,
    standalone,
    bounds,
    routes,
  };
}

function collectTree(visibleChildren: ReadonlyMap<string, readonly string[]>, id: string) {
  const result: string[] = [];
  const stack = [...(visibleChildren.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    result.push(next);
    stack.push(...(visibleChildren.get(next) ?? []));
  }
  return result;
}

/**
 * Lay the forest out. Only tree children move cards; fork links are overlay
 * edges and never enter here. Output is deterministic for the same input.
 */
export function layoutProjectGraph(
  input: LayoutInput,
  mode: ProjectGraphLayoutMode,
): ProjectGraphLayout {
  if (mode !== "radial") return layoutRows(input, mode);

  // Radial: a tidy forest whose slots are wide enough for a card in any
  // direction, wrapped around a circle. One root sits at the center.
  const spacing = SPACING[mode];
  const box = cardBox(mode);
  const positions = new Map<string, XYPosition>();
  const diagonal = Math.hypot(spacing.width, spacing.height);
  const slot = diagonal + spacing.siblingGap;
  const tidy = tidyForest(input, slot, 0, null);
  const { offsets } = packRow(
    tidy.roots.map((root) => root.contour),
    0,
  );
  const rootOffset = new Map(tidy.roots.map((root, index) => [root.id, offsets[index]]));
  const forestX = new Map<string, number>();
  for (const root of tidy.roots) {
    for (const id of [root.id, ...collectTree(tidy.visibleChildren, root.id)])
      forestX.set(id, rootOffset.get(root.id)! + tidy.centerX.get(id)!);
  }
  const ringStep = diagonal + spacing.levelGap;
  const singleRoot = tidy.roots.length === 1;
  const ringIds = [...forestX.keys()].filter((id) => !(singleRoot && tidy.depthById.get(id) === 0));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const id of ringIds) {
    minX = Math.min(minX, forestX.get(id)!);
    maxX = Math.max(maxX, forestX.get(id)!);
  }
  const circumference = ringIds.length > 0 ? maxX - minX + slot : slot;
  // Wide enough that neighbors a slot apart on one ring stay a slot apart as a chord.
  const innerRadius = Math.max(ringStep, (1.6 * circumference) / (2 * Math.PI));
  for (const [id, x] of forestX) {
    const depth = tidy.depthById.get(id)!;
    const ring = singleRoot ? depth - 1 : depth;
    let center: XYPosition = { x: 0, y: 0 };
    if (ring >= 0) {
      const angle = ((x - minX) / circumference) * 2 * Math.PI - Math.PI / 2;
      const radius = innerRadius + ring * ringStep;
      center = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }
    positions.set(id, {
      x: Math.round((center.x - spacing.width / 2) * 100) / 100,
      y: Math.round((center.y - spacing.height / 2) * 100) / 100,
    });
  }
  return {
    positions,
    depthById: tidy.depthById,
    visibleChildren: tidy.visibleChildren,
    box,
    treeBounds: new Map(),
    standalone: null,
    bounds: boundsOf(positions, box),
    routes: new Map(),
  };
}

/** The lowest zoom the graph opens or auto-fits at, so titles stay readable. */
export const MIN_READABLE_ZOOM = 0.85;
/** The fit control may zoom further out, but not below this. */
export const MIN_FIT_ZOOM = 0.5;
const VIEW_MARGIN = 48;

/**
 * Where the graph opens: the whole graph when it fits at a readable zoom,
 * otherwise the anchor's tree (or the standalone grid) at 100%. Content is
 * top-aligned and centered across, or centered on the anchor when wider.
 */
export function readableViewport(
  layout: ProjectGraphLayout,
  anchorId: string | null,
  canvas: NodeBox,
): Viewport {
  const usableWidth = canvas.width - 2 * VIEW_MARGIN;
  const usableHeight = canvas.height - 2 * VIEW_MARGIN;
  const fitZoom = (rect: Rect) =>
    usableWidth <= 0 || usableHeight <= 0 || rect.width === 0
      ? 1
      : Math.min(usableWidth / rect.width, usableHeight / rect.height);
  const anchor = anchorId !== null ? layout.positions.get(anchorId) : undefined;
  const group =
    (anchorId !== null && layout.treeBounds.get(anchorId)) ||
    (anchorId !== null && layout.standalone?.ids.includes(anchorId)
      ? union(layout.standalone.bounds, {
          ...layout.standalone.label,
          width: 1,
          height: STANDALONE_LABEL_HEIGHT,
        })
      : null) ||
    layout.bounds;

  const whole = fitZoom(layout.bounds);
  const rect = whole >= MIN_READABLE_ZOOM || !anchor ? layout.bounds : group;
  const fit = fitZoom(rect);
  const zoom = fit >= MIN_READABLE_ZOOM ? Math.min(fit, 1) : 1;

  const fitsWide = rect.width * zoom <= usableWidth;
  const focusX = fitsWide || !anchor ? rect.x + rect.width / 2 : anchor.x + layout.box.width / 2;
  let x = canvas.width / 2 - focusX * zoom;
  if (!fitsWide) {
    // Don't open on empty space past either end of the content.
    x = Math.min(x, VIEW_MARGIN - layout.bounds.x * zoom);
    x = Math.max(x, canvas.width - VIEW_MARGIN - (layout.bounds.x + layout.bounds.width) * zoom);
  }
  // Top-aligned, as an outline reads: roots first, children below.
  const y = VIEW_MARGIN - rect.y * zoom;
  return { x: Math.round(x), y: Math.round(y), zoom };
}

/** What a node's card renders; the view fills in live state. */
export interface ProjectGraphNodeData extends Record<string, unknown> {
  sessionId: string;
  mode: ProjectGraphLayoutMode;
}

export interface ProjectGraphEdgeData extends Record<string, unknown> {
  kind: ProjectGraphEdgeKind;
  /** The target session needs the viewer, so the edge takes the warning color. */
  attention?: boolean;
  /** On the selected card's path to its root. */
  highlighted?: boolean;
  /** Dimmed by search or a status filter. */
  dimmed?: boolean;
  /** Bends for an edge into a wrapped fan-out; a plain curve without them. */
  route?: readonly XYPosition[];
}

export type ProjectGraphFlowNode = Node<ProjectGraphNodeData, "session">;
export type ProjectGraphFlowEdge = Edge<ProjectGraphEdgeData, "tree" | "fork">;

/**
 * xyflow nodes and edges for a layout. Edges whose ends aren't both visible
 * are dropped; fork edges route between their cards' top handles.
 */
export function projectGraphFlowElements(
  layout: ProjectGraphLayout,
  edges: readonly ProjectGraphEdge[],
  mode: ProjectGraphLayoutMode,
): { nodes: ProjectGraphFlowNode[]; edges: ProjectGraphFlowEdge[] } {
  const nodes: ProjectGraphFlowNode[] = [];
  for (const [id, position] of layout.positions) {
    nodes.push({
      id,
      type: "session",
      position,
      width: layout.box.width,
      height: layout.box.height,
      data: { sessionId: id, mode },
    });
  }
  const visibleTreeEdges = new Set<string>();
  for (const [parent, children] of layout.visibleChildren) {
    for (const child of children) visibleTreeEdges.add(`${parent}->${child}`);
  }
  const flowEdges: ProjectGraphFlowEdge[] = [];
  for (const edge of edges) {
    if (!layout.positions.has(edge.source) || !layout.positions.has(edge.target)) continue;
    if (edge.kind === "fork") {
      flowEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: "fork-out",
        targetHandle: "fork-in",
        type: "fork",
        data: { kind: "fork" },
      });
    } else if (visibleTreeEdges.has(`${edge.source}->${edge.target}`)) {
      flowEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "tree",
        data: { kind: edge.kind, route: layout.routes.get(edge.target) },
      });
    }
  }
  return { nodes, edges: flowEdges };
}
