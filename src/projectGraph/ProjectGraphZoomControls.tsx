// Zoom in, zoom out, fit and 100%, styled as the shared GraphZoomControls, with
// the animation length the caller picks (0 under reduced motion). Fit stops
// at a zoom where cards still read as cards.

import { useReactFlow } from "@xyflow/react";
import { Maximize2Icon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { MIN_FIT_ZOOM } from "./projectGraphLayout";

const FIT_PADDING = 0.2;
const BUTTON_CLASS =
  "flex items-center justify-center size-7 rounded-md border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors";

export function ProjectGraphZoomControls({ duration }: { duration: number }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  return (
    <div className="absolute right-3 bottom-3 z-10 flex flex-col gap-1">
      <button
        type="button"
        className={`${BUTTON_CLASS} text-[10px] font-medium tabular-nums`}
        onClick={() => void zoomTo(1, { duration })}
        aria-label="Zoom to 100%"
      >
        100%
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={() => void zoomIn({ duration })}
        aria-label="Zoom in"
      >
        <ZoomInIcon className="size-4" />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={() => void zoomOut({ duration })}
        aria-label="Zoom out"
      >
        <ZoomOutIcon className="size-4" />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={() => void fitView({ duration, padding: FIT_PADDING, minZoom: MIN_FIT_ZOOM })}
        aria-label="Fit view"
      >
        <Maximize2Icon className="size-4" />
      </button>
    </div>
  );
}
