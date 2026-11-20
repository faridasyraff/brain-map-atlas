import { useState, type CSSProperties } from 'react';
import { fmtUm } from '@/lib/atlasFacts';
import { slicesToUm } from '@/lib/coords';
import { PLANE_ORDER, type ViewId } from '@/lib/planes';
import { useAtlas } from '@/store/atlas';
import { useUi, type ViewLayout } from '@/store/ui';
import { ThreeDCell } from './ThreeDCell';
import { ViewCell } from './ViewCell';

// All four views are children of one grid, so switching layouts or expanding a
// view only moves them: the 3D scene and each view's zoom survive.
const AREAS: Record<ViewLayout, { template: string; rows: string; cols: string }> = {
  // The 3D stage over the three sections; the strip gets enough height to read a slice.
  stage: { template: '"three-d three-d three-d" "sagittal coronal transverse"', rows: 'minmax(0,55fr) minmax(0,45fr)', cols: 'repeat(3, minmax(0,1fr))' },
  // Four equal views, the neuroimaging convention.
  quad: { template: '"coronal sagittal" "transverse three-d"', rows: 'repeat(2, minmax(0,1fr))', cols: 'repeat(2, minmax(0,1fr))' },
};

/** The views: Stage (3D over a strip of sections) or Quad (four equal views),
 *  chosen in the top bar. "Expand" fills the area with one view. Below them,
 *  the point where the three sections cross, in µm. */
export function ViewsGrid() {
  const slices = useAtlas((s) => s.slices);
  const setSlice = useAtlas((s) => s.setSlice);
  const highlight = useAtlas((s) => s.selection?.highlight);
  const layout = useUi((s) => s.layout);
  const [expanded, setExpanded] = useState<ViewId | null>(null);
  const toggle = (id: ViewId) => setExpanded((cur) => (cur === id ? null : id));
  const shown = (id: ViewId) => expanded === null || expanded === id;

  const a = AREAS[layout];
  const grid: CSSProperties = expanded
    ? { gridTemplateAreas: `"${expanded}"`, gridTemplateRows: 'minmax(0,1fr)', gridTemplateColumns: 'minmax(0,1fr)' }
    : { gridTemplateAreas: a.template, gridTemplateRows: a.rows, gridTemplateColumns: a.cols };
  const point = slicesToUm(slices);

  return (
    <main aria-label="Atlas views" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-layout={layout} className="grid min-h-0 flex-1 gap-px bg-border" style={grid}>
        <div className="flex min-h-0 min-w-0" style={{ gridArea: 'three-d' }} hidden={!shown('three-d')}>
          <ThreeDCell hidden={!shown('three-d')} expanded={expanded === 'three-d'} onToggleExpand={() => toggle('three-d')} />
        </div>
        {PLANE_ORDER.map((plane) => (
          <div key={plane} className="flex min-h-0 min-w-0" style={{ gridArea: plane }} hidden={!shown(plane)}>
            <ViewCell
              hidden={!shown(plane)}
              plane={plane}
              idx={slices[plane]}
              onIdxChange={(idx) => setSlice(plane, idx)}
              expanded={expanded === plane}
              onToggleExpand={() => toggle(plane)}
              highlight={highlight}
              compact={!expanded}
            />
          </div>
        ))}
      </div>
      <div
        role="group"
        aria-label="Point where the three sections cross"
        className="flex h-6 shrink-0 items-center gap-5 overflow-hidden whitespace-nowrap border-t border-border px-3 font-mono text-[11px] text-subtle-foreground"
      >
        <span>
          AP <span className="text-foreground">{fmtUm(point.ap)}</span> µm
        </span>
        <span>
          DV <span className="text-foreground">{fmtUm(point.dv)}</span> µm
        </span>
        <span>
          ML <span className="text-foreground">{fmtUm(point.ml)}</span> µm
        </span>
      </div>
    </main>
  );
}
