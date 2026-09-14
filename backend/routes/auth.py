"""
Minimal account access: no password/login system yet -- a user's identity is
their API key, which they paste into the extension/add-in once. This route
lets the website's "success" page (after Stripe checkout) fetch and display
that key, proven legitimate via the one-time Stripe session_id from the
redirect URL rather than a plain email lookup.

TODO: if you want a real login (e.g. to let users view/regenerate their key
later without re-checking-out), add proper auth here -- flask-jwt-extended
or Supabase Auth are both reasonable choices.
"""
from flask import Blueprint, request, jsonify

from services.stripe_service import get_checkout_session
from services.user_service import get_user_by_email, create_user

auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/signup-free")
def signup_free():
    """
    Free tier provisioning -- no Stripe involved at all. Called directly
    from the website when someone picks the free plan.
    Body: { "email": "..." }
    Returns: { "api_key": "...", "email": "...", "tier": "free" }
    """
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    if not email:
        return jsonify(error="email is required"), 400

    user = get_user_by_email(email)
    if not user:
        user = create_user(email, tier="free")

    return jsonify(api_key=user["api_key"], email=user["email"], tier=user.get("tier", "free"))


@auth_bp.get("/key-for-session")
def key_for_session():
    """
    Called by website/success.html after Stripe redirects back with
    ?session_id=... in the URL. Verifies the session with Stripe directly
    (can't be forged) before revealing the API key.
    """
    session_id = request.args.get("session_id")
    if not session_id:
        return jsonify(error="session_id is required"), 400

    try:
        session = get_checkout_session(session_id)
    except Exception:
        return jsonify(error="Invalid session_id"), 400

    if session.payment_status != "paid":
        return jsonify(error="Payment not completed"), 402

    email = session.customer_email or (session.customer_details or {}).get("email")
    user = get_user_by_email(email) if email else None
    if not user:
        return jsonify(error="No account found for this session"), 404

    return jsonify(api_key=user["api_key"], email=user["email"], tier=user.get("tier", "free"))
