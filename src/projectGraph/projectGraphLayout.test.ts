import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import type { StatusBucket } from "@/shell/sidebarNav";
import { buildProjectGraphForest, FORK_SOURCE_LABEL_KEY } from "./projectGraphForest";
import {
  COMPACT_CARD,
  layoutProjectGraph,
  MIN_READABLE_ZOOM,
  projectGraphFlowElements,
  readableViewport,
  TREE_CARD,
  type LayoutInput,
  type NodeBox,
  type ProjectGraphLayout,
  type ProjectGraphLayoutMode,
} from "./projectGraphLayout";

function tree(spec: Record<string, string[]>, roots: string[]): LayoutInput {
  return { roots, childrenById: new Map(Object.entries(spec)) };
}

// root ─ a ─ (a1, a2, a3), b, c ─ c1; plus a second root with one child.
const SAMPLE = tree({ root: ["a", "b", "c"], a: ["a1", "a2", "a3"], c: ["c1"], second: ["s1"] }, [
  "root",
  "second",
]);

function overlaps(layout: ProjectGraphLayout, box: NodeBox): [string, string][] {
  const entries = [...layout.positions];
  const pairs: [string, string][] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      if (Math.abs(a.x - b.x) < box.width && Math.abs(a.y - b.y) < box.height) {
        pairs.push([idA, idB]);
      }
    }
  }
  return pairs;
}

/** A balanced-ish forest of `count` nodes: each node has up to `fanout` children. */
function generated(count: number, fanout: number, rootCount: number): LayoutInput {
  const childrenById = new Map<string, string[]>();
  const roots: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `n${index}`;
    if (index < rootCount) {
      roots.push(id);
      continue;
    }
    const parent = `n${Math.floor((index - rootCount) / fanout)}`;
    childrenById.set(parent, [...(childrenById.get(parent) ?? []), id]);
  }
  return { roots, childrenById };
}

/**
 * A mixed project: `trees` roots with sub-agents of varied depth and breadth
 * (some fanning out past the wrap width), plus `standalone` childless roots.
 */
function mixedProject(trees: number, standalone: number): LayoutInput {
  const childrenById = new Map<string, string[]>();
  const roots: string[] = [];
  let next = 0;
  const add = (parent: string, count: number) => {
    const ids = Array.from({ length: count }, () => `s${next++}`);
    childrenById.set(parent, ids);
    return ids;
  };
  for (let index = 0; index < trees; index++) {
    const root = `tree${index}`;
    roots.push(root);
    const [first, ...rest] = add(root, 1 + (index % 4) + (index === 0 ? 8 : 0));
    if (index % 2 === 0) add(first, 2);
    if (index % 3 === 0 && rest.length > 0) add(add(rest[0], 1)[0], 1);
  }
  for (let index = 0; index < standalone; index++) roots.push(`solo${index}`);
  return { roots, childrenById };
}

/**
 * Each routed edge from `parent` to a child, as axis-aligned segments from the
 * parent's bottom to the child's top, checked against every card but its two ends.
 */
function routedCrossings(
  layout: ProjectGraphLayout,
  parent: string,
  children: readonly string[],
): string[] {
  const { width, height } = layout.box;
  const from = layout.positions.get(parent)!;
  const crossings: string[] = [];
  for (const child of children) {
    const to = layout.positions.get(child)!;
    const points = [
      { x: from.x + width / 2, y: from.y + height },
      ...layout.routes.get(child)!,
      { x: to.x + width / 2, y: to.y },
    ];
    for (let index = 1; index < points.length; index++) {
      const [start, end] = [points[index - 1], points[index]];
      const [minX, maxX] = [Math.min(start.x, end.x), Math.max(start.x, end.x)];
      const [minY, maxY] = [Math.min(start.y, end.y), Math.max(start.y, end.y)];
      for (const [id, card] of layout.positions) {
        if (id === parent || id === child) continue;
        const crosses =
          maxX > card.x && minX < card.x + width && maxY > card.y && minY < card.y + height;
        if (crosses) crossings.push(`${parent}->${child} crosses ${id}`);
      }
    }
  }
  return crossings;
}

function nodeCount(input: LayoutInput): number {
  const seen = new Set(input.roots);
  for (const kids of input.childrenById.values()) for (const kid of kids) seen.add(kid);
  return seen.size;
}

