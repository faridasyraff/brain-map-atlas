"""Shared plumbing: environment, logging, request/response helpers and the
rapid-click tracker. Imported by every other backend module."""
import logging
import os as _os
import traceback
import uuid
import time as _time
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from flask import request, jsonify, abort

import sys as _sys

# Windows consoles default stdout/stderr to the system codepage (cp1252),
# which chokes on characters like the em-dashes/arrows used in this file's
# print()s and docstring — that's a real crash risk any time this runs
# somewhere the console assumption doesn't hold (a process manager, a
# redirected log file, a container). Force UTF-8 unconditionally so it can't
# bite regardless of how App.py gets launched. Same fix as voxelize_meshes.py.
if hasattr(_sys.stdout, 'reconfigure'):
    _sys.stdout.reconfigure(encoding='utf-8')
    _sys.stderr.reconfigure(encoding='utf-8')


# ── Environment / secrets ──────────────────────────────────────────────────────
# Single source of truth for config: a .env file next to App.py (untracked —
# see .gitignore) is loaded into the process environment once at startup.
# Everything downstream just reads os.environ; no more re-parsing .env by hand.
load_dotenv(Path(__file__).parent / '.env')

def _get_openai_api_key():
    """Return OPENAI_API_KEY from the environment (populated from .env above)."""
    return _os.environ.get('OPENAI_API_KEY', '')

def _load_openai():
    """Try to load the OpenAI package. Three different places in this file
    talk to OpenAI, and someone running this app might not have that package
    installed (it's optional) — so instead of the whole app crashing on
    startup, each of those three places calls this first and just shows a
    "not installed" message if it comes back empty. Returns the OpenAI class
    to use, or None if the package isn't installed."""
    try:
        from openai import OpenAI
        return OpenAI
    except ImportError:
        log.warning('openai package not installed; run: pip install openai')
        return None

def _allowed_origins():
    """Comma-separated ALLOWED_ORIGINS env var, e.g. 'https://myapp.com,http://localhost:5000'.
    Defaults to localhost-only so a misconfigured deploy fails closed, not open."""
    raw = _os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5000,http://127.0.0.1:5000')
    return [o.strip() for o in raw.split(',') if o.strip()]

# ── Logging setup ─────────────────────────────────────────────────────────────
def _setup_logger():
    log_dir = Path(__file__).parent / 'logs'
    log_dir.mkdir(exist_ok=True)
    now = datetime.now()
    today = f'{now.month}-{now.day}-{now.year}'  # e.g. 3-16-2026
    log_file = log_dir / f'{today}.log'

    class AtlasFormatter(logging.Formatter):
        def format(self, record):
            _n    = datetime.now()
            now   = f'{_n.month}-{_n.day}-{_n.year} {_n.strftime("%H:%M:%S")}'
            level = f'[{record.levelname}]'
            src   = Path(record.pathname).name
            return f'{level}, {now} {src}, {record.getMessage()}'

    handler = logging.FileHandler(log_file, encoding='utf-8')
    handler.setFormatter(AtlasFormatter())

    logger = logging.getLogger('atlas')
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    # Also echo to console at WARNING+
    ch = logging.StreamHandler()
    ch.setLevel(logging.WARNING)
    ch.setFormatter(AtlasFormatter())
    logger.addHandler(ch)
    return logger

log = _setup_logger()
log.info('Atlas backend starting up')


# ── Rapid-click / spam tracker ────────────────────────────────────────────────
# Fires a WARNING if the same parcellation_index or group name is requested
# more than _RAPID_THRESHOLD times within _RAPID_WINDOW seconds.
_RAPID_WINDOW    = 2.0   # seconds
_RAPID_THRESHOLD = 3     # hits within window before warning

_rapid_lookup = {}   # pidx  → [timestamps]
_rapid_group  = {}   # label → [timestamps]

def _check_rapid(tracker, key, label, kind):
    now = _time.monotonic()
    hits = tracker.setdefault(key, [])
    # Drop timestamps outside the window
    hits[:] = [t for t in hits if now - t < _RAPID_WINDOW]
    hits.append(now)
    if len(hits) >= _RAPID_THRESHOLD:
        log.warning(
            f'Rapid {kind} clicks detected — "{label}" '
            f'requested {len(hits)}x in {_RAPID_WINDOW}s'
        )


_DEBUG_ERRORS = _os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')

def _json_body():
    """The request's JSON object, or a 400 if it isn't one. Requires a real
    `Content-Type: application/json` (the old force=True accepted anything,
    which also let another website POST here with a plain HTML form)."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, description='Request body must be a JSON object')
    return data


def _text(data, key, default=''):
    """A string field of a JSON body. Missing or null gives `default`; any
    other type (a number, a list) is a 400, not a crash on `.lower()`."""
    value = data.get(key)
    if value is None:
        return default
    if not isinstance(value, str):
        abort(400, description=f'{key} must be a string')
    return value


def _safe_error_response(e, status=500):
    """Does the same safe error handling as handle_exception above, but for
    use inside a route's own try/except block (instead of writing
    jsonify({'error': str(e)}) directly, which would leak the real error
    message to whoever made the request)."""
    error_id = uuid.uuid4().hex[:8]
    log.error(f'[{error_id}] {request.method} {request.path} — {e}\n{traceback.format_exc()}')
    if _DEBUG_ERRORS:
        return jsonify({'error': str(e), 'error_id': error_id}), status
    return jsonify({'error': 'Internal server error', 'error_id': error_id}), status
