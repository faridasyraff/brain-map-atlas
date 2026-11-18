"""Unit tests for db.py (no server needed — uses a temporary SQLite file)."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db  # noqa: E402


class DbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.DB_PATH = Path(self.tmp.name) / 'test.db'
        db.init_db()
        self.uid = db.create_user('a@example.com', 'hash')
        self.other = db.create_user('b@example.com', 'hash')

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_update_and_delete(self):
        db.upsert_saved(self.uid, 'region', '150', 'Lateral dorsal nucleus', 'LD', '#ff909f')
        db.upsert_saved(self.uid, 'region', '150', 'Lateral dorsal nucleus', 'LD', '#ff909f', note='my note')
        saved = db.list_saved(self.uid)
        self.assertEqual(len(saved), 1)                      # upsert, not duplicate
        self.assertEqual(saved[0]['note'], 'my note')
        db.upsert_saved(self.uid, 'region', '150', 'Lateral dorsal nucleus', 'LD', '#ff909f')
        self.assertEqual(db.list_saved(self.uid)[0]['note'], 'my note')   # note=None keeps it
        self.assertEqual(db.list_saved(self.other), [])      # other users can't see it
        self.assertTrue(db.delete_saved(self.uid, 'region', '150'))
        self.assertFalse(db.delete_saved(self.uid, 'region', '150'))

    def test_history_dedupes_consecutive_and_is_capped(self):
        db.add_history(self.uid, 'region', '1', 'A', '', '')
        db.add_history(self.uid, 'region', '1', 'A', '', '')
        db.add_history(self.uid, 'group', 'Thalamus', 'Thalamus', 'TH', '')
        self.assertEqual([h['ref'] for h in db.list_history(self.uid)], ['Thalamus', '1'])
        for i in range(db.HISTORY_LIMIT + 10):
            db.add_history(self.uid, 'region', str(i), str(i), '', '')
        self.assertEqual(len(db.list_history(self.uid, limit=1000)), db.HISTORY_LIMIT)

    def test_deleting_user_deletes_their_data(self):
        db.upsert_saved(self.uid, 'group', 'Thalamus', 'Thalamus', 'TH', '')
        db.add_history(self.uid, 'group', 'Thalamus', 'Thalamus', 'TH', '')
        db.delete_user(self.uid)
        self.assertIsNone(db.get_user_by_id(self.uid))
        conn = db.get_db()
        left = conn.execute('SELECT (SELECT COUNT(*) FROM saved_regions) + '
                            '(SELECT COUNT(*) FROM region_history)').fetchone()[0]
        conn.close()
        self.assertEqual(left, 0)


if __name__ == '__main__':
    unittest.main()
