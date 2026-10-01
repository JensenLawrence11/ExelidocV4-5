from unittest.mock import patch

from app import create_app


USER = {"id": "user-1", "email": "user@example.com", "tier": "free"}


def test_history_requires_a_session():
    app = create_app()

    with app.test_client() as client:
        response = client.get("/api/history")

    assert response.status_code == 401


def test_history_lists_only_authenticated_user_history():
    app = create_app()
    saved_items = [{"id": "history-1", "prompt": "Draft a reply"}]

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.history.list_conversations", return_value=saved_items) as list_items:
        response = client.get("/api/history", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 200
    assert response.get_json()["history"] == saved_items
    list_items.assert_called_once_with("user-1", 31, 0)


def test_history_clear_is_scoped_to_authenticated_user():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.history.delete_conversations") as delete_items:
        response = client.delete("/api/history", headers={"X-Session-Token": "session-1"})

    assert response.status_code == 204
    delete_items.assert_called_once_with("user-1")


def test_office_link_code_requires_session_and_returns_code():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("routes.auth.create_link_code", return_value=("A1B2C3D4", "expires")) as create_code:
        response = client.post(
            "/api/auth/link-code", headers={"X-Session-Token": "session-1"}
        )

    assert response.status_code == 200
    assert response.get_json()["code"] == "A1B2C3D4"
    create_code.assert_called_once_with("user-1")


def test_redeemed_office_link_code_returns_shared_session():
    app = create_app()
    linked_user = {**USER, "session_token": "shared-session"}

    with app.test_client() as client, patch(
        "routes.auth.redeem_link_code", return_value="user-1"
    ), patch("routes.auth.get_user_by_id", return_value=linked_user):
        response = client.post("/api/auth/redeem-link-code", json={"code": "A1B2C3D4"})

    assert response.status_code == 200
    assert response.get_json()["session_token"] == "shared-session"


def test_successful_ai_request_is_saved_to_account_history():
    app = create_app()

    with app.test_client() as client, patch(
        "utils.auth_decorator.get_user_by_session_token", return_value=USER
    ), patch("utils.auth_decorator.has_access", return_value=True), patch(
        "utils.auth_decorator.check_and_consume_quota", return_value=(True, 49)
    ), patch("routes.ai.generate_text", return_value={"generated": "A concise reply."}), patch(
        "routes.ai.save_conversation"
    ) as save_history, patch("routes.ai.log_ai_usage"):
        response = client.post(
            "/api/ai/generate-text",
            json={"prompt": "Draft a reply", "client": "chrome"},
            headers={"X-Session-Token": "session-1"},
        )

    assert response.status_code == 200
    save_history.assert_called_once_with(
        "user-1", "chrome", "generate-text", "Draft a reply", {"generated": "A concise reply."}
    )