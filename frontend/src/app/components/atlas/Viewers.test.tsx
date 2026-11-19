import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFakeApi } from '@/test/fakeApi';
import { liveViewer } from '@/test/fakeViewer';
import { renderApp, resetApp } from '@/test/render';
import { useAtlas } from '@/store/atlas';

// jsdom does no layout: give every element the slice's own size (1140×800),
// so client (x, y) maps straight onto slice (col, row).
beforeEach(() => {
  resetApp();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1140, 800));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const viewport = (plane: string) => screen.getByTestId(`${plane}-viewport`);
const press = (el: Element, x: number, y: number, id = 1) =>
  fireEvent.pointerDown(el, { pointerId: id, button: 0, pointerType: 'mouse', clientX: x, clientY: y });
const move = (el: Element, x: number, y: number, id = 1) => fireEvent.pointerMove(el, { pointerId: id, clientX: x, clientY: y });
const release = (el: Element, x: number, y: number, id = 1) =>
  fireEvent.pointerUp(el, { pointerId: id, button: 0, pointerType: 'mouse', clientX: x, clientY: y });

async function sliceShown(plane: string, idx: number) {
  await screen.findByRole('img', { name: `${plane} slice ${idx}` });
}

describe('2D views: click to identify', () => {
  it('selects the region under a click and moves the other two views to it', async () => {
    const api = installFakeApi();
    renderApp();
    await sliceShown('Coronal', 660);
    const coronalBefore = useAtlas.getState().slices.coronal;

    const vp = viewport('coronal');
    press(vp, 120, 340);
    release(vp, 121, 341);

    await waitFor(() => expect(useAtlas.getState().selection?.label).toBe('Lateral dorsal nucleus of thalamus'));
    expect(api.calls('/api/lookup')[0]?.body).toEqual({ view: 'coronal', idx: 660, col: 121, row: 341 });
    // The clicked view stays; the others move to the clicked voxel.
    expect(useAtlas.getState().slices).toEqual({ sagittal: 707, coronal: coronalBefore, transverse: 319 });
    expect(useAtlas.getState().selection?.structureId).toBe(155);
  });

  it('says so when the click is outside the brain', async () => {
    installFakeApi();
    renderApp();
    await sliceShown('Coronal', 660);
    press(viewport('coronal'), 900, 300);
    release(viewport('coronal'), 900, 300);
    expect(await screen.findByText('No region there')).toBeInTheDocument();
    expect(useAtlas.getState().selection).toBeNull();
  });

  it('a drag pans the view and is not a click', async () => {
    const api = installFakeApi();
    renderApp();
    await sliceShown('Sagittal', 570);
    const vp = viewport('sagittal');
    press(vp, 100, 100);
    move(vp, 160, 130);
    release(vp, 160, 130);
    expect(api.calls('/api/lookup')).toHaveLength(0);
    expect(vp.firstElementChild).toHaveStyle({ transform: 'translate(60px, 30px) scale(1)' });
    // Panned away from the default: Reset is offered.
    expect(screen.getAllByRole('button', { name: 'Reset zoom' })[0]).toBeEnabled();
  });
});

describe('2D views: zoom', () => {
  it('wheel zooms toward the cursor; Reset zoom puts it back', async () => {
    installFakeApi();
    renderApp();
    await sliceShown('Transverse', 400);
    const vp = viewport('transverse');
    // In the strip, the zoom readout appears once the slice is zoomed.
    expect(screen.queryByRole('status', { name: 'Transverse zoom' })).not.toBeInTheDocument();

    for (let i = 0; i < 5; i++) fireEvent.wheel(vp, { deltaY: -100, clientX: 200, clientY: 100 });
    const zoomOut = screen.getByRole('status', { name: 'Transverse zoom' });
    expect(Number.parseInt(zoomOut.textContent ?? '', 10)).toBeGreaterThan(150);
    // Zoomed toward (200, 100): that point is still under the cursor.
    const [, x, y, z] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(vp.firstElementChild!.getAttribute('style')!)!.map(Number);
    expect((200 - x!) / z!).toBeCloseTo(200);
    expect((100 - y!) / z!).toBeCloseTo(100);

    const reset = within(screen.getByRole('region', { name: 'Transverse view' })).getByRole('button', { name: 'Reset zoom' });
    await userEvent.click(reset);
    expect(vp.firstElementChild).toHaveStyle({ transform: 'translate(0px, 0px) scale(1)' });
    expect(screen.queryByRole('status', { name: 'Transverse zoom' })).not.toBeInTheDocument();
  });

  it('two-finger pinch zooms; lifting a finger is not a click', async () => {
    const api = installFakeApi();
    renderApp();
    await sliceShown('Coronal', 660);
    const vp = viewport('coronal');
    const touch = (fn: typeof fireEvent.pointerDown, id: number, x: number) =>
      fn(vp, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: 200 });
    touch(fireEvent.pointerDown, 1, 100);
    touch(fireEvent.pointerDown, 2, 200);
    touch(fireEvent.pointerMove, 2, 300); // fingers twice as far apart
    touch(fireEvent.pointerUp, 2, 300);
    touch(fireEvent.pointerUp, 1, 100);
    expect(screen.getByRole('status', { name: 'Coronal zoom' })).toHaveTextContent('200%');
    expect(api.calls('/api/lookup')).toHaveLength(0);
  });
});

