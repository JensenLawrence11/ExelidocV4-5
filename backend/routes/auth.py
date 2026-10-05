"""Auth endpoints for remembering a user without exposing a raw API key."""
import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from html import escape

from flask import Blueprint, request, jsonify, g

from config import Config
from services.email_service import send_verification_email, send_welcome_email
from services.stripe_service import get_checkout_session
from services.user_service import (
    get_user_by_email,
    create_user,
    create_pending_signup,
    delete_pending_signup,
    ensure_session_token,
    get_pending_signup_by_token_hash,
    hash_password,
    password_matches,
    set_user_password,
)
from utils.auth_decorator import require_session

auth_bp = Blueprint("auth", __name__)
EMAIL_PATTERN = re.compile(
    r"^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?"
    r"(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$",
    re.IGNORECASE,
)


def _verification_page(message: str, status: int = 200, token: str | None = None):
    action = ""
    if token:
        action = (
            '<form method="post"><input type="hidden" name="token" '
            f'value="{escape(token, quote=True)}"><button type="submit">Confirm email</button></form>'
        )
    return (
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Exelidoc email verification</title>"
        "<body style=\"font:16px system-ui;max-width:36rem;margin:12vh auto;padding:0 1rem\">"
        f"<h1>Exelidoc</h1><p>{escape(message)}</p>{action}</body></html>",
        status,
        {"Content-Type": "text/html; charset=utf-8"},
    )


@auth_bp.post("/signup-free")
def signup_free():
    """
    Starts a free account signup and sends a one-time email verification link.
    The account is created only after the user confirms the address.
    """
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    if not isinstance(email, str) or not EMAIL_PATTERN.fullmatch(email.strip()):
        return jsonify(error="Enter a valid email address"), 400
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
        return jsonify(error="Password must be between 8 and 128 characters"), 400

    email = email.strip().lower()
    user = get_user_by_email(email)
    if user:
        return jsonify(error="An account already exists for this email."), 409

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    create_pending_signup(email, hash_password(password), token_hash, expires_at)
    try:
        send_verification_email(email, token)
    except Exception:
        logging.exception("Could not send Exelidoc verification email")
        delete_pending_signup(email)
        return jsonify(error="Could not send a verification email. Try again later."), 503

    return jsonify(
        verification_required=True,
        message="Check your inbox for a verification link. Your account is created after you confirm your email.",
    ), 202


@auth_bp.route("/verify-email", methods=["GET", "POST"])
def verify_email():
    if request.method == "GET":
        token = request.args.get("token", "")
        if not token or len(token) > 128:
            return _verification_page("This verification link is invalid.", 400)
        return _verification_page("Confirm your email address to finish creating your account.", token=token)

    token = request.form.get("token", "")
    if not token or len(token) > 128:
        return _verification_page("This verification link is invalid.", 400)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    pending = get_pending_signup_by_token_hash(token_hash)
    if not pending:
        return _verification_page("This verification link is invalid or has already been used.", 400)

    expires_at = datetime.fromisoformat(str(pending["expires_at"]).replace("Z", "+00:00"))
    if expires_at <= datetime.now(timezone.utc):
        delete_pending_signup(pending["email"])
        return _verification_page("This verification link has expired. Start signup again.", 410)

    email = pending["email"]
    if get_user_by_email(email):
        delete_pending_signup(email)
        return _verification_page("An Exelidoc account already exists for this email. You can sign in.")

    create_user(email, tier="free", password_hash=pending["password_hash"])
    delete_pending_signup(email)
    try:
        send_welcome_email(email)
    except Exception:
        logging.exception("Could not send Exelidoc welcome email")
    return _verification_page("Your email is verified and your Exelidoc account is ready. You can now sign in.")


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
