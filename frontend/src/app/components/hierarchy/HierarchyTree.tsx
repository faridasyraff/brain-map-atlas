import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { ChevronRight, Eye, EyeOff, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { usePhoneLayout } from '@/hooks/useMediaQuery';
import { availableMeshesQuery, getOntology, type OntologyNode } from '@/lib/api';
import { openTreeNode } from '@/lib/navigate';
import { isHexColor } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { useAtlas } from '@/store/atlas';

interface Index {
  byId: Map<number, OntologyNode>;
  parentOf: Map<number, number | null>;
  all: OntologyNode[]; // depth-first order
}

function buildIndex(roots: OntologyNode[]): Index {
  const byId = new Map<number, OntologyNode>();
  const parentOf = new Map<number, number | null>();
  const all: OntologyNode[] = [];
  const walk = (n: OntologyNode, parent: number | null) => {
    byId.set(n.id, n);
    parentOf.set(n.id, parent);
    all.push(n);
    n.children.forEach((c) => walk(c, n.id));
  };
  roots.forEach((r) => walk(r, null));
  return { byId, parentOf, all };
}

/** The complete Allen CCFv3 structure tree, browsable and filterable. */
export function HierarchyTree() {
  const ontology = useQuery({ queryKey: ['ontology'], queryFn: getOntology, staleTime: Infinity });
  const index = useMemo(() => (ontology.data ? buildIndex(ontology.data) : null), [ontology.data]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState('');
  const selection = useAtlas((s) => s.selection);
  const surfaces = useAtlas((s) => s.surfaces);
  const toggleSurface = useAtlas((s) => s.toggleSurface);
  const meshes = useQuery(availableMeshesQuery);
  const eye: EyeProps = { meshes: meshes.data ?? null, shown: surfaces, onToggle: toggleSurface };

  // The node matching the current selection (by acronym, then name).
  const activeId = useMemo(() => {
    if (!index || !selection) return null;
    const a = selection.acronym.toLowerCase();
    const n = selection.label.toLowerCase();
    return (index.all.find((x) => x.acronym.toLowerCase() === a) ?? index.all.find((x) => x.name.toLowerCase() === n))?.id ?? null;
  }, [index, selection]);

  // Reveal the selected node: open its ancestors (and, on first load, the root
  // and its first child, so the major divisions show).
  useEffect(() => {
    if (!index) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const root = index.all[0];
      if (root && prev.size === 0) {
        next.add(root.id);
        if (root.children[0]) next.add(root.children[0].id);
      }
      for (let p = activeId !== null ? index.parentOf.get(activeId) : null; p != null; p = index.parentOf.get(p) ?? null) next.add(p);
      return next;
    });
  }, [index, activeId]);

  // Only the rows on screen are drawn: the tree has 1,327 structures, and
  // drawing every open row made expanding a big branch take ~0.5 s.
  const rows = useMemo(() => (index ? visibleRows(index.all.slice(0, 1), expanded) : []), [index, expanded]);
  const phone = usePhoneLayout();
  const scroller = useRef<HTMLDivElement>(null);
  // The row holding keyboard focus stays in the page even when scrolled away,
  // so focus isn't lost when it would otherwise be unmounted.
  const focused = useRef<number | null>(null);
  const rangeExtractor = useCallback((range: Range) => {
    const base = defaultRangeExtractor(range);
    const f = focused.current;
    return f === null || f >= range.count || base.includes(f) ? base : [...base, f].sort((a, b) => a - b);
  }, []);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => (phone ? 44 : 24), // rows are a fixed h-6, or h-11 on a phone
    overscan: 12,
    rangeExtractor,
  });

  // Bring the selected row into view (scrolling only as far as needed) when the
  // selection changes or the tree reappears after filtering; opening a branch
  // elsewhere leaves the scroll where the reader put it.
  const activeIndex = activeId === null ? -1 : rows.findIndex((r) => r.node.id === activeId);
  const shownFor = useRef<number | null>(null);
  const treeVisible = !!index && !filter.trim();
  useEffect(() => {
    if (!treeVisible) {
      shownFor.current = null;
      return;
    }
    if (activeIndex < 0 || shownFor.current === activeId) return;
    shownFor.current = activeId;
    virtual.scrollToIndex(activeIndex, { align: 'auto' });
  }, [treeVisible, activeId, activeIndex, virtual]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Filter: exact name/acronym matches first, then prefix matches, max 30.
  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !index) return [];
    const exact: OntologyNode[] = [];
    const prefix: OntologyNode[] = [];
    for (const n of index.all) {
      const name = n.name.toLowerCase();
      const acro = n.acronym.toLowerCase();
      if (name === q || acro === q) exact.push(n);
      else if (name.startsWith(q) || acro.startsWith(q)) prefix.push(n);
    }
    return [...exact, ...prefix].slice(0, 30);
  }, [filter, index]);

  function pick(n: OntologyNode) {
    setFilter('');
    void openTreeNode(n);
  }

  if (ontology.isError) {
    return <p role="alert" className="p-5 text-sm text-destructive">Could not load the hierarchy: {ontology.error.message}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative px-2.5 py-2">
        <label htmlFor="tree-filter" className="sr-only">
          Filter the hierarchy
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input
          id="tree-filter"
          type="search"
          autoComplete="off"
          placeholder="Filter by acronym or name"
          className="h-7 pl-7 text-[12.5px] max-md:h-11 max-md:text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) pick(matches[0]);
            if (e.key === 'Escape') setFilter('');
          }}
        />
      </div>

      {!index ? (
        <p role="status" className="px-3 py-2 text-[12.5px] text-muted-foreground">Loading the Allen CCFv3 hierarchy…</p>
      ) : filter.trim() ? (
        <ul aria-label="Matching structures" className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {matches.length === 0 && <li className="px-3 py-2 text-[12.5px] text-muted-foreground">No structures match.</li>}
          {matches.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => pick(n)}
                aria-label={spoken(n)}
                className="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-[12.5px] hover:bg-hover max-md:h-11"
              >
                <Dot color={n._color} dim={!n._available} />
                <Label node={n} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div ref={scroller} role="tree" aria-label="Allen CCFv3 hierarchy" className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((v) => {
              const row = rows[v.index]!;
              return (
                <TreeRow
                  key={row.node.id}
                  index={v.index}
                  onFocusRow={(i) => (focused.current = i)}
                  row={row}
                  top={v.start}
                  open={expanded.has(row.node.id)}
                  active={row.node.id === activeId}
                  onToggle={toggle}
                  onPick={pick}
                  eye={eye}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface Row {
  node: OntologyNode;
  depth: number;
  /** Position among its siblings, for screen readers (aria-posinset / -setsize). */
  pos: number;
  of: number;
}

/** The open part of the tree, depth first, as a flat list of rows. */
function visibleRows(roots: OntologyNode[], expanded: Set<number>): Row[] {
  const out: Row[] = [];
  const walk = (nodes: OntologyNode[], depth: number) =>
    nodes.forEach((node, i) => {
      out.push({ node, depth, pos: i + 1, of: nodes.length });
      if (node.children.length && expanded.has(node.id)) walk(node.children, depth + 1);
    });
  walk(roots, 0);
  return out;
}

interface EyeProps {
  /** Structures with a 3D model (null while loading). */
  meshes: Set<number> | null;
  shown: number[];
  onToggle: (id: number) => void;
}

interface TreeRowProps {
  index: number;
  onFocusRow: (index: number | null) => void;
  row: Row;
  top: number;
  open: boolean;
  active: boolean;
  onToggle: (id: number) => void;
  onPick: (n: OntologyNode) => void;
  eye: EyeProps;
}

/** One row of the tree. Rows are flat (not nested) so they can be drawn only
 *  when on screen; aria-level and aria-posinset carry the structure. */
function TreeRow({ index, onFocusRow, row, top, open, active, onToggle, onPick, eye }: TreeRowProps) {
  const { node, depth } = row;
  const hasKids = node.children.length > 0;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={row.pos}
      aria-setsize={row.of}
      aria-expanded={hasKids ? open : undefined}
      aria-selected={active}
      className={cn(
        'group absolute left-0 top-0 flex h-6 w-full items-center gap-0.5 rounded-sm pr-0.5 hover:bg-hover max-md:h-11',
        active && 'bg-hover shadow-[inset_0_0_0_1px_var(--color-border-strong)]',
      )}
      style={{ transform: `translateY(${top}px)`, paddingLeft: depth * 12 }}
      onFocus={() => onFocusRow(index)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusRow(null);
      }}
    >
      {hasKids ? (
        <button
          type="button"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
          onClick={() => onToggle(node.id)}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-subtle-foreground hover:text-foreground max-md:size-11"
        >
          <ChevronRight className={cn('size-3 transition-transform duration-150 ease-out', open && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-5 shrink-0 max-md:size-11" />
      )}
      <button
        type="button"
        onClick={() => onPick(node)}
        aria-label={spoken(node)}
        title={node._available ? undefined : 'No voxels in the 2D atlas'}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] max-md:text-sm"
      >
        <Dot color={node._color} dim={!node._available} />
        <Label node={node} active={active} />
      </button>
      {eye.meshes?.has(node.id) && <SurfaceToggle node={node} on={eye.shown.includes(node.id)} onToggle={eye.onToggle} />}
    </div>
  );
}

/** The region's Allen colour; dimmed for regions with no voxels in the 2D atlas. */
function Dot({ color, dim }: { color: string; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('size-[9px] shrink-0 rounded-[2px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]', dim && 'opacity-50')}
      style={{ background: isHexColor(color) ? color : 'var(--color-border-strong)' }}
    />
  );
}

/** Show or hide a structure's surface in 3D. A hidden one's eye appears on hover
 *  or focus (always on a phone), so the tree stays quiet. */
function SurfaceToggle({ node, on, onToggle }: { node: OntologyNode; on: boolean; onToggle: (id: number) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Show ${node.name} in 3D`}
      title={on ? `Hide ${node.name} in 3D` : `Show ${node.name} in 3D`}
      onClick={() => onToggle(node.id)}
      className={cn(
        'pressable grid size-6 shrink-0 place-items-center rounded-sm max-md:size-11',
        on ? 'text-foreground' : 'text-subtle-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100',
      )}
    >
      {on ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </button>
  );
}

/** Screen readers hear the name first, then the acronym. */
const nameRepeatsAcronym = (n: OntologyNode) => n.name.toLowerCase() === n.acronym.toLowerCase();
const spoken = (n: OntologyNode) => (nameRepeatsAcronym(n) ? n.name : `${n.name} (${n.acronym})`);

/** Bold acronym, then the name (left out when it only repeats the acronym). */
function Label({ node, active }: { node: OntologyNode; active?: boolean }) {
  const dim = !node._available;
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <b className={cn('shrink-0 font-mono text-[11.5px] font-bold', dim ? 'text-subtle-foreground' : 'text-foreground')}>{node.acronym}</b>
      {!nameRepeatsAcronym(node) && (
        <span className={cn('min-w-0 truncate', active ? 'font-medium text-foreground' : dim ? 'text-subtle-foreground' : 'text-muted-foreground')}>{node.name}</span>
      )}
    </span>
  );
}
