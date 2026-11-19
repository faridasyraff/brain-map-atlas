import { useState } from 'react';
import { PLANE_ORDER, type ViewId } from '@/lib/planes';
import { cn } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';
import { ThreeDCell } from './ThreeDCell';
import { ViewCell } from './ViewCell';

/** The workbench: the 3D brain on the stage, the three slices in a strip
 *  below it. "Expand" fills the stage with one view; the same button brings
 *  the workbench back. */
export function ViewsGrid() {
  const slices = useAtlas((s) => s.slices);
  const setSlice = useAtlas((s) => s.setSlice);
  const highlight = useAtlas((s) => s.selection?.highlight);
  const [expanded, setExpanded] = useState<ViewId | null>(null);
  const toggle = (id: ViewId) => setExpanded((cur) => (cur === id ? null : id));
  const shown = (id: ViewId) => expanded === null || expanded === id;

  return (
    <main aria-label="Atlas views" className="flex min-h-0 min-w-0 flex-1 flex-col gap-px bg-border">
      {/* Every view stays mounted (hidden when another is expanded), so the 3D
          scene and each view's zoom survive expanding and collapsing. */}
      <ThreeDCell hidden={!shown('three-d')} expanded={expanded === 'three-d'} onToggleExpand={() => toggle('three-d')} />
      <div
        hidden={expanded === 'three-d'}
        className={cn('grid min-h-0 gap-px', expanded ? 'flex-1 grid-cols-1' : 'h-[38%] shrink-0 grid-cols-3')}
      >
        {PLANE_ORDER.map((plane) => (
          <ViewCell
            key={plane}
            hidden={!shown(plane)}
            plane={plane}
            idx={slices[plane]}
            onIdxChange={(idx) => setSlice(plane, idx)}
            expanded={expanded === plane}
            onToggleExpand={() => toggle(plane)}
            highlight={highlight}
            compact={!expanded}
          />
        ))}
      </div>
    </main>
  );
}
