// A session's card on the project graph: its kind and status, a two-line
// title, then harness and time with the count of sessions below it.
// Right-click and the hover ⋯ open the session menu; hovering a moment opens
// a detail card (branch, PR, model and cost).

import { Fragment, memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BrainIcon, MoreHorizontalIcon, SquareIcon } from "lucide-react";
import { RunningDot } from "@/components/RunningDot";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { agentCostLabel } from "@/hooks/useAgentCosts";
import type { SessionState } from "@/hooks/useSessionState";
import { formatTokenCount } from "@/lib/formatCost";
import { cn } from "@/lib/utils";
import {
  conversationDisplayLabel,
  getConversationAgentType,
  type StatusBucket,
} from "@/shell/sidebarNav";
import { SessionHarnessIcon, SessionUpdatedLabel } from "@/shell/sessionRowMeta";
import { useProjectGraphActions, useProjectGraphPointerStore } from "./projectGraphContext";
import { SESSION_TAG_NOTE } from "./memory/memoryLogic";
import { hasActiveTurn, type ContextGauge, type ContextGaugeTone } from "./projectGraphControls";
import { cardBox } from "./projectGraphLayout";
import type { SessionCardData, SessionCardNode, StandaloneLabelNode } from "./projectGraphTypes";
import type { StatusPillTone } from "./projectGraphStatus";
import { ProjectGraphHoverDetails } from "./ProjectGraphHoverDetails";
import { ProjectGraphMenuBody, useSetMenuTarget } from "./ProjectGraphMenus";
import {
  cardSessionState,
  isWaitingOnUser,
  splitSearchMatches,
  statusPill,
} from "./projectGraphStatus";

const HOVER_OPEN_DELAY_MS = 350;
const HOVER_CLOSE_DELAY_MS = 120;
const HANDLE_CLASS =
  "!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

function Highlighted({ text, query, active }: { text: string; query: string; active: boolean }) {
  if (!active) return text;
  let offset = 0;
  return splitSearchMatches(text, query).map((part) => {
    const key = offset;
    offset += part.text.length;
    return part.match ? (
      <mark key={key} className="rounded-[2px] bg-warning/20 text-search-match">
        {part.text}
      </mark>
    ) : (
      <Fragment key={key}>{part.text}</Fragment>
    );
  });
}

const PILL_TONE = {
  attention: "bg-warning/15 text-warning",
  working: "bg-session-active/15 text-session-active",
  unread: "bg-brand-accent/15 text-brand-accent",
  error: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
} as const satisfies Record<StatusPillTone, string>;

function StatusPill({
  state,
  bucket,
  compact,
}: {
  state: SessionState | null;
  bucket: StatusBucket;
  compact: boolean;
}) {
  const visual = statusPill(state, bucket);
  if (compact && visual.running) {
    return (
      <span role="status" aria-label="Working" className="flex shrink-0">
        <RunningDot className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={visual.label}
      title={visual.title}
      data-testid="project-graph-status"
      data-state={state?.kind ?? bucket}
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-none font-medium",
        PILL_TONE[visual.tone],
      )}
    >
      {visual.running && <RunningDot className="size-3" />}
      {visual.label}
    </span>
  );
}

/** The waiting-on-you pill, as a button that opens the approvals drawer. Always visible. */
function ReviewablePill({
  data,
  state,
  compact,
}: {
  data: SessionCardData;
  state: SessionState | null;
  compact: boolean;
}) {
  const graph = useProjectGraphActions();
  const pill = <StatusPill state={state} bucket={data.bucket} compact={compact} />;
  if (!data.canControl || !isWaitingOnUser(data.conversation)) return pill;
  const title = conversationDisplayLabel(data.conversation);
  return (
    <button
      type="button"
      aria-label={`Review approvals for ${title}`}
      title="Review approvals"
      data-testid="project-graph-review"
      onClick={(event) => {
        event.stopPropagation();
        graph.openApprovals(data.sessionId);
      }}
      className="nodrag nopan flex shrink-0 rounded-full hover:ring-2 hover:ring-warning/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {pill}
    </button>
  );
}

