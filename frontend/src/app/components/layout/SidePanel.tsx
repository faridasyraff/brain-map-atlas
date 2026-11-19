import { Assistant } from '@/components/assistant/Assistant';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyTree } from '@/components/hierarchy/HierarchyTree';
import { Inspector } from '@/components/inspector/Inspector';
import { SavedPanel } from '@/components/library/SavedPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUi, type PanelTab } from '@/store/ui';

/** The right-hand panel: Inspector / Hierarchy / Saved tabs over the assistant. */
export function SidePanel() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  return (
    <aside aria-label="Region details" className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex min-h-0 flex-[3_1_0] flex-col">
        <TabsList aria-label="Panel sections">
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
          <TabsTrigger value="hierarchy">Hierarchy</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>
        <TabsContent value="inspector">
          <ErrorBoundary area="the inspector">
            <Inspector />
          </ErrorBoundary>
        </TabsContent>
        {/* The tree manages its own scrolling (filter box stays put). */}
        <TabsContent value="hierarchy" className="overflow-hidden">
          <ErrorBoundary area="the hierarchy">
            <HierarchyTree />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="saved">
          <ErrorBoundary area="your saved regions">
            <SavedPanel />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
      <ErrorBoundary area="the assistant" className="border-t border-border p-5">
        <Assistant />
      </ErrorBoundary>
    </aside>
  );
}
