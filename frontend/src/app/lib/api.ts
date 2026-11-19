import type { Plane } from './planes';

/** Thrown for any non-2xx response, with the server's own message when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: unknown }).error;
    throw new ApiError(typeof msg === 'string' ? msg : `Request failed (HTTP ${res.status})`, res.status);
  }
  return body as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
const post = <T>(path: string, json: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', json, signal });
const qs = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined || v === null || v === '' ? [] : [[k, String(v)]])),
  ).toString();

// --- Slices & highlights -----------------------------------------------------

/** A rendered slice, as returned by GET /api/slice. One image pixel = one voxel. */
export interface SliceImage {
  view: Plane;
  idx: number;
  image: string; // PNG data: URL
  rows: number;
  cols: number;
}

export const fetchSlice = (view: Plane, idx: number, signal?: AbortSignal) =>
  get<SliceImage>(`/api/slice?${qs({ view, idx, colorize: 'structure' })}`, signal);

/** A transparent PNG (same size as the slice) marking the selected region(s). */
export interface HighlightMask {
  mask: string;
}

export const highlightRegion = (view: Plane, idx: number, pidx: number, signal?: AbortSignal) =>
  post<HighlightMask>('/api/highlight', { view, idx, parcellation_index: pidx, color_mode: true }, signal);

export const highlightIndices = (view: Plane, idx: number, indices: number[], signal?: AbortSignal) =>
  post<HighlightMask>('/api/highlight_indices', { view, idx, parcellation_indices: indices }, signal);

export const highlightGroupLevel = (view: Plane, idx: number, level: string, name: string, signal?: AbortSignal) =>
  post<HighlightMask>('/api/highlight_group', { view, idx, group_level: level, group_name: name }, signal);

// --- Regions -------------------------------------------------------------------

export const HIERARCHY_LEVELS = ['organ', 'category', 'division', 'structure', 'substructure'] as const;
export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

/** Names, acronyms and colors of one region at every hierarchy level (GET /api/resolve_parcellation). */
export type RegionDetails = {
  parcellation_index: number;
  matched_label: string;
  matched_acronym: string;
  error?: string;
} & Partial<Record<HierarchyLevel | `${HierarchyLevel}_acronym` | `${HierarchyLevel}_color`, string>>;

export const getRegion = (pidx: number, signal?: AbortSignal) =>
  get<RegionDetails>(`/api/resolve_parcellation?${qs({ pidx })}`, signal);

/** A search hit: either one region, or a whole group of regions. */
export interface SearchResult {
  is_group: boolean;
  parcellation_index: number;
  matched_label: string;
  matched_acronym: string;
  structure_color?: string;
  /** Region exists in the ontology but has no voxels in the 2D atlas. */
  no_voxels?: boolean;
  group_level?: string; // 'term' | 'category' | 'division' | 'structure'
  group_name?: string;
  group_acronym?: string;
  member_count?: number;
}

export const searchRegions = (q: string, limit = 50, signal?: AbortSignal) =>
  get<{ results: SearchResult[] }>(`/api/search?${qs({ q, limit })}`, signal).then((r) => r.results);

/** Best single match for a free-text name (used for region names in AI answers). */
export const resolveRegionName = (name: string, signal?: AbortSignal) =>
  get<Partial<SearchResult>>(`/api/resolve_region?${qs({ name })}`, signal).then((r) =>
    r.matched_label ? (r as SearchResult) : null,
  );

/** Slice indices (x = sagittal, y = transverse, z = coronal) with the most voxels of the region(s). */
export interface Center {
  xi: number;
  yi: number;
  zi: number;
}

export const regionCenter = (pidx: number) => post<Center>('/api/region_center', { parcellation_index: pidx });
export const centerOfIndices = (indices: number[]) =>
  post<Center>('/api/region_center_indices', { parcellation_indices: indices });
export const groupCenterByLevel = (level: string, name: string) =>
  post<Center>('/api/region_center_group', { group_level: level, group_name: name });
export const groupByTerm = (name: string, acronym: string) =>
  post<{ name: string; acronym: string; parcellation_indices: number[] }>('/api/group_by_term', { name, acronym });

export interface RelatedRegion {
  label: string;
  name: string;
  query: string;
  relationship: string;
}

export interface Enrichment {
  region_summary: string;
  functional_keywords: { term: string; weight: number }[];
  related_regions: RelatedRegion[];
  /** Why the AI parts are empty when it's a setup problem (e.g. no API key). */
  ai_note?: string;
}

export const getEnrichment = (p: { pidx?: number | null; name: string; acronym?: string }, signal?: AbortSignal) =>
  get<Enrichment>(`/api/enrich?${qs({ pidx: p.pidx, name: p.name, acronym: p.acronym })}`, signal);

// --- Ontology (the Allen hierarchy tree) ------------------------------------

export interface OntologyNode {
  id: number;
  name: string;
  acronym: string;
  _color: string;
  /** False when the structure has no voxels in the 2D atlas. */
  _available: boolean;
  children: OntologyNode[];
}

export const getOntology = () => get<{ msg: OntologyNode[] }>('/api/ontology').then((r) => r.msg);

// --- Accounts & library ---------------------------------------------------------

export interface User {
  email: string;
  is_admin: boolean;
}

export const getMe = () => get<{ user: User | null }>('/api/auth/me').then((r) => r.user);
export const signIn = (email: string, password: string) => post<User>('/api/auth/login', { email, password });
export const signUp = (email: string, password: string) => post<User>('/api/auth/signup', { email, password });
export const signOut = () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
export const deleteAccount = (password: string) =>
  request<{ ok: true }>('/api/auth/account', { method: 'DELETE', json: { password } });

/** A region in someone's library. kind 'region': ref = parcellation index; 'group': ref = group name. */
export interface LibraryItem {
  kind: 'region' | 'group';
  ref: string;
  label: string;
  acronym: string;
  color: string;
}

export interface SavedItem extends LibraryItem {
  note: string;
  updated_at: string;
}

export const getSaved = () => get<{ saved: SavedItem[] }>('/api/me/saved').then((r) => r.saved);
export const saveItem = (item: LibraryItem & { note?: string }) =>
  request<{ saved: SavedItem[] }>('/api/me/saved', { method: 'PUT', json: item }).then((r) => r.saved);
export const unsaveItem = (item: Pick<LibraryItem, 'kind' | 'ref'>) =>
  request<{ saved: SavedItem[] }>('/api/me/saved', { method: 'DELETE', json: item }).then((r) => r.saved);
export const getHistory = () => get<{ history: (LibraryItem & { viewed_at: string })[] }>('/api/me/history').then((r) => r.history);
export const recordHistory = (item: LibraryItem) => post<{ ok: true }>('/api/me/history', item);

// --- Assistant ------------------------------------------------------------------

export type AiProvider = 'ollama' | 'openai';

export interface ChatReply {
  answer: string;
  provider: AiProvider;
  cortexmap_status?: string;
  /** Shown under the answer when the research service had a problem. */
  cortexmap_notice?: string | null;
  pmc_sources?: string[];
}

export const askAssistant = (p: {
  message: string;
  provider: AiProvider;
  regionName?: string;
  regionAcronym?: string;
  pidx?: number | null;
}) =>
  post<ChatReply>('/api/chat', {
    message: p.message,
    ai_provider: p.provider,
    region_name: p.regionName ?? '',
    region_acronym: p.regionAcronym ?? '',
    parcellation_index: p.pidx ?? '',
  });
