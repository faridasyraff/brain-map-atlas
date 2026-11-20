// Facts about the reference atlas itself, shown in the details panel and the
// home page footer. The extent follows from the volume: 1,320 x 800 x 1,140
// voxels at 10 µm (AP x DV x ML).

export const ATLAS = {
  name: 'Allen Mouse Brain CCFv3',
  annotation: '2017 annotation',
  voxelUm: 10,
  extentUm: { ap: 13_200, dv: 8_000, ml: 11_400 },
  dataUrl: 'https://atlas.brain-map.org/',
} as const;

export const CITATION = {
  text: 'Wang Q, Ding S-L, Li Y, et al. The Allen Mouse Brain Common Coordinate Framework: A 3D Reference Atlas. Cell. 2020;181(4):936–953.e20.',
  doi: '10.1016/j.cell.2020.04.007',
} as const;

/** The credit the Allen Institute asks for wherever its images appear. */
export const IMAGE_CREDIT = 'Image credit: Allen Institute.';

export const fmtUm = (n: number) => n.toLocaleString('en-US');

/** How many structures a (sub)tree of the ontology holds. */
export function countStructures(nodes: { children: unknown[] }[]): number {
  return nodes.reduce((n, x) => n + 1 + countStructures(x.children as { children: unknown[] }[]), 0);
}
