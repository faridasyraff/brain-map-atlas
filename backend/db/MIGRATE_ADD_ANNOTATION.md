Migration steps to add `annotation_id` column and populate it

1) Stop the backend server if running.

2) Update the database schema:
   - If you are starting from scratch, re-run `backend/db/init_db.py` which will create tables from `backend/db/schema.sql`.
   - If you have an existing DB and want to migrate in-place, run the following SQL commands against the database `backend/data/brain_atlas.db`:

```sql
ALTER TABLE brain_regions ADD COLUMN annotation_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_brain_regions_annotation_id ON brain_regions(annotation_id);
```

3) Re-seed or update the `annotation_id` values for existing rows. From project root run:

```powershell
& '.\.venv\Scripts\Activate.ps1'
python backend/db/seed_db.py
```

The `seed_db.py` script has been updated to compute `annotation_id = (color_r << 16) | (color_g << 8) | color_b` when color values are present and will upsert the computed `annotation_id` for each region.

4) Restart the backend:

```powershell
python -m uvicorn backend.app.main:app --reload --port 8000
```

5) Quick verification (manual):
   - Open `http://127.0.0.1:8000/docs` and try `GET /regions/by_annotation/{annotation_id}` with a known example such as `526157192`.

Notes:
- The `annotation_id` column is additive and does not remove or change `color_r`, `color_g`, `color_b` columns; both lookup paths will work.
- If you prefer to preserve your current DB file, back it up before running migrations.
