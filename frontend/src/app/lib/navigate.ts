// Opening a region — the one code path behind search, the hierarchy tree,
// related-region chips, the assistant's region list, saved items and shared
// links. Each resolves what to highlight and where to move the views, then
// updates the store in one step.
import { toast } from 'sonner';
import {
  centerOfIndices,
  getRegion,
  groupByTerm,
  groupCenterByLevel,
  lookupPoint,
  regionCenter,
  resolveStructureIdx,
  resolveRegionName,
  searchRegions,
  type Center,
  type OntologyNode,
  type RegionDetails,
  type SearchResult,
} from './api';
import type { Plane } from './planes';
import { isHexColor, type Selection } from './selection';
import { useAtlas } from '@/store/atlas';

const color = (c: unknown) => (isHexColor(c) ? c : undefined);
const fail = (what: string, err: unknown) =>
  toast.error(`Could not open ${what}`, { description: err instanceof Error ? err.message : String(err) });

/** Open a search result (a single region or a group) and move all views to it. */
export async function openSearchResult(r: SearchResult): Promise<boolean> {
  try {
    if (!r.is_group) {
      if (r.no_voxels) {
        toast.warning(`${r.matched_label} isn't shown in the 2D atlas`, {
          description: 'It exists in the Allen ontology but has no voxels in the annotation volume.',
        });
        return false;
      }
      const center = await regionCenter(r.parcellation_index);
      useAtlas.getState().select(
        {
          kind: 'region',
          ref: String(r.parcellation_index),
          label: r.matched_label,
          acronym: r.matched_acronym,
          color: color(r.structure_color),
          pidx: r.parcellation_index,
          highlight: { type: 'region', pidx: r.parcellation_index },
        },
        center,
      );
      return true;
    }

    const name = r.group_name ?? r.matched_label;
    const acronym = r.group_acronym ?? r.matched_acronym ?? '';
    const base = { kind: 'group' as const, ref: name, label: name, acronym, color: color(r.structure_color), pidx: null };
    if (r.group_level === 'term') {
      const g = await groupByTerm(name, acronym);
      const center = await centerOfIndices(g.parcellation_indices);
      useAtlas.getState().select(
        { ...base, memberCount: g.parcellation_indices.length, highlight: { type: 'indices', indices: g.parcellation_indices } },
        center,
      );
    } else {
      const level = r.group_level ?? 'structure';
      const center = await groupCenterByLevel(level, name);
      useAtlas.getState().select(
        { ...base, memberCount: r.member_count, highlight: { type: 'level', level, name } },
        center,
      );
    }
    return true;
  } catch (err) {
    fail(r.group_name ?? r.matched_label, err);
    return false;
  }
}

/** A region selection from the details the backend returns for it. */
function regionSelection(d: RegionDetails & { structure_id?: number }): Selection {
  const pidx = d.parcellation_index;
  return {
    kind: 'region',
    ref: String(pidx),
    label: d.matched_label,
    acronym: d.matched_acronym,
    color: color(d.structure_color),
    pidx,
    structureId: d.structure_id || undefined,
    highlight: { type: 'region', pidx },
  };
}

/** A selection for one region by its index, without moving any view. */
export async function selectionForRegion(pidx: number): Promise<Selection> {
  const d = await getRegion(pidx);
  if (d.error || !d.matched_label) throw new Error('That region was not found in the atlas.');
  return regionSelection({ ...d, parcellation_index: pidx });
}

const notARegion = (d: { parcellation_index?: number; error?: string; matched_label?: string }) =>
  !d.parcellation_index || !!d.error || !d.matched_label || d.matched_label === '—';

const outsideBrain = () =>
  toast('No region there', { id: 'no-region', description: 'That point is outside the annotated brain.' });

// Only the latest click counts: a slow answer to an earlier click is dropped.
let clickSeq = 0;

/** A click on a 2D slice: select the region under it and move the other two views to it. */
export async function identifyAt(plane: Plane, idx: number, col: number, row: number): Promise<boolean> {
  const seq = ++clickSeq;
  try {
    const d = await lookupPoint(plane, idx, col, row);
    if (seq !== clickSeq) return false;
    if (notARegion(d)) {
      outsideBrain();
      return false;
    }
    useAtlas.getState().select(regionSelection(d), d, plane);
    return true;
  } catch (err) {
    if (seq === clickSeq) fail('that point', err);
    return false;
  }
}

