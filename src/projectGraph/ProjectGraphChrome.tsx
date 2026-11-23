// The graph's chrome around the canvas: toolbar, focus breadcrumb, bulk bar,
// footer legend, and the loading, empty, error and no-match states.

import { Fragment } from "react";
import {
  ArchiveIcon,
  BrainIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  FolderInputIcon,
  GitForkIcon,
  HandIcon,
  KeyboardIcon,
  LayersIcon,
  ListFilterIcon,
  MessageCirclePlusIcon,
  OctagonXIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompactKbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProjects } from "@/hooks/useConversations";
import { cn } from "@/lib/utils";
import type { StatusBucket } from "@/shell/sidebarNav";
import { PROJECT_GRAPH_LAYOUTS, type ProjectGraphLayoutMode } from "./projectGraphLayout";
import { GRAPH_STATUS_CHIPS } from "./projectGraphStatus";
import { SESSION_TAG_NOTE } from "./memory/memoryLogic";
import type { ProjectGraphOverlays } from "./projectGraphStorage";

const LAYOUT_LABEL: Record<ProjectGraphLayoutMode, string> = {
  tree: "Tree",
  compact: "Compact",
  radial: "Radial",
};

const BUCKET_DOT_CLASS: Record<StatusBucket, string> = {
  Draft: "bg-muted-foreground",
  "Needs attention": "bg-warning",
  Unread: "bg-brand-accent",
  Working: "bg-session-active",
  Done: "bg-success",
};

const SHORTCUTS: [keys: string[], action: string][] = [
  [["↑", "↓", "←", "→"], "Move between sessions"],
  [["Enter"], "Open in quick view"],
  [["⌘", "Enter"], "Open the session page"],
  [["Space"], "Collapse or expand"],
  [["F"], "Focus subtree"],
  [["A"], "Review approvals"],
  [["."], "Cancel the running turn"],
  [["⌘", "Enter"], "Send from the composer"],
  [["/"], "Search"],
  [["0"], "Fit view"],
  [["+", "−"], "Zoom"],
  [["M"], "Toggle minimap"],
  [["Esc"], "Clear search, exit focus, close quick view"],
];

