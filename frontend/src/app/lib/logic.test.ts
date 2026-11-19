import { extractCandidateNames, isListQuery } from '@/lib/regionCloud';
import { parseLink } from '@/hooks/useUrlSync';
import { slicesFromCenter } from '@/store/atlas';

describe('slicesFromCenter', () => {
  it('maps x/y/z to sagittal/transverse/coronal and clamps to each slider', () => {
    expect(slicesFromCenter({ xi: 707, yi: 319, zi: 660 })).toEqual({ sagittal: 707, coronal: 660, transverse: 319 });
    expect(slicesFromCenter({ xi: 0, yi: 9999, zi: -5 })).toEqual({ sagittal: 51, coronal: 0, transverse: 757 });
  });
});

describe('parseLink', () => {
  it('reads a region link with slices', () => {
    expect(parseLink('?region=150&sag=707&cor=660&tra=319')).toEqual({
      slices: { sagittal: 707, coronal: 660, transverse: 319 },
      ref: { kind: 'region', ref: '150' },
    });
  });
  it('reads a group link and ignores junk', () => {
    expect(parseLink('?group=Thalamus&sag=abc')).toEqual({ slices: {}, ref: { kind: 'group', ref: 'Thalamus' } });
    expect(parseLink('?region=-3').ref).toBeNull();
  });
});

describe('region map helpers', () => {
  it('finds region names in list items, bold and capitalised phrases', () => {
    const names = extractCandidateNames('Targets:\n1. **Caudoputamen**\n- Field CA1 (dorsal)\nThe Retrosplenial Area also matters.');
    expect(names).toEqual(expect.arrayContaining(['Caudoputamen', 'Field CA1', 'Retrosplenial Area']));
    expect(names).not.toContain('Targets');
  });
  it('only builds a map for list-style questions', () => {
    expect(isListQuery('Which regions are connected to the thalamus?')).toBe(true);
    expect(isListQuery('What does it do?')).toBe(false);
  });
});
