import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Slider } from '@/components/ui/slider';
import { useHighlight } from '@/hooks/useHighlight';
import { usePanZoom } from '@/hooks/usePanZoom';
import { useSlice } from '@/hooks/useSlice';
import { identifyAt } from '@/lib/navigate';
import { PLANE_COLOR_CLASS, PLANES, type Plane } from '@/lib/planes';
import type { Highlight } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { isIdentity, ZOOM_MAX, ZOOM_MIN } from '@/lib/zoom';

interface ViewCellProps {
  plane: Plane;
  idx: number;
  onIdxChange: (idx: number) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  /** The current selection's overlay, if any. */
  highlight?: Highlight;
  /** Hidden while another view is expanded (kept mounted to keep its zoom). */
  hidden?: boolean;
}

/** Where an `object-fit: contain` image actually draws inside its box. */
function containedRect(box: DOMRect, natW: number, natH: number) {
  const scale = Math.min(box.width / natW, box.height / natH);
  const w = natW * scale;
  const h = natH * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, w, h };
}

/** One 2D slice view: header (name, slice slider, zoom, actions), the slice
 *  with the selection overlaid, and a coordinate strip. Click the slice to
 *  identify a region; wheel/pinch to zoom, drag to pan. */
export function ViewCell({ plane, idx, onIdxChange, expanded, onToggleExpand, highlight, hidden }: ViewCellProps) {
  const cfg = PLANES[plane];
  const color = PLANE_COLOR_CLASS[plane];
  // A hidden view (another one is expanded) loads nothing until shown again.
  const slice = useSlice(plane, idx, !hidden);
  const mask = useHighlight(plane, idx, highlight, !hidden);

  // While dragging, the number follows the thumb; the image only reloads on
  // release (onValueCommit) — no request per pixel of drag.
  const [draft, setDraft] = useState(idx);
  useEffect(() => {
    setDraft(idx);
  }, [idx]);

  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);
  const data = slice.data;
  const imgRef = useRef<HTMLImageElement>(null);

  /** The slice pixel under a client point (null outside the image). The
   *  image's box includes the zoom transform, so this works at any zoom. */
  function pixelAt(clientX: number, clientY: number) {
    const img = imgRef.current;
    if (!data || !img) return null;
    const r = containedRect(img.getBoundingClientRect(), data.cols, data.rows);
    const col = Math.floor(((clientX - r.left) / r.w) * data.cols);
    const row = Math.floor(((clientY - r.top) / r.h) * data.rows);
    return col >= 0 && row >= 0 && col < data.cols && row < data.rows ? { col, row } : null;
  }

  const view = usePanZoom((x, y) => {
    const px = pixelAt(x, y);
    if (data && px) void identifyAt(plane, data.idx, px.col, px.row);
  });
  const { zoom } = view.transform;
  // Zoomed in, show voxels as crisp squares rather than a blur.
  const crisp = zoom >= 2 && '[image-rendering:pixelated]';

  // Slice and overlay share one box and `object-contain`, so they always line up.
  const layer = 'absolute inset-3 block h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] object-contain select-none';

  return (
    <section aria-label={`${cfg.label} view`} hidden={hidden} className="flex min-h-0 min-w-0 flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3.5 pr-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className={cn('size-2 rounded-[2px]', color.bg)} />
          {cfg.label}
        </span>
        <Slider
          aria-label={`${cfg.label} slice`}
          className={cn('max-w-64 flex-1', color.text)}
          min={cfg.min}
          max={cfg.max}
          value={[draft]}
          onValueChange={([v]) => v !== undefined && setDraft(v)}
          onValueCommit={([v]) => v !== undefined && onIdxChange(v)}
        />
        <output className="min-w-10 text-[13px] font-medium" aria-live="off">
          {draft}
        </output>
        <span className="text-xs text-subtle-foreground max-xl:hidden" title={`Slider moves ${cfg.axisTitle}`}>
          {cfg.axis}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <output
            className={cn('min-w-11 text-right text-xs text-subtle-foreground', (zoom <= ZOOM_MIN || zoom >= ZOOM_MAX) && 'text-foreground')}
            aria-label={`${cfg.label} zoom`}
          >
            {Math.round(zoom * 100)}%
          </output>
          <IconButton label="Reset zoom" onClick={view.reset} disabled={isIdentity(view.transform)}>
            <RotateCcw />
          </IconButton>
          <IconButton label={expanded ? 'Show all views' : `Expand ${cfg.label.toLowerCase()} view`} onClick={onToggleExpand}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </span>
      </header>

      <div
        ref={view.ref}
        data-testid={`${plane}-viewport`}
        onPointerMove={(e) => setHover(pixelAt(e.clientX, e.clientY))}
        onPointerLeave={() => setHover(null)}
        className="relative min-h-0 flex-1 cursor-crosshair touch-none overflow-hidden data-[panning]:cursor-grabbing"
      >
        <div
          className="absolute inset-0 origin-top-left"
          style={{ transform: `translate(${view.transform.x}px, ${view.transform.y}px) scale(${zoom})` }}
        >
          {data && (
            <img
              ref={imgRef}
              src={data.image}
              alt={`${cfg.label} slice ${data.idx}`}
              draggable={false}
              className={cn(layer, crisp, 'transition-opacity', slice.status === 'loading' && 'opacity-40')}
            />
          )}
          {data && highlight && mask.data && slice.status === 'ready' && (
            <img src={mask.data.mask} alt="" aria-hidden draggable={false} className={cn(layer, crisp, 'pointer-events-none')} />
          )}
        </div>
        {slice.status === 'loading' && !data && (
          <p role="status" className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            Loading slice…
          </p>
        )}
        {slice.status === 'error' && (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-canvas/85 p-6 text-center">
            <div>
              <p className="text-sm font-semibold text-destructive">{slice.error}</p>
              <p className="mt-1 text-xs text-muted-foreground">Check that the backend is running, then reload.</p>
            </div>
          </div>
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-surface px-3.5 text-xs text-subtle-foreground">
        <span>
          Column <span className="text-foreground">{hover?.col ?? '—'}</span>
        </span>
        <span>
          Row <span className="text-foreground">{hover?.row ?? '—'}</span>
        </span>
      </footer>
    </section>
  );
}
