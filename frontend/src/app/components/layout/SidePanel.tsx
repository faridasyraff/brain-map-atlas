import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** The right-hand panel: Inspector / Hierarchy / Saved tabs over the
 *  assistant. Structure only for now — each tab's contents move over in
 *  stage 3 of the migration. */
export function SidePanel() {
  return (
    <aside aria-label="Region details" className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
      <Tabs defaultValue="inspector" className="flex min-h-0 flex-[3_1_0] flex-col">
        <TabsList aria-label="Panel sections">
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
          <TabsTrigger value="hierarchy">Hierarchy</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>
        <TabsContent value="inspector" className="p-5">
          <EmptyState title="No region selected" body="Click any slice to identify a region, or search for one." />
        </TabsContent>
        <TabsContent value="hierarchy" className="p-5">
          <EmptyState title="Allen CCFv3 hierarchy" body="The browsable structure tree moves here next." />
        </TabsContent>
        <TabsContent value="saved" className="p-5">
          <EmptyState title="Saved regions" body="Sign in to save regions, add notes, and see what you viewed recently." />
        </TabsContent>
      </Tabs>

      <section aria-label="Assistant" className="flex min-h-0 flex-[2_1_0] flex-col border-t border-border">
        <h2 className="px-5 pb-2 pt-3 text-sm font-semibold">Assistant</h2>
        <p className="px-5 text-sm text-muted-foreground">Ask about the selected region. Coming over with the inspector.</p>
      </section>
    </aside>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-[48ch] text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
