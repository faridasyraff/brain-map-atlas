import { useState } from 'react';
import { PLANE_ORDER, type Plane, type ViewId } from '@/lib/planes';
import { cn } from '@/lib/utils';
import { ThreeDCell } from './ThreeDCell';
import { ViewCell } from './ViewCell';

interface ViewsGridProps {
  slices: Record<Plane, number>;
  onSliceChange: (plane: Plane, idx: number) => void;
}

/** The 2×2 grid of views. "Expand" shows one view alone; the same button brings the grid back. */
export function ViewsGrid({ slices, onSliceChange }: ViewsGridProps) {
  const [expanded, setExpanded] = useState<ViewId | null>(null);
  const toggle = (id: ViewId) => setExpanded((cur) => (cur === id ? null : id));
  const shown = (id: ViewId) => expanded === null || expanded === id;

  return (
    <main
      aria-label="Atlas views"
      className={cn(
        'grid min-h-0 min-w-0 flex-1 gap-px bg-border',
        expanded ? 'grid-cols-1 grid-rows-1' : 'grid-cols-2 grid-rows-2',
      )}
    >
      {PLANE_ORDER.filter(shown).map((plane) => (
        <ViewCell
          key={plane}
          plane={plane}
          idx={slices[plane]}
          onIdxChange={(idx) => onSliceChange(plane, idx)}
          expanded={expanded === plane}
          onToggleExpand={() => toggle(plane)}
        />
      ))}
      {shown('three-d') && <ThreeDCell expanded={expanded === 'three-d'} onToggleExpand={() => toggle('three-d')} />}
    </main>
  );
}
