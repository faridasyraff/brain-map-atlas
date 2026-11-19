import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { getOntology, type OntologyNode } from '@/lib/api';
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

  // The node matching the current selection (by acronym, then name).
  const activeId = useMemo(() => {
    if (!index || !selection) return null;
    const a = selection.acronym.toLowerCase();
    const n = selection.label.toLowerCase();
    return (index.all.find((x) => x.acronym.toLowerCase() === a) ?? index.all.find((x) => x.name.toLowerCase() === n))?.id ?? null;
  }, [index, selection]);

  // Reveal the selected node: open its ancestors (and the root on first load).
  useEffect(() => {
    if (!index) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      index.all.slice(0, 1).forEach((r) => next.add(r.id));
      for (let p = activeId !== null ? index.parentOf.get(activeId) : null; p != null; p = index.parentOf.get(p) ?? null) next.add(p);
      return next;
    });
  }, [index, activeId]);

  const activeRef = useRef<HTMLDivElement>(null);
  // Block body: scrollIntoView() returns a Promise in current Chrome (see Assistant.tsx).
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, expanded]);

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
      <div className="border-b border-border p-4">
        <label htmlFor="tree-filter" className="mb-1 block text-xs font-medium text-muted-foreground">
          Filter the hierarchy
        </label>
        <Input
          id="tree-filter"
          type="search"
          autoComplete="off"
          placeholder="Name or acronym"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) pick(matches[0]);
            if (e.key === 'Escape') setFilter('');
          }}
        />
      </div>

      {!index ? (
        <p role="status" className="p-5 text-sm text-muted-foreground">Loading the Allen CCFv3 hierarchy…</p>
      ) : filter.trim() ? (
        <ul aria-label="Matching structures" className="min-h-0 flex-1 overflow-y-auto p-2">
          {matches.length === 0 && <li className="p-3 text-sm text-muted-foreground">No structures match.</li>}
          {matches.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => pick(n)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
              >
                <Dot color={n._color} dim={!n._available} />
                <span className={cn('min-w-0 flex-1 truncate text-sm', !n._available && 'text-subtle-foreground')}>{n.name}</span>
                <span className="text-xs text-subtle-foreground">{n.acronym}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div role="tree" aria-label="Allen CCFv3 hierarchy" className="min-h-0 flex-1 overflow-auto p-2">
          {index.all.slice(0, 1).map((root) => (
            <TreeNode key={root.id} node={root} depth={0} expanded={expanded} activeId={activeId} activeRef={activeRef} onToggle={toggle} onPick={pick} />
          ))}
        </div>
      )}
    </div>
  );
}

interface TreeNodeProps {
  node: OntologyNode;
  depth: number;
  expanded: Set<number>;
  activeId: number | null;
  activeRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (id: number) => void;
  onPick: (n: OntologyNode) => void;
}

function TreeNode({ node, depth, expanded, activeId, activeRef, onToggle, onPick }: TreeNodeProps) {
  const hasKids = node.children.length > 0;
  const open = expanded.has(node.id);
  const active = node.id === activeId;
  return (
    <div role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={active}>
      <div
        ref={active ? activeRef : undefined}
        className={cn(
          'flex h-7 items-center gap-1 rounded-sm pr-2 hover:bg-hover',
          active && 'bg-ring/15 shadow-[inset_2px_0_0_var(--color-ring)]',
        )}
        style={{ paddingLeft: depth * 14 }}
      >
        {hasKids ? (
          <button
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => onToggle(node.id)}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-raised hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onPick(node)}
          title={node._available ? undefined : 'No voxels in the 2D atlas'}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Dot color={node._color} dim={!node._available} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              active ? 'font-semibold text-foreground' : node._available ? 'text-muted-foreground hover:text-foreground' : 'text-subtle-foreground hover:text-muted-foreground',
            )}
          >
            {node.name}
          </span>
          <span className="shrink-0 text-xs text-subtle-foreground">{node.acronym}</span>
        </button>
      </div>
      {hasKids && open && (
        <div role="group">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} expanded={expanded} activeId={activeId} activeRef={activeRef} onToggle={onToggle} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The region's Allen colour; dimmed for regions with no voxels in the 2D atlas. */
function Dot({ color, dim }: { color: string; dim?: boolean }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', dim && 'opacity-50')} style={{ background: isHexColor(color) ? color : 'var(--color-border-strong)' }} />;
}
