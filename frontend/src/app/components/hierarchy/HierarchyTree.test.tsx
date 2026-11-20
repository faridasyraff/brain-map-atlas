import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HierarchyTree } from './HierarchyTree';
import { Providers } from '@/components/Providers';
import { resetApp, testQueryClient } from '@/test/render';
import { useAtlas } from '@/store/atlas';

// A wide tree: root > grey > 1,000 leaves, and a small second branch. Only a screenful should be drawn.
const leaves = Array.from({ length: 1000 }, (_, i) => ({
  id: 10_000 + i,
  name: `Leaf ${i}`,
  acronym: `L${i}`,
  _color: '#88AA88',
  _available: true,
  children: [],
}));
const ONTOLOGY = [
  {
    id: 997, name: 'root', acronym: 'root', _color: '#FFFFFF', _available: false,
    children: [
      { id: 8, name: 'Basic cell groups and regions', acronym: 'grey', _color: '#BFDAE3', _available: true, children: leaves },
      {
        id: 1009, name: 'fiber tracts', acronym: 'fiber tracts', _color: '#CCCCCC', _available: true,
        children: [{ id: 776, name: 'corpus callosum', acronym: 'cc', _color: '#CCCCCC', _available: true, children: [] }],
      },
    ],
  },
];

beforeEach(() => {
  resetApp('/app');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/ontology') ? { msg: ONTOLOGY } : url.includes('/api/available_meshes') ? { structure_ids: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('structure tree', () => {
  it('draws only the rows on screen, and keeps their place in the tree for screen readers', async () => {
    render(
      <Providers queryClient={testQueryClient()}>
        <HierarchyTree />
      </Providers>,
    );
    const tree = await screen.findByRole('tree', { name: 'Allen CCFv3 hierarchy' });
    await within(tree).findByRole('button', { name: 'Leaf 0 (L0)' });
    const items = within(tree).getAllByRole('treeitem');
    // 1,002 open rows, but only a window of them is in the page.
    expect(items.length).toBeGreaterThan(10);
    expect(items.length).toBeLessThan(100);
    const leaf = within(tree).getByRole('button', { name: 'Leaf 0 (L0)' }).closest('[role="treeitem"]')!;
    expect(leaf).toHaveAttribute('aria-level', '3');
    expect(leaf).toHaveAttribute('aria-posinset', '1');
    expect(leaf).toHaveAttribute('aria-setsize', '1000');

    // Collapsing the branch leaves three rows: root, it, and fiber tracts.
    await userEvent.click(within(tree).getByRole('button', { name: 'Collapse Basic cell groups and regions' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
  });

  it('selecting a region elsewhere opens its branch but leaves a branch you closed closed', async () => {
    render(
      <Providers queryClient={testQueryClient()}>
        <HierarchyTree />
      </Providers>,
    );
    const tree = await screen.findByRole('tree', { name: 'Allen CCFv3 hierarchy' });
    await userEvent.click(await within(tree).findByRole('button', { name: 'Collapse Basic cell groups and regions' }));
    act(() =>
      useAtlas.getState().select({ kind: 'region', ref: '1', label: 'corpus callosum', acronym: 'cc', pidx: 1, highlight: { type: 'region', pidx: 1 } }),
    );
    await within(tree).findByRole('button', { name: 'corpus callosum (cc)' });
    expect(within(tree).getByRole('button', { name: 'Expand Basic cell groups and regions' })).toBeInTheDocument();
  });
});
