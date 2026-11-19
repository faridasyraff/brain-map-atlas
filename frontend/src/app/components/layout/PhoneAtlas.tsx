import { useEffect, useRef, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Bookmark, BookmarkCheck, ChevronUp, CircleUser, Link2, LogIn, Minus, Plus, Search } from 'lucide-react';
import { Assistant } from '@/components/assistant/Assistant';
import { ThreeDCell } from '@/components/atlas/ThreeDCell';
import { ViewCell } from '@/components/atlas/ViewCell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { BrandMark } from '@/components/layout/BrandMark';
import { PanelTabs } from '@/components/layout/SidePanel';
import { SearchBox } from '@/components/search/SearchBox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Slider } from '@/components/ui/slider';
import { useAuthActions, useMe } from '@/hooks/useAuth';
import { useEnrichment } from '@/hooks/useEnrichment';
import { useRegionActions } from '@/hooks/useRegionActions';
import { useSliderDraft } from '@/hooks/useSliderDraft';
import { PLANE_COLOR_CLASS, PLANE_ORDER, PLANES, type Plane, type ViewId } from '@/lib/planes';
import { isBlank, type Selection } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';
import { useUi } from '@/store/ui';

const VIEW_LABEL: Record<ViewId, string> = { sagittal: 'Sagittal', coronal: 'Coronal', transverse: 'Transverse', 'three-d': '3D' };
const VIEWS: ViewId[] = [...PLANE_ORDER, 'three-d'];

/** A panel that slides up from the bottom (a full-width dialog). */
const SHEET =
  'left-0 right-0 top-auto bottom-0 flex h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-b-none rounded-t-xl p-0';

/**
 * The phone layout: one view at a time (tabs), its slice stepper, and a sheet
 * for the selected region. Every view stays mounted, so switching tabs keeps
 * the 3D scene and each view's zoom; hidden views load nothing.
 */
