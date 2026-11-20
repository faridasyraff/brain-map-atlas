import { Assistant } from '@/components/assistant/Assistant';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyTree } from '@/components/hierarchy/HierarchyTree';
import { Inspector } from '@/components/inspector/Inspector';
import { SavedPanel } from '@/components/library/SavedPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useUi, type PanelTab } from '@/store/ui';

/** The right-hand panel: Inspector / Saved over the assistant (on desktop the
 *  hierarchy is the index on the left). */
export function SidePanel() {
  return (
    <aside aria-label="Region details" className="flex w-[336px] shrink-0 flex-col border-l border-border bg-surface">
      <PanelTabs className="flex-[3_1_0]" withHierarchy={false} />
      <ErrorBoundary area="the assistant" className="border-t border-border p-5">
        <Assistant />
      </ErrorBoundary>
    </aside>
  );
}

/** Details / Hierarchy / Saved (the phone's details sheet; the desktop side panel leaves out Hierarchy). */
export function PanelTabs({ className, withHierarchy = true }: { className?: string; withHierarchy?: boolean }) {
  const stored = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const tab = !withHierarchy && stored === 'hierarchy' ? 'inspector' : stored;
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className={cn('flex min-h-0 flex-col', className)}>
      <TabsList aria-label="Panel sections">
        <TabsTrigger value="inspector">Details</TabsTrigger>
        {withHierarchy && <TabsTrigger value="hierarchy">Hierarchy</TabsTrigger>}
        <TabsTrigger value="saved">Saved</TabsTrigger>
      </TabsList>
      <TabsContent value="inspector">
        <ErrorBoundary area="the inspector">
          <Inspector />
        </ErrorBoundary>
      </TabsContent>
      {/* The tree manages its own scrolling (filter box stays put). */}
      {withHierarchy && (
        <TabsContent value="hierarchy" className="overflow-hidden">
          <ErrorBoundary area="the hierarchy">
            <HierarchyTree />
          </ErrorBoundary>
        </TabsContent>
      )}
      <TabsContent value="saved">
        <ErrorBoundary area="your saved regions">
          <SavedPanel />
        </ErrorBoundary>
      </TabsContent>
    </Tabs>
  );
}