describe("layoutProjectGraph", () => {
  it("gives the same positions for the same input", () => {
    const first = layoutProjectGraph(SAMPLE, "tree");
    const second = layoutProjectGraph(SAMPLE, "tree");
    expect([...second.positions]).toEqual([...first.positions]);
  });

  it("places children a row below and a parent centered over its children", () => {
    const layout = layoutProjectGraph(SAMPLE, "tree");
    const root = layout.positions.get("root")!;
    const a = layout.positions.get("a")!;
    const c = layout.positions.get("c")!;
    expect(a.y).toBeGreaterThan(root.y);
    expect(root.x).toBeCloseTo((a.x + c.x) / 2);
    expect(layout.depthById.get("a1")).toBe(2);
  });

  it.each<[ProjectGraphLayoutMode, NodeBox]>([
    ["tree", TREE_CARD],
    ["compact", COMPACT_CARD],
    ["radial", COMPACT_CARD],
  ])("never overlaps cards in %s mode", (mode, box) => {
    expect(overlaps(layoutProjectGraph(SAMPLE, mode), box)).toEqual([]);
    expect(overlaps(layoutProjectGraph(generated(100, 3, 8), mode), box)).toEqual([]);
  });

  it("hides a collapsed node's subtree", () => {
    const layout = layoutProjectGraph({ ...SAMPLE, collapsed: new Set(["a"]) }, "tree");
    expect(layout.positions.has("a")).toBe(true);
    for (const hidden of ["a1", "a2", "a3"]) expect(layout.positions.has(hidden)).toBe(false);
    expect(layout.visibleChildren.get("a")).toEqual([]);
  });

  it("doesn't move tree coordinates for fork edges", () => {
    const rows = (withFork: boolean): Conversation[] => [
      { id: "src", created_at: 1, updated_at: 2, labels: {} } as Conversation,
      {
        id: "kid",
        created_at: 1,
        updated_at: 2,
        labels: {},
        parent_session_id: "src",
      } as Conversation,
      {
        id: "forked",
        created_at: 1,
        updated_at: 1,
        labels: withFork ? { [FORK_SOURCE_LABEL_KEY]: "kid" } : {},
      } as Conversation,
    ];
    const layoutOf = (withFork: boolean) => {
      const forest = buildProjectGraphForest(rows(withFork), {
        bucketOf: () => "Done" as StatusBucket,
      });
      const layout = layoutProjectGraph(forest, "tree");
      return { layout, forest };
    };
    const plain = layoutOf(false);
    const forked = layoutOf(true);
    expect([...forked.layout.positions]).toEqual([...plain.layout.positions]);
    const elements = projectGraphFlowElements(forked.layout, forked.forest.edges, "tree");
    expect(elements.edges.map((edge) => [edge.id, edge.type])).toEqual([
      ["subagent:src->kid", "tree"],
      ["fork:kid->forked", "fork"],
    ]);
  });

  it("uses compact cards and tighter spacing in compact mode", () => {
    const tidy = layoutProjectGraph(SAMPLE, "tree");
    const compact = layoutProjectGraph(SAMPLE, "compact");
    expect(compact.box).toEqual(COMPACT_CARD);
    const span = (layout: ProjectGraphLayout) => {
      const xs = [...layout.positions.values()].map((position) => position.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(compact)).toBeLessThan(span(tidy));
    expect(compact.positions.get("a")!.y).toBeLessThan(tidy.positions.get("a")!.y);
  });

  it("puts a lone root at the radial center with its descendants on rings", () => {
    const layout = layoutProjectGraph(
      tree({ root: ["a", "b", "c"], a: ["a1"] }, ["root"]),
      "radial",
    );
    const center = (id: string) => {
      const position = layout.positions.get(id)!;
      return { x: position.x + COMPACT_CARD.width / 2, y: position.y + COMPACT_CARD.height / 2 };
    };
    const radius = (id: string) => Math.hypot(center(id).x, center(id).y);
    expect(radius("root")).toBeCloseTo(0);
    expect(radius("a")).toBeCloseTo(radius("b"));
    expect(radius("a1")).toBeGreaterThan(radius("a"));
  });

  it("lays out 100 nodes quickly", () => {
    const input = generated(100, 3, 10);
    layoutProjectGraph(input, "tree");
    const started = performance.now();
    for (let run = 0; run < 10; run++) layoutProjectGraph(input, "tree");
    expect((performance.now() - started) / 10).toBeLessThan(5);
  });

  it("stacks childless roots in a wrapped grid below the trees", () => {
    const input = tree({ polly: ["a", "b", "c"] }, [
      "polly",
      ...Array.from({ length: 13 }, (_, index) => `run${index}`),
    ]);
    const layout = layoutProjectGraph(input, "tree");
    const treeBottom = Math.max(
      ...["polly", "a", "b", "c"].map((id) => layout.positions.get(id)!.y + TREE_CARD.height),
    );
    const standalone = layout.standalone!;
    expect(standalone.ids).toHaveLength(13);
    expect(standalone.label.y).toBeGreaterThanOrEqual(treeBottom);
    const rows = new Map<number, number>();
    for (const id of standalone.ids) {
      const { y } = layout.positions.get(id)!;
      expect(y).toBeGreaterThan(standalone.label.y);
      rows.set(y, (rows.get(y) ?? 0) + 1);
    }
    expect(rows.size).toBeGreaterThan(1);
    expect(Math.max(...rows.values())).toBeLessThanOrEqual(6);
    expect([...layout.treeBounds.keys()]).toEqual(["polly"]);
  });

  it("wraps trees into rows past the row width", () => {
    const input = tree(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`root${index}`, [`a${index}`, `b${index}`]]),
      ),
      Array.from({ length: 6 }, (_, index) => `root${index}`),
    );
    const layout = layoutProjectGraph(input, "tree");
    const rootRows = new Set(
      Array.from({ length: 6 }, (_, index) => layout.positions.get(`root${index}`)!.y),
    );
    expect(rootRows.size).toBeGreaterThan(1);
    expect(layout.bounds.width).toBeLessThanOrEqual(2800);
  });

  it.each<[string, (index: number) => string[] | null]>([
    ["childless children", () => null],
    ["children with sub-agents of their own", (index) => [`kid${index}-sub`]],
  ])("wraps a 176-child fan-out of %s into bands", (_label, grandchildren) => {
    const kids = Array.from({ length: 176 }, (_, index) => `kid${index}`);
    const spec: Record<string, string[]> = { root: kids };
    kids.forEach((kid, index) => {
      const below = grandchildren(index);
      if (below) spec[kid] = below;
    });
    const layout = layoutProjectGraph(tree(spec, ["root"]), "tree");

    expect(layout.positions.size).toBe(Object.values(spec).flat().length + 1);
    expect(overlaps(layout, TREE_CARD)).toEqual([]);
    expect(layout.bounds.width).toBeLessThanOrEqual(2000);
    const kidRows = new Set(kids.map((kid) => layout.positions.get(kid)!.y));
    expect(kidRows.size).toBeGreaterThanOrEqual(30);
    for (const kid of kids) expect(layout.routes.get(kid)).toBeDefined();
    expect(routedCrossings(layout, "root", kids)).toEqual([]);
    const flow = projectGraphFlowElements(
      layout,
      [{ id: "e", source: "root", target: "kid175", kind: "subagent" }],
      "tree",
    );
    expect(flow.edges[0].data!.route).toEqual(layout.routes.get("kid175"));
  });

  it("keeps a 100-session project compact: no overlaps and a bounded aspect ratio", () => {
    const input = mixedProject(10, 40);
    expect(nodeCount(input)).toBeGreaterThanOrEqual(95);
    for (const mode of ["tree", "compact"] as const) {
      const layout = layoutProjectGraph(input, mode);
      expect(layout.positions.size).toBe(nodeCount(input));
      expect(overlaps(layout, layout.box)).toEqual([]);
      const { width, height } = layout.bounds;
      expect(width / height).toBeLessThan(3);
      expect(height / width).toBeLessThan(3);
      expect(width).toBeLessThanOrEqual(3000);
    }
  });
});

