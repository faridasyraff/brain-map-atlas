import { useState } from 'react';
import { ViewsGrid } from '@/components/atlas/ViewsGrid';
import { SidePanel } from '@/components/layout/SidePanel';
import { TopBar } from '@/components/layout/TopBar';
import { TooltipProvider } from '@/components/ui/icon-button';
import { PLANES, type Plane } from '@/lib/planes';

const initialSlices = (): Record<Plane, number> => ({
  sagittal: PLANES.sagittal.initial,
  coronal: PLANES.coronal.initial,
  transverse: PLANES.transverse.initial,
});

/** The atlas app shell: top bar, the four views, and the side panel. */
export function App() {
  const [slices, setSlices] = useState(initialSlices);
  const [panelOpen, setPanelOpen] = useState(true);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <TopBar panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((o) => !o)} />
        <div className="flex min-h-0 flex-1">
          <ViewsGrid slices={slices} onSliceChange={(plane, idx) => setSlices((s) => ({ ...s, [plane]: idx }))} />
          {panelOpen && <SidePanel />}
        </div>
      </div>
    </TooltipProvider>
  );
}