export function PhoneAtlas() {
  const [view, setView] = useState<ViewId>('coronal');
  // 3D (three.js, meshes, a render loop) loads the first time its tab is opened.
  const [opened3d, setOpened3d] = useState(false);
  const choose = (v: ViewId) => {
    setView(v);
    if (v === 'three-d') setOpened3d(true);
  };
  const slices = useAtlas((s) => s.slices);
  const highlight = useAtlas((s) => s.selection?.highlight);

  return (
    <div className="flex h-full flex-col">
      <PhoneHeader />
      <TabsPrimitive.Root asChild value={view} onValueChange={(v) => choose(v as ViewId)}>
        <main aria-label="Atlas views" className="flex min-h-0 flex-1 flex-col">
          <TabsPrimitive.List
            aria-label="View"
            className="mx-4 mt-3 grid shrink-0 grid-cols-4 gap-1 rounded-lg border border-border bg-surface p-1"
          >
            {VIEWS.map((id) => (
              <TabsPrimitive.Trigger
                key={id}
                value={id}
                // The active tab is underlined in its plane's color.
                style={{ '--tab-accent': `var(--color-plane-${id === 'three-d' ? '3d' : id})` } as React.CSSProperties}
                className={cn(
                  'h-9 rounded-[7px] text-[13px] font-medium text-muted-foreground transition-colors',
                  'data-[state=active]:bg-hover data-[state=active]:font-semibold data-[state=active]:text-foreground',
                  'data-[state=active]:shadow-[inset_0_-2px_0_var(--tab-accent)]',
                )}
              >
                {VIEW_LABEL[id]}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>

          <ErrorBoundary area="the atlas views" className="mt-3 flex-1 p-4">
            {PLANE_ORDER.map((plane) => (
              <TabsPrimitive.Content key={plane} value={plane} forceMount className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
                <ViewCell phone plane={plane} idx={slices[plane]} highlight={highlight} hidden={view !== plane} />
                <SliceStepper plane={plane} />
              </TabsPrimitive.Content>
            ))}
            <TabsPrimitive.Content value="three-d" forceMount className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              {opened3d && <ThreeDCell hidden={view !== 'three-d'} />}
            </TabsPrimitive.Content>
          </ErrorBoundary>
        </main>
      </TabsPrimitive.Root>
      <RegionSheet />
    </div>
  );
}

function PhoneHeader() {
  const [searching, setSearching] = useState(false);
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface pl-4 pr-2">
      <BrandMark size={22} className="mr-auto text-base" />
      <IconButton label="Find a region" className="size-11 [&_svg]:size-5" onClick={() => setSearching(true)}>
        <Search />
      </IconButton>
      <AccountButton />
      <Dialog open={searching} onOpenChange={setSearching}>
        <DialogContent aria-describedby={undefined} className="top-3 max-w-none translate-y-0 p-4 pt-12">
          <DialogTitle className="sr-only">Find a region</DialogTitle>
          <SearchBox inDialog onChosen={() => setSearching(false)} />
        </DialogContent>
      </Dialog>
    </header>
  );
}

/** Signed out: opens sign-in. Signed in: who you are, and Sign out. */
function AccountButton() {
  const { data: user } = useMe();
  const { signOut } = useAuthActions();
  const openSignIn = useUi((s) => s.openSignIn);
  const [open, setOpen] = useState(false);

  if (!user) {
    return (
      <IconButton label="Sign in" className="size-11 [&_svg]:size-5" onClick={() => openSignIn('signin')}>
        <LogIn />
      </IconButton>
    );
  }
  return (
    <>
      <IconButton label="Account" className="size-11 [&_svg]:size-5" onClick={() => setOpen(true)}>
        <CircleUser />
      </IconButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Your account</DialogTitle>
          <p className="mt-2 break-all text-sm text-muted-foreground">
            Signed in as <span className="text-foreground">{user.email}</span>
            {user.is_admin && ' (admin)'}
          </p>
          <Button className="mt-5 h-11 w-full" onClick={() => signOut.mutate(undefined, { onSuccess: () => setOpen(false) })}>
            Sign out
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** −, slider, +, and the slice number, under the active 2D view. */
function SliceStepper({ plane }: { plane: Plane }) {
  const cfg = PLANES[plane];
  const idx = useAtlas((s) => s.slices[plane]);
  const setSlice = useAtlas((s) => s.setSlice);
  const [draft, setDraft] = useSliderDraft(idx);
  const step = (d: number) => setSlice(plane, idx + d); // the store clamps
  const name = cfg.label.toLowerCase();

  return (
    <div className="flex shrink-0 items-center gap-2.5 px-4 py-3">
      <IconButton label={`Previous ${name} slice`} variant="secondary" className="size-11" disabled={idx <= cfg.min} onClick={() => step(-1)}>
        <Minus />
      </IconButton>
      <Slider
        size="lg"
        aria-label={`${cfg.label} slice`}
        className={cn('min-w-0 flex-1', PLANE_COLOR_CLASS[plane].text)}
        min={cfg.min}
        max={cfg.max}
        value={[draft]}
        onValueChange={([v]) => v !== undefined && setDraft(v)}
        onValueCommit={([v]) => v !== undefined && setSlice(plane, v)}
      />
      <IconButton label={`Next ${name} slice`} variant="secondary" className="size-11" disabled={idx >= cfg.max} onClick={() => step(1)}>
        <Plus />
      </IconButton>
      <output aria-label={`${cfg.label} slice number`} className="min-w-10 text-right text-[15px] font-semibold">
        {draft}
      </output>
    </div>
  );
}

/** The selected region at the bottom: name, summary, Save / Copy link / Ask, and the full details. */
function RegionSheet() {
  const selection = useAtlas((s) => s.selection);
  const setTab = useUi((s) => s.setTab);
  const [sheet, setSheet] = useState<'details' | 'ask' | null>(null);
  const showDetails = () => setSheet('details');

  // Opening a region from the details (hierarchy, saved, related regions)
  // closes the sheet, so you see the views move to it.
  const key = selection ? `${selection.kind}:${selection.ref}` : '';
  const lastKey = useRef(key);
  useEffect(() => {
    if (key !== lastKey.current && sheet === 'details') setSheet(null);
    lastKey.current = key;
  }, [key, sheet]);

  return (
    <section
      aria-label="Selected region"
      className="shrink-0 rounded-t-xl border-t border-border bg-surface shadow-[0_-8px_24px_rgb(0_0_0/0.35)]"
    >
      <button type="button" aria-label="Show region details" onClick={showDetails} className="flex h-6 w-full justify-center pt-2">
        <span aria-hidden className="h-1 w-10 rounded-full bg-border-strong" />
      </button>
      {selection ? (
        <SheetSummary key={`${selection.kind}:${selection.ref}`} selection={selection} onDetails={showDetails} onAsk={() => setSheet('ask')} />
      ) : (
        <div className="px-4 pb-5 pt-1">
          <h2 className="text-base font-semibold">No region selected</h2>
          <p className="mt-1 text-sm text-muted-foreground">Tap the slice to identify a region, or search for one.</p>
          <Button
            className="mt-3 h-11 w-full"
            onClick={() => {
              setTab('hierarchy');
              showDetails();
            }}
          >
            Browse the hierarchy
          </Button>
        </div>
      )}

      <Dialog open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <DialogContent aria-describedby={undefined} className={SHEET}>
          <DialogTitle className="sr-only">{sheet === 'ask' ? 'Ask about this region' : 'Region details'}</DialogTitle>
          {sheet === 'ask' ? (
            <ErrorBoundary area="the assistant" className="min-h-0 flex-1 overflow-y-auto p-4 pt-12">
              <Assistant />
            </ErrorBoundary>
          ) : (
            <PanelTabs className="flex-1 pr-10" />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SheetSummary({ selection, onDetails, onAsk }: { selection: Selection; onDetails: () => void; onAsk: () => void }) {
  const enrich = useEnrichment(selection);
  const { saved, pending, toggleSave, copyLink } = useRegionActions(selection);
  const summary = enrich.data?.region_summary;
  const hasAcronym = !isBlank(selection.acronym);

  return (
    <div className="px-4 pb-5">
      <div className="flex items-start gap-3 pt-1">
        <span
          aria-hidden
          className="mt-0.5 size-8 shrink-0 rounded-lg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]"
          style={{ background: selection.color ?? 'var(--color-border-strong)' }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{selection.label}</h2>
          {hasAcronym && (
            <abbr title="Acronym" className="mt-1.5 inline-block rounded-sm border border-border-strong px-2 py-0.5 text-xs font-semibold no-underline">
              {selection.acronym}
            </abbr>
          )}
        </div>
        <IconButton label="Show region details" className="-mr-2 -mt-2 size-11 [&_svg]:size-5" onClick={onDetails}>
          <ChevronUp />
        </IconButton>
      </div>
      <p className={cn('mt-3 line-clamp-3 text-sm leading-relaxed', summary ? 'text-foreground/85' : 'text-subtle-foreground')}>
        {enrich.isLoading ? 'Loading summary…' : summary || enrich.data?.ai_note || 'No summary for this region yet.'}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button className="h-11" aria-pressed={!!saved} disabled={pending} onClick={toggleSave}>
          {saved ? <BookmarkCheck /> : <Bookmark />}
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button className="h-11" onClick={copyLink}>
          <Link2 />
          Copy link
        </Button>
        <Button variant="primary" className="h-11" onClick={onAsk}>
          Ask
        </Button>
      </div>
    </div>
  );
}
