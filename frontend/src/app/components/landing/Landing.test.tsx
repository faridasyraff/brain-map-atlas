import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Landing } from './Landing';
import { Providers } from '@/components/Providers';
import { installFakeApi } from '@/test/fakeApi';
import { resetApp, testQueryClient } from '@/test/render';
import { parseLink } from '@/hooks/useUrlSync';

const renderLanding = () =>
  render(
    <Providers queryClient={testQueryClient()}>
      <Landing />
    </Providers>,
  );

beforeEach(() => resetApp('/'));
afterEach(() => vi.unstubAllGlobals());

describe('landing page', () => {
  it('links into the atlas, including straight to the hippocampal formation', () => {
    installFakeApi();
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('The Allen mouse brain, region by region');
    expect(screen.getByRole('link', { name: 'Open the atlas' })).toHaveAttribute('href', '/next');
    const hip = screen.getByRole('link', { name: 'Try the hippocampus' }).getAttribute('href')!;
    expect(hip.startsWith('/next?')).toBe(true);
    // The atlas reads that link as the group.
    expect(parseLink(hip.slice(hip.indexOf('?'))).ref).toEqual({ kind: 'group', ref: 'Hippocampal formation' });
  });

  it('shows a real coronal section from the atlas', async () => {
    const api = installFakeApi();
    renderLanding();
    expect(screen.getByRole('status')).toHaveTextContent('Loading a section');
    const img = await screen.findByRole('img', { name: /Coronal section of the mouse brain/ });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,coronal-660');
    expect(api.calls('/api/slice')[0]?.url.search).toContain('view=coronal&idx=660');
  });

  it('says so when the atlas server is not reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    renderLanding();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('signs in from the header', async () => {
    installFakeApi();
    renderLanding();
    await userEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('dialog', { name: 'Create an account' })).toBeInTheDocument();
  });
});
