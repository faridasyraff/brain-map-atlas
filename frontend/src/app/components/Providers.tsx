import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { SignInDialog } from '@/components/account/AccountMenu';
import { TooltipProvider } from '@/components/ui/icon-button';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
}

/** What every page needs: the query cache, tooltips, the sign-in dialog and toasts. */
export function Providers({ queryClient, children }: { queryClient?: QueryClient; children: React.ReactNode }) {
  const [client] = useState(() => queryClient ?? makeQueryClient());
  return (
    <QueryClientProvider client={client}>
      {/* The first tooltip waits 300 ms; moving on to the next icon within 500 ms
          shows it at once. Tooltips here are labels, not hoverable panels: keeping
          one open while the pointer travelled toward it made a quick move to the
          neighbouring icon show nothing until the mouse moved again. */}
      <TooltipProvider delayDuration={300} skipDelayDuration={500} disableHoverableContent>
        {children}
        <SignInDialog />
        <Toaster theme="dark" position="bottom-left" closeButton toastOptions={{ className: 'font-sans' }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
