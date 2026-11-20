import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyTree } from '@/components/hierarchy/HierarchyTree';
import { IconButton } from '@/components/ui/icon-button';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { getOntology } from '@/lib/api';
import { countStructures } from '@/lib/atlasFacts';
import { useUi } from '@/store/ui';

/** Desktop: the Allen hierarchy as a browsable index on the left. Open by
 *  default so a first-time visitor sees what's in the brain; folds to a rail. */
export function IndexPanel() {
  const open = useUi((s) => s.indexOpen);
  const toggleIndex = useUi((s) => s.toggleIndex);
  const button = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  const ontology = useQuery({ queryKey: ['ontology'], queryFn: getOntology, staleTime: Infinity });
  const count = useMemo(() => (ontology.data ? countStructures(ontology.data) : null), [ontology.data]);

  // Below 1280px the index is folded, so the three slices keep usable widths;
  // it opens again when the window widens. (Before paint: no layout jump.)
  const narrow = useMediaQuery('(max-width: 1279px)');
  useLayoutEffect(() => {
    useUi.setState({ indexOpen: !narrow });
  }, [narrow]);

  // The button you pressed is replaced by its counterpart: keep keyboard focus on it.
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    button.current?.focus();
  }, [open]);

  function toggle() {
    toggled.current = true;
    toggleIndex();
  }

  if (!open) {
    return (
      <nav aria-label="Brain index" className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-surface py-1">
        <IconButton ref={button} label="Show the brain index" onClick={toggle}>
          <PanelLeftOpen />
        </IconButton>
      </nav>
    );
  }

  return (
    <nav aria-label="Brain index" className="flex w-[284px] shrink-0 flex-col border-r border-border bg-surface">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        <h2 className="panel-label">Structure tree</h2>
        <span className="ml-auto font-mono text-[11px] text-subtle-foreground">{count?.toLocaleString('en-US')}</span>
        <IconButton ref={button} label="Fold the brain index" onClick={toggle} className="size-7">
          <PanelLeftClose />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">
        <ErrorBoundary area="the brain index">
          <HierarchyTree />
        </ErrorBoundary>
      </div>
    </nav>
  );
}
