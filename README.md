# Brain Atlas Explorer

An interactive explorer for the Allen Institute's CCFv3 mouse brain atlas: four synced views (sagittal, coronal, transverse, and a full 3D mesh viewer), region search across both individual structures and whole anatomical groups, the complete Allen ontology as a browsable tree, and an AI assistant that can answer questions about whatever region is currently selected.

![All four views showing the hippocampal formation selected, with the AI-generated inspector panel open](docs/screenshots/hero.png)

## Features

### Four synced views
- **2D slice views** (sagittal / coronal / transverse) — the annotated CCFv3 volume, colorized by region, with independent zoom/pan per view and click-to-identify on any pixel.
- **3D mesh viewer** — loads the clicked structure's actual mesh, with live slice planes showing exactly where the three 2D views currently sit in 3D space.
- **eBrain mode** — an alternate 3D rendering mode: the three slice planes get the real slice image textured onto them, plus an octant cutaway of the brain so you can see the planes intersecting the volume from any angle.
- Selecting a region from *any* view (a 2D click, a 3D click, search, or the hierarchy tree) syncs all the others to match.

### Search
- Look up a region by name or acronym.
- Finds whole anatomical **groups** too (e.g. searching "Isocortex" or "cerebrum" jumps to and highlights every region in that group at once), not just single structures — group and individual-region results are ranked and shown together.
- Regions that exist in the Allen ontology but aren't actually delineated in this atlas's annotation volume are clearly marked as unavailable rather than silently missing.

### Anatomical hierarchy tree
- Browse the complete official Allen CCFv3 structure tree, expand/collapse branches, with its own inline search box.
- Structures with no voxels in the annotation volume are greyed out up front, so you're not guessing which parts of the tree are actually clickable.

### Region inspector
- Name, acronym, and 3D coordinates for whatever's currently selected.
- AI-generated functional summary, functional keywords, and related regions for the current selection (cached after the first request per region).

### AI chat
- Ask questions about the currently selected region, or general questions with nothing selected. There are two options, selectable per question:
  - **Local** runs on your own computer with Ollama (gemma3:4b). For any region it's given the atlas's own facts: where the region sits in the hierarchy, its acronym, related regions, and the curated notes where they exist.
  - **GPT** uses OpenAI.
