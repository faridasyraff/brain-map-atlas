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

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: unknown }).error;
    throw new ApiError(typeof msg === 'string' ? msg : `Request failed (HTTP ${res.status})`, res.status);
  }
  return body as T;
}

/** A rendered slice, as returned by GET /api/slice. */
export interface SliceImage {
  view: Plane;
  idx: number;
  /** PNG as a data: URL. One image pixel = one voxel. */
  image: string;
  rows: number;
  cols: number;
}

export function fetchSlice(view: Plane, idx: number, signal?: AbortSignal): Promise<SliceImage> {
  const q = new URLSearchParams({ view, idx: String(idx), colorize: 'structure' });
  return getJson<SliceImage>(`/api/slice?${q}`, signal);
}
