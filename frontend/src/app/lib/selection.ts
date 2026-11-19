/** How the selected region(s) are drawn on the slices. */
export type Highlight =
  | { type: 'region'; pidx: number }
  | { type: 'indices'; indices: number[] } // a group from the ontology tree
  | { type: 'level'; level: string; name: string }; // a group by hierarchy level name

/** What's selected in the atlas: one region, or a group of regions. */
export interface Selection {
  kind: 'region' | 'group';
  /** Stable reference: the parcellation index for a region, the name for a group. */
  ref: string;
  label: string;
  acronym: string;
  /** The region's Allen color (used as the inspector accent). */
  color?: string;
  pidx: number | null;
  memberCount?: number;
  /** Allen structure id, when known: the fallback for finding its 3D mesh. */
  structureId?: number;
  highlight: Highlight;
}

/** A short key that changes whenever the highlight would look different. */
export function highlightKey(h: Highlight): string {
  switch (h.type) {
    case 'region':
      return `r:${h.pidx}`;
    case 'indices':
      return `i:${h.indices.length}:${h.indices.slice(0, 8).join(',')}`;
    case 'level':
      return `l:${h.level}:${h.name}`;
  }
}

/** An empty name or acronym, including the atlas's placeholders. */
export const isBlank = (v: unknown) => !v || v === '—' || v === '--' || v === 'nan';

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