/** A click on a 3D slice plane (eBrain mode). */
export interface PlanePick {
  view: Plane;
  /** Hit point in mesh space (µm): x = A–P, y = S–I, z = L–R. */
  local: { x: number; y: number; z: number };
  /** Label of the mesh-derived volume at that point (0 = empty). */
  voxel: number;
}

const ATLAS_UM = 10; // annotation voxel size
// annotation_10 is (x = L–R, y = S–I, z = A–P) = (1140, 800, 1320) voxels.
const ATLAS_MAX = { xi: 1139, yi: 799, zi: 1319 };

/**
 * Identify a 3D plane click and move all views there. Inside the 2D atlas the
 * annotation is the ground truth (/api/lookup); meshes reach past it (e.g.
 * cerebellum), so outside it the mesh volume's label is resolved instead and
 * the views move to that region's center.
 */
export async function identifyPick({ view, local, voxel }: PlanePick): Promise<boolean> {
  if (!voxel) return false;
  const seq = ++clickSeq;
  const xi = Math.round(local.z / ATLAS_UM); // L–R
  const yi = Math.round(local.y / ATLAS_UM); // S–I
  const zi = Math.round(local.x / ATLAS_UM); // A–P
  const inside = xi >= 0 && xi <= ATLAS_MAX.xi && yi >= 0 && yi <= ATLAS_MAX.yi && zi >= 0 && zi <= ATLAS_MAX.zi;
  try {
    if (inside) {
      // Inverse of the backend's world_coords() for each view.
      const [idx, col, row] =
        view === 'sagittal' ? [xi, zi, yi] : view === 'coronal' ? [zi, xi, yi] : [yi, zi, xi];
      const d = await lookupPoint(view, idx, col, row);
      if (seq !== clickSeq) return false;
      if (notARegion(d)) {
        outsideBrain();
        return false;
      }
      useAtlas.getState().select(regionSelection(d), d);
      return true;
    }
    const d = await resolveStructureIdx(voxel);
    if (notARegion(d)) throw new Error('That region was not found in the atlas.');
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const center: Center = await regionCenter(d.parcellation_index).catch(() => ({
      xi: clamp(xi, ATLAS_MAX.xi),
      yi: clamp(yi, ATLAS_MAX.yi),
      zi: clamp(zi, ATLAS_MAX.zi),
    }));
    if (seq !== clickSeq) return false;
    useAtlas.getState().select(regionSelection(d), center, view);
    return true;
  } catch (err) {
    if (seq === clickSeq) fail('that point', err);
    return false;
  }
}

/** Open a saved/history/linked reference. `keepSlices` highlights it without moving the views. */
export async function openRegionRef(ref: { kind: 'region' | 'group'; ref: string }, opts: { keepSlices?: boolean } = {}) {
  try {
    if (ref.kind === 'region') {
      const pidx = Number(ref.ref);
      if (!Number.isInteger(pidx) || pidx <= 0) throw new Error('That region was not found in the atlas.');
      const selection = await selectionForRegion(pidx);
      if (opts.keepSlices) useAtlas.getState().select(selection);
      else useAtlas.getState().select(selection, await regionCenter(pidx));
      return true;
    }
    const r = await resolveRegionName(ref.ref);
    if (!r) throw new Error(`"${ref.ref}" was not found in the atlas.`);
    return openSearchResult(r);
  } catch (err) {
    fail('that region', err);
    return false;
  }
}

/** Open a node from the Allen hierarchy tree. */
export async function openTreeNode(node: OntologyNode): Promise<boolean> {
  if (node._available === false) {
    toast.warning(`${node.name} isn't shown in the 2D atlas`, {
      description: 'It exists in the Allen ontology but has no voxels in the annotation volume.',
    });
    return false;
  }
  if (!node.children.length) {
    // A leaf: find the matching atlas region.
    try {
      const results = await searchRegions(node.acronym || node.name, 20);
      const leaf = results.find(
        (x) =>
          !x.is_group &&
          (x.matched_label.toLowerCase() === node.name.toLowerCase() ||
            x.matched_acronym.toLowerCase() === node.acronym.toLowerCase()),
      );
      if (leaf) return openSearchResult(leaf);
    } catch (err) {
      fail(node.name, err);
      return false;
    }
    toast.warning(`${node.name} isn't shown in the 2D atlas`, {
      description: 'It exists in the Allen ontology but has no voxels in the annotation volume.',
    });
    return false;
  }
  return openSearchResult({
    is_group: true,
    group_level: 'term',
    group_name: node.name,
    group_acronym: node.acronym,
    matched_label: node.name,
    matched_acronym: node.acronym,
    parcellation_index: 0,
    structure_color: node._color,
  });
}