export function ProjectGraphToolbar({
  counts,
  statusFilter,
  onToggleStatus,
  includeArchived,
  onIncludeArchived,
  onTurnOff,
  matchCount,
  matchIndex,
  onStepMatch,
  layout,
  onLayout,
  allCollapsed,
  onToggleCollapseAll,
  awaitingCount,
  onNextAwaiting,
  overlays,
  onOverlays,
  memoryOpen,
  onToggleMemory,
}: {
  counts: ReadonlyMap<StatusBucket, number>;
  statusFilter: ReadonlySet<StatusBucket>;
  onToggleStatus: (bucket: StatusBucket) => void;
  includeArchived: boolean;
  onIncludeArchived: (include: boolean) => void;
  onTurnOff: () => void;
  /** Null while no search is active. */
  matchCount: number | null;
  matchIndex: number;
  onStepMatch: (step: 1 | -1) => void;
  layout: ProjectGraphLayoutMode;
  onLayout: (layout: ProjectGraphLayoutMode) => void;
  allCollapsed: boolean;
  onToggleCollapseAll: () => void;
  /** Sessions waiting on the viewer that the viewer may answer. */
  awaitingCount: number;
  onNextAwaiting: () => void;
  overlays: ProjectGraphOverlays;
  onOverlays: (overlays: ProjectGraphOverlays) => void;
  memoryOpen: boolean;
  onToggleMemory: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Graph controls"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 pb-2"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            <ListFilterIcon />
            Filter
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuCheckboxItem
            checked={includeArchived}
            onCheckedChange={(checked) => onIncludeArchived(checked === true)}
          >
            Show archived sessions
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onTurnOff}>Turn off graph view</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {GRAPH_STATUS_CHIPS.map((bucket) => {
        const active = statusFilter.has(bucket);
        return (
          <button
            key={bucket}
            type="button"
            aria-pressed={active}
            onClick={() => onToggleStatus(bucket)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-full border px-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              active
                ? "border-foreground/30 bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60",
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", BUCKET_DOT_CLASS[bucket])} />
            {bucket}
            <span className="tabular-nums">{counts.get(bucket) ?? 0}</span>
          </button>
        );
      })}
      {awaitingCount > 0 && (
        <button
          type="button"
          onClick={onNextAwaiting}
          title="Jump to the next session waiting on you"
          data-testid="project-graph-awaiting"
          className="flex h-6 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/15 px-2 text-sm font-medium text-warning transition-colors hover:bg-warning/25 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <HandIcon className="size-3.5" />
          Awaiting you <span className="tabular-nums">({awaitingCount})</span>
        </button>
      )}
      <span className="flex-1" />
      {matchCount !== null && matchCount > 0 && (
        <span
          className="flex items-center gap-0.5 text-sm text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {matchIndex + 1} of {matchCount}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            onClick={() => onStepMatch(-1)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            onClick={() => onStepMatch(1)}
          >
            <ChevronDownIcon />
          </Button>
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        aria-label="Project memory"
        aria-pressed={memoryOpen}
        data-testid="project-graph-memory-toggle"
        title="What agents remember about this project"
        className={cn("text-muted-foreground", memoryOpen && "bg-muted text-foreground")}
        onClick={onToggleMemory}
      >
        <BrainIcon />
        Memory
      </Button>
      <OverlaysToggle overlays={overlays} onOverlays={onOverlays} />
      <div
        role="radiogroup"
        aria-label="Layout"
        className="flex h-6 items-center rounded-md border border-border p-px"
      >
        {PROJECT_GRAPH_LAYOUTS.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={layout === mode}
            onClick={() => onLayout(mode)}
            className={cn(
              "h-full rounded-[5px] px-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              layout === mode
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LAYOUT_LABEL[mode]}
          </button>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={allCollapsed ? "Expand all" : "Collapse all"}
        title={allCollapsed ? "Expand all" : "Collapse all"}
        className="text-muted-foreground"
        onClick={onToggleCollapseAll}
      >
        {allCollapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
      </Button>
      <ShortcutsPopover />
    </div>
  );
}

function OverlaysToggle({
  overlays,
  onOverlays,
}: {
  overlays: ProjectGraphOverlays;
  onOverlays: (overlays: ProjectGraphOverlays) => void;
}) {
  const options: [keyof ProjectGraphOverlays, string, string?][] = [
    ["cost", "Cost"],
    ["context", "Context"],
    ["memory", "Memory", `Project memories each session wrote. ${SESSION_TAG_NOTE}`],
  ];
  return (
    <div
      role="group"
      aria-label="Overlays"
      className="flex h-6 items-center gap-0.5 rounded-md border border-border p-px pl-1.5 text-sm"
    >
      <LayersIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="pr-0.5 text-muted-foreground">Overlays:</span>
      {options.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          title={title}
          aria-pressed={overlays[key]}
          onClick={() => onOverlays({ ...overlays, [key]: !overlays[key] })}
          className={cn(
            "h-full rounded-[5px] px-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            overlays[key]
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ShortcutsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Keyboard shortcuts"
          data-testid="project-graph-shortcuts"
          className="text-muted-foreground"
        >
          <KeyboardIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="menu-surface w-72 rounded-xl p-3">
        <dl className="flex flex-col gap-1.5 text-sm">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={action} className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{action}</dt>
              <dd className="flex gap-0.5">
                {keys.map((key) => (
                  <CompactKbd key={key}>{key}</CompactKbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

/** Opens the shortcut list from the `?` key. */
export function openShortcutsPopover() {
  document.querySelector<HTMLButtonElement>('[data-testid="project-graph-shortcuts"]')?.click();
}

export function ProjectGraphBreadcrumb({
  path,
  onFocus,
  onExit,
}: {
  /** Focus root's ancestors then the focus root, each id with its title. */
  path: { id: string; title: string }[];
  onFocus: (id: string) => void;
  onExit: () => void;
}) {
  return (
    <nav aria-label="Focus path" className="flex h-9 shrink-0 items-center gap-1 text-sm">
      <span className="text-muted-foreground">Focus:</span>
      <Button variant="ghost" size="xs" onClick={onExit}>
        All sessions
      </Button>
      {path.map((entry, index) => (
        <Fragment key={entry.id}>
          <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <Button
            variant="ghost"
            size="xs"
            aria-current={index === path.length - 1 ? "page" : undefined}
            className={cn("max-w-48", index === path.length - 1 && "font-medium text-foreground")}
            onClick={() => onFocus(entry.id)}
          >
            <span className="truncate">{entry.title}</span>
          </Button>
        </Fragment>
      ))}
      <span className="flex-1" />
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onExit}>
        Exit focus
        <CompactKbd>Esc</CompactKbd>
      </Button>
    </nav>
  );
}

export function ProjectGraphBulkBar({
  count,
  currentProject,
  onArchive,
  onMove,
  onMarkRead,
  stoppableCount,
  onStop,
  onClear,
}: {
  count: number;
  currentProject: string;
  onArchive: () => void;
  onMove: (projectName: string) => void;
  onMarkRead: () => void;
  /** Picked sessions the viewer may stop. */
  stoppableCount: number;
  onStop: () => void;
  onClear: () => void;
}) {
  const { data: projects } = useProjects();
  return (
    <div
      role="toolbar"
      aria-label="Selected sessions"
      className="menu-surface pointer-events-auto flex items-center gap-1 rounded-xl px-2 py-1.5 shadow-card"
    >
      <span className="px-1.5 text-sm font-medium tabular-nums">{count} selected</span>
      <Button variant="ghost" size="xs" onClick={onArchive}>
        <ArchiveIcon />
        Archive
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs">
            <FolderInputIcon />
            Move to project
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="max-h-72 min-w-44 overflow-y-auto">
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {(projects ?? [])
            .filter((project) => project.name !== currentProject)
            .map((project) => (
              <DropdownMenuItem key={project.id} onSelect={() => onMove(project.name)}>
                {project.name}
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onMove("")}>Remove from project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="xs" onClick={onMarkRead}>
        <CheckCheckIcon />
        Mark read
      </Button>
      {stoppableCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive hover:text-destructive"
          onClick={onStop}
        >
          <OctagonXIcon />
          Stop selected
        </Button>
      )}
      <Button variant="ghost" size="icon-xs" aria-label="Clear selection" onClick={onClear}>
        <XIcon />
      </Button>
    </div>
  );
}

export function ProjectGraphFooter({
  total,
  needsAttention,
  working,
  costLabel,
  memoryLegend,
}: {
  total: number;
  needsAttention: number;
  working: number;
  /** The shown trees' spend, each counted once; null when off or unknown. */
  costLabel: string | null;
  /** The Memory overlay marks at least one branch. */
  memoryLegend: boolean;
}) {
  const line = "h-0 w-5 border-t-[1.5px]";
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-col gap-1.5 rounded-lg bg-background/85 px-2 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
      <p className="tabular-nums" data-testid="project-graph-summary">
        {total} {total === 1 ? "session" : "sessions"} · {needsAttention} need attention · {working}{" "}
        working
        {costLabel && (
          <span data-testid="project-graph-cost-total" title="Shown trees, each counted once">
            {" "}
            · {costLabel}
          </span>
        )}
      </p>
      <ul aria-label="Legend" className="flex items-center gap-3">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cn(line, "border-border-strong")} />
          Sub-agent
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cn(line, "border-dotted border-border-strong")} />
          Nested
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(line, "border-dashed border-muted-foreground opacity-80")}
          />
          Fork
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cn(line, "border-t-2 border-warning")} />
          Needs you
        </li>
        {memoryLegend && (
          <li className="flex items-center gap-1.5" title={SESSION_TAG_NOTE}>
            <span aria-hidden className={cn(line, "border-t-2 border-brand-accent")} />
            Wrote to memory
          </li>
        )}
      </ul>
    </div>
  );
}

export function ProjectGraphLoading() {
  const bone =
    "h-14 w-52 animate-pulse rounded-xl border border-border bg-muted/50 motion-reduce:animate-none";
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-6">
      <div aria-hidden className="flex flex-col items-center gap-8">
        <div className={bone} />
        <div className="flex gap-6">
          <div className={bone} />
          <div className={bone} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Loading project graph…</p>
    </div>
  );
}

export function ProjectGraphError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center gap-3 p-6">
      <p className="text-muted-foreground">Couldn’t load this project’s sessions.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function ProjectGraphEmpty({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-card-solid text-muted-foreground shadow-sm">
        <GitForkIcon className="size-5" />
      </span>
      <p className="text-muted-foreground">No sessions in this project yet</p>
      <Button onClick={onNewSession}>
        <MessageCirclePlusIcon />
        New session
      </Button>
    </div>
  );
}

export function ProjectGraphNoMatch({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
      <div
        role="status"
        className="menu-surface pointer-events-auto flex items-center gap-2 rounded-full py-1 pr-1 pl-3 text-sm shadow-card"
      >
        <span className="max-w-72 truncate">No sessions match “{query}”</span>
        <Button variant="ghost" size="xs" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

export function ProjectGraphTurnedOff({ onTurnOn }: { onTurnOn: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-3 p-6">
      <p className="text-muted-foreground">The graph view is turned off for you.</p>
      <Button variant="outline" size="sm" onClick={onTurnOn}>
        Turn on graph view
      </Button>
    </div>
  );
}
