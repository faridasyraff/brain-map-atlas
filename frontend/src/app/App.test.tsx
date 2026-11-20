import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, fetchSlice } from '@/lib/api';
import { installFakeApi } from '@/test/fakeApi';
import { renderApp, resetApp } from '@/test/render';
import { useAtlas } from '@/store/atlas';

beforeEach(() => resetApp());
afterEach(() => vi.unstubAllGlobals());

const slider = (name: string) => screen.getByRole('slider', { name });
const inspector = () => screen.getByRole('tabpanel', { name: 'Details' });

async function searchAndOpen(text: string) {
  const box = screen.getByRole('combobox', { name: 'Find a region' });
  await userEvent.type(box, text);
  await screen.findByRole('option', { name: new RegExp(text, 'i') });
  await userEvent.keyboard('{Enter}');
}

describe('App shell', () => {
  it('shows all four views, each 2D view loading its slice', async () => {
    installFakeApi();
    renderApp();
    const views = screen.getByRole('main', { name: 'Atlas views' });
    for (const name of ['Sagittal view', 'Coronal view', 'Transverse view', '3D view']) {
      expect(within(views).getByRole('region', { name })).toBeInTheDocument();
    }
    expect(await screen.findByRole('img', { name: 'Sagittal slice 570' })).toBeInTheDocument();
  });

  it('expands one view and brings the grid back', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Expand coronal view' }));
    expect(screen.queryByRole('region', { name: 'Sagittal view' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    expect(screen.getByRole('region', { name: 'Sagittal view' })).toBeInTheDocument();
  });

  it('switches between the stage and four equal views, and remembers the choice', async () => {
    installFakeApi();
    renderApp();
    const canvas = screen.getByLabelText('3D brain');
    const grid = () => screen.getByRole('main', { name: 'Atlas views' }).firstElementChild as HTMLElement;
    expect(grid()).toHaveAttribute('data-layout', 'stage');
    await userEvent.click(screen.getByRole('button', { name: 'Four equal views' }));
    expect(grid()).toHaveAttribute('data-layout', 'quad');
    expect(screen.getByLabelText('3D brain')).toBe(canvas); // moved, not remounted
    expect(localStorage.getItem('brain-atlas.layout')).toBe('quad');
    await userEvent.click(screen.getByRole('button', { name: 'Stage: 3D above the three sections' }));
    expect(grid()).toHaveAttribute('data-layout', 'stage');
  });

  it('hides and shows the side panel', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Hide side panel' }));
    expect(screen.queryByRole('complementary', { name: 'Region details' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show side panel' }));
    expect(screen.getByRole('complementary', { name: 'Region details' })).toBeInTheDocument();
  });

  it('"/" jumps to search, but typing "/" in a box does not', async () => {
    installFakeApi();
    renderApp();
    const search = screen.getByRole('combobox', { name: 'Find a region' });
    await userEvent.keyboard('/');
    expect(search).toHaveFocus();
    await userEvent.type(search, 'a/b');
    expect(search).toHaveValue('a/b');
  });

  it('the details panel states the atlas and its citation, even with nothing selected', async () => {
    installFakeApi();
    renderApp();
    expect(within(inspector()).getByText('2017 annotation')).toBeInTheDocument();
    expect(within(inspector()).getByRole('link', { name: 'doi:10.1016/j.cell.2020.04.007' })).toHaveAttribute(
      'href',
      'https://doi.org/10.1016/j.cell.2020.04.007',
    );
  });

  it('Ctrl K jumps to search, even from inside another box', async () => {
    installFakeApi();
    renderApp();
    const search = screen.getByRole('combobox', { name: 'Find a region' });
    search.blur();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search).toHaveFocus();
  });
});

describe('Search → selection', () => {
  it('opens a region: inspector, all three views moved to it, highlight, shareable URL', async () => {
    const api = installFakeApi();
    renderApp();
    await searchAndOpen('Lateral');

    expect(await within(inspector()).findByRole('heading', { name: 'Lateral dorsal nucleus of thalamus' })).toBeInTheDocument();
    // Views jump to the region's center (x = sagittal, z = coronal, y = transverse).
    expect(slider('Sagittal slice')).toHaveAttribute('aria-valuenow', '707');
    expect(slider('Coronal slice')).toHaveAttribute('aria-valuenow', '660');
    expect(slider('Transverse slice')).toHaveAttribute('aria-valuenow', '319');
    await waitFor(() => expect(api.calls('/api/highlight').length).toBeGreaterThanOrEqual(3));
    expect(window.location.search).toContain('region=150');
    expect(window.location.search).toContain('cor=660');
    // Hierarchy path and the "why is the summary empty" note from the server.
    expect(within(inspector()).getByRole('list', { name: 'Position in the hierarchy' })).toHaveTextContent('Thalamus');
    expect(await within(inspector()).findByText(/no OPENAI_API_KEY/)).toBeInTheDocument();
  });

  it('Enter right after typing opens what was typed, not the previous results', async () => {
    installFakeApi();
    renderApp();
    await searchAndOpen('Lateral');
    await within(inspector()).findByRole('heading', { name: 'Lateral dorsal nucleus of thalamus' });
    // Type and press Enter at once: the list may still hold the old results.
    await userEvent.type(screen.getByRole('combobox', { name: 'Find a region' }), 'Caudoputamen{Enter}');
    expect(await within(inspector()).findByRole('heading', { name: 'Caudoputamen' })).toBeInTheDocument();
  });

  it('opens a group of regions', async () => {
    installFakeApi();
    renderApp();
    await searchAndOpen('Thalamus');
    expect(await within(inspector()).findByText('Group of 2 regions')).toBeInTheDocument();
    expect(window.location.search).toContain('group=Thalamus');
  });

  it('related-region chips open that region', async () => {
    installFakeApi();
    renderApp();
    await searchAndOpen('Lateral');
    await userEvent.click(await within(inspector()).findByRole('button', { name: 'Caudoputamen' }));
    expect(await within(inspector()).findByRole('heading', { name: 'Caudoputamen' })).toBeInTheDocument();
  });

  it('restores a shared link, keeping its exact slices', async () => {
    installFakeApi();
    resetApp('/app?region=150&sag=500&cor=600&tra=300');
    renderApp();
    expect(await within(inspector()).findByRole('heading', { name: 'Lateral dorsal nucleus of thalamus' })).toBeInTheDocument();
    expect(slider('Coronal slice')).toHaveAttribute('aria-valuenow', '600');
    expect(useAtlas.getState().slices).toEqual({ sagittal: 500, coronal: 600, transverse: 300 });
  });
});

describe('Hierarchy', () => {
  it('the index folds to a rail and back, keeping keyboard focus', async () => {
    installFakeApi();
    renderApp();
    expect(await screen.findByRole('tree')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fold the brain index' }));
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the brain index' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Show the brain index' }));
    expect(await screen.findByRole('tree')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fold the brain index' })).toHaveFocus();
  });

  it('browses the tree and opens a group from it', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /^Thalamus/ }));
    await waitFor(() => expect(useAtlas.getState().selection?.label).toBe('Thalamus'));
  });

  it('filter: exact match first, Enter opens it', async () => {
    installFakeApi();
    renderApp();
    await screen.findByRole('tree');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter the hierarchy' }), 'cp{Enter}');
    await waitFor(() => expect(useAtlas.getState().selection?.label).toBe('Caudoputamen'));
  });
});

