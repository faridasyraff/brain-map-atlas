import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bookmark, BookmarkCheck, Link2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toLibraryItem, useLibrary } from '@/hooks/useLibrary';
import { useEnrichment } from '@/hooks/useEnrichment';
import { usePhoneLayout } from '@/hooks/useMediaQuery';
import { useRegionActions } from '@/hooks/useRegionActions';
import { getOntology, getRegion, HIERARCHY_LEVELS, searchRegions, type RegionDetails as Details } from '@/lib/api';
import { ATLAS, CITATION, countStructures, fmtUm } from '@/lib/atlasFacts';
import { openSearchResult } from '@/lib/navigate';
import { isBlank, isHexColor, type Selection } from '@/lib/selection';
import { cn, modKey } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';

/** The details panel: the selected region (identity, hierarchy, summary,
 *  keywords, related regions), then the reference atlas and its citation. */
export function Inspector() {
  const selection = useAtlas((s) => s.selection);
  const phone = usePhoneLayout();
  return (
    <div>
      {selection ? (
        <RegionDetails key={`${selection.kind}:${selection.ref}`} selection={selection} />
      ) : (
        <div className="border-b border-border px-4 py-4">
          <h2 className="text-[14px] font-semibold">No region selected</h2>
          <p className="mt-1 max-w-[48ch] text-[12.5px] leading-relaxed text-muted-foreground max-md:text-sm">
            {phone ? (
              'Tap a point in any section, choose a structure in the Hierarchy tab, or search for one.'
            ) : (
              <>
                Click a point in any section, choose a row in the structure tree, or search with <kbd className="keycap">{modKey()}</kbd>{' '}
                <kbd className="keycap">K</kbd>.
              </>
            )}
          </p>
        </div>
      )}
      <ReferenceAtlas />
    </div>
  );
}

function RegionDetails({ selection }: { selection: Selection }) {
  const details = useQuery({
    queryKey: ['region', selection.pidx],
    queryFn: ({ signal }) => getRegion(selection.pidx!, signal),
    enabled: selection.pidx !== null,
    staleTime: Infinity,
  });
  const enrich = useEnrichment(selection);
  const color = selection.color ?? 'var(--color-border-strong)';

  return (
    <article aria-label={`${selection.label} details`}>
      <div className="border-b border-border px-4 py-4">
        <p className="flex items-center gap-2 text-[11.5px]">
          <span aria-hidden className="size-3 shrink-0 rounded-[3px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]" style={{ background: color }} />
          {!isBlank(selection.acronym) && (
            <abbr title="Acronym" className="font-mono font-bold text-foreground no-underline">
              {selection.acronym}
            </abbr>
          )}
          {selection.structureId !== undefined && <span className="font-mono text-subtle-foreground">ID {selection.structureId}</span>}
          {selection.kind === 'group' && (
            <span className="text-subtle-foreground">Group{selection.memberCount ? ` of ${selection.memberCount} regions` : ''}</span>
          )}
        </p>
        <h2 className="mt-1.5 text-[19px] font-semibold leading-tight tracking-[-0.005em]">{selection.label}</h2>

        <Actions selection={selection} />
      </div>

      {details.data && <Ladder details={details.data} />}

      <Section title="Summary">
        {enrich.isLoading ? (
          <Muted>Loading summary…</Muted>
        ) : enrich.data?.region_summary ? (
          <p className="max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">{enrich.data.region_summary}</p>
        ) : (
          <Muted>{enrich.data?.ai_note || 'No summary for this region yet.'}</Muted>
        )}
      </Section>

      <Section title="Keywords">
        {enrich.data?.functional_keywords.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            {[...enrich.data.functional_keywords]
              .sort((a, b) => b.weight - a.weight)
              .map((k) => (
                <li key={k.term}>{k.term}</li>
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
                className="min-h-7 rounded-md border border-border-strong px-2.5 py-1 text-left text-xs pressable hover:bg-hover max-md:min-h-11"
              >
                {r.label}
              </button>
            ))}
          </div>
        ) : (
          <Muted>{enrich.isLoading ? 'Loading related regions…' : 'No related regions found.'}</Muted>
        )}
      </Section>
    </article>
  );
}