describe("readableViewport", () => {
  const canvas = { width: 1600, height: 900 };

  it("shows a small graph whole at no more than 100%", () => {
    const layout = layoutProjectGraph(SAMPLE, "tree");
    const viewport = readableViewport(layout, "root", canvas);
    expect(viewport.zoom).toBeLessThanOrEqual(1);
    expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    const left = layout.bounds.x * viewport.zoom + viewport.x;
    const right = (layout.bounds.x + layout.bounds.width) * viewport.zoom + viewport.x;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(canvas.width);
  });

  it("opens a big graph at 100% on the anchor instead of zooming out", () => {
    const input = mixedProject(10, 40);
    const layout = layoutProjectGraph(input, "tree");
    const viewport = readableViewport(layout, "tree3", canvas);
    expect(viewport.zoom).toBe(1);
    const anchor = layout.positions.get("tree3")!;
    const screenX = anchor.x + viewport.x;
    const screenY = anchor.y + viewport.y;
    expect(screenX).toBeGreaterThanOrEqual(0);
    expect(screenX + TREE_CARD.width).toBeLessThanOrEqual(canvas.width);
    expect(screenY).toBeGreaterThanOrEqual(0);
    expect(screenY).toBeLessThan(canvas.height / 2);
  });

  it("opens on the standalone grid when the anchor is in it", () => {
    const input = mixedProject(10, 40);
    const layout = layoutProjectGraph(input, "tree");
    const viewport = readableViewport(layout, "solo0", canvas);
    const anchor = layout.positions.get("solo0")!;
    expect(anchor.y + viewport.y).toBeGreaterThanOrEqual(0);
    expect(anchor.y + viewport.y).toBeLessThan(canvas.height / 2);
  });
});
