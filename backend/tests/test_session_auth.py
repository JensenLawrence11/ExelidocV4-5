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
