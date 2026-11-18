import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Slider } from '@/components/ui/slider';
import { useSlice } from '@/hooks/useSlice';
import { PLANE_COLOR_CLASS, PLANES, type Plane } from '@/lib/planes';
import { cn } from '@/lib/utils';

interface ViewCellProps {
  plane: Plane;
  idx: number;
  onIdxChange: (idx: number) => void;
  expanded: boolean;
  onToggleExpand: () => void;
}

/** One 2D slice view: header (name, slice slider, actions), the slice image, and a coordinate strip. */
export function ViewCell({ plane, idx, onIdxChange, expanded, onToggleExpand }: ViewCellProps) {
  const cfg = PLANES[plane];
  const color = PLANE_COLOR_CLASS[plane];
  const slice = useSlice(plane, idx);

  // While dragging, the number follows the thumb; the image only reloads on
  // release (onValueCommit), like the current app — no request per pixel.
  const [draft, setDraft] = useState(idx);
  useEffect(() => setDraft(idx), [idx]);

  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);
  const data = slice.data;

  function trackPointer(e: React.PointerEvent<HTMLImageElement>) {
    if (!data) return;
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * data.cols);
    const row = Math.floor(((e.clientY - r.top) / r.height) * data.rows);
    setHover(col >= 0 && row >= 0 && col < data.cols && row < data.rows ? { col, row } : null);
  }

  return (
    <section aria-label={`${cfg.label} view`} className="flex min-h-0 min-w-0 flex-col bg-canvas">
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
        <span className="ml-auto flex gap-0.5">
          <IconButton label={expanded ? 'Show all views' : `Expand ${cfg.label.toLowerCase()} view`} onClick={onToggleExpand}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </span>
      </header>

      {/* flex (not grid): a flex item's height is definite, so the image's
          max-h-full can resolve against it and the slice never overflows
          onto the coordinate strip below. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        {data && (
          <img
            src={data.image}
            alt={`${cfg.label} slice ${data.idx}`}
            draggable={false}
            onPointerMove={trackPointer}
            onPointerLeave={() => setHover(null)}
            className={cn(
              'block max-h-full max-w-full select-none object-contain transition-opacity',
              slice.status === 'loading' && 'opacity-40',
            )}
          />
        )}
        {slice.status === 'loading' && !data && (
          <p role="status" className="text-xs text-muted-foreground">
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
