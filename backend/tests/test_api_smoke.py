"""
HTTP smoke tests for the Brain Atlas backend.

App.py loads ~6 GB of atlas data the moment it's imported, so instead of
importing it these tests talk to an already-running server — the Docker
container or `python App.py`. Standard library only (nothing to install).

    docker compose up -d                       # or: python App.py
    pytest                                      # from the repo root

Point them somewhere else with ATLAS_URL=http://host:port. Without a
running app they're skipped (as in CI), unless ATLAS_REQUIRE_SERVER=1.
They never create accounts or change any data.
"""
import json
import os
import unittest
import urllib.error
import urllib.request

BASE = os.environ.get('ATLAS_URL', 'http://localhost:5000').rstrip('/')


def setUpModule():
    """Skip this whole file when no app is running (e.g. in CI, which has no
    atlas data). Set ATLAS_REQUIRE_SERVER=1 to make that a failure instead."""
    try:
        with urllib.request.urlopen(BASE + '/health', timeout=5) as r:
            if r.status == 200:
                return
    except Exception:
        pass
    msg = f'no running Brain Atlas app at {BASE} (start it, or set ATLAS_URL)'
    if os.environ.get('ATLAS_REQUIRE_SERVER') == '1':
        raise RuntimeError(msg)
    raise unittest.SkipTest(msg)


def call(path, body=None, content_type='application/json', method=None, timeout=60):
    """Returns (status, parsed_json_or_raw_bytes). Never raises on HTTP errors."""
    data = None
    headers = {}
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers['Content-Type'] = content_type
    req = urllib.request.Request(BASE + path, data=data, headers=headers,
                                 method=method or ('POST' if body is not None else 'GET'))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


class CoreViews(unittest.TestCase):
    def test_health(self):
        self.assertEqual(call('/health'), (200, {'status': 'ok'}))

    def test_pages_served(self):
        for path in ('/', '/app'):
            status, raw = call(path)
            self.assertEqual(status, 200, path)
            self.assertIn(b'<html', raw[:500].lower())

    def test_slice_renders_png(self):
        status, d = call('/api/slice?view=coronal&idx=660&colorize=structure')
        self.assertEqual(status, 200)
        self.assertTrue(d['image'].startswith('data:image/png;base64,'))
        self.assertEqual((d['rows'], d['cols']), (800, 1140))   # rows = S-I, cols = L-R

    def test_slice_png_is_native_resolution_and_fast(self):
        import base64
        import struct
        import time
        idx = 300 + int(time.time()) % 400            # avoid the server's slice cache
        # Warm the neighbouring slice first: the volumes are memory-mapped, so
        # right after a restart the first reads come from disk. This test is
        # about render speed, not cold-disk speed.
        call(f'/api/slice?view=transverse&idx={idx + 1}&colorize=structure')
        req = urllib.request.Request(f'{BASE}/api/slice?view=transverse&idx={idx}&colorize=structure')
        with urllib.request.urlopen(req, timeout=30) as r:
            timing = r.headers.get('Server-Timing', '')
            d = json.loads(r.read())
        png = base64.b64decode(d['image'].split(',', 1)[1])
        w, h = struct.unpack('>II', png[16:24])
        self.assertEqual((h, w), (d['rows'], d['cols']))   # 1 image pixel = 1 voxel
        self.assertTrue(timing.startswith('app;dur='), timing)
        # Was 300-800 ms with matplotlib; ~60-150 ms now. Generous bound.
        self.assertLess(float(timing.split('=')[1]), 600)

    def test_slice_rejects_unknown_view(self):
        self.assertEqual(call('/api/slice?view=diagonal')[0], 400)

    def test_lookup_identifies_region_and_syncs_coords(self):
        status, d = call('/api/lookup', {'view': 'coronal', 'idx': 660, 'col': 600, 'row': 300})
        self.assertEqual(status, 200)
        self.assertGreater(d['parcellation_index'], 0)
        self.assertEqual(d['zi'], 660)          # coronal slice index is the z coordinate
        self.assertTrue(d['matched_label'])

    def test_highlight_returns_mask(self):
        _, look = call('/api/lookup', {'view': 'coronal', 'idx': 660, 'col': 600, 'row': 300})
        status, d = call('/api/highlight', {'view': 'sagittal', 'idx': look['xi'],
                                            'parcellation_index': look['parcellation_index'],
                                            'color_mode': True})
        self.assertEqual(status, 200)
        self.assertTrue(d['mask'].startswith('data:image/png;base64,'))


