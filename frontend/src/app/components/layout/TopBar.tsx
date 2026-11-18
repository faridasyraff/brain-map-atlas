import { useEffect, useRef } from 'react';
import { PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';

interface TopBarProps {
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function TopBar({ panelOpen, onTogglePanel }: TopBarProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere, unless you're already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t?.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
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

      <div role="search" className="relative max-w-xl flex-1">
        <label htmlFor="region-search" className="sr-only">
          Find a region
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          id="region-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Find a region by name or acronym"
          className="pl-9 pr-10"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border-strong px-1.5 text-xs text-muted-foreground">
          /
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} aria-pressed={panelOpen} onClick={onTogglePanel}>
          {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </header>
  );
}
