import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, fetchSlice } from '@/lib/api';
import { stubSliceApi } from '@/test/fetch';
import { App } from './App';

afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('shows all four views, each 2D view loading its slice', async () => {
    stubSliceApi();
    render(<App />);
    const views = screen.getByRole('main', { name: 'Atlas views' });
    for (const name of ['Sagittal view', 'Coronal view', 'Transverse view', '3D view']) {
      expect(within(views).getByRole('region', { name })).toBeInTheDocument();
    }
    expect(await screen.findByRole('img', { name: 'Sagittal slice 570' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Transverse slice 400' })).toBeInTheDocument();
  });

  it('expands one view and brings the grid back', async () => {
    stubSliceApi();
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand coronal view' }));
    expect(screen.queryByRole('region', { name: 'Sagittal view' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Coronal view' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    expect(screen.getByRole('region', { name: 'Sagittal view' })).toBeInTheDocument();
  });

  it('hides and shows the side panel', async () => {
    stubSliceApi();
    render(<App />);
    expect(screen.getByRole('complementary', { name: 'Region details' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide side panel' }));
    expect(screen.queryByRole('complementary', { name: 'Region details' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show side panel' }));
    expect(screen.getByRole('complementary', { name: 'Region details' })).toBeInTheDocument();
  });

  it('"/" jumps to search, but typing "/" in a box does not', async () => {
    stubSliceApi();
    render(<App />);
    const search = screen.getByRole('searchbox', { name: 'Find a region' });
    await userEvent.keyboard('/');
    expect(search).toHaveFocus();
    await userEvent.type(search, 'a/b');
    expect(search).toHaveValue('a/b');
  });

  it('switches side panel tabs', async () => {
    stubSliceApi();
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Saved' }));
    expect(screen.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Saved regions' })).toBeInTheDocument();
  });
});

describe('api client', () => {
  it("raises the server's own error message", async () => {
    stubSliceApi({ fail: { status: 400, error: 'view must be one of sagittal, coronal, transverse' } });
    await expect(fetchSlice('coronal', 1)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 400, message: 'view must be one of sagittal, coronal, transverse' }),
    );
    await expect(fetchSlice('coronal', 1)).rejects.toBeInstanceOf(ApiError);
  });
});
