import { useEffect } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { BrandMark } from '@/components/layout/BrandMark';
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
      <BrandMark />
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
