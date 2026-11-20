import { useEffect } from 'react';
import { LayoutGrid, LayoutPanelTop, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { BrandMark } from '@/components/layout/BrandMark';
import { SearchBox } from '@/components/search/SearchBox';
import { IconButton } from '@/components/ui/icon-button';
import { useUi } from '@/store/ui';

export function TopBar() {
  const panelOpen = useUi((s) => s.panelOpen);
  const togglePanel = useUi((s) => s.togglePanel);
  const layout = useUi((s) => s.layout);
  const setLayout = useUi((s) => s.setLayout);

  // Ctrl K (Cmd K on a Mac) focuses search from anywhere; "/" does too, unless you're typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t?.closest('input, textarea, select, [contenteditable="true"]');
      const ctrlK = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      const slash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (ctrlK || slash) {
        e.preventDefault();
        document.getElementById('region-search')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="grid h-10 shrink-0 grid-cols-[minmax(min-content,1fr)_minmax(0,440px)_minmax(min-content,1fr)] items-center gap-4 border-b border-border bg-surface pl-3 pr-1.5">
      {/* The side columns never get narrower than their content, so on a tablet the
          search box shrinks instead of sliding over the name. */}
      <div className="flex min-w-0 items-baseline gap-2.5">
        <BrandMark className="shrink-0 whitespace-nowrap text-[13px]" />
        <span className="truncate text-xs text-subtle-foreground max-lg:hidden">Allen Mouse Brain CCFv3, 2017 annotation</span>
      </div>
      <SearchBox />
      <div className="flex items-center justify-end gap-1">
        <div role="group" aria-label="View layout" className="mr-2 flex gap-0.5 rounded-md border border-border p-0.5">
          <IconButton label="Stage: 3D above the three sections" aria-pressed={layout === 'stage'} onClick={() => setLayout('stage')} className={layoutButton(layout === 'stage')}>
            <LayoutPanelTop />
          </IconButton>
          <IconButton label="Four equal views" aria-pressed={layout === 'quad'} onClick={() => setLayout('quad')} className={layoutButton(layout === 'quad')}>
            <LayoutGrid />
          </IconButton>
        </div>
        <AccountMenu />
        <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} aria-pressed={panelOpen} onClick={togglePanel}>
          {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </header>
  );
}

const layoutButton = (on: boolean) =>
  on ? 'size-6 bg-hover text-foreground shadow-[inset_0_0_0_1px_var(--color-border-strong)] [&_svg]:size-3.5' : 'size-6 [&_svg]:size-3.5';
