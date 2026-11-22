// The graph's three edge kinds. Sub-agent edges are solid curves from the
// parent's bottom to the child's top, nested edges dotted; both turn warning
// when they lead into a session that needs the viewer. Fork edges are dashed
// arcs over the cards with a "forked" pill.

import { memo } from "react";
import {
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
  type XYPosition,
} from "@xyflow/react";
import { GitForkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectGraphActions, useProjectGraphPointerStore } from "./projectGraphContext";
import type { ProjectGraphFlowEdge } from "./projectGraphLayout";

const PILL_ICON_ONLY_BELOW_ZOOM = 0.65;
const CORNER_RADIUS = 10;

/** An orthogonal path through `points`, its corners rounded. */
function roundedPolyline(points: readonly XYPosition[]): string {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const [previous, corner, next] = [points[index - 1], points[index], points[index + 1]];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(CORNER_RADIUS, inLength / 2, outLength / 2);
    if (radius === 0) continue;
    const before = {
      x: corner.x - ((corner.x - previous.x) / inLength) * radius,
      y: corner.y - ((corner.y - previous.y) / inLength) * radius,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * radius,
      y: corner.y + ((next.y - corner.y) / outLength) * radius,
    };
    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}
const INTERACTION_WIDTH = 14;

function TreeEdgeComponent({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ProjectGraphFlowEdge>) {
  const path = data?.route
    ? roundedPolyline([{ x: sourceX, y: sourceY }, ...data.route, { x: targetX, y: targetY }])
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0];
  const nested = data?.kind === "nested";
  const stroke = data?.highlighted
    ? "stroke-[var(--foreground)] [stroke-width:2px]"
    : data?.attention
      ? "stroke-[var(--warning)] [stroke-width:2px]"
      : "stroke-[var(--border-strong)] [stroke-width:1.5px]";
  return (
    <g
      className={cn("transition-opacity duration-150", data?.dimmed && "opacity-25")}
      data-edge-kind={data?.kind}
      data-attention={data?.attention ? "" : undefined}
    >
      <path
        d={path}
        fill="none"
        strokeLinecap="round"
        className={cn(stroke, nested && "[stroke-dasharray:1_5]")}
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={INTERACTION_WIDTH}>
        <title>{nested ? "Nested agent" : "Sub-agent"}</title>
      </path>
    </g>
  );
}

function ForkEdgeComponent({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<ProjectGraphFlowEdge>) {
  const graph = useProjectGraphActions();
  const setHoveredFork = useProjectGraphPointerStore((state) => state.setHoveredFork);
  const iconOnly = useStore((state) => state.transform[2] < PILL_ICON_ONLY_BELOW_ZOOM);
  // Both ends leave from the cards' tops, so the arc rises over the rows between them.
  const lift = 48 + Math.abs(targetX - sourceX) * 0.12;
  const crest = Math.min(sourceY, targetY) - lift;
  const path = `M ${sourceX} ${sourceY} C ${sourceX} ${crest}, ${targetX} ${crest}, ${targetX} ${targetY}`;
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 8 + crest * 0.75;
  const chevron = `M ${targetX - 4} ${targetY - 7} L ${targetX} ${targetY - 1.5} L ${targetX + 4} ${targetY - 7}`;
  return (
    <>
      <g
        className={cn("transition-opacity duration-150", data?.dimmed && "opacity-25")}
        data-edge-kind="fork"
      >
        <path
          d={path}
          fill="none"
          className="stroke-[var(--muted-foreground)] opacity-80 [stroke-dasharray:6_5] [stroke-width:1.5px]"
        />
        <path
          d={chevron}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-[var(--muted-foreground)] opacity-80 [stroke-width:1.5px]"
        />
      </g>
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label="Forked: jump to the source session"
          title="Forked — jump to source"
          onPointerEnter={() => setHoveredFork({ source, target })}
          onPointerLeave={() => setHoveredFork(null)}
          onClick={() => graph.jumpToSession(source)}
          className={cn(
            "nodrag nopan pointer-events-auto absolute flex h-5 items-center gap-1 rounded-full border border-border bg-card-solid px-1.5 text-[11px] text-muted-foreground shadow-xs transition-opacity duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            data?.dimmed && "opacity-25",
          )}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <GitForkIcon aria-hidden className="size-3" />
          {!iconOnly && "forked"}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const projectGraphEdgeTypes = {
  tree: memo(TreeEdgeComponent),
  fork: memo(ForkEdgeComponent),
};
