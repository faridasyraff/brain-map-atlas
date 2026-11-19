import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';
import { TooltipProvider } from '@/components/ui/icon-button';
import { initialSlices, useAtlas } from '@/store/atlas';
import { useUi } from '@/store/ui';

/** A fresh query cache per test (no retries, so errors show up immediately). */
export const testQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Reset shared stores and the address bar between tests. */
export function resetApp(url = '/app') {
  useAtlas.setState({ slices: initialSlices(), selection: null });
  useUi.setState({ panelOpen: true, indexOpen: true, tab: 'inspector', signInMode: null });
  window.history.replaceState(null, '', url);
}

export function renderApp() {
  return render(<App queryClient={testQueryClient()} />);
}

/** Render one component with the providers it needs (query cache, tooltips). */
export function renderWithProviders(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}
