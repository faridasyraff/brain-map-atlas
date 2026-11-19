"""
Brain Atlas Explorer — Flask application.

This file only creates and configures the app and wires in the pieces:
  common.py           environment, logging, request/response helpers
  atlas.py            the Allen CCFv3 data (loaded once at import), rendering
  enrichment.py       region summaries / keywords / related regions
  assistant.py        Ollama / CortexMap / OpenAI answers
  extensions.py       rate limiter and login manager
  routes_atlas.py     /api/slice, /api/lookup, /api/search, meshes, ...
  routes_accounts.py  /api/auth/*, /api/me/*
  routes_assistant.py /api/chat, /api/enrich

Run with gunicorn (App:app) — see the Dockerfile — or `python App.py`.
"""
import json as _json
import os as _os
import traceback
import uuid
import time as _time
from pathlib import Path
from flask import g as _g
from flask import Flask, request, jsonify, redirect, send_from_directory
from werkzeug.exceptions import HTTPException
from flask_cors import CORS
from common import (_DEBUG_ERRORS, _allowed_origins, log)
from flask_compress import Compress
from db import init_db
from extensions import limiter, login_manager
import routes_atlas
import routes_accounts
import routes_assistant

# ── Flask ─────────────────────────────────────────────────────────────────────
# static_folder=None turns off Flask's built-in "serve any file in this
# folder" feature. Without this line, Flask would happily hand out ANY file
# sitting in this project over the web to anyone who asks for it — including
# this App.py source file itself, the logs, the OpenAI cache, and eventually
# our .env file with secrets in it. Every file we actually want people to be
# able to fetch (the website itself, the 3D meshes, etc.) already has its own
# specific route written below, so we don't need this catch-all shortcut.
app = Flask(__name__, static_folder=None)

# Behind a reverse proxy / load balancer (almost every host: Render, Fly,
# Railway, nginx, Caddy, ...) every request arrives from the proxy's IP, so
# the rate limiter would put ALL visitors in one shared bucket (e.g. 15 chat
# messages per minute for the whole site). TRUST_PROXY_HOPS=1 tells the app
# to read the real visitor IP / https-ness from the proxy's X-Forwarded-*
# headers. Leave it at 0 when nothing sits in front of the app, otherwise
# anyone could fake their IP by sending that header themselves.
_PROXY_HOPS = int(_os.environ.get('TRUST_PROXY_HOPS') or 0)
if _PROXY_HOPS > 0:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_PROXY_HOPS, x_proto=_PROXY_HOPS,
                            x_host=_PROXY_HOPS)
# supports_credentials lets the browser send the login session cookie along
# with cross-origin requests (e.g. the Vite dev server on a different port
# than Flask) — without it, /api/auth/me etc. would never see who's logged in.
CORS(app, origins=_allowed_origins(), supports_credentials=True)

# Automatically shrinks responses before sending them, when the visitor's
# browser says it can handle a compressed reply (basically every browser
# does). Was measured completely off before this — a checked response
# showed the raw, uncompressed file being sent even though the browser
# asked for compression. The website's own build tools already show the
# expected saving: the main JS file is 581KB normally but only 151KB
# compressed — that's the difference this turns on.
# How long each request spent inside the app, sent as a standard
# Server-Timing header (browser dev tools show it per request) and logged
# when slow. Lets you tell "the server was slow" apart from "the request
# was waiting to be picked up" when something feels laggy.

@app.before_request
def _start_timer():
    _g._t0 = _time.perf_counter()

@app.after_request
def _add_server_timing(resp):
    t0 = getattr(_g, '_t0', None)
    if t0 is not None:
        ms = (_time.perf_counter() - t0) * 1000
        resp.headers['Server-Timing'] = f'app;dur={ms:.1f}'
        if ms > 1000:
            log.warning(f'slow request: {request.method} {request.path} took {ms:.0f} ms')
    return resp

# Registered after the timer on purpose: Flask runs after_request hooks in
# reverse order, so compression happens first and is included in the timing.
Compress(app)

limiter.init_app(app)

# ── User accounts (sign up / sign in) ─────────────────────────────────────────
# Accounts live in a small SQLite database (db.py) — one file on disk,
# nothing extra to run. Sessions are the plain cookie-based kind Flask
# already knows how to do (via Flask-Login), which is simpler to reason
# about than token-based auth for an app that isn't a distributed API.
app.secret_key = _os.environ.get('SECRET_KEY')
if not app.secret_key:
    raise RuntimeError(
        'SECRET_KEY is missing from backend/.env — login sessions can\'t be '
        'signed without one. Generate one with:\n'
        '  python -c "import secrets; print(secrets.token_hex(32))"\n'
        'and add it to .env as SECRET_KEY=<the value it printed>.'
    )
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_HTTPONLY'] = True
# Set SESSION_COOKIE_SECURE=1 once the site is served over https, so the
# login cookie is never sent over plain http. (Off by default because it
# would break sign-in on http://localhost.)
app.config['SESSION_COOKIE_SECURE'] = _os.environ.get('SESSION_COOKIE_SECURE', '').lower() in ('1', 'true', 'yes')

