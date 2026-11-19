import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { SignInDialog } from '@/components/account/AccountMenu';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ViewsGrid } from '@/components/atlas/ViewsGrid';
import { SidePanel } from '@/components/layout/SidePanel';
import { TopBar } from '@/components/layout/TopBar';
import { TooltipProvider } from '@/components/ui/icon-button';
import { useRecordHistory } from '@/hooks/useLibrary';
import { useUrlSync } from '@/hooks/useUrlSync';
import { useUi } from '@/store/ui';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
}

/** The atlas: top bar, the four views, and the side panel. */
export function App({ queryClient }: { queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? makeQueryClient());
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        <Atlas />
        <SignInDialog />
        <Toaster theme="dark" position="bottom-left" closeButton toastOptions={{ className: 'font-sans' }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function Atlas() {
  const panelOpen = useUi((s) => s.panelOpen);
  useUrlSync();
  useRecordHistory();
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
