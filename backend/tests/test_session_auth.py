from unittest.mock import patch

from app import create_app
from services.user_service import hash_password, password_matches


def test_signup_free_returns_session_token_not_api_key():
    app = create_app()

    with app.test_client() as client:
        with patch("routes.auth.get_user_by_email", return_value=None), patch(
            "routes.auth.create_user"
        ) as mock_create_user:
            mock_create_user.return_value = {
                "id": "user-1",
                "email": "user@example.com",
                "tier": "free",
                "session_token": "remember-me-token",
                "api_key": "internal-secret-key",
            }

            response = client.post(
                "/api/auth/signup-free",
                json={"email": "user@example.com", "password": "correct horse battery"},
            )

    assert response.status_code == 200
    data = response.get_json()
    assert data["session_token"] == "remember-me-token"
    assert "api_key" not in data
    mock_create_user.assert_called_once_with(
        "user@example.com", tier="free", password="correct horse battery"
    )


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
