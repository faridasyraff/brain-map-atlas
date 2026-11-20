import { identifyAt, openSearchResult } from '@/lib/navigate';
import type { Center, LookupResult } from '@/lib/api';
import { useAtlas } from '@/store/atlas';

// Each API call returns a promise the test settles by hand, so the order in
// which answers arrive can be chosen.
const pending: { center: ((v: unknown) => void)[]; lookup: ((v: unknown) => void)[] } = { center: [], lookup: [] };
vi.mock('@/lib/api', () => ({
  regionCenter: () => new Promise((r) => pending.center.push(r)),
  lookupPoint: () => new Promise((r) => pending.lookup.push(r)),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }) }));

const center: Center = { xi: 500, yi: 300, zi: 600 };
const lookup = { parcellation_index: 2, matched_label: 'Clicked', matched_acronym: 'CK', ...center } as LookupResult;

describe('only the latest navigation counts', () => {
  beforeEach(() => useAtlas.getState().select(null));

  it('a slow search answer does not replace a newer slice click', async () => {
    const search = openSearchResult({ is_group: false, parcellation_index: 1, matched_label: 'Searched', matched_acronym: 'SR' });
    const click = identifyAt('coronal', 600, 10, 20);

    pending.lookup.shift()!(lookup); // the click answers first...
    await expect(click).resolves.toBe(true);
    pending.center.shift()!(center); // ...then the older search
    await expect(search).resolves.toBe(false);

    expect(useAtlas.getState().selection?.label).toBe('Clicked');
  });
});