describe('3D view', () => {
  it('follows the sliders and shows the selected region (parent mesh when it has none)', async () => {
    installFakeApi();
    renderApp();
    await waitFor(() => expect(liveViewer()).toBeDefined());
    const v = liveViewer()!;
    await waitFor(() => expect(v.setSlices).toHaveBeenLastCalledWith(useAtlas.getState().slices));

    press(viewport('coronal'), 50, 50);
    release(viewport('coronal'), 50, 50);
    await waitFor(() =>
      expect(v.showRegion).toHaveBeenLastCalledWith(expect.objectContaining({ structureId: 155, acronym: 'LD' })),
    );
    expect(v.setSlices).toHaveBeenLastCalledWith(expect.objectContaining({ sagittal: 707, transverse: 319 }));
    // The catalog carries which meshes exist, so the viewer can fall back to Thalamus.
    await waitFor(() => expect(v.setCatalog.mock.lastCall?.[0].available).toEqual(new Set([997, 549, 672])));
  });

  it('pins a label beside the region once the camera has arrived', async () => {
    installFakeApi();
    renderApp();
    await waitFor(() => expect(liveViewer()).toBeDefined());
    const v = liveViewer()!;
    press(viewport('coronal'), 50, 50);
    release(viewport('coronal'), 50, 50);
    await waitFor(() => expect(v.showRegion).toHaveBeenLastCalledWith(expect.objectContaining({ acronym: 'LD' })));
    act(() => v.events.onStatus({ acronym: 'LD', name: 'Lateral dorsal nucleus of thalamus' }));
    const line = within(screen.getByRole('region', { name: '3D view' })).getByText('Lateral dorsal nucleus of thalamus', { selector: '[role=status] span' });
    const statusLine = line.closest('[role=status]')!;

    // Flying in: no label yet, the status line is visible.
    act(() => v.events.onAnchor?.({ x: 100, y: 80, settled: false }));
    expect(statusLine).not.toHaveClass('sr-only');
    // Arrived: the label shows and the status line is left to screen readers.
    act(() => v.events.onAnchor?.({ x: 100, y: 80, settled: true }));
    expect(statusLine).toHaveClass('sr-only');
    // Region gone: back to the plain status line.
    act(() => v.events.onAnchor?.(null));
    expect(statusLine).not.toHaveClass('sr-only');
  });

  it('eBrain: a click on a plane identifies the region and moves all views', async () => {
    const api = installFakeApi();
    renderApp();
    await waitFor(() => expect(liveViewer()).toBeDefined());
    const v = liveViewer()!;
    const toggle = screen.getByRole('button', { name: /eBrain mode/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(v.setEbrain).toHaveBeenLastCalledWith(true);

    // Mesh space (µm): x = A–P → zi, y = S–I → yi, z = L–R → xi.
    act(() => v.events.onPick({ view: 'coronal', local: { x: 4000, y: 3000, z: 2500 }, voxel: 12 }));
    await waitFor(() => expect(useAtlas.getState().selection?.acronym).toBe('LD'));
    expect(api.calls('/api/lookup')[0]?.body).toEqual({ view: 'coronal', idx: 400, col: 250, row: 300 });
    expect(useAtlas.getState().slices).toEqual({ sagittal: 707, coronal: 660, transverse: 319 });
    expect(screen.getByText(/coronal plane at 4000, 3000, 2500/)).toBeInTheDocument();
  });

  it('eBrain: a posterior click (A–P beyond the L–R width) still uses the annotation', async () => {
    const api = installFakeApi();
    renderApp();
    await waitFor(() => expect(liveViewer()).toBeDefined());
    // zi = 1250 is inside the 1320-deep A–P axis.
    act(() => liveViewer()!.events.onPick({ view: 'sagittal', local: { x: 12500, y: 3000, z: 2500 }, voxel: 7 }));
    await waitFor(() => expect(api.calls('/api/lookup')).toHaveLength(1));
    expect(api.calls('/api/lookup')[0]?.body).toEqual({ view: 'sagittal', idx: 250, col: 1250, row: 300 });
  });

  it('views hidden behind an expanded one load nothing until shown', async () => {
    const api = installFakeApi();
    renderApp();
    await sliceShown('Sagittal', 570);
    await userEvent.click(screen.getByRole('button', { name: 'Expand 3D view' }));
    const before = api.calls('/api/slice').length;
    act(() => useAtlas.getState().setSlices({ sagittal: 600, coronal: 600, transverse: 300 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls('/api/slice').length).toBe(before);
    await userEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    await sliceShown('Sagittal', 600);
  });

  it('keeps the 3D scene when another view is expanded', async () => {
    installFakeApi();
    renderApp();
    await waitFor(() => expect(liveViewer()).toBeDefined());
    const v = liveViewer()!;
    await userEvent.click(screen.getByRole('button', { name: 'Expand coronal view' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    expect(v.dispose).not.toHaveBeenCalled();
    expect(liveViewer()).toBe(v);
  });
});
