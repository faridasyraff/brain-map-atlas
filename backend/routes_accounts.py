"""Accounts (sign up / in / out / delete) and the per-user library
(saved regions with notes, recently viewed)."""
import os as _os
import re
from flask import Blueprint, jsonify, abort
from flask_login import UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from common import _json_body, _text
from extensions import limiter, login_manager
from db import (create_user, get_user_by_email, get_user_by_id, user_count,
                list_saved, upsert_saved, delete_saved, list_history, add_history, delete_user)

bp = Blueprint('accounts', __name__)

# The account matching this email is always admin, however they sign up —
# set it in .env once and you never need a separate "make me admin" step.
# If it's left blank, the first account ever created becomes admin instead.
_ADMIN_EMAIL = _os.environ.get('ADMIN_EMAIL', '').strip().lower()

def _should_be_admin(email):
    if _ADMIN_EMAIL:
        return email == _ADMIN_EMAIL
    return user_count() == 0


class User(UserMixin):
    """Thin adapter so Flask-Login can track who's signed in. The actual
    account data lives in the users table (db.py) — this just wraps one row
    of it in the shape Flask-Login expects (an object with .id etc.)."""
    def __init__(self, row):
        self.id = str(row['id'])
        self.email = row['email']
        self.is_admin = bool(row['is_admin'])

@login_manager.user_loader
def load_user(user_id):
    row = get_user_by_id(int(user_id))
    return User(row) if row else None

@login_manager.unauthorized_handler
def unauthorized():
    # Default Flask-Login behavior is to redirect to a login page, which
    # doesn't exist here — this is a JSON API, so a plain 401 is correct.
    return jsonify({'error': 'Not signed in'}), 401

def _user_public(u):
    return {'email': u.email, 'is_admin': u.is_admin}

@bp.route('/api/auth/signup', methods=['POST'])
@limiter.limit('5 per minute')
def auth_signup():
    data = _json_body()
    email = _text(data, 'email').strip().lower()
    password = _text(data, 'password')

    if not email or '@' not in email or len(email) > 254:
        return jsonify({'error': 'A valid email is required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if get_user_by_email(email):
        return jsonify({'error': 'An account with that email already exists'}), 409

    is_admin = _should_be_admin(email)
    user_id = create_user(email, generate_password_hash(password), is_admin=is_admin)
    user = User(get_user_by_id(user_id))
    login_user(user)
    return jsonify(_user_public(user)), 201

@bp.route('/api/auth/login', methods=['POST'])
@limiter.limit('10 per minute')
def auth_login():
    data = _json_body()
    email = _text(data, 'email').strip().lower()
    password = _text(data, 'password')

    row = get_user_by_email(email)
    # A Google-only account has an empty password_hash (nothing to check
    # against) — `not row['password_hash']` catches that before it ever
    # reaches check_password_hash, which expects a real hash string.
    if not row or not row['password_hash'] or not check_password_hash(row['password_hash'], password):
        # Same message either way — confirming "that email doesn't exist"
        # vs "wrong password" tells an attacker which emails have accounts.
        return jsonify({'error': 'Incorrect email or password'}), 401

    user = User(row)
    login_user(user)
    return jsonify(_user_public(user))

@bp.route('/api/auth/logout', methods=['POST'])
@login_required
def auth_logout():
    logout_user()
    return jsonify({'ok': True})

@bp.route('/api/auth/me')
def auth_me():
    if not current_user.is_authenticated:
        return jsonify({'user': None})
    return jsonify({'user': _user_public(current_user)})

@bp.route('/api/auth/account', methods=['DELETE'])
@login_required
@limiter.limit('5 per minute')
def auth_delete_account():
    """Permanently delete the signed-in account and everything saved with
    it. Asks for the password again so a stray request can't do it."""
    data = _json_body()
    row = get_user_by_id(int(current_user.id))
    if not row or not row['password_hash'] or not check_password_hash(row['password_hash'], _text(data, 'password')):
        return jsonify({'error': 'Incorrect password'}), 401
    delete_user(int(current_user.id))
    logout_user()
    return jsonify({'ok': True})


# ── Per-user library: saved regions (with notes) and recently viewed ─────────
# kind = 'region' (ref = parcellation index) or 'group' (ref = group name).
_HEX_COLOR = re.compile(r'^#[0-9a-fA-F]{3,8}$')

def _library_item(data, with_note=False):
    """Validate a saved/history item from a request body; aborts with 400."""
    kind = data.get('kind')
    ref = str(data.get('ref') or '').strip()
    label = str(data.get('label') or '').strip()
    if kind not in ('region', 'group'):
        abort(400, description="kind must be 'region' or 'group'")
    if kind == 'region' and not ref.isdigit():
        abort(400, description='ref must be a parcellation index for kind=region')
    if not ref or len(ref) > 200 or not label or len(label) > 200:
        abort(400, description='ref and label are required (max 200 characters)')
    acronym = str(data.get('acronym') or '').strip()[:40]
    color = str(data.get('color') or '').strip()
    color = color if _HEX_COLOR.match(color) else ''
    item = {'kind': kind, 'ref': ref, 'label': label, 'acronym': acronym, 'color': color}
    if with_note:
        note = data.get('note')
        if note is not None:
            note = str(note)
            if len(note) > 5000:
                abort(400, description='note is too long (max 5000 characters)')
        item['note'] = note
    return item

@bp.route('/api/me/saved', methods=['GET'])
@login_required
def my_saved():
    return jsonify({'saved': list_saved(int(current_user.id))})

@bp.route('/api/me/saved', methods=['PUT'])
@login_required
def my_saved_put():
    item = _library_item(_json_body(), with_note=True)
    upsert_saved(int(current_user.id), **item)
    return jsonify({'saved': list_saved(int(current_user.id))})

@bp.route('/api/me/saved', methods=['DELETE'])
@login_required
def my_saved_delete():
    data = _json_body()
    kind, ref = data.get('kind'), str(data.get('ref') or '')
    if not delete_saved(int(current_user.id), kind, ref):
        return jsonify({'error': 'Not in your saved regions'}), 404
    return jsonify({'saved': list_saved(int(current_user.id))})

@bp.route('/api/me/history', methods=['GET'])
@login_required
def my_history():
    return jsonify({'history': list_history(int(current_user.id))})

@bp.route('/api/me/history', methods=['POST'])
@login_required
def my_history_add():
    add_history(int(current_user.id), **_library_item(_json_body()))
    return jsonify({'ok': True})
