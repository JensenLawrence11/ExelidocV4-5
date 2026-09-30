from unittest.mock import patch

from app import create_app


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

            response = client.post("/api/auth/signup-free", json={"email": "user@example.com"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["session_token"] == "remember-me-token"
    assert "api_key" not in data


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
            response = client.post("/api/auth/signup-free", json={"email": " USER@example.com "})

    assert response.status_code == 409
    assert "session_token" not in response.get_json()
    mock_create_user.assert_not_called()
