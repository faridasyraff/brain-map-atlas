import type { QueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ViewsGrid } from '@/components/atlas/ViewsGrid';
import { PhoneAtlas } from '@/components/layout/PhoneAtlas';
import { Providers } from '@/components/Providers';
import { SidePanel } from '@/components/layout/SidePanel';
import { TopBar } from '@/components/layout/TopBar';
import { useRecordHistory } from '@/hooks/useLibrary';
import { usePhoneLayout } from '@/hooks/useMediaQuery';
import { useUrlSync } from '@/hooks/useUrlSync';
import { useUi } from '@/store/ui';

/** The atlas: top bar, the four views, and the side panel (one view at a time on a phone). */
export function App({ queryClient }: { queryClient?: QueryClient }) {
  return (
    <Providers queryClient={queryClient}>
      <Atlas />
    </Providers>
  );
}

function Atlas() {
  const panelOpen = useUi((s) => s.panelOpen);
  const phone = usePhoneLayout();
  useUrlSync();
  useRecordHistory();
  if (phone) return <PhoneAtlas />;
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <ErrorBoundary area="the atlas views" className="flex-1 p-5">
          <ViewsGrid />
        </ErrorBoundary>
        {panelOpen && <SidePanel />}
      </div>
    </div>
  );
}
