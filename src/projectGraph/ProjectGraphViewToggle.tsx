// The project header's Board | Graph switch.

import { GitForkIcon, KanbanIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useNavigate, useSearchParams } from "@/lib/routing";
import { cn } from "@/lib/utils";
import {
  isProjectGraphSearch,
  PROJECT_GRAPH_VIEW,
  PROJECT_VIEW_PARAM,
  useProjectGraphEnabled,
} from "./projectGraphFeature";

/** Board | Graph switch in the project header; hidden when the graph is off or on phones. */
export function ProjectGraphViewToggle() {
  const enabled = useProjectGraphEnabled();
  const isMobile = useIsMobileViewport();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  if (!enabled || isMobile) return null;
  const graph = isProjectGraphSearch(searchParams);
  const show = (wantGraph: boolean) => {
    if (wantGraph === graph) return;
    const next = new URLSearchParams(searchParams);
    if (wantGraph) next.set(PROJECT_VIEW_PARAM, PROJECT_GRAPH_VIEW);
    else next.delete(PROJECT_VIEW_PARAM);
    void navigate({ search: next.size > 0 ? `?${next.toString()}` : "" });
  };
  const options = [
    { value: false, label: "Board", icon: KanbanIcon },
    { value: true, label: "Graph", icon: GitForkIcon },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Project view"
      data-testid="project-view-toggle"
      className="flex h-8 items-center rounded-lg border border-border p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={graph === value}
              aria-label={`${label} view`}
              onClick={() => show(value)}
              className={cn(
                "flex h-full items-center gap-1.5 rounded-md px-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                graph === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {value ? "Sessions as a branching graph" : "Sessions by status"}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
