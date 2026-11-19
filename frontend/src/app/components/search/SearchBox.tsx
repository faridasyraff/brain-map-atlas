import { useEffect, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { searchRegions, type SearchResult } from '@/lib/api';
import { openSearchResult } from '@/lib/navigate';
import { isHexColor } from '@/lib/selection';
import { cn } from '@/lib/utils';

const MAX_SHOWN = 30;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Region search: a combobox over /api/search (single regions and groups). */
export function SearchBox({ inDialog, onChosen }: { inDialog?: boolean; onChosen?: () => void } = {}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = useDebounced(text.trim(), 200);
  const listId = useId();

  const { data, isFetching, isError, isPlaceholderData } = useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => searchRegions(q, 50, signal),
    enabled: q.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData, // keep the old list up while typing (no flicker)…
  });
  const results = (q ? (data ?? []) : []).slice(0, MAX_SHOWN);
  // …but those are results for an EARLIER query until the new ones arrive.
  const stale = text.trim() !== q || isPlaceholderData;
  const pending = stale || isFetching;
  const showList = open && text.trim().length > 0;

  useEffect(() => {
    setActive(-1);
  }, [q]);

  async function choose(r: SearchResult | undefined) {
    if (!r) return;
    setOpen(false);
    setText('');
    onChosen?.();
    await openSearchResult(r);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (!results.length) return;
      setActive((i) => (e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // The list still shows an earlier query's results (debounce or fetch
      // not caught up): search for exactly what's typed and open its top hit,
      // rather than opening a stale result.
      if (stale) {
        searchRegions(text.trim(), 50).then((r) => choose(r[0]), () => {});
        return;
      }
      void choose(results[Math.max(0, active)]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const status = !text.trim()
    ? ''
    : pending && !results.length
      ? 'Searching…'
      : isError
        ? 'Search failed. Is the backend running?'
        : results.length
          ? `${results.length}${data && data.length > MAX_SHOWN ? '+' : ''} results`
          : `No regions match "${text.trim()}"`;

  return (
    <div role="search" className={cn('relative flex-1', !inDialog && 'max-w-xl')}>
      <label htmlFor="region-search" className="sr-only">
        Find a region
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id="region-search"
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Find a region by name or acronym"
        className={cn('pl-9', inDialog ? 'h-11 pr-3' : 'pr-10')}
        autoFocus={inDialog}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {!inDialog && (
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border-strong px-1.5 text-xs text-muted-foreground">
        /
      </kbd>
      )}

      {showList && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md bg-raised shadow-menu">
          <p aria-live="polite" className="px-3 pb-1 pt-2 text-xs text-subtle-foreground">
            {status}
          </p>
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching regions"
            aria-busy={stale}
            className={cn('max-h-[min(420px,60vh)] overflow-y-auto p-1 transition-opacity', stale && 'opacity-50')}
          >
            {results.map((r, i) => (
              <li
                key={`${r.is_group ? 'g' : 'r'}-${r.group_level ?? ''}-${r.parcellation_index}-${r.matched_label}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown (not click) so it fires before the input's blur closes the list
                onMouseDown={(e) => {
                  e.preventDefault();
                  void choose(r);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 py-1',
                  i === active && 'bg-hover shadow-[inset_2px_0_0_var(--color-ring)]',
                  r.no_voxels && 'opacity-55',
                )}
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: isHexColor(r.structure_color) ? r.structure_color : 'var(--color-border-strong)' }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {r.matched_label}
                    {r.matched_acronym && <span className="ml-2 text-xs text-subtle-foreground">{r.matched_acronym}</span>}
                  </span>
                  {r.is_group && <span className="text-xs text-muted-foreground">{r.member_count} regions</span>}
                  {r.no_voxels && <span className="text-xs text-warning">Not shown in the 2D atlas</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
