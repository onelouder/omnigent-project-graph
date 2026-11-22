import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as StorageModule from "./projectGraphStorage";
import {
  DEFAULT_PROJECT_GRAPH_VIEW_STATE,
  projectGraphStorageKey,
  readProjectGraphViewState,
  writeProjectGraphViewState,
  type ProjectGraphViewState,
} from "./projectGraphStorage";
import { useProjectGraphViewState } from "./useProjectGraphViewState";

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./projectGraphStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    readProjectGraphViewState: vi.fn(
      (viewerId: string | null, projectName: string) =>
        saved.get(actual.projectGraphStorageKey(viewerId, projectName)) ??
        actual.DEFAULT_PROJECT_GRAPH_VIEW_STATE,
    ),
    writeProjectGraphViewState: vi.fn(),
  };
});

const userState: ProjectGraphViewState = {
  ...DEFAULT_PROJECT_GRAPH_VIEW_STATE,
  layout: "radial",
  collapsed: ["conv_a"],
};

beforeEach(() => {
  saved.clear();
  vi.mocked(readProjectGraphViewState).mockClear();
  vi.mocked(writeProjectGraphViewState).mockClear();
});

describe("useProjectGraphViewState", () => {
  it("re-hydrates when the viewer id resolves and writes only to the loaded key", () => {
    saved.set(projectGraphStorageKey("user_1", "demo"), userState);
    const { result, rerender } = renderHook(
      ({ viewerId }) => useProjectGraphViewState(viewerId, "demo"),
      { initialProps: { viewerId: null as string | null } },
    );
    expect(result.current.view.layout).toBe("tree");

    rerender({ viewerId: "user_1" });
    expect(result.current.view).toEqual(userState);
    expect(result.current.storageKey).toBe(projectGraphStorageKey("user_1", "demo"));
    // Nothing was written while the key changed hands.
    expect(writeProjectGraphViewState).not.toHaveBeenCalled();

    act(() => result.current.update((previous) => ({ ...previous, focusRoot: "conv_a" })));
    expect(writeProjectGraphViewState).toHaveBeenCalledTimes(1);
    expect(writeProjectGraphViewState).toHaveBeenCalledWith("user_1", "demo", {
      ...userState,
      focusRoot: "conv_a",
    });
  });

  it("keeps the viewport with the rest of the state", () => {
    const { result } = renderHook(() => useProjectGraphViewState("user_1", "demo"));
    act(() => result.current.saveViewport({ x: 4, y: 5, zoom: 0.5 }));
    expect(result.current.view.viewport).toEqual({ x: 4, y: 5, zoom: 0.5 });
    expect(writeProjectGraphViewState).toHaveBeenLastCalledWith(
      "user_1",
      "demo",
      expect.objectContaining({ viewport: { x: 4, y: 5, zoom: 0.5 } }),
    );
  });
});
