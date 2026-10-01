"""Auth endpoints for remembering a user without exposing a raw API key."""
from flask import Blueprint, request, jsonify, g

from services.stripe_service import get_checkout_session
from services.user_service import (
    get_user_by_email,
    create_user,
    ensure_session_token,
    password_matches,
    set_user_password,
)
from utils.auth_decorator import require_session

auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/signup-free")
def signup_free():
    """
    Free tier provisioning -- no Stripe involved at all. Called directly
    from the website when someone picks the free plan.
    Body: { "email": "...", "password": "..." }
    Returns: { "session_token": "...", "email": "...", "tier": "free" }
    """
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    if not isinstance(email, str) or not email.strip():
        return jsonify(error="email is required"), 400
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
        return jsonify(error="Password must be between 8 and 128 characters"), 400

    email = email.strip().lower()
    user = get_user_by_email(email)
    if user:
        return jsonify(error="An account already exists for this email."), 409

    user = create_user(email, tier="free", password=password)

    session_token = user.get("session_token") or ensure_session_token(user["id"])

    return jsonify(session_token=session_token, email=user["email"], tier=user.get("tier", "free"))


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")
    if not isinstance(email, str) or not email.strip() or not isinstance(password, str):
        return jsonify(error="Email and password are required"), 400

    user = get_user_by_email(email.strip().lower())
    if not user or not password_matches(password, user.get("password_hash")):
        return jsonify(error="Invalid email or password"), 401

    session_token = user.get("session_token") or ensure_session_token(user["id"])
    return jsonify(session_token=session_token, email=user["email"], tier=user.get("tier", "free"))


@auth_bp.post("/set-password")
@require_session
def set_password():
    data = request.get_json(silent=True) or {}
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
        return jsonify(error="Password must be between 8 and 128 characters"), 400

    set_user_password(g.user["id"], password)
    return jsonify(ok=True)


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

    return jsonify(email=user["email"], tier=user.get("tier", "free"))
