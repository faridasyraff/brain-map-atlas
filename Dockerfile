# ── Step 1: build the frontend ───────────────────────────────────────────────
# This first part is temporary — it only exists to run `npm run build` and
# produce the finished website files (frontend/dist/). Once that's done, we
# copy just those finished files into the real app below. Everything else
# used to build them (all the npm packages, etc.) gets thrown away and never
# ends up in the final app.
FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Step 2: the actual app ───────────────────────────────────────────────────
FROM python:3.11-slim AS backend
# A few extra programs the app needs that don't come with Python by default:
#   libgomp1 - a helper library some of the science/math packages need to run
#   curl     - used further down to check the app is still alive and responding
#   git      - one of our Python packages (abc_atlas_access) isn't on the normal
#              Python package store, it has to be fetched directly from GitHub,
#              which needs git to do the fetching
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# Copy in only the finished website files built in step 1 — not the raw
# source code or npm packages, which we don't need anymore.
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

EXPOSE 5000

# This tells Docker how to check "is the app actually working right now?" —
# not just "is it still running," but "does it actually answer when asked?"
# (see the /health page in App.py, which just replies "yes, I'm here").
#
# start-period=300 seconds: the very first time this starts, it has to
# download several hundred MB of brain atlas data before it can answer
# anything, which can take a few minutes depending on internet speed. This
# tells Docker "don't panic if it doesn't answer right away — give it up to
# 5 minutes before you start worrying." I confirmed this by timing an actual
# first-time startup.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

# This is the command that actually starts the app.
#
# This app keeps a large amount of brain atlas data loaded in memory the
# whole time it's running. Normally you'd let the app handle several
# visitors at once by running several separate copies of it side by side
# ("workers") — but each copy would need its own full copy of that same
# large chunk of memory, which adds up fast. So instead we run just one
# copy, but give that one copy 4 "threads" (a way to still handle multiple
# visitors at the same time) without duplicating all that memory.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "120", "App:app"]
