import { vi } from 'vitest';

/** Replace global fetch with a stub answering /api/slice like the backend. */
export function stubSliceApi(opts: { fail?: { status: number; error: string } } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test');
    if (opts.fail) {
      return new Response(JSON.stringify({ error: opts.fail.error }), { status: opts.fail.status });
    }
    const view = url.searchParams.get('view');
    const idx = Number(url.searchParams.get('idx'));
    const body = { view, idx, image: `data:image/png;base64,${view}-${idx}`, rows: 800, cols: 1140 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
