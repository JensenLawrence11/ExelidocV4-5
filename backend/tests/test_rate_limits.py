from unittest.mock import patch

from app import create_app
from config import Config
from services.rate_limit_service import consume_rate_limit


def test_rate_limit_rpc_receives_only_a_keyed_hash():
    with patch("services.rate_limit_service.get_supabase") as get_supabase:
        get_supabase.return_value.rpc.return_value.execute.return_value.data = [{
            "allowed": True,
            "retry_after_seconds": 0,
        }]

        assert consume_rate_limit("login", "user@example.com", 5, 900) == (True, 0)

    args = get_supabase.return_value.rpc.call_args.args
    params = get_supabase.return_value.rpc.call_args.args[1]
    assert args[0] == "consume_api_rate_limit"
    assert len(params["p_key_hash"]) == 64
    assert "user@example.com" not in repr(params)


def test_auth_endpoint_returns_retry_after_when_rate_limited():
    app = create_app()

    with app.test_client() as client, patch.object(Config, "ENV", "production"), patch(
        "utils.rate_limit.consume_rate_limit", return_value=(False, 120)
    ) as consume, patch("routes.auth.get_user_by_email") as lookup:
        response = client.post(
            "/api/auth/login",
            json={"email": "user@example.com", "password": "wrong"},
        )

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "120"
    assert response.get_json()["error"] == "Too many attempts. Try again later."
    consume.assert_called_once()
    lookup.assert_not_called()


def test_auth_endpoint_fails_closed_when_shared_rate_limit_store_is_unavailable():
    app = create_app()

    with app.test_client() as client, patch.object(Config, "ENV", "production"), patch(
        "utils.rate_limit.consume_rate_limit", side_effect=RuntimeError("database down")
    ), patch("routes.auth.get_user_by_email") as lookup:
        response = client.post(
            "/api/auth/login",
            json={"email": "user@example.com", "password": "wrong"},
        )

    assert response.status_code == 503
    assert "temporarily unavailable" in response.get_json()["error"]
    lookup.assert_not_called()


def test_email_link_get_is_not_counted_as_a_verification_attempt():
    app = create_app()

    with app.test_client() as client, patch.object(Config, "ENV", "production"), patch(
        "utils.rate_limit.consume_rate_limit"
    ) as consume:
        response = client.get("/api/auth/verify-email")

    assert response.status_code == 200
    consume.assert_not_called()