- **Semantic Region Cloud** — when the AI's answer mentions other region names, they turn into clickable chips that jump the atlas straight to that region.
- Optional integration with [CortexMap](https://capstone.ssdd.dev), a separately-hosted research orchestrator, for deeper literature-backed answers.

### Clear signaling when something isn't in this atlas
Not every structure the Allen ontology names is actually delineated in the CCFv3 annotation volume (2D) or has its own mesh (3D). Rather than looking broken, the app is explicit about it:
- The hierarchy tree greys out structures with no 2D voxels before you even click.
- Selecting one shows a note directly on each 2D view (not just a status-bar message easy to miss).
- In 3D, if a structure has no mesh of its own, the nearest ancestor with one is shown instead, explicitly labeled as a substitute (e.g. "showing parent shape 'ventricular systems' instead") — never silently.

![All three 2D views showing the "no voxels here" note, and the 3D view separately showing a labeled parent-shape substitute](docs/screenshots/all-views-no-voxel-note.png)

### Shareable links
The address bar always describes the current view: the selected region (or group) and all three slice positions. Opening a copied link restores exactly that view. The inspector's **Copy link** button copies it.

### Accounts
Create an account to save regions with a private note on each, and to keep a list of recently viewed regions; both are in the **Saved** tab. You can delete the account, and all of its data, from the same tab. One account can be the admin, set via `ADMIN_EMAIL`; if that's blank, the first account created becomes admin.

## Running it

Requires [Docker](https://www.docker.com/).

1. Copy `backend/.env.example` to `backend/.env` and fill in the values:
   - `SECRET_KEY` — required for sign in to work at all. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`.
   - `OPENAI_API_KEY` — only needed if you want the OpenAI chat option (the local Ollama option works without it, but needs Ollama running separately with `ollama pull gemma3:4b`).
   - `ADMIN_EMAIL` — optional; see Accounts above.
2. From the project root:
   ```
   docker compose up --build
   ```
3. Open `http://localhost:5000/app`.

The first start downloads ~500MB of atlas data and mesh files, which can take a few minutes. It then builds the 3D click volume (`meshes_volume.npy`, used for clicking inside eBrain mode) in the background, which takes about 7 more minutes; progress is in `logs/voxelize.log`, and everything else works in the meantime. All of this is kept in Docker volumes, so restarts after the first one are fast. You never need to run `voxelize_meshes.py` by hand.

The "Local" chat option needs [Ollama](https://ollama.com) running on your computer (`ollama serve`, then `ollama pull gemma3:4b`). The container finds it at `host.docker.internal:11434` automatically; set `OLLAMA_URL` in `backend/.env` only if it's somewhere else.

### Tests and linting

```
pip install -r backend/requirements-dev.txt   # pytest + ruff
ruff check .                                   # lint (rules in pyproject.toml)
pytest                                         # all tests
```

- `backend/tests/test_db.py` contains database unit tests that need nothing running.
- `backend/tests/test_api_smoke.py` contains HTTP tests against a running app (`ATLAS_URL`, default `http://localhost:5000`). Without an app they skip themselves; set `ATLAS_REQUIRE_SERVER=1` to make that a failure. The account test creates a throwaway account and deletes it again.

GitHub Actions (`.github/workflows/build.yml`) runs ruff, pytest, the frontend build and a Docker build on every push and pull request.

## Deploying

The same Docker image runs on any server or host that runs containers. Before going live:

- **Size the machine for it.** The atlas volumes are memory-mapped from disk rather than held in RAM. The app uses about **0.5 GB** at rest, and was load-tested inside a **2 GB** memory limit at around 120–150 ms per click. It needs about **15 GB of disk**: the image, plus about 12 GB of uncompressed volumes written on first start.
- **Persistent storage.** Mount persistent disks at `/app/backend/data`, `/app/backend/meshes` and `/app/backend/logs`, as `docker-compose.yml` does. Without them, every redeploy re-downloads about 500 MB, rebuilds the 3D volume and forgets every account.
- **HTTPS.** Put it behind a reverse proxy or your host's HTTPS, then set these in `backend/.env` (or the host's environment settings):
  - `TRUST_PROXY_HOPS=1`, so rate limits count per visitor instead of sharing one limit across everyone.
  - `SESSION_COOKIE_SECURE=1`
  - `ALLOWED_ORIGINS=https://your-domain`
- **Secrets.** Set a fresh `SECRET_KEY`. Set `ADMIN_EMAIL`, otherwise the first person to sign up becomes admin. Set `OPENAI_API_KEY` if you want AI summaries and the GPT chat, and put a spending limit on that key.
- **Local AI is optional.** The "Local" (Ollama) chat only works if Ollama runs somewhere the server can reach (`OLLAMA_URL`); otherwise users can pick GPT.
- **First start is slow.** It downloads data and builds the 3D volume, about 10 minutes in total. The container's health check allows for this.

## Project structure

```
backend/    Flask API (gunicorn runs App:app)
  App.py               creates the app and wires everything below together
  atlas.py             atlas data (memory-mapped volumes, histograms, ontology,
                       colors), slice rendering, meshes, 3D click volume
  enrichment.py        region summaries, keywords, related regions (+ AI cache)
  assistant.py         Ollama / CortexMap / OpenAI answers
  routes_atlas.py      /api/slice, /api/lookup, /api/search, /api/ontology, meshes...
  routes_accounts.py   /api/auth/*, /api/me/* (saved regions, history)
  routes_assistant.py  /api/chat, /api/enrich
  common.py, extensions.py   shared helpers, rate limiter, login manager
  db.py                SQLite: accounts, saved regions, history
  voxelize_meshes.py     builds the 3D click volume (run automatically on first start)
  convert_meshes_to_glb.py
                         one-off .obj -> .glb conversion (not run by the app itself)
frontend/   Vanilla JS + Three.js, built with Vite. Split by concern:
  src/sliceViewer.js     the 2D views themselves
  src/threeViewer.js     the 3D viewer + eBrain mode
  src/searchPanel.js     region search
  src/ontology.js        the hierarchy tree
  src/lookup.js          resolving a click into a region (shared by 2D/3D)
  src/inspectorPanel.js  the region-info side panel
  src/chatPanel.js       AI chat + Semantic Region Cloud
  src/auth.js            sign in / create account
  src/library.js         saved regions, notes, recently viewed (Saved tab)
  src/urlState.js        shareable links (URL <-> view state)
  styles.css             design system: tokens, components, responsive layout
Dockerfile, docker-compose.yml
            Single container: builds the frontend, serves it and the API
            from one Flask app behind gunicorn.
```

## Backend API (selected endpoints)

| Endpoint | What it does |
|---|---|
| `GET /api/slice?view=coronal&idx=660&colorize=structure` | A rendered slice image |
| `POST /api/lookup` | Resolve a clicked 2D pixel to a region |
| `POST /api/highlight` | Highlight a region on a given slice |
| `GET /api/search?q=...` | Region search (individual + group results) |
| `GET /api/ontology` | The full anatomical hierarchy tree |
| `GET /api/available_meshes` | Which structures have a 3D mesh on disk |
| `GET /api/enrich` | AI summary / keywords / related regions for a region |
| `POST /api/chat` | AI chat (Ollama or OpenAI) |
| `POST /api/auth/signup`, `/login`, `/logout`, `GET /me`, `DELETE /account` | Accounts |
| `GET/PUT/DELETE /api/me/saved`, `GET/POST /api/me/history` | Saved regions and recently viewed (signed in) |

The complete list is in the `routes_*.py` files.

## License

MIT — see [LICENSE](LICENSE).
