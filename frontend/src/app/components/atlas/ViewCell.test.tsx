import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { stubSliceApi } from '@/test/fetch';
import { ViewCell } from './ViewCell';

function renderCell(props: Partial<React.ComponentProps<typeof ViewCell>> = {}) {
  const onIdxChange = vi.fn();
  const onToggleExpand = vi.fn();
  renderWithProviders(
    <ViewCell plane="coronal" idx={660} onIdxChange={onIdxChange} expanded={false} onToggleExpand={onToggleExpand} {...props} />,
  );
  return { onIdxChange, onToggleExpand };
}

afterEach(() => vi.unstubAllGlobals());

describe('ViewCell', () => {
  it('loads and shows the slice image for its plane and index', async () => {
    const fetchMock = stubSliceApi();
    renderCell();
    const img = await screen.findByRole('img', { name: 'Coronal slice 660' });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,coronal-660');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('view=coronal&idx=660');
  });

  it('commits a new slice from the keyboard', async () => {
    stubSliceApi();
    const { onIdxChange } = renderCell();
    const thumb = screen.getByRole('slider', { name: 'Coronal slice' });
    expect(thumb).toHaveAttribute('aria-valuenow', '660');
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onIdxChange).toHaveBeenLastCalledWith(661);
  });

  it('explains a failed load instead of showing nothing', async () => {
    stubSliceApi({ fail: { status: 503, error: 'Atlas still loading' } });
    renderCell();
    expect(await screen.findByRole('alert')).toHaveTextContent('Atlas still loading');
  });

  it('has an expand button named for its view', async () => {
    stubSliceApi();
    const { onToggleExpand } = renderCell();
    await userEvent.click(screen.getByRole('button', { name: 'Expand coronal view' }));
    expect(onToggleExpand).toHaveBeenCalledOnce();
  });
});
