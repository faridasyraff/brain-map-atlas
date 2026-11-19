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
  regionCenter,
  resolveRegionName,
  searchRegions,
  type OntologyNode,
  type SearchResult,
} from './api';
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

/** A selection for one region by its index, without moving any view. */
export async function selectionForRegion(pidx: number): Promise<Selection> {
  const d = await getRegion(pidx);
  if (d.error || !d.matched_label) throw new Error('That region was not found in the atlas.');
  return {
    kind: 'region',
    ref: String(pidx),
    label: d.matched_label,
    acronym: d.matched_acronym,
    color: color(d.structure_color),
    pidx,
    highlight: { type: 'region', pidx },
  };
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
