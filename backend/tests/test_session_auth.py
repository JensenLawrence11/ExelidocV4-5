from unittest.mock import patch

from app import create_app
from services.user_service import hash_password, password_matches


def test_signup_free_sends_verification_email_before_creating_account():
    app = create_app()

    with app.test_client() as client:
        with patch("routes.auth.get_user_by_email", return_value=None), patch(
            "routes.auth.create_pending_signup"
        ) as mock_create_pending, patch("routes.auth.send_verification_email") as send_email:

            response = client.post(
                "/api/auth/signup-free",
                json={"email": "user@example.com", "password": "correct horse battery"},
            )

    assert response.status_code == 202
    data = response.get_json()
    assert data["verification_required"] is True
    assert "session_token" not in data
    mock_create_pending.assert_called_once()
    send_email.assert_called_once()


def test_signup_free_does_not_return_existing_account_session():
    app = create_app()
    existing_user = {
        "id": "user-1",
        "email": "user@example.com",
        "tier": "free",
        "session_token": "existing-private-token",
    }

    with app.test_client() as client:
        with patch("routes.auth.get_user_by_email", return_value=existing_user), patch(
            "routes.auth.create_user"
        ) as mock_create_user:
            response = client.post(
                "/api/auth/signup-free",
                json={"email": " USER@example.com ", "password": "correct horse battery"},
            )

    assert response.status_code == 409
    assert "session_token" not in response.get_json()
    mock_create_user.assert_not_called()


def test_signup_free_requires_a_strong_enough_password():
    app = create_app()

    with app.test_client() as client:
        response = client.post(
            "/api/auth/signup-free",
            json={"email": "user@example.com", "password": "short"},
        )

    assert response.status_code == 400


def test_signup_free_rejects_invalid_email_address():
    app = create_app()

    with app.test_client() as client:
        response = client.post(
            "/api/auth/signup-free",
            json={"email": "not-an-email", "password": "correct horse battery"},
        )

    assert response.status_code == 400


def test_verification_creates_account_and_sends_welcome_email():
    from datetime import datetime, timedelta, timezone

    app = create_app()
    pending = {
        "email": "user@example.com",
        "password_hash": "hashed-password",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }

    with app.test_client() as client, patch(
        "routes.auth.get_pending_signup_by_token_hash", return_value=pending
    ), patch("routes.auth.get_user_by_email", return_value=None), patch(
        "routes.auth.create_user"
    ) as create_account, patch("routes.auth.delete_pending_signup") as delete_pending, patch(
        "routes.auth.send_welcome_email"
    ) as send_welcome:
        response = client.post("/api/auth/verify-email", data={"token": "verification-token"})

    assert response.status_code == 200
    assert b"account is ready" in response.data
    create_account.assert_called_once_with(
        "user@example.com", tier="free", password_hash="hashed-password"
    )
    delete_pending.assert_called_once_with("user@example.com")
    send_welcome.assert_called_once_with("user@example.com")


def test_password_hash_verifies_without_storing_plaintext():
    stored_hash = hash_password("correct horse battery")

    assert stored_hash != "correct horse battery"
    assert password_matches("correct horse battery", stored_hash)
    assert not password_matches("wrong password", stored_hash)


def test_login_returns_existing_session_for_valid_credentials():
    app = create_app()
    user = {
        "id": "user-1",
        "email": "user@example.com",
        "tier": "free",
        "session_token": "remember-me-token",
        "password_hash": "stored-hash",
    }

    with app.test_client() as client, patch(
        "routes.auth.get_user_by_email", return_value=user
    ), patch("routes.auth.password_matches", return_value=True) as verify:
        response = client.post(
            "/api/auth/login",
            json={"email": " USER@example.com ", "password": "correct horse battery"},
        )

    assert response.status_code == 200
    assert response.get_json()["session_token"] == "remember-me-token"
    verify.assert_called_once_with("correct horse battery", "stored-hash")


def test_login_does_not_disclose_unknown_email():
    app = create_app()

    with app.test_client() as client, patch("routes.auth.get_user_by_email", return_value=None):
        response = client.post(
            "/api/auth/login",
            json={"email": "unknown@example.com", "password": "correct horse battery"},
        )

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid email or password"


def test_signed_in_user_can_set_password():
    app = create_app()
    user = {"id": "user-1", "email": "user@example.com"}

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=user
    ), patch("routes.auth.set_user_password") as save_password:
        response = client.post(
            "/api/auth/set-password",
            json={"password": "correct horse battery"},
            headers={"X-Session-Token": "existing-session"},
        )

    assert response.status_code == 200
    save_password.assert_called_once_with("user-1", "correct horse battery")


def test_stripe_return_does_not_issue_a_login_session():
    app = create_app()
    checkout_session = type("CheckoutSession", (), {
        "payment_status": "paid",
        "customer_email": "user@example.com",
        "customer_details": {},
    })()
    user = {"id": "user-1", "email": "user@example.com", "tier": "pro"}

    with app.test_client() as client, patch(
        "routes.auth.get_checkout_session", return_value=checkout_session
    ), patch("routes.auth.get_user_by_email", return_value=user):
        response = client.get("/api/auth/key-for-session?session_id=checkout-1")

    assert response.status_code == 200
    assert "session_token" not in response.get_json()
