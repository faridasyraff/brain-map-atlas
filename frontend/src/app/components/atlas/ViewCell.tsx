import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Slider } from '@/components/ui/slider';
import { useHighlight } from '@/hooks/useHighlight';
import { usePanZoom } from '@/hooks/usePanZoom';
import { useSlice } from '@/hooks/useSlice';
import { useSliderDraft } from '@/hooks/useSliderDraft';
import { voxelToUm } from '@/lib/coords';
import { identifyAt } from '@/lib/navigate';
import { PLANE_COLOR_CLASS, PLANES, type Plane } from '@/lib/planes';
import type { Highlight } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { ATLAS, fmtUm } from '@/lib/atlasFacts';
import { useAtlas } from '@/store/atlas';
import { ScaleBar } from './ScaleBar';
import { isIdentity, ZOOM_MAX, ZOOM_MIN, type ViewTransform } from '@/lib/zoom';

interface ViewCellProps {
  plane: Plane;
  idx: number;
  onIdxChange?: (idx: number) => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** The current selection's overlay, if any. */
  highlight?: Highlight;
  /** Hidden while another view is expanded (kept mounted to keep its zoom). */
  hidden?: boolean;
  /** Phone layout: just the slice (the slider lives below it, outside this view). */
  phone?: boolean;
  /** In the strip under the 3D stage: a tighter header. */
  compact?: boolean;
}

/** The zoom readout and its Reset button. */
function ZoomControls({ label, transform, onReset, large, compact }: { label: string; transform: ViewTransform; onReset: () => void; large?: boolean; compact?: boolean }) {
  const { zoom } = transform;
  return (
    <>
      <output
        className={cn('min-w-11 text-right font-mono text-xs text-subtle-foreground', compact && 'min-w-8', (zoom <= ZOOM_MIN || zoom >= ZOOM_MAX) && 'text-foreground')}
        aria-label={`${label} zoom`}
      >
        {Math.round(zoom * 100)}%
      </output>
      <IconButton label="Reset zoom" onClick={onReset} disabled={isIdentity(transform)} className={large ? 'size-11' : 'size-7'}>
        <RotateCcw />
      </IconButton>
    </>
  );
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
export function ViewCell({ plane, idx, onIdxChange, expanded, onToggleExpand, highlight, hidden, phone, compact }: ViewCellProps) {
  const cfg = PLANES[plane];
  const color = PLANE_COLOR_CLASS[plane];
  // A hidden view (another one is expanded) loads nothing until shown again.
  const opening = useAtlas((s) => s.opening);
  const slice = useSlice(plane, idx, !hidden && !opening);
  const mask = useHighlight(plane, idx, highlight, !hidden);

  const [draft, setDraft] = useSliderDraft(idx);

  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);
  const data = slice.data;
  const imgRef = useRef<HTMLImageElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);

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
  const box = useBoxSize(view.ref);
  // Slice pixels are voxels; the image is drawn `contain` inside the viewport less its 12px inset.
  const pxPerUm =
    data && box ? (Math.min((box.w - 24) / data.cols, (box.h - 24) / data.rows) * zoom) / ATLAS.voxelUm : null;
  // Zoomed in, show voxels as crisp squares rather than a blur.
  const crisp = zoom >= 2 && '[image-rendering:pixelated]';

  // Slice and overlay share one box and `object-contain`, so they always line up.
  const layer = 'absolute inset-3 block h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] object-contain select-none';

  return (
    <section aria-label={`${cfg.label} view`} hidden={hidden} className="@container flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      {!phone && (
      <header className="flex h-8 shrink-0 items-center gap-2.5 border-b border-border bg-surface pl-2.5 pr-1 @max-[200px]:gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold">
          <span aria-hidden className={cn('size-[9px] shrink-0 rounded-[2px]', color.bg)} />
          {/* Short of room the name shortens first; in a narrow view (a tablet) the swatch alone
              names the plane, so the slider and the buttons keep their room. */}
          <span className="truncate @max-[200px]:sr-only">{cfg.label}</span>
        </span>
        <Slider
          aria-label={`${cfg.label} slice`}
          className={cn('min-w-10 max-w-64 flex-1', color.text)}
          min={cfg.min}
          max={cfg.max}
          value={[draft]}
          onValueChange={([v]) => v !== undefined && setDraft(v)}
          onValueCommit={([v]) => v !== undefined && onIdxChange?.(v)}
        />
        <output className="min-w-8 font-mono text-[11.5px] text-foreground" aria-live="off" title={`Slice ${draft}; the slider moves ${cfg.axisTitle}`}>
          {draft}
        </output>
        <span className="ml-auto flex items-center gap-0.5">
          {/* In the strip, zoom controls appear once the slice is zoomed, leaving the slider room. */}
          {(!compact || !isIdentity(view.transform)) && (
            <ZoomControls
              label={cfg.label}
              transform={view.transform}
              compact={compact}
              onReset={() => {
                view.reset();
                // In the strip the controls disappear at 100%: keep keyboard focus nearby.
                if (compact) expandRef.current?.focus();
              }}
            />
          )}
          <IconButton ref={expandRef} label={expanded ? 'Show all views' : `Expand ${cfg.label.toLowerCase()} view`} onClick={onToggleExpand} className="size-7">
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </span>
      </header>
      )}

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
        {slice.status !== 'error' && <ScaleBar pxPerUm={pxPerUm} className="bottom-2 left-2.5" />}
        {phone && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-surface/85 pl-2.5 backdrop-blur">
            <ZoomControls label={cfg.label} transform={view.transform} onReset={view.reset} large />
          </span>
        )}
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

      {!phone && (
      <footer className="flex h-6 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border bg-surface px-2.5 font-mono text-[11px] text-subtle-foreground">
        <PointerReadout plane={plane} idx={data?.idx ?? idx} hover={hover} />
      </footer>
      )}
    </section>
  );
}

/** The atlas point under the pointer, in µm along the three standard axes. */
function PointerReadout({ plane, idx, hover }: { plane: Plane; idx: number; hover: { col: number; row: number } | null }) {
  const p = hover ? voxelToUm(plane, idx, hover.col, hover.row) : null;
  return (
    <>
      {(['ap', 'dv', 'ml'] as const).map((k) => (
        <span key={k}>
          {k.toUpperCase()} <span className="text-foreground">{p ? fmtUm(p[k]) : '—'}</span>
        </span>
      ))}
      <span>µm</span>
    </>
  );
}

/** An element's size, kept up to date as it resizes. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return size;
}
