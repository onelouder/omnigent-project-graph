// Whether the project home offers its branching-graph view: on per deployment
// (VITE_OMNIGENT_PROJECT_GRAPH, default on) and per user (a stored preference).

import { createStoredPreference } from "@/lib/storedChoicePreference";

/** Query parameter value of `view` that shows the graph on a project home. */
export const PROJECT_GRAPH_VIEW = "graph";
export const PROJECT_VIEW_PARAM = "view";

/** Whether a build/deploy env value leaves the graph on; only "0" and "false" turn it off. */
export function projectGraphEnvEnabled(value: string | boolean | undefined): boolean {
  if (value === undefined || value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export const projectGraphPreference = createStoredPreference<boolean>(
  "omnigent:project-graph-enabled",
  (stored) => (stored === "true" ? true : stored === "false" ? false : undefined),
  true,
);

/** Whether this deployment offers the graph view at all. */
export const PROJECT_GRAPH_DEPLOYMENT_ENABLED = projectGraphEnvEnabled(
  import.meta.env.VITE_OMNIGENT_PROJECT_GRAPH as string | undefined,
);

/** Whether this deployment and this user have the graph view on. */
export function useProjectGraphEnabled(): boolean {
  const userEnabled = projectGraphPreference.use();
  return PROJECT_GRAPH_DEPLOYMENT_ENABLED && userEnabled;
}

/** Whether a project home's query asks for the graph view. */
export function isProjectGraphSearch(searchParams: URLSearchParams): boolean {
  return searchParams.get(PROJECT_VIEW_PARAM) === PROJECT_GRAPH_VIEW;
}