/** The region's place in the Allen hierarchy, one level per line, each in its own colour. */
function Ladder({ details }: { details: Details }) {
  const seen = new Set<string>();
  const levels = HIERARCHY_LEVELS.flatMap((l) => {
    const name = details[l];
    if (isBlank(name) || seen.has(name!)) return [];
    seen.add(name!);
    return [{ name: name!, acronym: details[`${l}_acronym`], color: details[`${l}_color`] }];
  });
  if (levels.length < 2) return null;
  return (
    <Section title="Hierarchy">
      <ol aria-label="Position in the hierarchy" className="grid gap-1 text-[12.5px]">
        {levels.map((lv, i) => {
          const last = i === levels.length - 1;
          return (
            <li key={lv.name} className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: i * 12 }} aria-current={last ? 'location' : undefined}>
              <span
                aria-hidden
                className="size-[9px] shrink-0 rounded-[2px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]"
                style={{ background: isHexColor(lv.color) ? lv.color : 'var(--color-border-strong)' }}
              />
              {!isBlank(lv.acronym) && <b className="shrink-0 font-mono text-[11.5px] font-bold text-foreground">{lv.acronym}</b>}
              <span className={cn('min-w-0 truncate', last ? 'font-medium text-foreground' : 'text-muted-foreground')}>{lv.name}</span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/** Save (with a private note), Copy link and Ask. */
function Actions({ selection }: { selection: Selection }) {
  const { saved, signedIn, pending, toggleSave, copyLink } = useRegionActions(selection);
  const phone = usePhoneLayout(); // the phone sheet has its own Ask
  return (
    <>
      <div className="mt-3 flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          className="h-7 px-2.5 text-[12.5px] max-md:h-11"
          aria-pressed={!!saved}
          title={signedIn ? undefined : 'Sign in to save regions and keep notes'}
          disabled={pending}
          onClick={toggleSave}
        >
          {saved ? <BookmarkCheck /> : <Bookmark />}
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button size="sm" className="h-7 px-2.5 text-[12.5px] max-md:h-11" onClick={copyLink}>
          <Link2 />
          Copy link
        </Button>
        {!phone && (
          <Button size="sm" className="h-7 px-2.5 text-[12.5px]" onClick={() => document.getElementById('assistant-input')?.focus()}>
            <MessageSquare />
            Ask
          </Button>
        )}
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
    <div className="mt-3">
      <label htmlFor="region-note" className="mb-1 block text-xs font-medium text-muted-foreground">
        Your note (private)
      </label>
      <textarea
        id="region-note"
        rows={3}
        maxLength={5000}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Your note"
        className="w-full resize-y rounded-md border border-border-strong bg-background px-2.5 py-2 text-[13px] placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:outline-none"
      />
      <p aria-live="polite" className="mt-1 min-h-4 text-xs text-subtle-foreground">
        {{ idle: '', dirty: 'Unsaved changes', saved: 'Note saved', error: 'Could not save the note' }[state]}
      </p>
    </div>
  );
}

/** What the atlas is: release, size, resolution and extent, and how to cite it. */
function ReferenceAtlas() {
  const ontology = useQuery({ queryKey: ['ontology'], queryFn: getOntology, staleTime: Infinity });
  const count = ontology.data ? countStructures(ontology.data) : null;
  const { ap, dv, ml } = ATLAS.extentUm;
  const rows: [string, React.ReactNode][] = [
    ['Atlas', ATLAS.name],
    ['Release', ATLAS.annotation],
    ...(count ? [['Structures', <span className="font-mono">{fmtUm(count)}</span>] as [string, React.ReactNode]] : []),
    ['Voxel', <span className="font-mono">{ATLAS.voxelUm} µm, isotropic</span>],
    ['Extent', <span className="font-mono">{fmtUm(ap)} × {fmtUm(dv)} × {fmtUm(ml)} µm</span>],
    ['Axes', 'Anterior–posterior, dorsal–ventral, medial–lateral'],
  ];
  return (
    <>
      <Section title="Reference atlas">
        <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-subtle-foreground">{k}</dt>
              <dd className="min-w-0 text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Citation">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {CITATION.text}{' '}
          <a className="text-link underline-offset-2 hover:underline" href={`https://doi.org/${CITATION.doi}`} target="_blank" rel="noreferrer">
            doi:{CITATION.doi}
          </a>
        </p>
        <p className="mt-2 text-[12px] text-subtle-foreground">
          Atlas data and images: Allen Institute for Brain Science,{' '}
          <a className="text-link underline-offset-2 hover:underline" href={ATLAS.dataUrl} target="_blank" rel="noreferrer">
            atlas.brain-map.org
          </a>
        </p>
      </Section>
    </>
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
    <section className="border-b border-border px-4 py-3">
      <h3 className="panel-label mb-2.5">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-subtle-foreground">{children}</p>;
}