init_db()
login_manager.init_app(app)

@app.errorhandler(Exception)
def handle_exception(e):
    # Normal HTTP errors (400 bad input, 429 rate limited, ...) are not
    # crashes: pass them through with their real status code. Without this,
    # this catch-all turned every one of them into a "500 Internal server
    # error" and logged it as one.
    if isinstance(e, HTTPException):
        # Start from the exception's own response so headers like
        # Retry-After (429) survive; just swap the HTML body for JSON.
        resp = e.get_response()
        resp.set_data(_json.dumps({'error': e.description or e.name}))
        resp.content_type = 'application/json'
        return resp
    tb = traceback.format_exc()
    error_id = uuid.uuid4().hex[:8]
    log.error(f'[{error_id}] Unhandled exception on {request.method} {request.path} — {e}\n{tb}')
    # The full error details always get written to the log file on the
    # server. But we only send a short, generic message back to whoever made
    # the request, plus a short id code — showing them the real error text
    # could accidentally reveal things about how the app works internally
    # that we don't want strangers to see. If they tell us the id code, we
    # can look up exactly what went wrong in the log ourselves.
    if _DEBUG_ERRORS:
        return jsonify({'error': str(e), 'error_id': error_id}), 500
    return jsonify({'error': 'Internal server error', 'error_id': error_id}), 500

@app.errorhandler(404)
def handle_404(e):
    log.warning(f'404 {request.method} {request.path}')
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(405)
def handle_405(e):
    log.warning(f'405 Method Not Allowed {request.method} {request.path}')
    return jsonify({'error': 'Method not allowed'}), 405

# A hosting service checks this page again and again to make sure the app
# is still working, and can restart it automatically if it ever stops
# answering. This page doesn't actually do anything — it just says "yes,
# I'm here." All the slow work of loading the brain atlas data happens
# earlier, before the app can even respond to requests at all, so if this
# page is answering, that slow part has already finished.
@limiter.exempt
@app.route('/health')
def health():
    return jsonify({'status': 'ok'}), 200


# ── Website files ────────────────────────────────────────────────────────────
# This serves the finished, built version of the website, not the raw source
# code you'd edit. The actual source lives in frontend/ and gets turned into
# the finished version by running `npm run build` there, which creates a
# frontend/dist folder — that's what gets served here. If you're actively
# changing the website's code, use `npm run dev` in frontend/ instead, which
# shows your changes immediately without needing a rebuild each time.
_FRONTEND_DIST = Path(__file__).parent.parent / 'frontend' / 'dist'

def _serve_built_page(filename):
    if not (_FRONTEND_DIST / filename).exists():
        return jsonify({'error': "Frontend build not found. Run 'npm run build' in frontend/."}), 500
    return send_from_directory(_FRONTEND_DIST, filename)

@app.route('/')
@limiter.exempt   # static files: not worth rate limiting, and a page load fetches many
def home_page():
    return _serve_built_page('home.html')

@app.route('/app')
@limiter.exempt   # static files: not worth rate limiting, and a page load fetches many
def index():
    return _serve_built_page('index.html')

# The React app was previewed at /next while it was being built. Links
# shared from that preview (/next?region=150&sag=707&...) still work: they
# land on the same view at /app. (302, not 301: browsers would cache a 301
# forever, and this route may be retired or reused.)
@app.route('/next')
@limiter.exempt
def old_preview_link():
    query = request.query_string.decode('utf-8', 'replace')
    return redirect('/app' + (f'?{query}' if query else ''), code=302)

# This only hands out files from inside frontend/dist/assets — nothing else
# on the computer. See the static_folder=None note above for why we're
# careful never to just hand out "any file you ask for."
#
# These files get a new, unique name every time their content changes
# (Vite does this automatically when building the website), so it's
# completely safe to tell browsers "keep your own copy of this and never
# bother asking me again" — if the content ever changes, it'll show up under
# a brand new name instead, and old cached copies just quietly stop being
# used. That's what max_age (1 year) and "immutable" below are doing.
@app.route('/assets/<path:filename>')
@limiter.exempt   # static files: not worth rate limiting, and a page load fetches many
def frontend_assets(filename):
    response = send_from_directory(_FRONTEND_DIST / 'assets', filename, max_age=31536000)
    response.headers['Cache-Control'] += ', immutable'
    return response

app.register_blueprint(routes_atlas.bp)
app.register_blueprint(routes_accounts.bp)
app.register_blueprint(routes_assistant.bp)


if __name__ == '__main__':
    print("\nOpen your browser at: http://localhost:5000\n")
    app.run(debug=False, port=5000)