class Search(unittest.TestCase):
    def test_group_and_leaf_results(self):
        status, d = call('/api/search?q=hippocampal&limit=50')
        self.assertEqual(status, 200)
        names = [r['matched_label'] for r in d['results']]
        self.assertIn('Hippocampal formation', names)
        self.assertTrue(any(r['is_group'] for r in d['results']))

    def test_acronym_exact_match_ranks_first_among_leaves(self):
        _, d = call('/api/search?q=CA1')
        leaves = [r for r in d['results'] if not r['is_group']]
        self.assertTrue(leaves and leaves[0]['matched_acronym'].lower().startswith('ca1'))

    def test_bad_limit_is_400_not_500(self):
        self.assertEqual(call('/api/search?q=a&limit=abc')[0], 400)

    def test_resolve_region_for_chat_chips(self):
        status, d = call('/api/resolve_region?name=Caudoputamen')
        self.assertEqual(status, 200)
        self.assertEqual(d.get('matched_label'), 'Caudoputamen')


class ErrorHandling(unittest.TestCase):
    """HTTP errors must keep their real status (they used to all become 500)."""

    def test_invalid_json_is_400(self):
        self.assertEqual(call('/api/lookup', b'not json')[0], 400)

    def test_non_object_json_is_400(self):
        self.assertEqual(call('/api/log_warning', [1, 2])[0], 400)

    def test_non_json_content_type_is_rejected(self):
        # A cross-site <form enctype="text/plain"> can't pass as JSON anymore.
        status, _ = call('/api/lookup', b'{"view":"coronal","idx":1,"col":1,"row":1}',
                         content_type='text/plain')
        self.assertEqual(status, 400)

    def test_out_of_range_region_indices_never_500(self):
        # 1328 used to slip past a range check whose bound had been
        # overwritten, and crash the histogram lookup.
        for idx in (1327, 1328, 1329, 10**6, -1):
            status, _ = call('/api/region_center_indices', {'parcellation_indices': [idx]})
            self.assertIn(status, (200, 400, 404), idx)
            status, _ = call('/api/region_center', {'parcellation_index': idx})
            self.assertIn(status, (200, 404), idx)

    def test_unknown_route_is_404_json(self):
        status, d = call('/api/does_not_exist')
        self.assertEqual(status, 404)
        self.assertEqual(d['error'], 'Not found')


class RateLimit(unittest.TestCase):
    def test_normal_browsing_is_not_rate_limited(self):
        # ~10 clicks' worth of requests in a few seconds. The old limit
        # (60/minute) started answering 429 after ~6 clicks.
        statuses = {call('/api/lookup', {'view': 'coronal', 'idx': 660,
                                         'col': 500 + i, 'row': 300})[0] for i in range(80)}
        self.assertEqual(statuses, {200})


class RemovedAndHiddenEndpoints(unittest.TestCase):
    def test_unused_bulk_volume_endpoints_are_gone(self):
        # /api/annotation_volume?res=1 used to build+cache a 2.4 GB copy per call.
        for path in ('/api/annotation_volume?res=1', '/api/annotation_volume_meta',
                     '/api/annotation_lut'):
            self.assertEqual(call(path)[0], 404, path)

    def test_debug_endpoints_hidden_unless_debug(self):
        status, _ = call('/api/debug_name?q=CA1')
        self.assertIn(status, (200, 404))   # 200 only when FLASK_DEBUG=1
        if os.environ.get('EXPECT_DEBUG') != '1':
            self.assertEqual(status, 404)


class MeshVolume(unittest.TestCase):
    def test_meta_is_ready_or_explains_itself(self):
        status, d = call('/api/mesh_volume_meta')
        self.assertIn(status, (200, 503))
        if status == 200:
            self.assertEqual(len(d['shape']), 3)
            self.assertEqual(d['byte_length'], d['shape'][0] * d['shape'][1] * d['shape'][2] * 2)
        else:
            self.assertEqual(d['status'], 'generating')


class ThreeDClick(unittest.TestCase):
    def test_compact_index_resolves_to_a_region(self):
        # 3D eBrain clicks sample the mesh volume (compact ids) and resolve
        # them here. This silently broke once during the module split.
        status, meta = call('/api/mesh_volume_meta')
        if status != 200:
            self.skipTest('3D click volume still being generated')
        idx = meta['idx_to_sid'].index(672)          # 672 = Caudoputamen
        status, d = call(f'/api/resolve_structure_id?idx={idx}')
        self.assertEqual(status, 200)
        self.assertEqual(d['structure_id'], 672)
        self.assertIn('Caudoputamen', d['matched_label'])


