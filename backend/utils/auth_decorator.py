"""
Decorator for routes that require an account with quota remaining. The
extension and add-in send the user's API key in the X-Api-Key header on
every request.
"""
from functools import wraps
from flask import request, jsonify, g

from services.user_service import get_user_by_api_key, has_access, check_and_consume_quota


def require_subscription(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        api_key = request.headers.get("X-Api-Key")
        if not api_key:
            return jsonify(error="Missing X-Api-Key header"), 401

        try:
            user = get_user_by_api_key(api_key)
        except Exception as e:
            # Almost always a bad SUPABASE_URL / SUPABASE_SERVICE_KEY in .env,
            # or Supabase being unreachable. Logged server-side with the real
            # error; the client just gets a clean 503 instead of a stack trace.
            print(f"require_subscription: Supabase lookup failed -- {e}")
            return jsonify(error="Backend service unavailable, try again shortly"), 503

        if not user:
            return jsonify(error="Invalid API key"), 401

        if not has_access(user):
            return jsonify(error="Subscription not active"), 402  # Payment Required

        try:
            allowed, remaining = check_and_consume_quota(user)
        except Exception as e:
            print(f"require_subscription: quota check failed -- {e}")
            return jsonify(error="Backend service unavailable, try again shortly"), 503

        if not allowed:
            return jsonify(
                error="Monthly usage limit reached -- upgrade your plan for more",
                tier=user.get("tier"),
            ), 429  # Too Many Requests

        g.user = user  # available inside the route via flask.g.user
        g.remaining_requests = remaining
        return fn(*args, **kwargs)

    return wrapper
