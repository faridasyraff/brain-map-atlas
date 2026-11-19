import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bookmark, BookmarkCheck, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toLibraryItem, useLibrary } from '@/hooks/useLibrary';
import { getEnrichment, getRegion, HIERARCHY_LEVELS, searchRegions } from '@/lib/api';
import { openSearchResult } from '@/lib/navigate';
import type { Selection } from '@/lib/selection';
import { useAtlas } from '@/store/atlas';
import { useUi } from '@/store/ui';

const blank = (v: unknown) => !v || v === '—' || v === '--' || v === 'nan';

/** Details of the selected region: identity, hierarchy, summary, keywords, related regions. */
export function Inspector() {
  const selection = useAtlas((s) => s.selection);
  if (!selection) {
    return (
      <div className="p-5">
        <h2 className="text-sm font-semibold">No region selected</h2>
        <p className="mt-1 max-w-[48ch] text-sm text-muted-foreground">Search for a region above, or pick one from the Hierarchy tab.</p>
      </div>
    );
  }
  return <RegionDetails key={`${selection.kind}:${selection.ref}`} selection={selection} />;
}

function RegionDetails({ selection }: { selection: Selection }) {
  const details = useQuery({
    queryKey: ['region', selection.pidx],
    queryFn: ({ signal }) => getRegion(selection.pidx!, signal),
    enabled: selection.pidx !== null,
    staleTime: Infinity,
  });
  const enrich = useQuery({
    queryKey: ['enrich', selection.pidx, selection.label, selection.acronym],
    queryFn: ({ signal }) => getEnrichment({ pidx: selection.pidx, name: selection.label, acronym: selection.acronym }, signal),
    staleTime: 10 * 60_000,
  });

  const path = details.data
    ? HIERARCHY_LEVELS.map((l) => details.data[l]).filter((v, i, arr): v is string => !blank(v) && arr.indexOf(v) === i)
    : [];
  const color = selection.color ?? 'var(--color-border-strong)';

  return (
    <article aria-label={`${selection.label} details`}>
      <div aria-hidden className="h-1 transition-colors" style={{ background: color }} />
      <div className="p-5">
        <div className="flex items-start gap-3.5">
          <span aria-hidden className="mt-0.5 size-9 shrink-0 rounded-lg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" style={{ background: color }} />
          <div className="min-w-0">
            <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{selection.label}</h2>
            <p className="mt-2 flex flex-wrap items-center gap-2">
              {!blank(selection.acronym) && (
                <abbr title="Acronym" className="rounded-sm border border-border-strong px-2 py-0.5 text-xs font-semibold no-underline">
                  {selection.acronym}
                </abbr>
              )}
              {selection.kind === 'group' && (
                <span className="text-xs text-muted-foreground">
                  Group{selection.memberCount ? ` of ${selection.memberCount} regions` : ''}
                </span>
              )}
            </p>
          </div>
        </div>

        {path.length > 1 && (
          <ol aria-label="Position in the hierarchy" className="mt-4 flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-subtle-foreground">
            {path.map((p, i) => (
              <li key={p} className={i === path.length - 1 ? 'text-foreground' : undefined}>
                {p}
                {i < path.length - 1 && <span aria-hidden> /</span>}
              </li>
            ))}
          </ol>
        )}

        <Actions selection={selection} />

        <Section title="Summary">
          {enrich.isLoading ? (
            <Muted>Loading summary…</Muted>
          ) : enrich.data?.region_summary ? (
            <p className="max-w-[65ch] text-sm leading-relaxed">{enrich.data.region_summary}</p>
          ) : (
            <Muted>{enrich.data?.ai_note || 'No summary for this region yet.'}</Muted>
          )}
        </Section>

        <Section title="Keywords">
          {enrich.data?.functional_keywords.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {[...enrich.data.functional_keywords]
                .sort((a, b) => b.weight - a.weight)
                .map((k) => (
                  <li key={k.term} className="rounded-sm bg-raised px-2.5 py-1 text-xs">
                    {k.term}
                  </li>
                ))}
            </ul>
          ) : (
            <Muted>{enrich.isLoading ? 'Loading keywords…' : 'No keywords for this region yet.'}</Muted>
          )}
        </Section>

        <Section title="Related regions">
          {enrich.data?.related_regions.length ? (
            <div className="flex flex-wrap gap-1.5">
              {enrich.data.related_regions.map((r) => (
                <button
                  key={`${r.relationship}-${r.label}`}
                  type="button"
                  title={`${r.relationship}: ${r.label}`}
                  onClick={() => openRelated(r.query || r.label)}
                  className="h-7 rounded-full border border-border-strong px-3 text-xs transition-colors hover:bg-hover"
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : (
            <Muted>{enrich.isLoading ? 'Loading related regions…' : 'No related regions found.'}</Muted>
          )}
        </Section>
      </div>
    </article>
  );
}

/** Save (with a private note) and Copy link. */
function Actions({ selection }: { selection: Selection }) {
  const lib = useLibrary();
  const openSignIn = useUi((s) => s.openSignIn);
  const saved = lib.find(selection);

  async function toggleSave() {
    if (!lib.signedIn) {
      openSignIn('signin');
      return;
    }
    const item = toLibraryItem(selection);
    if (saved) await lib.unsave.mutateAsync(item).then(() => toast.success(`Removed ${selection.label} from saved regions`));
    else await lib.save.mutateAsync(item).then(() => toast.success(`Saved ${selection.label}`));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied', { description: 'It reopens this region at these slices.' });
    } catch {
      toast.error('Could not copy automatically', { description: 'Copy the address bar instead.' });
    }
  }

  return (
    <>
      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          aria-pressed={!!saved}
          title={lib.signedIn ? undefined : 'Sign in to save regions and keep notes'}
          disabled={lib.save.isPending || lib.unsave.isPending}
          onClick={() => void toggleSave().catch((e: Error) => toast.error('Could not update saved regions', { description: e.message }))}
        >
          {saved ? <BookmarkCheck /> : <Bookmark />}
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button size="sm" onClick={() => void copyLink()}>
          <Link2 />
          Copy link
        </Button>
      </div>
      {saved && <NoteEditor selection={selection} initial={saved.note} />}
    </>
  );
}

/** A private note on a saved region; saves itself shortly after typing stops. */
function NoteEditor({ selection, initial }: { selection: Selection; initial: string }) {
  const lib = useLibrary();
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'dirty' | 'saved' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function onChange(v: string) {
    setText(v);
    setState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lib.save.mutate({ ...toLibraryItem(selection), note: v }, { onSuccess: () => setState('saved'), onError: () => setState('error') });
    }, 700);
  }

  return (
    <div className="mt-4">
      <label htmlFor="region-note" className="mb-1 block text-xs font-medium text-muted-foreground">
        Your note (private)
      </label>
      <textarea
        id="region-note"
        rows={3}
        maxLength={5000}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Anything you want to remember about this region"
        className="w-full resize-y rounded-md border border-border-strong bg-background px-3 py-2 text-sm placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:outline-none"
      />
      <p aria-live="polite" className="mt-1 min-h-4 text-xs text-subtle-foreground">
        {{ idle: '', dirty: 'Unsaved changes', saved: 'Note saved', error: 'Could not save the note' }[state]}
      </p>
    </div>
  );
}

async function openRelated(name: string) {
  try {
    const results = await searchRegions(name, 10);
    const match = results.find((r) => !r.is_group) ?? results[0];
    if (!match) {
      toast.warning(`"${name}" was not found in the atlas`);
      return;
    }
    await openSearchResult(match);
  } catch (e) {
    toast.error('Could not open that region', { description: e instanceof Error ? e.message : String(e) });
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-[13px] font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-subtle-foreground">{children}</p>;
}
