import { slicesToUm, voxelToUm } from '@/lib/coords';

describe('voxelToUm', () => {
  it('reads each slice image along its own two axes', () => {
    expect(voxelToUm('coronal', 660, 570, 400)).toEqual({ ap: 6600, dv: 4000, ml: 5700 });
    expect(voxelToUm('sagittal', 570, 660, 400)).toEqual({ ap: 6600, dv: 4000, ml: 5700 });
    expect(voxelToUm('transverse', 400, 660, 570)).toEqual({ ap: 6600, dv: 4000, ml: 5700 });
  });

  it('places the crossing of the three slices at the same point', () => {
    expect(slicesToUm({ sagittal: 570, coronal: 660, transverse: 400 })).toEqual({ ap: 6600, dv: 4000, ml: 5700 });
  });
});
