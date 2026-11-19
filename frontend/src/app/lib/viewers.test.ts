import { buildMeshCatalog, meshTargetFor, resolveMeshId, stripAtlasSuffix } from './meshTarget';
import { IDENTITY, wheelFactor, zoomAround, ZOOM_MAX, ZOOM_MIN } from './zoom';
import type { OntologyNode } from './api';
import { initialSlices, useAtlas } from '@/store/atlas';

const node = (id: number, name: string, acronym: string, children: OntologyNode[] = []): OntologyNode => ({
  id, name, acronym, _color: '#123456', _available: true, children,
});

describe('zoom math', () => {
  it('keeps the point under the cursor fixed', () => {
    const p = { x: 120, y: 80 };
    const t = zoomAround({ zoom: 1.5, x: 10, y: -20 }, 3, p);
    // Content point under p before: (p - pan) / zoom. Same after.
    expect((p.x - t.x) / t.zoom).toBeCloseTo((p.x - 10) / 1.5);
    expect((p.y - t.y) / t.zoom).toBeCloseTo((p.y + 20) / 1.5);
  });

  it('clamps the zoom range', () => {
    expect(zoomAround(IDENTITY, 100, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
    expect(zoomAround(IDENTITY, 0.01, { x: 0, y: 0 }).zoom).toBe(ZOOM_MIN);
  });

  it('wheel: up zooms in, down zooms out, about 10% a notch', () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeCloseTo(0.905, 2);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0)); // line mode
  });
});

describe('3D mesh for a selection', () => {
  const tree = [
    node(997, 'root', 'root', [
      node(549, 'Thalamus', 'TH', [node(155, 'Lateral dorsal nucleus of thalamus', 'LD')]),
      node(795, 'Periaqueductal gray', 'PAG'),
      node(507, 'Main olfactory bulb', 'MOB', [node(212, 'Main olfactory bulb, glomerular layer', 'MOBgl')]),
    ]),
  ];
  const cat = buildMeshCatalog(tree);

  it('strips the atlas "unassigned" suffixes', () => {
    expect(stripAtlasSuffix('Periaqueductal gray, unassigned')).toBe('Periaqueductal gray');
    expect(stripAtlasSuffix('PAG-un')).toBe('PAG');
  });

  it('matches by acronym, then name, then falls back to the structure id', () => {
    expect(meshTargetFor({ label: 'x', acronym: 'LD' }, cat)?.structureId).toBe(155);
    expect(meshTargetFor({ label: 'Periaqueductal gray, unassigned', acronym: '—' }, cat)?.structureId).toBe(795);
    expect(meshTargetFor({ label: 'Unknown', acronym: 'UNK', structureId: 42 }, cat)?.structureId).toBe(42);
    expect(meshTargetFor({ label: 'Unknown', acronym: 'UNK' }, cat)).toBeNull();
  });

  it('falls back to the nearest parent with a mesh, never to the root', () => {
    expect(resolveMeshId(155, new Set([997, 549]), cat.parentOf)).toEqual({ kind: 'mesh', id: 549, substitute: true });
    expect(resolveMeshId(549, new Set([997, 549]), cat.parentOf)).toEqual({ kind: 'mesh', id: 549, substitute: false });
    expect(resolveMeshId(155, new Set([997]), cat.parentOf)).toEqual({ kind: 'none' });
  });

  it('always shows the olfactory bulb whole', () => {
    expect(resolveMeshId(212, new Set([997, 212, 507]), cat.parentOf)).toMatchObject({ id: 507 });
  });
});

describe('select(…, keep)', () => {
  beforeEach(() => useAtlas.setState({ slices: initialSlices(), selection: null }));

  it('moves every view but the kept one', () => {
    const before = useAtlas.getState().slices;
    useAtlas.getState().select(null, { xi: 700, yi: 300, zi: 650 }, 'coronal');
    expect(useAtlas.getState().slices).toEqual({ sagittal: 700, coronal: before.coronal, transverse: 300 });
  });
});