class Assistant(unittest.TestCase):
    def test_local_chat_never_hangs_on_old_placeholder(self):
        status, d = call('/api/chat', {'message': 'What does it do?',
                                       'region_name': 'Caudoputamen', 'ai_provider': 'ollama'},
                         timeout=180)
        self.assertEqual(status, 200)
        self.assertNotIn('Still building the knowledge base', d['answer'])
        self.assertTrue(d['answer'])

    def test_chat_requires_message(self):
        self.assertEqual(call('/api/chat', {'message': ''})[0], 400)

    def test_enrich_explains_missing_ai(self):
        status, d = call('/api/enrich?name=Caudoputamen&acronym=CP')
        self.assertEqual(status, 200)
        if not d['region_summary']:
            self.assertTrue(d['ai_note'])


class Session:
    """A cookie-keeping client, for the signed-in tests."""
    def __init__(self):
        import http.cookiejar
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method or ('POST' if data else 'GET'),
                                     headers={'Content-Type': 'application/json'} if data else {})
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')


class Library(unittest.TestCase):
    """Saved regions, notes, history and account deletion. Creates a
    throwaway account and deletes it again at the end."""

    def test_requires_sign_in(self):
        for path in ('/api/me/saved', '/api/me/history'):
            self.assertEqual(call(path)[0], 401, path)

    def test_full_flow_and_cleanup(self):
        import uuid
        s = Session()
        email, pw = f'smoke-{uuid.uuid4().hex[:10]}@example.invalid', 'smoke-test-pw-123'
        self.assertEqual(s.call('/api/auth/signup', {'email': email, 'password': pw})[0], 201)
        try:
            item = {'kind': 'region', 'ref': '150', 'label': 'Lateral dorsal nucleus of thalamus',
                    'acronym': 'LD', 'color': '#ff909f'}
            status, d = s.call('/api/me/saved', {**item, 'note': '<b>my</b> note'}, method='PUT')
            self.assertEqual(status, 200)
            self.assertEqual(d['saved'][0]['note'], '<b>my</b> note')   # stored as plain text
            self.assertEqual(s.call('/api/me/saved', {**item, 'color': 'red;x'}, method='PUT')[1]['saved'][0]['color'], '')
            self.assertEqual(s.call('/api/me/saved', {**item, 'kind': 'bogus'}, method='PUT')[0], 400)
            self.assertEqual(s.call('/api/me/saved', {**item, 'ref': 'abc'}, method='PUT')[0], 400)

            self.assertEqual(s.call('/api/me/history', item)[0], 200)
            self.assertEqual(s.call('/api/me/history', {**item, 'kind': 'group', 'ref': 'Thalamus', 'label': 'Thalamus'})[0], 200)
            self.assertEqual([h['ref'] for h in s.call('/api/me/history')[1]['history']][:2], ['Thalamus', '150'])

            # Another user can't see it
            other = Session()
            other_email = f'smoke-{uuid.uuid4().hex[:10]}@example.invalid'
            other.call('/api/auth/signup', {'email': other_email, 'password': pw})
            self.assertEqual(other.call('/api/me/saved')[1]['saved'], [])
            other.call('/api/auth/account', {'password': pw}, method='DELETE')

            self.assertEqual(s.call('/api/me/saved', {'kind': 'region', 'ref': '150'}, method='DELETE')[1]['saved'], [])
            self.assertEqual(s.call('/api/auth/account', {'password': 'wrong-password'}, method='DELETE')[0], 401)
        finally:
            self.assertEqual(s.call('/api/auth/account', {'password': pw}, method='DELETE')[0], 200)
        # Account is really gone
        self.assertEqual(call('/api/auth/login', {'email': email, 'password': pw})[0], 401)


class Accounts(unittest.TestCase):
    def test_me_anonymous(self):
        self.assertEqual(call('/api/auth/me'), (200, {'user': None}))

    def test_bad_login_is_401_with_generic_message(self):
        status, d = call('/api/auth/login', {'email': 'nobody@example.invalid', 'password': 'x' * 10})
        self.assertEqual(status, 401)
        self.assertEqual(d['error'], 'Incorrect email or password')


if __name__ == '__main__':
    unittest.main()
