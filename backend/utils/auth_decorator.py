"""Decorator for routes that require an account with quota remaining."""
from functools import wraps
from flask import request, jsonify, g

from services.user_service import (
    get_user_by_api_key,
    get_user_by_session_token,
    has_access,
    check_and_consume_quota,
)


def _extract_session_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.split(" ", 1)[1].strip()

    token = request.headers.get("X-Session-Token") or request.headers.get("X-Api-Key")
    if token:
        return token.strip()

    if "session_token" in request.cookies:
        return request.cookies["session_token"]

    return None


def require_subscription(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _extract_session_token()
        if not token:
            return jsonify(error="Missing session token"), 401

        try:
            user = get_user_by_session_token(token) or get_user_by_api_key(token)
        except Exception as e:
            print(f"require_subscription: Supabase lookup failed -- {e}")
            return jsonify(error="Backend service unavailable, try again shortly"), 503

        if not user:
            return jsonify(error="Invalid session"), 401

        if not has_access(user):
            return jsonify(error="Subscription not active"), 402

        try:
            allowed, remaining = check_and_consume_quota(user)
        except Exception as e:
            print(f"require_subscription: quota check failed -- {e}")
            return jsonify(error="Backend service unavailable, try again shortly"), 503

        if not allowed:
            return jsonify(
                error="Monthly usage limit reached -- upgrade your plan for more",
                tier=user.get("tier"),
            ), 429

        g.user = user
        g.remaining_requests = remaining
        return fn(*args, **kwargs)

    return wrapper
