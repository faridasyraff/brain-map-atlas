"""
Quick test to validate annotation lookup in the DB and API.
Run from project root with the virtualenv active.
"""
import sqlite3
import requests

DB = 'backend/data/brain_atlas.db'
SAMPLE_ANNOTATION = 526157192

print('Checking DB directly...')
conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute('SELECT mba_id, identifier, acronym, name, color_r, color_g, color_b, annotation_id FROM brain_regions WHERE annotation_id = ?', (SAMPLE_ANNOTATION,))
row = cur.fetchone()
if row:
    print('DB row:', row)
else:
    print('No DB row found for annotation', SAMPLE_ANNOTATION)
conn.close()

print('\nChecking API...')
try:
    r = requests.get(f'http://127.0.0.1:8000/regions/by_annotation/{SAMPLE_ANNOTATION}', timeout=5)
    print('HTTP', r.status_code)
    try:
        print('JSON:', r.json())
    except Exception:
        print('No JSON body')
except Exception as e:
    print('API request failed:', e)
