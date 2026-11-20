import hashlib
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app import create_app


USER = {
    "id": "user-1",
    "email": "user@example.com",
    "tier": "free",
    "subscription_status": "inactive",
    "password_hash": "password-hash",
}


def test_password_reset_request_is_generic_for_existing_account():
    app = create_app()

    with app.test_client() as client, patch(
        "routes.auth.get_user_by_email", return_value=USER
    ), patch("routes.auth.issue_password_reset", return_value=True) as issue_reset, patch(
        "routes.auth.send_password_reset_email"
    ) as send_email:
        response = client.post(
            "/api/auth/request-password-reset",
            json={"email": " USER@example.com "},
        )

    assert response.status_code == 202
    assert "If an account exists" in response.get_json()["message"]
    token_hash = issue_reset.call_args.args[1]
    assert len(token_hash) == 64
    assert token_hash != send_email.call_args.args[1]
    send_email.assert_called_once_with("user@example.com", send_email.call_args.args[1])


def test_password_reset_request_does_not_disclose_unknown_account():
    app = create_app()

    with app.test_client() as client, patch(
        "routes.auth.get_user_by_email", return_value=None
    ), patch("routes.auth.send_password_reset_email") as send_email:
        response = client.post(
            "/api/auth/request-password-reset",
            json={"email": "unknown@example.com"},
        )

    assert response.status_code == 202
    assert "If an account exists" in response.get_json()["message"]
    send_email.assert_not_called()


def test_password_reset_request_respects_account_cooldown():
    app = create_app()

    with app.test_client() as client, patch(
        "routes.auth.get_user_by_email", return_value=USER
    ), patch("routes.auth.issue_password_reset", return_value=False) as issue_reset, patch(
        "routes.auth.send_password_reset_email"
    ) as send_email:
        response = client.post(
            "/api/auth/request-password-reset",
            json={"email": "user@example.com"},
        )

    assert response.status_code == 202
    issue_reset.assert_called_once()
    send_email.assert_not_called()


def test_password_reset_get_does_not_consume_token():
    app = create_app()

    with app.test_client() as client, patch(
        "routes.auth.get_password_reset_by_hash"
    ) as lookup:
        response = client.get("/api/auth/reset-password?token=reset-token")

    assert response.status_code == 200
    assert b"Choose a new password" in response.data
    lookup.assert_not_called()
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"


def test_password_reset_uses_single_use_hashed_token_and_revokes_sessions():
    app = create_app()
    token = "reset-token"
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()

    with app.test_client() as client, patch(
        "routes.auth.get_password_reset_by_hash",
        return_value={"user_id": "user-1", "expires_at": expires_at},
    ) as lookup, patch("routes.auth.complete_password_reset") as complete:
        response = client.post(
            "/api/auth/reset-password",
            data={"token": token, "password": "a new secure password"},
        )

    assert response.status_code == 200
    assert b"Sign in again" in response.data
    lookup.assert_called_once_with(hashlib.sha256(token.encode()).hexdigest())
    complete.assert_called_once_with(hashlib.sha256(token.encode()).hexdigest(), "a new secure password")


def test_password_reset_completion_uses_atomic_database_function():
    from services.user_service import complete_password_reset

    with patch("services.user_service.get_supabase") as get_supabase, patch(
        "services.user_service.hash_password", return_value="stored-password-hash"
    ), patch("services.user_service.generate_session_token", return_value="rotated-session-token"):
        get_supabase.return_value.rpc.return_value.execute.return_value.data = True
        completed = complete_password_reset("hashed-reset-token", "new password")

    assert completed is True
    get_supabase.return_value.rpc.assert_called_once_with(
        "complete_password_reset",
        {
            "p_token_hash": "hashed-reset-token",
            "p_password_hash": "stored-password-hash",
            "p_session_token": "rotated-session-token",
        },
    )


def test_expired_password_reset_token_is_deleted_and_rejected():
    app = create_app()
    token = "expired-token"
    expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()

    with app.test_client() as client, patch(
        "routes.auth.get_password_reset_by_hash",
        return_value={"user_id": "user-1", "expires_at": expires_at},
    ), patch("routes.auth.delete_password_reset") as delete_reset, patch(
        "routes.auth.complete_password_reset"
    ) as complete:
        response = client.post(
            "/api/auth/reset-password",
            data={"token": token, "password": "a new secure password"},
        )

    assert response.status_code == 410
    delete_reset.assert_called_once_with(hashlib.sha256(token.encode()).hexdigest())
    complete.assert_not_called()


def test_account_status_reports_customer_billing_controls():
    app = create_app()
    user = {**USER, "tier": "pro", "subscription_status": "active", "stripe_customer_id": "cus-1"}

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=user
    ):
        response = client.get("/api/auth/account", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 200
    assert response.get_json() == {
        "email": "user@example.com",
        "tier": "pro",
        "subscription_status": "active",
        "has_billing_account": True,
        "has_password": True,
        "can_delete": False,
    }


def test_account_deletion_requires_password_and_typed_confirmation():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.auth.password_matches", return_value=True), patch(
        "routes.auth.delete_user"
    ) as delete_account:
        response = client.delete(
            "/api/auth/account",
            json={"password": "current password", "confirmation": "delete"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 400
    delete_account.assert_not_called()


def test_legacy_account_without_password_must_set_one_before_deletion():
    app = create_app()
    user = {**USER, "password_hash": None}

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=user
    ), patch("routes.auth.password_matches") as verify_password, patch(
        "routes.auth.delete_user"
    ) as delete_account:
        response = client.delete(
            "/api/auth/account",
            json={"password": "unused", "confirmation": "DELETE"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 409
    assert "Set a password" in response.get_json()["error"]
    verify_password.assert_not_called()
    delete_account.assert_not_called()


def test_account_deletion_requires_paid_subscription_to_be_canceled():
    app = create_app()
    user = {**USER, "tier": "pro", "subscription_status": "active", "stripe_customer_id": "cus-1"}

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=user
    ), patch("routes.auth.password_matches", return_value=True), patch(
        "routes.auth.delete_user"
    ) as delete_account:
        response = client.delete(
            "/api/auth/account",
            json={"password": "current password", "confirmation": "DELETE"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 409
    assert "Cancel your subscription" in response.get_json()["error"]
    delete_account.assert_not_called()


def test_canceled_account_can_be_deleted_after_password_confirmation():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.auth.password_matches", return_value=True), patch(
        "routes.auth.delete_user"
    ) as delete_account:
        response = client.delete(
            "/api/auth/account",
            json={"password": "current password", "confirmation": "DELETE"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    delete_account.assert_called_once_with("user-1")


def test_billing_portal_requires_linked_stripe_customer():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.stripe_routes.create_customer_portal_session") as create_portal:
        response = client.post("/api/stripe/customer-portal", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 409
    create_portal.assert_not_called()


def test_billing_portal_creates_session_for_authenticated_customer():
    app = create_app()
    user = {**USER, "stripe_customer_id": "cus-1"}
    session = type("PortalSession", (), {"url": "https://billing.stripe.com/session"})()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=user
    ), patch("routes.stripe_routes.create_customer_portal_session", return_value=session) as create_portal:
        response = client.post("/api/stripe/customer-portal", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 200
    assert response.get_json() == {"url": session.url}
    create_portal.assert_called_once_with("cus-1")
