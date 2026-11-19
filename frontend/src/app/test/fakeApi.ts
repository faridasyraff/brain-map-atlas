import { vi } from 'vitest';

/**
 * An in-memory stand-in for the Flask API, so component tests can run real
 * user flows (search → inspector → save → …) without a server. Covers only
 * the endpoints the React app calls, with a tiny region dataset.
 */

const REGIONS: Record<number, { name: string; acronym: string; division: string; color: string; center: [number, number, number] }> = {
  150: { name: 'Lateral dorsal nucleus of thalamus', acronym: 'LD', division: 'Thalamus', color: '#FF909F', center: [707, 319, 660] },
  662: { name: 'Caudoputamen', acronym: 'CP', division: 'Striatum', color: '#98D6F9', center: [400, 350, 600] },
};

const ONTOLOGY = [
  {
    id: 997, name: 'root', acronym: 'root', _color: '#FFFFFF', _available: false,
    children: [
      {
        id: 549, name: 'Thalamus', acronym: 'TH', _color: '#FF7080', _available: true,
        children: [{ id: 155, name: 'Lateral dorsal nucleus of thalamus', acronym: 'LD', _color: '#FF909F', _available: true, children: [] }],
      },
      { id: 672, name: 'Caudoputamen', acronym: 'CP', _color: '#98D6F9', _available: true, children: [] },
      { id: 1, name: 'Unavailable thing', acronym: 'UNA', _color: '#888888', _available: false, children: [] },
    ],
  },
];

const leaf = (pidx: number) => {
  const r = REGIONS[pidx]!;
  return { is_group: false, parcellation_index: pidx, matched_label: r.name, matched_acronym: r.acronym, structure_color: r.color, no_voxels: false };
};
const thalamusGroup = {
  is_group: true, group_level: 'term', group_name: 'Thalamus', group_acronym: 'TH', member_count: 2,
  parcellation_index: 150, matched_label: 'Thalamus', matched_acronym: 'TH', structure_color: '#FF7080',
};

export interface FakeApi {
  fetch: ReturnType<typeof vi.fn>;
  calls: (path: string) => { method: string; body: Record<string, unknown> | null; url: URL }[];
  state: { user: { email: string; is_admin: boolean } | null; saved: Record<string, unknown>[]; history: Record<string, unknown>[] };
  /** Next /api/chat reply. */
  chatReply: { answer: string; provider?: string; pmc_sources?: string[]; cortexmap_notice?: string | null };
}

