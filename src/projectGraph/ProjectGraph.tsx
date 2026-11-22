// The project home's graph view. The graph itself loads on demand, since xyflow is heavy.

import { lazy, Suspense } from "react";
import { useSearchParams } from "@/lib/routing";
import { ProjectGraphLoading, ProjectGraphTurnedOff } from "./ProjectGraphChrome";
import {
  isProjectGraphSearch,
  PROJECT_GRAPH_DEPLOYMENT_ENABLED,
  projectGraphPreference,
  useProjectGraphEnabled,
} from "./projectGraphFeature";
import type { ProjectGraphViewProps } from "./projectGraphTypes";

const ProjectGraphView = lazy(() => import("./ProjectGraphView"));

/** Whether the project home should show the graph instead of the board. */
export function useShowsProjectGraph(): boolean {
  const [searchParams] = useSearchParams();
  // A user who turned the view off still lands here, to turn it back on.
  return PROJECT_GRAPH_DEPLOYMENT_ENABLED && isProjectGraphSearch(searchParams);
}

export function ProjectGraph(props: ProjectGraphViewProps) {
  const enabled = useProjectGraphEnabled();
  if (!enabled)
    return <ProjectGraphTurnedOff onTurnOn={() => projectGraphPreference.write(true)} />;
  return (
    <Suspense fallback={<ProjectGraphLoading />}>
      <ProjectGraphView {...props} />
    </Suspense>
  );
}
