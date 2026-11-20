import { niceScale } from '@/lib/scale';

describe('niceScale', () => {
  it('picks a round length near the target width', () => {
    expect(niceScale(0.05)).toEqual({ um: 2000, px: 100, label: '2 mm' }); // 20 µm per px
    expect(niceScale(0.4)).toEqual({ um: 200, px: 80, label: '200 µm' });
    expect(niceScale(1)).toEqual({ um: 100, px: 100, label: '100 µm' });
  });

  it('never draws a bar much wider than asked for', () => {
    for (const p of [0.013, 0.07, 0.31, 2.7, 9]) expect(niceScale(p)!.px).toBeLessThanOrEqual(120);
  });

  it('gives up on a scale it cannot measure', () => {
    expect(niceScale(0)).toBeNull();
    expect(niceScale(Number.NaN)).toBeNull();
  });
});
