import { useEffect, useLayoutEffect, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyTree } from '@/components/hierarchy/HierarchyTree';
import { IconButton } from '@/components/ui/icon-button';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useUi } from '@/store/ui';

/** Desktop: the Allen hierarchy as a browsable index on the left. Open by
 *  default so a first-time visitor sees what's in the brain; folds to a rail. */
export function IndexPanel() {
  const open = useUi((s) => s.indexOpen);
  const toggleIndex = useUi((s) => s.toggleIndex);
  const button = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);

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
      <nav aria-label="Brain index" className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-surface py-1.5">
        <IconButton ref={button} label="Show the brain index" onClick={toggle}>
          <PanelLeftOpen />
        </IconButton>
      </nav>
    );
  }

  return (
    <nav aria-label="Brain index" className="flex w-[272px] shrink-0 flex-col border-r border-border bg-surface">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-1.5">
        <h2 className="font-wide text-sm font-semibold">Index</h2>
        <span className="font-condensed text-xs text-subtle-foreground">Allen CCFv3</span>
        <IconButton ref={button} label="Fold the brain index" onClick={toggle} className="ml-auto">
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
