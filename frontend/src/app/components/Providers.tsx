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
      <TooltipProvider delayDuration={300}>
        {children}
        <SignInDialog />
        <Toaster theme="dark" position="bottom-left" closeButton toastOptions={{ className: 'font-sans' }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