describe('Accounts and saved regions', () => {
  it('shows a sign-in error, then signs in', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await userEvent.type(within(dialog).getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'wrong-password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Incorrect email or password');

    await userEvent.clear(within(dialog).getByLabelText('Password'));
    await userEvent.type(within(dialog).getByLabelText('Password'), 'correct-horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('saves a region with a note and lists it in the Saved tab', async () => {
    const api = installFakeApi({ signedIn: true });
    renderApp();
    await searchAndOpen('Lateral');
    await userEvent.click(await within(inspector()).findByRole('button', { name: 'Save' }));
    expect(await within(inspector()).findByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.type(within(inspector()).getByLabelText('Your note (private)'), 'Head-direction cells');
    expect(await within(inspector()).findByText('Note saved', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.state.saved[0]).toMatchObject({ kind: 'region', ref: '150', note: 'Head-direction cells' });

    await userEvent.click(screen.getByRole('tab', { name: 'Saved' }));
    const saved = screen.getByRole('tabpanel', { name: 'Saved' });
    expect(await within(saved).findByText('Head-direction cells')).toBeInTheDocument();
    // History was recorded too.
    await waitFor(() => expect(api.state.history[0]).toMatchObject({ ref: '150' }));
  });

  it('asks you to sign in when saving while signed out', async () => {
    installFakeApi();
    renderApp();
    await searchAndOpen('Lateral');
    await userEvent.click(await within(inspector()).findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('Assistant', () => {
  it('sends the selected region with the question and shows the answer as plain text', async () => {
    const api = installFakeApi();
    api.chatReply = { answer: 'Try <img src=x onerror="alert(1)"> here', pmc_sources: ['PMC123', 'javascript:alert(1)'] };
    renderApp();
    await searchAndOpen('Lateral');
    const box = screen.getByRole('region', { name: 'Assistant' });
    await userEvent.type(within(box).getByLabelText('Question for the assistant'), 'What does it do?{Enter}');

    expect(await within(box).findByText(/Try <img src=x/)).toBeInTheDocument(); // shown as text, not HTML
    expect(within(box).queryByRole('img')).not.toBeInTheDocument();
    expect(within(box).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/',
    ]);
    expect(api.calls('/api/chat')[0]?.body).toMatchObject({
      message: 'What does it do?',
      region_name: 'Lateral dorsal nucleus of thalamus',
      parcellation_index: 150,
      ai_provider: 'ollama',
    });
  });

  it('turns regions named in a list answer into chips that open them', async () => {
    const api = installFakeApi();
    api.chatReply = { answer: 'Main targets:\n1. Caudoputamen\n2. Thalamus\n3. Made-up area' };
    renderApp();
    const box = screen.getByRole('region', { name: 'Assistant' });
    await userEvent.type(within(box).getByLabelText('Question for the assistant'), 'Which regions are connected to the cortex?{Enter}');
    expect(await within(box).findByText('2 of 3 in the atlas')).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: /Caudoputamen/ }));
    await waitFor(() => expect(useAtlas.getState().selection?.label).toBe('Caudoputamen'));
  });
});

describe('api client', () => {
  it("raises the server's own error message", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'view must be one of …' }), { status: 400 })));
    await expect(fetchSlice('coronal', 1)).rejects.toEqual(expect.objectContaining({ name: 'ApiError', status: 400, message: 'view must be one of …' }));
    await expect(fetchSlice('coronal', 1)).rejects.toBeInstanceOf(ApiError);
  });
});
