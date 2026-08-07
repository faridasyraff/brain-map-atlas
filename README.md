# Brain Atlas Explorer

An interactive explorer for the Allen Institute's CCFv3 mouse brain atlas — three synced 2D slice views (sagittal, coronal, transverse), a 3D mesh viewer, region search, an anatomical hierarchy tree, and an AI chat assistant for asking questions about whatever region you're looking at.

## Features

- **2D slice views** — sagittal/coronal/transverse views of the annotated CCFv3 volume, colorized by region, with zoom/pan and click-to-identify.
- **3D region viewer** — loads individual structure meshes on click, with live slice planes showing where the 2D views currently sit in 3D space.
- **Search** — look up a region by name or acronym, including whole anatomical groups (e.g. "Isocortex"), not just individual structures.
- **Anatomical hierarchy tree** — browse the full Allen ontology; unavailable structures (no voxels in this atlas's annotation volume) are greyed out.
- **AI chat** — ask questions about the currently selected region; auto-generated functional summaries, keywords, and related regions.
- **Accounts** — sign up / sign in to save session state.

## Running it

Requires [Docker](https://www.docker.com/).

1. Copy `backend/.env.example` to `backend/.env` and fill in the values (an OpenAI API key is needed for the chat/summary features; a `SECRET_KEY` is needed for login to work at all — see the comments in that file for how to generate one).
2. From the project root:
   ```
   docker compose up --build
   ```
3. Open `http://localhost:5000/app`.

The first start downloads ~500MB of atlas data and mesh files, which can take a few minutes — subsequent starts are fast, since that data persists in a Docker volume between restarts.

## Project structure

```
backend/    Flask API — serves slice images, region lookups, search, the
            ontology tree, mesh files, chat/AI endpoints, and auth.
frontend/   Vanilla JS + Three.js frontend, built with Vite.
Dockerfile, docker-compose.yml
            Single-container setup: builds the frontend, serves it and the
            API from one Flask app behind gunicorn.
```

## Backend API (selected endpoints)

- `GET /api/slice?view=coronal&idx=660&colorize=structure` — a rendered slice image
- `POST /api/lookup` — resolve a clicked pixel to a region
- `POST /api/highlight` — highlight a region on a given slice
- `GET /api/search?q=...` — region search
- `GET /api/ontology` — the full anatomical hierarchy tree
- `GET /api/available_meshes` — which structures have a 3D mesh on disk

See the docstrings at the top of `backend/App.py` for the complete list.
