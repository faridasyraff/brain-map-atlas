# Brain Atlas

Flask backend + two frontends (old vanilla JS at `/app`, new React at `/next`) for browsing a 3D mouse-brain atlas.

## Run / test

```bash
# Backend (Docker, http://localhost:5000)
docker build -t brain-map-atlas-app .
docker compose up -d --no-build        # `up --build` needs an extra permission here

# Frontend (in frontend/)
npm run typecheck && npm test && npm run build
npm run dev                            # Vite; proxies /api and /meshes to :5000

# Backend checks (repo root)
ruff check .                           # or `python -m ruff check .` if ruff isn't on PATH
ATLAS_REQUIRE_SERVER=1 pytest          # HTTP smoke tests need the app running
```

Run all of these before every commit. Also check the UI in a real browser against the real backend, not just in jsdom. If the Playwright MCP hangs, run playwright-core from `%LOCALAPPDATA%\npm-cache\_npx\e41f203b7505f1fb\node_modules` (Chromium 1234) in a Node script with a timeout.

## Architecture

- `backend/App.py` wires the blueprints: `routes_atlas.py` (slices, lookup, meshes, eBrain volume), `routes_accounts.py`, `routes_assistant.py`. `atlas.py` holds the data (memory-mapped volumes). `db.py` is SQLite. Tests are in `backend/tests/`.
- Old app: `frontend/index.html` + `frontend/src/*.js` (`threeViewer.js` is ~1,600 lines). Keep it working until stage 7.
- React app: `frontend/next.html` → `frontend/src/app/`. It uses React 19, strict TS, Vite 6, Tailwind 4 (tokens in `styles/globals.css`, shadcn naming), Radix/shadcn-style `components/ui`, Zustand (`store/atlas.ts`, `store/ui.ts`) and TanStack Query (`lib/api.ts`).
  - The landing page at `/` is React too: `frontend/home.html` → `src/app/landing.tsx`. Both entries share `components/Providers.tsx`. `lib/paths.ts` holds the atlas URL (`/next` until stage 7).
  - Below 768px (`usePhoneLayout`), `App` renders `components/layout/PhoneAtlas.tsx` instead of the grid: one view per tab, a slice stepper, and a region sheet. 3D mounts the first time its tab is opened. Tests fake a phone by stubbing `matchMedia` (see `Phone.test.tsx`).
  - Every way of opening a region goes through `lib/navigate.ts`, including 2D clicks (`identifyAt`) and eBrain plane clicks (`identifyPick`).
  - 3D: `lib/three/BrainViewer.ts` is a plain TS class with no React. It is lazy-loaded by `components/atlas/ThreeDCell.tsx` and replaced by `test/fakeViewer.ts` in tests (jsdom has no WebGL).
  - Axes: atlas voxels are (xi = L–R 1140, yi = S–I 800, zi = A–P 1320) at 10 µm. Sagittal = xi, coronal = zi, transverse = yi. The 3D mesh frame is (x = A–P, y = S–I, z = L–R) in µm.
  - Tests are `*.test.ts(x)` under `src/app`. Helpers are in `src/app/test/`, with `fakeApi.ts` for a fake backend.

## Conventions

- No Claude/AI attribution anywhere (no Co-Authored-By, no "Generated with"). Never commit `.claude/`.
- Proceed through the next steps and report. Commit each stage separately, then push `react-migration`.
- Keep token use low: few screenshots, short output.
- Use Context7 for library docs and the Code Review plugin on each stage before committing.

## Windows gotchas

- `npm test` goes through `frontend/scripts/vitest.mjs`: a lowercase `c:` cwd makes Vitest load twice.
- Effects need block bodies (`useEffect(() => { … })`). `scrollIntoView()` returns a Promise in current Chrome, and returning it from an effect crashed the app. The test setup mimics this.
- Don't write files that contain backslash escapes via bash heredocs. Use the file-write tool.
- Python scripts that edit files: run them with `python -X utf8` (the default cp1252 corrupts non-ASCII). For long scripts, use a file in the scratchpad, not a heredoc.
- If the Docker engine is down, start `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`.

## React migration (branch `react-migration`)

Design reference: https://claude.ai/artifact/WBKdhmUP66mhSw1ETbUiVL

1. ✅ Setup  2. ✅ App shell  3. ✅ Search, inspector, hierarchy, accounts, assistant, shareable links
4. ✅ Viewers: click a slice to identify a region (POST /api/lookup) and move the other views to it; zoom/pan/pinch per 2D view with a Reset button; 3D viewer ported to TS (slice planes, region mesh with parent fallback, eBrain mode + plane click)
5. ✅ Landing page + phone layout from the canvas
6. Playwright e2e tests in CI
7. `/app` serves the React app; delete the vanilla files; update the README and screenshots
