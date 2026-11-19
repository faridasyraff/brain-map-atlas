import { useEffect } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { SearchBox } from '@/components/search/SearchBox';
import { IconButton } from '@/components/ui/icon-button';
import { useUi } from '@/store/ui';

export function TopBar() {
  const panelOpen = useUi((s) => s.panelOpen);
  const togglePanel = useUi((s) => s.togglePanel);

  // "/" focuses search from anywhere, unless you're already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t?.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.getElementById('region-search')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center gap-6 border-b border-border bg-surface pl-5 pr-3">
      <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold text-foreground">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
          <ellipse cx="12" cy="12" rx="9" ry="7" stroke="var(--color-plane-sagittal)" strokeWidth="2" />
          <path d="M12 5v14" stroke="var(--color-plane-coronal)" strokeWidth="2" />
        </svg>
        Brain Atlas
      </a>
      <SearchBox />
      <div className="ml-auto flex items-center gap-1">
        <AccountMenu />
        <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} aria-pressed={panelOpen} onClick={togglePanel}>
          {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </header>
  );
}
