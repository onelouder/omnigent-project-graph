// The graph's saved view state for the current viewer and project. Re-reads
// when the storage key changes (e.g. the viewer id resolves after first
// paint), and writes only to the key whose state it loaded.

import { useCallback, useState } from "react";
import {
  projectGraphStorageKey,
  readProjectGraphViewState,
  writeProjectGraphViewState,
  type ProjectGraphViewport,
  type ProjectGraphViewState,
} from "./projectGraphStorage";

interface Hydrated {
  key: string;
  viewerId: string | null;
  projectName: string;
  view: ProjectGraphViewState;
}

function hydrate(viewerId: string | null, projectName: string): Hydrated {
  return {
    key: projectGraphStorageKey(viewerId, projectName),
    viewerId,
    projectName,
    view: readProjectGraphViewState(viewerId, projectName),
  };
}

export interface ProjectGraphViewStateHandle {
  view: ProjectGraphViewState;
  /** The storage key `view` was loaded from; changes when the state re-hydrates. */
  storageKey: string;
  update: (change: (previous: ProjectGraphViewState) => ProjectGraphViewState) => void;
  saveViewport: (viewport: ProjectGraphViewport) => void;
}

export function useProjectGraphViewState(
  viewerId: string | null,
  projectName: string,
): ProjectGraphViewStateHandle {
  const [hydrated, setHydrated] = useState(() => hydrate(viewerId, projectName));
  let current = hydrated;
  if (hydrated.key !== projectGraphStorageKey(viewerId, projectName)) {
    // Load the new key's state before anything can write to it.
    current = hydrate(viewerId, projectName);
    setHydrated(current);
  }
  const update = useCallback<ProjectGraphViewStateHandle["update"]>((change) => {
    setHydrated((previous) => {
      const view = change(previous.view);
      writeProjectGraphViewState(previous.viewerId, previous.projectName, view);
      return { ...previous, view };
    });
  }, []);
  const saveViewport = useCallback(
    (viewport: ProjectGraphViewport) => update((previous) => ({ ...previous, viewport })),
    [update],
  );
  return { view: current.view, storageKey: current.key, update, saveViewport };
}