export function installFakeApi(opts: { signedIn?: boolean } = {}): FakeApi {
  const state: FakeApi['state'] = {
    user: opts.signedIn ? { email: 'ada@example.com', is_admin: false } : null,
    saved: [],
    history: [],
  };
  const api = { state, chatReply: { answer: 'It connects with the retrosplenial cortex.' } } as FakeApi;
  const log: { method: string; body: Record<string, unknown> | null; url: URL }[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  api.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    log.push({ method, body, url });
    const p = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? '';

    switch (`${method} ${p}`) {
      case 'GET /api/slice':
        return json({ view: q('view'), idx: Number(q('idx')), image: `data:image/png;base64,${q('view')}-${q('idx')}`, rows: 800, cols: 1140 });
      case 'POST /api/highlight':
      case 'POST /api/highlight_indices':
      case 'POST /api/highlight_group':
        return json({ mask: `data:image/png;base64,mask-${body?.view}-${body?.idx}` });

      case 'GET /api/search': {
        const s = q('q').toLowerCase();
        const leaves = Object.keys(REGIONS).map(Number).map(leaf)
          .filter((r) => r.matched_label.toLowerCase().startsWith(s) || r.matched_acronym.toLowerCase().startsWith(s));
        const groups = 'thalamus'.startsWith(s) || s === 'th' ? [thalamusGroup] : [];
        return json({ results: [...groups, ...leaves] });
      }
      case 'GET /api/resolve_region': {
        const n = q('name').toLowerCase();
        if (n === 'thalamus') return json(thalamusGroup);
        const hit = Object.keys(REGIONS).map(Number).map(leaf).find((r) => r.matched_label.toLowerCase() === n);
        return json(hit ?? {});
      }
      case 'POST /api/region_center': {
        const r = REGIONS[Number(body?.parcellation_index)];
        return r ? json({ xi: r.center[0], yi: r.center[1], zi: r.center[2] }) : json({ error: 'No voxels found' }, 404);
      }
      case 'POST /api/group_by_term':
        return body?.name === 'Thalamus'
          ? json({ name: 'Thalamus', acronym: 'TH', parcellation_indices: [150, 151] })
          : json({ error: `Term not found: ${body?.name}` }, 404);
      case 'POST /api/region_center_indices':
      case 'POST /api/region_center_group':
        return json({ xi: 545, yi: 410, zi: 704 });
      case 'GET /api/resolve_parcellation': {
        const r = REGIONS[Number(q('pidx'))];
        if (!r) return json({ parcellation_index: Number(q('pidx')), error: 'No region' });
        return json({
          parcellation_index: Number(q('pidx')), matched_label: r.name, matched_acronym: r.acronym, structure_color: r.color,
          organ: 'brain', category: 'Basic cell groups and regions', division: r.division, structure: r.name, substructure: r.name,
        });
      }
      case 'GET /api/enrich':
        return json({
          region_summary: '', functional_keywords: [{ term: 'spatial navigation', weight: 0.9 }],
          related_regions: [{ label: 'Caudoputamen', name: 'Caudoputamen', query: 'Caudoputamen', relationship: 'sibling' }],
          ai_note: 'AI summaries are turned off: no OPENAI_API_KEY is set in backend/.env.',
        });
      case 'GET /api/ontology':
        return json({ msg: ONTOLOGY });
      case 'GET /api/available_meshes':
        // LD (155) has no mesh of its own: the 3D view falls back to Thalamus.
        return json({ structure_ids: [997, 549, 672] });
      case 'POST /api/lookup': {
        // Left part of any slice is LD; the rest is outside the brain.
        const col = Number(body?.col);
        const hitCol = col < 500;
        const r = REGIONS[150]!;
        return json({
          view: body?.view, idx: body?.idx, col, row: body?.row, xi: 707, yi: 319, zi: 660,
          parcellation_index: hitCol ? 150 : 0, structure_id: hitCol ? 155 : 0,
          ...(hitCol
            ? { matched_label: r.name, matched_acronym: r.acronym, structure_color: r.color, division: r.division }
            : { error: 'No region for index 0' }),
        });
      }

      case 'GET /api/auth/me':
        return json({ user: state.user });
      case 'POST /api/auth/login':
        if (body?.password !== 'correct-horse') return json({ error: 'Incorrect email or password' }, 401);
        state.user = { email: String(body.email), is_admin: false };
        return json(state.user);
      case 'POST /api/auth/signup':
        state.user = { email: String(body?.email), is_admin: false };
        return json(state.user, 201);
      case 'POST /api/auth/logout':
        state.user = null;
        return json({ ok: true });

      case 'GET /api/me/saved':
        return state.user ? json({ saved: state.saved }) : json({ error: 'Not signed in' }, 401);
      case 'PUT /api/me/saved': {
        const key = `${body?.kind}:${body?.ref}`;
        const prev = state.saved.find((s) => `${s.kind}:${s.ref}` === key);
        const next = { ...prev, ...body, note: body?.note ?? prev?.note ?? '', updated_at: 'now' };
        state.saved = [next, ...state.saved.filter((s) => `${s.kind}:${s.ref}` !== key)];
        return json({ saved: state.saved });
      }
      case 'DELETE /api/me/saved':
        state.saved = state.saved.filter((s) => !(s.kind === body?.kind && s.ref === body?.ref));
        return json({ saved: state.saved });
      case 'GET /api/me/history':
        return json({ history: state.history });
      case 'POST /api/me/history':
        state.history = [{ ...body, viewed_at: 'now' }, ...state.history];
        return json({ ok: true });

      case 'POST /api/chat':
        return json({ provider: body?.ai_provider, ...api.chatReply });
    }
    return json({ error: `fake API: no route for ${method} ${p}` }, 404);
  });

  api.calls = (path: string) => log.filter((c) => c.url.pathname === path);
  vi.stubGlobal('fetch', api.fetch);
  return api;
}
