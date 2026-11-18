import { Maximize2, Minimize2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from '@/components/ui/button';

interface ThreeDCellProps {
  expanded: boolean;
  onToggleExpand: () => void;
}

/** The 3D view's frame. The Three.js viewer itself moves in during stage 4
 *  of the migration; until then this links to the current atlas. */
export function ThreeDCell({ expanded, onToggleExpand }: ThreeDCellProps) {
  return (
    <section aria-label="3D view" className="flex min-h-0 min-w-0 flex-col bg-[#0b0d10]">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3.5 pr-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="size-2 rounded-[2px] bg-plane-3d" />
          3D
        </span>
        <span className="ml-auto flex gap-0.5">
          <IconButton label={expanded ? 'Show all views' : 'Expand 3D view'} onClick={onToggleExpand}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </span>
      </header>
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div>
          <p className="text-sm text-muted-foreground">The 3D viewer arrives in the next stage.</p>
          <Button asChild variant="secondary" size="sm" className="mt-3">
            <a href="/app">Use it in the current atlas</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