const GAUGE_TONE = {
  normal: "bg-muted-foreground/45",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const satisfies Record<ContextGaugeTone, string>;

/** A slim context-window bar along the card's bottom edge. */
function ContextBar({ gauge }: { gauge: ContextGauge }) {
  const percent = Math.round(gauge.ratio * 100);
  const label = `Context ${percent}% used (${formatTokenCount(gauge.usedTokens)} of ${formatTokenCount(gauge.windowTokens)} tokens)`;
  return (
    <div
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={label}
      title={label}
      data-testid="project-graph-context"
      data-tone={gauge.tone}
      className="absolute inset-x-0 bottom-0 h-[3px] bg-muted"
    >
      <div className={cn("h-full", GAUGE_TONE[gauge.tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** The card's inclusive cost, e.g. "$0.42", or "~$0.10" for an estimate. */
function CostLabel({ data }: { data: SessionCardData }) {
  if (!data.showCost) return null;
  const label = agentCostLabel(data.cost ?? undefined);
  if (label === null) return null;
  const below = data.descendants.total > 0 ? ", including its sub-agents" : "";
  return (
    <span
      data-testid="project-graph-cost"
      title={data.cost?.estimated ? `Estimated cost${below}` : `Cost${below}`}
      className="shrink-0 tabular-nums"
    >
      {label}
    </span>
  );
}

/** How many project memories this session tagged: a brain icon and the count. */
function MemoryLabel({ data }: { data: SessionCardData }) {
  if (data.memoryCount === null) return null;
  const noun = data.memoryCount === 1 ? "memory" : "memories";
  return (
    <span
      data-testid="project-graph-memory-count"
      title={`Wrote ${data.memoryCount} project ${noun}. ${SESSION_TAG_NOTE}`}
      className="flex shrink-0 items-center gap-0.5 text-brand-accent tabular-nums"
    >
      <BrainIcon aria-hidden className="size-3" />
      {data.memoryCount}
      <span className="sr-only"> project {noun} written</span>
    </span>
  );
}

/** The card's kind, named after the edge into it. */
function kindLabel(data: SessionCardData): string {
  if (data.treeKind === "subagent") return "Sub-agent";
  if (data.treeKind === "nested") return "Nested";
  if (data.forkSourceLabel) return "Fork";
  return "Root";
}

/** "3 sub-agents" or "2 nested": everything under the card, named by its children's kind. */
function belowLabel(data: SessionCardData): string | null {
  const total = data.descendants.total;
  if (total === 0) return null;
  if (data.childKind === "nested") return `${total} nested`;
  return `${total} sub-agent${total === 1 ? "" : "s"}`;
}

function CollapsePill({ data }: { data: SessionCardData }) {
  const graph = useProjectGraphActions();
  const { collapsed, childCount, descendants, canLoadChildren, loadingChildren } = data;
  if (childCount === 0 && !canLoadChildren) return null;
  const hiddenUrgent = collapsed && descendants.needsAttention > 0;
  const hiddenWorking = collapsed && descendants.working > 0;
  const label =
    childCount === 0
      ? loadingChildren
        ? "Loading sub-agents"
        : "Load sub-agents"
      : collapsed
        ? `Expand ${descendants.total} hidden sessions`
        : "Collapse subtree";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="project-graph-collapse-pill"
      onClick={(event) => {
        event.stopPropagation();
        if (childCount === 0) graph.loadChildren(data.sessionId);
        else graph.toggleCollapse(data.sessionId);
      }}
      className={cn(
        "nodrag nopan absolute -bottom-2.5 left-1/2 z-10 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center gap-1 rounded-full border border-border bg-card-solid px-1.5 text-[11px] leading-none text-muted-foreground tabular-nums shadow-xs transition-opacity hover:text-foreground motion-reduce:transition-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        !collapsed && "opacity-0 group-hover/node:opacity-100 group-focus-within/node:opacity-100",
      )}
    >
      {childCount === 0 ? (loadingChildren ? "…" : "+") : collapsed ? `+${descendants.total}` : "−"}
      {hiddenUrgent && <span aria-hidden className="size-1.5 rounded-full bg-warning" />}
      {hiddenWorking && <span aria-hidden className="size-1.5 rounded-full bg-session-active" />}
    </button>
  );
}

function CardBody({ data }: { data: SessionCardData }) {
  const { conversation, mode, search, searchQuery } = data;
  const compact = mode !== "tree";
  const state = cardSessionState(conversation);
  const title = conversationDisplayLabel(conversation);
  const harness = getConversationAgentType(conversation);
  const time = conversation.updated_at > 0 && (
    <SessionUpdatedLabel updatedAt={conversation.updated_at} />
  );
  const below = belowLabel(data);
  const titleText = <Highlighted text={title} query={searchQuery} active={search === "match"} />;

  if (compact) {
    return (
      <>
        <div className="flex min-w-0 items-center gap-1.5">
          <SessionHarnessIcon
            conversation={conversation}
            testId="project-graph-harness"
            withFallback
          />
          <span className="min-w-0 flex-1 truncate font-medium">{titleText}</span>
          <ReviewablePill data={data} state={state} compact />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <span className="min-w-0 truncate">{time || harness}</span>
          <CostLabel data={data} />
          <MemoryLabel data={data} />
          <span className="flex-1" />
          {below && <span className="shrink-0 text-brand-accent">{below}</span>}
        </div>
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex h-5 min-w-0 items-center justify-between gap-2",
          data.canControl && hasActiveTurn(conversation)
            ? "group-hover/node:pr-12 group-focus-within/node:pr-12"
            : "group-hover/node:pr-6 group-focus-within/node:pr-6",
          data.canControl &&
            hasActiveTurn(conversation) &&
            (data.selected || data.keyboardFocused) &&
            "pr-12",
        )}
      >
        <span
          className="truncate text-[11px] leading-none font-medium tracking-wide text-muted-foreground uppercase"
          title={data.forkSourceLabel ? `Forked from ${data.forkSourceLabel}` : undefined}
        >
          {kindLabel(data)}
        </span>
        <ReviewablePill data={data} state={state} compact={false} />
      </div>
      <p className="line-clamp-2 min-h-0 flex-1 text-base leading-[21px] font-semibold break-words">
        {titleText}
      </p>
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
        <SessionHarnessIcon
          conversation={conversation}
          testId="project-graph-harness"
          withFallback
        />
        <span className="min-w-0 truncate">
          {harness}
          {time && (
            <>
              <span aria-hidden> · </span>
              {time}
            </>
          )}
        </span>
        <CostLabel data={data} />
        <MemoryLabel data={data} />
        <span className="flex-1" />
        {below && <span className="shrink-0 font-medium text-brand-accent">{below}</span>}
      </div>
    </>
  );
}

function SessionCardNodeComponent({ data }: NodeProps<SessionCardNode>) {
  const graph = useProjectGraphActions();
  const setMenuTarget = useSetMenuTarget();
  const interacting = useProjectGraphPointerStore((state) => state.interacting);
  const anyMenuOpen = useProjectGraphPointerStore((state) => state.menuOpen);
  const setMenuOpen = useProjectGraphPointerStore((state) => state.setMenuOpen);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const { conversation, bucket, mode, search } = data;
  const compact = mode !== "tree";
  const needsYou = bucket === "Needs attention" || isWaitingOnUser(conversation);
  const title = conversationDisplayLabel(conversation);
  const cancellable = data.canControl && hasActiveTurn(conversation);
  const menuProps = {
    conversation,
    collapsed: data.collapsed,
    hasChildren: data.childCount > 0,
    forkSourceId: data.forkSourceOnGraph,
    canControl: data.canControl,
    subtreeStopCount: data.subtreeStopCount,
  };
  const onMenuOpenChange = (open: boolean) => {
    if (open) setMenuTarget(conversation);
    setMenuOpen(open);
    if (open) setHoverOpen(false);
  };

  return (
    // xyflow turns pointer events off on nodes that can't be dragged or selected.
    <div
      className="group/node pointer-events-auto relative"
      data-testid="project-graph-node"
      data-session-id={data.sessionId}
    >
      <Handle
        type="target"
        position={Position.Top}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <Handle
        id="fork-in"
        type="target"
        position={Position.Top}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <HoverCard
          open={hoverOpen && !interacting && !anyMenuOpen}
          onOpenChange={setHoverOpen}
          openDelay={HOVER_OPEN_DELAY_MS}
          closeDelay={HOVER_CLOSE_DELAY_MS}
        >
          <ContextMenuTrigger asChild>
            <HoverCardTrigger asChild>
              <div
                role="button"
                tabIndex={-1}
                aria-label={title}
                aria-pressed={data.selected}
                data-search={search ?? undefined}
                onClick={(event) => graph.clickCard(data.sessionId, event)}
                className={cn(
                  "relative flex cursor-pointer flex-col overflow-hidden border border-border bg-card-solid text-ui text-foreground shadow-sm transition-[opacity,filter,box-shadow,border-color] duration-150 hover:border-foreground/25 motion-reduce:transition-none",
                  compact
                    ? "justify-center gap-0.5 rounded-lg px-2.5 py-2"
                    : "gap-1.5 rounded-xl px-3.5 py-3",
                  needsYou && "border-warning hover:border-warning",
                  search === "match" && "ring-2 ring-warning/25",
                  search === "ancestor" && "opacity-[0.72]",
                  search === "dim" && "opacity-[0.22] saturate-[0.35]",
                  data.forkHighlighted && "border-foreground/45",
                  data.selected && "border-foreground/45 shadow-md ring-2 ring-ring/25",
                  data.keyboardFocused && "ring-[3px] ring-ring/50",
                )}
                style={cardBox(data.mode)}
              >
                <CardBody data={data} />
                {data.context && <ContextBar gauge={data.context} />}
              </div>
            </HoverCardTrigger>
          </ContextMenuTrigger>
          <HoverCardContent
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={8}
            className="menu-surface w-[300px] rounded-xl p-3"
            data-testid="project-graph-hover-card"
            // Radix would take the key just to close this; close it and let Escape go on.
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              setHoverOpen(false);
              graph.escape();
            }}
          >
            <ProjectGraphHoverDetails data={data} open={hoverOpen} />
          </HoverCardContent>
        </HoverCard>
        <ContextMenuContent className="min-w-48">
          <ProjectGraphMenuBody {...menuProps} kind="context" close={() => {}} />
        </ContextMenuContent>
      </ContextMenu>
      {cancellable && (
        <button
          type="button"
          aria-label={`Cancel turn in ${title}`}
          title="Cancel turn"
          data-testid="project-graph-cancel-turn"
          onClick={(event) => {
            event.stopPropagation();
            graph.cancelTurn(data.sessionId);
          }}
          className={cn(
            "nodrag nopan absolute flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/node:opacity-100 group-focus-within/node:opacity-100 motion-reduce:transition-none hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            (data.selected || data.keyboardFocused) && "opacity-100",
            compact ? "top-1 right-7" : "top-2.5 right-8",
          )}
        >
          <SquareIcon className="size-3 fill-current" />
        </button>
      )}
      <DropdownMenu
        open={dropdownOpen}
        onOpenChange={(open) => {
          setDropdownOpen(open);
          onMenuOpenChange(open);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${title}`}
            data-testid="project-graph-node-actions"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "nodrag nopan absolute flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/node:opacity-100 motion-reduce:transition-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:opacity-100",
              compact ? "top-1 right-1" : "top-2.5 right-2.5",
            )}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <ProjectGraphMenuBody
            {...menuProps}
            kind="dropdown"
            close={() => setDropdownOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <CollapsePill data={data} />
      <Handle
        type="source"
        position={Position.Bottom}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <Handle
        id="fork-out"
        type="source"
        position={Position.Top}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
    </div>
  );
}

export const SessionCardNodeView = memo(SessionCardNodeComponent);

/** The heading over the grid of top-level sessions that have nothing under them. */
function StandaloneLabelComponent({ data }: NodeProps<StandaloneLabelNode>) {
  return (
    <div
      data-testid="project-graph-standalone-label"
      className="pointer-events-none flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase select-none"
    >
      Standalone sessions
      <span className="tabular-nums normal-case opacity-75">{data.count}</span>
    </div>
  );
}

export const StandaloneLabelNodeView = memo(StandaloneLabelComponent);
