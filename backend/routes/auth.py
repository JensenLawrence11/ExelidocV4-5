"""Auth endpoints for remembering a user without exposing a raw API key."""
from flask import Blueprint, request, jsonify

from services.stripe_service import get_checkout_session
from services.user_service import get_user_by_email, create_user, ensure_session_token

auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/signup-free")
def signup_free():
    """
    Free tier provisioning -- no Stripe involved at all. Called directly
    from the website when someone picks the free plan.
    Body: { "email": "..." }
    Returns: { "session_token": "...", "email": "...", "tier": "free" }
    """
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    if not email:
        return jsonify(error="email is required"), 400

    user = get_user_by_email(email)
    if not user:
        user = create_user(email, tier="free")

    session_token = user.get("session_token") or ensure_session_token(user["id"])

    return jsonify(session_token=session_token, email=user["email"], tier=user.get("tier", "free"))


@auth_bp.get("/key-for-session")
def key_for_session():
    """Backwards-compatible Stripe success callback that returns a remembered session token."""
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

    session_token = user.get("session_token") or ensure_session_token(user["id"])
    return jsonify(session_token=session_token, email=user["email"], tier=user.get("tier", "free"))
