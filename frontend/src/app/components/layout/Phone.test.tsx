import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFakeApi } from '@/test/fakeApi';
import { liveViewer } from '@/test/fakeViewer';
import { renderApp, resetApp } from '@/test/render';
import { PHONE_QUERY } from '@/hooks/useMediaQuery';
import { useAtlas } from '@/store/atlas';
import { useUi } from '@/store/ui';

/** Pretend the window is phone-sized: only the phone media query matches. */
function phoneWindow() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === PHONE_QUERY,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  resetApp();
  phoneWindow();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1140, 800));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tab = (name: string) => screen.getByRole('tab', { name });

describe('phone layout', () => {
  it('shows one view at a time; hidden views load nothing until their tab is chosen', async () => {
    const api = installFakeApi();
    renderApp();
    expect(screen.queryByRole('complementary', { name: 'Region details' })).not.toBeInTheDocument();
    expect(tab('Coronal')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('img', { name: 'Coronal slice 660' });
    expect(api.calls('/api/slice').map((c) => c.url.searchParams.get('view'))).toEqual(['coronal']);

    await userEvent.click(tab('Sagittal'));
    await screen.findByRole('img', { name: 'Sagittal slice 570' });
    // The coronal view is still mounted (keeps its zoom), just hidden.
    expect(screen.queryByRole('img', { name: 'Coronal slice 660' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Coronal slice 660', hidden: true })).not.toBeVisible();
  });

  it('steps the slice with − and +', async () => {
    installFakeApi();
    renderApp();
    await screen.findByRole('img', { name: 'Coronal slice 660' });
    const panel = screen.getByRole('tabpanel', { name: 'Coronal' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Next coronal slice' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Next coronal slice' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Previous coronal slice' }));
    expect(useAtlas.getState().slices.coronal).toBe(661);
    expect(within(panel).getByRole('status', { name: 'Coronal slice number' })).toHaveTextContent('661');
    await screen.findByRole('img', { name: 'Coronal slice 661' });
  });

  it('a tap identifies the region; the sheet shows it with Save, Copy link and Ask', async () => {
    installFakeApi();
    renderApp();
    const sheet = screen.getByRole('region', { name: 'Selected region' });
    expect(within(sheet).getByText('No region selected')).toBeInTheDocument();
    await screen.findByRole('img', { name: 'Coronal slice 660' });

    const vp = screen.getByTestId('coronal-viewport');
    fireEvent.pointerDown(vp, { pointerId: 1, button: 0, pointerType: 'touch', clientX: 120, clientY: 340 });
    fireEvent.pointerUp(vp, { pointerId: 1, button: 0, pointerType: 'touch', clientX: 120, clientY: 340 });

    expect(await within(sheet).findByRole('heading', { name: 'Lateral dorsal nucleus of thalamus' })).toBeInTheDocument();
    expect(within(sheet).getByText('LD')).toBeInTheDocument();
    // No AI key in the fake backend: the sheet says why there's no summary.
    expect(await within(sheet).findByText(/AI summaries are turned off/)).toBeInTheDocument();

    // Signed out, Save asks you to sign in first.
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(useUi.getState().signInMode).toBe('signin');
    useUi.getState().closeSignIn();

    await userEvent.click(await within(sheet).findByRole('button', { name: 'Ask' }));
    const ask = await screen.findByRole('dialog', { name: 'Ask about this region' });
    expect(within(ask).getByRole('textbox')).toBeInTheDocument();
  });

  it('the details sheet has the inspector, hierarchy and saved tabs', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Browse the hierarchy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Region details' });
    expect(within(dialog).getByRole('tab', { name: 'Hierarchy' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tab', { name: 'Details' })).toBeInTheDocument();
    // Opening a region from the tree closes the sheet, so the views can be seen moving.
    await userEvent.click(await within(dialog).findByRole('button', { name: /^Thalamus/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAtlas.getState().selection?.label).toBe('Thalamus');
  });

  it('search opens in a dialog and closes when a region is chosen', async () => {
    installFakeApi();
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Find a region' }));
    const dialog = await screen.findByRole('dialog', { name: 'Find a region' });
    const box = within(dialog).getByRole('combobox');
    expect(box).toHaveFocus();
    await userEvent.type(box, 'Caud');
    fireEvent.mouseDown(await within(dialog).findByRole('option', { name: /Caudoputamen/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(useAtlas.getState().selection?.label).toBe('Caudoputamen'));
  });

  it('the 3D tab shows the viewer without an expand button', async () => {
    installFakeApi();
    renderApp();
    await screen.findByRole('img', { name: 'Coronal slice 660' });
    expect(liveViewer()).toBeUndefined(); // 3D loads only once its tab is opened
    await userEvent.click(tab('3D'));
    await waitFor(() => expect(liveViewer()).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Expand 3D view' })).not.toBeInTheDocument();
  });
});
