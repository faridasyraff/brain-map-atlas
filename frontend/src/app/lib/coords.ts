// Atlas coordinates in micrometres. The volume is 10 µm voxels indexed
// (xi = medial–lateral, yi = dorsal–ventral, zi = anterior–posterior).
// Each slice image is one plane through it:
//   sagittal   (index xi): columns = AP, rows = DV
//   coronal    (index zi): columns = ML, rows = DV
//   transverse (index yi): columns = AP, rows = ML
import { ATLAS } from './atlasFacts';
import type { Plane } from './planes';

export interface PointUm {
  ap: number;
  dv: number;
  ml: number;
}

const um = (voxel: number) => voxel * ATLAS.voxelUm;

/** The atlas point under one pixel of a slice. */
export function voxelToUm(plane: Plane, idx: number, col: number, row: number): PointUm {
  switch (plane) {
    case 'sagittal':
      return { ap: um(col), dv: um(row), ml: um(idx) };
    case 'coronal':
      return { ap: um(idx), dv: um(row), ml: um(col) };
    case 'transverse':
      return { ap: um(col), dv: um(idx), ml: um(row) };
  }
}

/** The point where the three current slices cross. */
export const slicesToUm = (s: Record<Plane, number>): PointUm => ({ ap: um(s.coronal), dv: um(s.transverse), ml: um(s.sagittal) });
