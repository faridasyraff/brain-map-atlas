import type { OntologyNode } from './api';
import type { Selection } from './selection';

/** What the 3D view should load for a selection. */
export interface MeshTarget {
  structureId: number;
  name: string;
  acronym: string;
  color: string;
}

/** The Allen tree, indexed for the 3D view: lookups by name/acronym, and each node's parent. */
export interface MeshCatalog {
  byAcronym: Map<string, OntologyNode>;
  byName: Map<string, OntologyNode>;
  parentOf: Map<number, number>;
  nodeOf: Map<number, OntologyNode>;
}

export function buildMeshCatalog(roots: OntologyNode[]): MeshCatalog {
  const cat: MeshCatalog = { byAcronym: new Map(), byName: new Map(), parentOf: new Map(), nodeOf: new Map() };
  const walk = (n: OntologyNode, parent: number | null) => {
    if (!n.id) return;
    cat.nodeOf.set(n.id, n);
    if (parent !== null) cat.parentOf.set(n.id, parent);
    // First match wins, like the old tree walk.
    const a = n.acronym?.toLowerCase();
    const nm = n.name?.toLowerCase();
    if (a && !cat.byAcronym.has(a)) cat.byAcronym.set(a, n);
    if (nm && !cat.byName.has(nm)) cat.byName.set(nm, n);
    for (const c of n.children ?? []) walk(c, n.id);
  };
  for (const r of roots) walk(r, null);
  return cat;
}

/**
 * The atlas labels leftover voxels "<Name>, unassigned" / "PAG-un"; the Allen
 * tree (which names the mesh files) only has the parent, "Periaqueductal gray".
 */
export const stripAtlasSuffix = (s: string) =>
  s
    .replace(/,\s*unassigned\s*$/i, '')
    .replace(/,\s*mixed\s*$/i, '')
    .replace(/[\s\-_]+un(assigned)?\s*$/i, '')
    .trim();

const usable = (s: string) => s && s !== '—' && s !== '--';

/**
 * Find the Allen structure to show in 3D for a selection: match its acronym,
 * then its name (suffix-stripped first, then as given) against the tree. Only
 * when that fails, fall back to the structure id the backend reported.
 */
export function meshTargetFor(sel: Pick<Selection, 'label' | 'acronym' | 'structureId'>, cat: MeshCatalog | null): MeshTarget | null {
  const name = stripAtlasSuffix(sel.label);
  const acronym = stripAtlasSuffix(sel.acronym);
  if (cat) {
    const tries: [Map<string, OntologyNode>, string][] = [
      [cat.byAcronym, acronym],
      [cat.byName, name],
      [cat.byAcronym, sel.acronym],
      [cat.byName, sel.label],
    ];
    for (const [map, key] of tries) {
      const node = usable(key) ? map.get(key.toLowerCase()) : undefined;
      if (node) return { structureId: node.id, name: node.name, acronym: node.acronym, color: node._color || '#a5afae' };
    }
  }
  if (sel.structureId) return { structureId: sel.structureId, name: name || sel.label, acronym: acronym || sel.acronym, color: '#a5afae' };
  return null;
}

export const ROOT_STRUCTURE_ID = 997;
/** Always shown as a whole, never as one of their layers (Main olfactory bulb). */
const FORCED_COLLAPSE = [507];

export type MeshResolution =
  | { kind: 'mesh'; id: number; substitute: boolean }
  /** Neither the structure nor any parent below the root has a mesh. */
  | { kind: 'none' };

/**
 * Which mesh file to load for a structure. Collapses MOB's layers to MOB;
 * then, if the structure has no mesh on disk, walks up to the nearest parent
 * that has one (e.g. MOBgr → MOB). Without a catalog, tries the id as is.
 */
export function resolveMeshId(id: number, available: Set<number> | null, parentOf: Map<number, number> | null): MeshResolution {
  if (!parentOf) return { kind: 'mesh', id, substitute: false };
  const ancestors = (start: number) => {
    const chain = [start];
    const seen = new Set(chain);
    for (let p = parentOf.get(start); p && !seen.has(p); p = parentOf.get(p)) {
      chain.push(p);
      seen.add(p);
    }
    return chain;
  };
  const original = id;
  const collapse = ancestors(id).find((s) => FORCED_COLLAPSE.includes(s));
  if (collapse) id = collapse;
  if (!available) return { kind: 'mesh', id, substitute: id !== original };
  const found = ancestors(id).find((s) => s === ROOT_STRUCTURE_ID || available.has(s));
  if (!found || found === ROOT_STRUCTURE_ID) return { kind: 'none' };
  return { kind: 'mesh', id: found, substitute: found !== original };
}
