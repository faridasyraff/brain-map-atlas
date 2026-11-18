"""Flask extensions shared by the app and its blueprints. Created here
without an app; App.py calls init_app() on each."""
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import LoginManager

# ── Rate limiting ─────────────────────────────────────────────────────────────
# Limits how many requests one visitor can make per minute, so nobody can
# hammer the site with requests and slow it down or run up a big bill.
# /api/chat and /api/enrich get an even tighter limit than everything else,
# since each of those calls costs real money (they talk to OpenAI).
limiter = Limiter(
    get_remote_address,
    # One click in the atlas makes ~8 requests (lookup, enrich, mesh, 2-3
    # slices, 3 highlights), so the old 60/minute cut normal users off after
    # ~6 clicks (views then showed 'HTTP 429'). 600/minute is ~1 click per
    # second, sustained. The costly endpoints (chat, AI enrich, login) keep
    # their own much tighter limits below.
    default_limits=['600 per minute'],
    storage_uri='memory://',  # Keeps the request counts in this app's own
                               # memory. That's fine as long as you're only
                               # running one copy of the app. If you ever run
                               # several copies at once to handle more
                               # traffic, they'd each count separately and
                               # this limit would stop working properly — at
                               # that point you'd want a shared place to keep
                               # the count instead (a small database called
                               # Redis is the usual choice).
)


login_manager = LoginManager()
